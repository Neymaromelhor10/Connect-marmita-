-- Migração 0014: Quarta Rodada de Correções Técnicas Controladas (Argon 4 — AUD3-01 a AUD3-08)
-- 100% incremental, aditiva e não destrutiva (preserva intactas as migrations históricas 0000 a 0013).
-- Escopo:
--   AUD3-01 (CRÍTICO): Corrige public.claim_whatsapp_queue_batch removendo FOR UPDATE OF sobre CTE
--                      com window function (row_number) e aplicando LIMIT + FOR UPDATE OF m SKIP LOCKED
--                      diretamente sobre a tabela base public.whatsapp_messages m no mesmo bloco SELECT.
--   AUD3-02 (ALTO):    Unifica a chave de pg_advisory_xact_lock em public.get_or_create_customer_by_phone
--                      para ':customer_phone:' (idêntica ao trigger guard_customer_phone_uniqueness) e
--                      adiciona tratamento controlado de unique_violation (23505) com releitura segura.
--   AUD3-03 (ALTO):    Protege public.create_manual_or_reviewed_order contra criação de pedidos a partir
--                      de ecos comerciais OK/OKK ou de mensagens que já possuem order_id, e cria a RPC
--                      public.reconcile_reviewed_whatsapp_echo para reconciliar ecos em revisão sem duplicar pedidos.
--   AUD3-04 (MÉDIO):   Cria public.prepare_manual_whatsapp_retry para liberar next_retry_at em reprocessamentos
--                      manuais acionados pelo operador autenticado.

-- ============================================================================
-- 1. AUD3-01 (CRÍTICO): CORREÇÃO DE CLAIM_WHATSAPP_QUEUE_BATCH (POSTGRESQL 16)
-- ============================================================================
-- Na migration 0013, a CTE `candidates` aplicava `FOR UPDATE OF e SKIP LOCKED` sobre a CTE `eligible`
-- (que contém `row_number() OVER (...)`) e posicionava `LIMIT effective_limit` antes da CTE `locked_rows`.
-- Nesta versão corrigida:
--   1. `eligible` é materializada (`AS MATERIALIZED`) sem cláusula de bloqueio, calculando `causal_wait`
--      e `fairness_slot` (`row_number() OVER (PARTITION BY company_id, direction ORDER BY created_at, id)`).
--   2. `locked_rows` faz o JOIN da tabela base `public.whatsapp_messages m` com `eligible e`, ordena
--      pelos critérios de causalidade e fairness e aplica `LIMIT effective_limit FOR UPDATE OF m SKIP LOCKED`
--      diretamente sobre a tabela física `m` no mesmo nível de consulta.
--   3. Mensagens em `status = 'processando'` só são elegíveis para retomada quando `m.locked_until IS NOT NULL`
--      e `m.locked_until < clock_timestamp()`.

CREATE OR REPLACE FUNCTION public.claim_whatsapp_queue_batch(
  _batch_size integer DEFAULT 5,
  _lock_seconds integer DEFAULT 60,
  _company_id uuid DEFAULT NULL,
  _message_id uuid DEFAULT NULL,
  _limit integer DEFAULT NULL,
  _worker_id text DEFAULT NULL
)
RETURNS SETOF public.whatsapp_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  effective_limit integer := least(greatest(coalesce(_limit, _batch_size, 5), 1), 100);
  resolved_worker text := coalesce(nullif(btrim(_worker_id), ''), 'worker:' || gen_random_uuid()::text);
  caller_comp uuid;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    caller_comp := public.current_company_id();
    IF caller_comp IS NULL OR (_company_id IS NOT NULL AND _company_id <> caller_comp) THEN
      RAISE EXCEPTION 'Acesso negado à fila de outra empresa'
        USING ERRCODE = '42501';
    END IF;
    _company_id := caller_comp;
  END IF;

  RETURN QUERY
  WITH eligible AS MATERIALIZED (
    SELECT
      m.id,
      CASE
        WHEN m.direction = 'outbound' AND EXISTS (
          SELECT 1
            FROM public.whatsapp_messages inb
           WHERE inb.company_id = m.company_id
             AND inb.direction = 'inbound'
             AND inb.order_id IS NULL
             AND inb.status IN ('aguardando', 'processando', 'erro')
             AND inb.attempts < 5
             AND public.financial_phone_key(inb.phone) = public.financial_phone_key(m.phone)
             AND inb.created_at >= clock_timestamp() - interval '15 minutes'
        ) THEN 1
        ELSE 0
      END AS causal_wait,
      row_number() OVER (
        PARTITION BY m.company_id, m.direction
        ORDER BY m.created_at ASC, m.id ASC
      ) AS fairness_slot
    FROM public.whatsapp_messages m
    WHERE m.order_id IS NULL
      AND (_company_id IS NULL OR m.company_id = _company_id)
      AND (_message_id IS NULL OR m.id = _message_id)
      AND m.attempts < 5
      AND (
        (m.status = 'aguardando' AND (m.next_retry_at IS NULL OR m.next_retry_at <= clock_timestamp()))
        OR (m.status = 'erro' AND (m.next_retry_at IS NULL OR m.next_retry_at <= clock_timestamp()))
        OR (m.status = 'processando' AND m.locked_until IS NOT NULL AND m.locked_until < clock_timestamp())
      )
  ),
  locked_rows AS (
    SELECT m.id
      FROM public.whatsapp_messages m
      JOIN eligible e ON e.id = m.id
     WHERE m.order_id IS NULL
       AND m.attempts < 5
       AND (
         (m.status = 'aguardando' AND (m.next_retry_at IS NULL OR m.next_retry_at <= clock_timestamp()))
         OR (m.status = 'erro' AND (m.next_retry_at IS NULL OR m.next_retry_at <= clock_timestamp()))
         OR (m.status = 'processando' AND m.locked_until IS NOT NULL AND m.locked_until < clock_timestamp())
       )
     ORDER BY
       e.causal_wait ASC,
       e.fairness_slot ASC,
       CASE WHEN m.direction = 'inbound' THEN 0 ELSE 1 END ASC,
       m.created_at ASC,
       m.id ASC
     LIMIT effective_limit
     FOR UPDATE OF m SKIP LOCKED
  )
  UPDATE public.whatsapp_messages target
     SET status = 'processando',
         attempts = target.attempts + 1,
         locked_until = clock_timestamp() + make_interval(secs => greatest(coalesce(_lock_seconds, 60), 15)),
         locked_by = resolved_worker,
         lease_generation = coalesce(target.lease_generation, 0) + 1
    FROM locked_rows lr
   WHERE target.id = lr.id
  RETURNING target.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_whatsapp_queue_batch(integer, integer, uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_queue_batch(integer, integer, uuid, uuid, integer, text) TO service_role;

-- ============================================================================
-- 2. AUD3-02 (ALTO): UNIFICAÇÃO DE ADVISORY LOCK E TRATAMENTO DE UNIQUE_VIOLATION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_or_create_customer_by_phone(
  _company_id uuid,
  _phone text,
  _name text DEFAULT NULL
)
RETURNS TABLE(id uuid, name text, phone text, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  norm_key text := public.financial_phone_key(_phone);
  resolved_name text;
  found_rec record;
BEGIN
  IF _company_id IS NULL OR length(norm_key) < 8 OR length(norm_key) > 15 THEN
    RETURN;
  END IF;

  IF auth.uid() IS NOT NULL THEN
    IF _company_id IS DISTINCT FROM public.current_company_id() THEN
      RAISE EXCEPTION 'Acesso negado aos clientes de outra empresa'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- AUD3-02: Usa exatamente a mesma chave de advisory lock do trigger guard_customer_phone_uniqueness
  -- (':customer_phone:'), serializando tanto chamadas RPC quanto INSERTs diretos na tabela customers.
  PERFORM pg_advisory_xact_lock(hashtextextended(_company_id::text || ':customer_phone:' || norm_key, 0));

  SELECT c.id, c.name, c.phone
    INTO found_rec
    FROM public.customers c
   WHERE c.company_id = _company_id
     AND public.financial_phone_key(c.phone) = norm_key
   ORDER BY c.created_at ASC, c.id ASC
   LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT found_rec.id, found_rec.name, found_rec.phone, false;
    RETURN;
  END IF;

  resolved_name := coalesce(nullif(btrim(_name), ''), norm_key);

  -- AUD3-02: Recuperação controlada de corrida de unicidade (captura exclusivamente unique_violation 23505)
  BEGIN
    INSERT INTO public.customers(company_id, phone, name)
    VALUES (_company_id, norm_key, resolved_name)
    RETURNING customers.id, customers.name, customers.phone
    INTO found_rec;

    RETURN QUERY SELECT found_rec.id, found_rec.name, found_rec.phone, true;
    RETURN;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT c.id, c.name, c.phone
        INTO found_rec
        FROM public.customers c
       WHERE c.company_id = _company_id
         AND public.financial_phone_key(c.phone) = norm_key
       ORDER BY c.created_at ASC, c.id ASC
       LIMIT 1;

      IF FOUND THEN
        RETURN QUERY SELECT found_rec.id, found_rec.name, found_rec.phone, false;
        RETURN;
      END IF;
      RAISE;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.get_or_create_customer_by_phone(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_or_create_customer_by_phone(uuid, text, text) TO authenticated, service_role;

-- ============================================================================
-- 3. AUD3-03 (ALTO): PROTEÇÃO CONTRA DUPLICAÇÃO DE PEDIDOS NA REVISÃO DE ECOS OK/OKK
-- ============================================================================

-- 3.1. Endurece create_manual_or_reviewed_order para:
--      (a) rejeitar qualquer tentativa de criar novo pedido a partir de um eco comercial outbound (OK/OKK);
--      (b) retornar de forma idempotente o pedido já existente caso a mensagem revisada já possua order_id.
CREATE OR REPLACE FUNCTION public.create_manual_or_reviewed_order(
  _customer_id uuid,
  _qty_p integer,
  _qty_m integer,
  _qty_g integer,
  _order_date date,
  _financial_state text DEFAULT NULL,
  _source text DEFAULT 'manual',
  _event_id uuid DEFAULT gen_random_uuid(),
  _whatsapp_message_id uuid DEFAULT NULL,
  _condition text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid;
  cust public.customers%ROWTYPE;
  ord public.orders%ROWTYPE;
  msg public.whatsapp_messages%ROWTYPE;
  ph text;
  conv text;
  audit_id uuid;
  new_order_id uuid := gen_random_uuid();
  cmd text;
  ev_key text;
  resolved_state text;
  effective_event_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória';
  END IF;

  comp := public.financial_require_operator();
  resolved_state := coalesce(nullif(btrim(_financial_state), ''), nullif(btrim(_condition), ''));

  IF _customer_id IS NULL OR _order_date IS NULL THEN
    RAISE EXCEPTION 'Cliente e data são obrigatórios';
  END IF;

  IF coalesce(_qty_p, 0) < 0 OR coalesce(_qty_m, 0) < 0 OR coalesce(_qty_g, 0) < 0
     OR (coalesce(_qty_p, 0) + coalesce(_qty_m, 0) + coalesce(_qty_g, 0)) < 1 THEN
    RAISE EXCEPTION 'Informe pelo menos uma marmita';
  END IF;

  IF resolved_state NOT IN ('pago', 'fiado', 'aguardando_classificacao') THEN
    RAISE EXCEPTION 'Condição financeira inválida';
  END IF;

  IF _source NOT IN ('manual', 'mensagem') THEN
    RAISE EXCEPTION 'Origem inválida';
  END IF;

  IF _source = 'mensagem' AND resolved_state <> 'aguardando_classificacao' THEN
    RAISE EXCEPTION 'Pedido originado de mensagem deve iniciar como aguardando_classificacao';
  END IF;

  effective_event_id := coalesce(_whatsapp_message_id, _event_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(comp::text || ':manual_order:' || coalesce(effective_event_id::text, ''), 0));

  -- AUD3-03: Se _whatsapp_message_id foi informado, bloqueia a mensagem e verifica sua natureza e vínculo
  IF _whatsapp_message_id IS NOT NULL THEN
    SELECT * INTO msg
      FROM public.whatsapp_messages
     WHERE id = _whatsapp_message_id
       AND company_id = comp
       FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Mensagem para revisão não encontrada nesta empresa';
    END IF;

    -- Bloqueia criação de novo pedido a partir de eco comercial OK/OKK
    IF msg.direction = 'outbound' OR msg.source = 'whatsapp_echo' OR upper(btrim(msg.body)) IN ('OK', 'OKK') THEN
      RAISE EXCEPTION 'Mensagem de confirmação comercial (OK/OKK) não pode criar um novo pedido; reconcilie o pedido existente do cliente'
        USING ERRCODE = '22023';
    END IF;

    -- Se a mensagem já possui um pedido associado, retorna o pedido existente de forma idempotente (nunca duplica)
    IF msg.order_id IS NOT NULL THEN
      SELECT * INTO ord
        FROM public.orders
       WHERE id = msg.order_id
         AND company_id = comp;

      IF FOUND THEN
        IF msg.status <> 'registrado' THEN
          UPDATE public.whatsapp_messages
             SET status = 'registrado',
                 locked_until = NULL,
                 locked_by = NULL,
                 next_retry_at = NULL,
                 last_error = NULL
           WHERE id = msg.id;
        END IF;
        RETURN to_jsonb(ord);
      END IF;
    END IF;
  END IF;

  IF effective_event_id IS NOT NULL THEN
    SELECT * INTO ord FROM public.orders WHERE company_id = comp AND financial_creation_event = effective_event_id;
    IF FOUND THEN
      IF _whatsapp_message_id IS NOT NULL THEN
        UPDATE public.whatsapp_messages
           SET status = 'registrado',
               order_id = ord.id,
               customer_id = ord.customer_id,
               locked_until = NULL,
               locked_by = NULL,
               next_retry_at = NULL,
               last_error = NULL
         WHERE id = _whatsapp_message_id
           AND company_id = comp;
      END IF;
      RETURN to_jsonb(ord);
    END IF;
  END IF;

  SELECT * INTO cust FROM public.customers WHERE id = _customer_id AND company_id = comp FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente não encontrado';
  END IF;

  ph := public.financial_phone_key(cust.phone);
  conv := CASE WHEN _source = 'manual' THEN 'operator:' ELSE 'wa:' END || comp::text || ':' || cust.id::text;

  SET CONSTRAINTS zz_financial_require_audit_event DEFERRED;

  INSERT INTO public.orders(
    id, company_id, customer_id, qty_p, qty_m, qty_g, quantity, unit_price,
    order_date, paid, settled_by_payment, source, financial_state,
    financial_conversation_id, financial_phone, financial_creation_event
  )
  VALUES (
    new_order_id, comp, cust.id, coalesce(_qty_p, 0), coalesce(_qty_m, 0), coalesce(_qty_g, 0),
    coalesce(_qty_p, 0) + coalesce(_qty_m, 0) + coalesce(_qty_g, 0),
    0, _order_date, (resolved_state = 'pago'), false, _source, resolved_state,
    conv, nullif(ph, ''), effective_event_id
  )
  RETURNING * INTO ord;

  IF resolved_state IN ('pago', 'fiado') THEN
    cmd := CASE WHEN resolved_state = 'pago' THEN 'OK' ELSE 'OKK' END;
    ev_key := 'manual_create:' || ord.id::text;

    INSERT INTO public.financial_events(
      company_id, event_id, actor_id, order_id, customer_id, command, source,
      conversation_id, phone, received_at, previous_state, requested_state,
      final_state, total, outcome, reason
    )
    VALUES (
      comp, ev_key, auth.uid(), ord.id, cust.id, cmd, 'authenticated_operator',
      conv, ph, clock_timestamp(), NULL, resolved_state,
      resolved_state, ord.total, 'classified', 'CRIACAO_MANUAL_CLASSIFICADA'
    )
    RETURNING id INTO audit_id;

    UPDATE public.orders SET financial_last_audit_id = audit_id WHERE id = ord.id RETURNING * INTO ord;
  END IF;

  IF _whatsapp_message_id IS NOT NULL THEN
    UPDATE public.whatsapp_messages
       SET status = 'registrado',
           order_id = ord.id,
           customer_id = cust.id,
           qty_p = coalesce(_qty_p, 0),
           qty_m = coalesce(_qty_m, 0),
           qty_g = coalesce(_qty_g, 0),
           fiado = false,
           order_date = _order_date,
           locked_until = NULL,
           locked_by = NULL,
           next_retry_at = NULL,
           last_error = NULL
     WHERE id = _whatsapp_message_id
       AND company_id = comp;
  END IF;

  SET CONSTRAINTS zz_financial_require_audit_event IMMEDIATE;

  RETURN to_jsonb(ord);
END;
$$;

REVOKE ALL ON FUNCTION public.create_manual_or_reviewed_order(uuid, integer, integer, integer, date, text, text, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_manual_or_reviewed_order(uuid, integer, integer, integer, date, text, text, uuid, uuid, text) TO authenticated, service_role;

-- 3.2. RPC dedicada e idempotente para reconciliar manualmente um eco comercial OK/OKK em status 'revisar'
--      com um pedido existente do cliente, sem jamais criar um novo pedido.
CREATE OR REPLACE FUNCTION public.reconcile_reviewed_whatsapp_echo(
  _whatsapp_message_id uuid,
  _order_id uuid,
  _command text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid;
  msg public.whatsapp_messages%ROWTYPE;
  ord public.orders%ROWTYPE;
  resolved_cmd text;
  det_event_id uuid;
  classify_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória';
  END IF;

  comp := public.financial_require_operator();

  IF _whatsapp_message_id IS NULL OR _order_id IS NULL THEN
    RAISE EXCEPTION 'Mensagem e pedido existente são obrigatórios para reconciliação';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(comp::text || ':reconcile_echo:' || _whatsapp_message_id::text, 0));

  SELECT * INTO msg
    FROM public.whatsapp_messages
   WHERE id = _whatsapp_message_id
     AND company_id = comp
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mensagem não encontrada nesta empresa';
  END IF;

  SELECT * INTO ord
    FROM public.orders
   WHERE id = _order_id
     AND company_id = comp;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado nesta empresa';
  END IF;

  -- Idempotência: se a mensagem já foi reconciliada com este pedido antes, retorna sem duplicar
  IF msg.order_id IS NOT NULL AND msg.status = 'registrado' THEN
    IF msg.order_id <> _order_id THEN
      RAISE EXCEPTION 'Esta mensagem já foi reconciliada anteriormente com outro pedido';
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'duplicate',
      'reason', 'MENSAGEM_JA_RECONCILIADA',
      'order_id', ord.id,
      'state', ord.financial_state,
      'total', ord.total,
      'message_id', msg.id
    );
  END IF;

  resolved_cmd := coalesce(nullif(upper(btrim(_command)), ''), upper(btrim(msg.body)));
  IF resolved_cmd NOT IN ('OK', 'OKK') THEN
    IF resolved_cmd LIKE '%OKK%' THEN
      resolved_cmd := 'OKK';
    ELSIF resolved_cmd LIKE '%OK%' THEN
      resolved_cmd := 'OK';
    ELSE
      RAISE EXCEPTION 'Comando de reconciliação inválido: utilize OK ou OKK';
    END IF;
  END IF;

  -- Se o pedido já estiver classificado no mesmo estado correspondente ao comando, apenas vincula a mensagem de eco
  IF (resolved_cmd = 'OK' AND ord.financial_state = 'pago')
     OR (resolved_cmd = 'OKK' AND ord.financial_state = 'fiado') THEN
    UPDATE public.whatsapp_messages
       SET status = 'registrado',
           order_id = ord.id,
           customer_id = ord.customer_id,
           locked_until = NULL,
           locked_by = NULL,
           next_retry_at = NULL,
           last_error = NULL
     WHERE id = msg.id;

    RETURN jsonb_build_object(
      'outcome', 'duplicate',
      'reason', 'PEDIDO_JA_NO_ESTADO_DESEJADO',
      'order_id', ord.id,
      'state', ord.financial_state,
      'total', ord.total,
      'message_id', msg.id
    );
  END IF;

  det_event_id := md5(comp::text || ':echo_reconcile:' || msg.id::text)::uuid;

  classify_res := public.financial_classify_order(
    _order_id => ord.id,
    _event_id => det_event_id,
    _command => resolved_cmd,
    _received_at => clock_timestamp(),
    _validation_allowed => true,
    _validation_reason => 'CONFIRMACAO_VALIDADA'
  );

  IF (classify_res->>'outcome') IN ('classified', 'duplicate') THEN
    UPDATE public.whatsapp_messages
       SET status = 'registrado',
           order_id = ord.id,
           customer_id = ord.customer_id,
           locked_until = NULL,
           locked_by = NULL,
           next_retry_at = NULL,
           last_error = NULL
     WHERE id = msg.id;
  END IF;

  RETURN classify_res || jsonb_build_object('message_id', msg.id);
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_reviewed_whatsapp_echo(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_reviewed_whatsapp_echo(uuid, uuid, text) TO authenticated, service_role;

-- ============================================================================
-- 4. AUD3-04 (MÉDIO): PREPARAÇÃO DE REPROCESSAMENTO MANUAL PELO OPERADOR
-- ============================================================================

CREATE OR REPLACE FUNCTION public.prepare_manual_whatsapp_retry(
  _company_id uuid DEFAULT NULL,
  _message_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid;
  updated_count integer;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    comp := public.current_company_id();
    IF comp IS NULL OR (_company_id IS NOT NULL AND _company_id <> comp) THEN
      RAISE EXCEPTION 'Acesso negado às mensagens de outra empresa'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    comp := _company_id;
  END IF;

  IF comp IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.whatsapp_messages m
     SET next_retry_at = clock_timestamp(),
         attempts = CASE WHEN m.attempts >= 5 THEN 4 ELSE m.attempts END
   WHERE m.company_id = comp
     AND (_message_id IS NULL OR m.id = _message_id)
     AND m.order_id IS NULL
     AND m.status IN ('erro', 'aguardando')
     AND (m.locked_until IS NULL OR m.locked_until < clock_timestamp());

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_manual_whatsapp_retry(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prepare_manual_whatsapp_retry(uuid, uuid) TO authenticated, service_role;
