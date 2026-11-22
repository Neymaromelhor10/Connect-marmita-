-- Migração 0016: Sétima Rodada de Correções e Hardening Pós-Sexta Auditoria Independente (Argon 4 — AUD6-02 a AUD6-09)
-- 100% incremental, aditiva e não destrutiva (preserva intactas as migrations históricas 0000 a 0015).
-- Escopo:
--   AUD6-02 (ALTO) & AUD6-05 (MÉDIO):
--     - Refatora public.prepare_manual_whatsapp_retry para persistir registros 'blocked' em
--       public.whatsapp_manual_retry_audit e a transição status = 'revisar' SEM disparar RAISE EXCEPTION
--       após o INSERT/UPDATE (evitando rollback transacional da auditoria e do status), retornando JSONB
--       estruturado ({ authorized, updated_count, outcome, reason, error_code, message, status }).
--     - Impõe limites fixos invioláveis no banco (effective_max = 3 retries manuais, effective_cooldown = 30s),
--       ignorando tentativas do cliente de elevar o teto ou reduzir o cooldown via PostgREST.
--     - Exige public.financial_require_operator() quando auth.uid() está presente e valida permissão
--       operacional do _actor_id quando chamado via service_role.
--   AUD6-06 (MÉDIO):
--     - Atualiza public.has_inflight_customer_order_message para considerar retries manuais
--       (m.attempts < 5 + least(coalesce(m.manual_retry_count, 0), 3)) e validar tenant.
--     - Atualiza public.claim_whatsapp_queue_batch para varrer e transicionar automaticamente para
--       status = 'revisar' qualquer mensagem órfã em status = 'processando' cujo lease tenha expirado
--       (locked_until < clock_timestamp()) após atingir o limite máximo de tentativas.
--   AUD6-07 (MÉDIO):
--     - Atualiza public.reconcile_reviewed_whatsapp_echo para validar o timestamp real do eco
--       (coalesce(msg.received_at, msg.created_at)), mesma data comercial em America/Sao_Paulo e
--       janela temporal de reconciliação (-1 min a +30 min em relação a ord.created_at).
--     - Revoga escrita direta ampla de authenticated em public.whatsapp_messages, concede apenas
--       UPDATE (status) + cria RPC public.ignore_whatsapp_message e trigger BEFORE UPDATE que bloqueia
--       com SQLSTATE 42501 qualquer tentativa de alterar campos de controle (attempts, manual_retry_count,
--       last_manual_retry_at, last_manual_retry_by, lease_generation, locked_by, locked_until, order_id, etc.)
--       ou realizar transições privilegiadas de status fora das RPCs SECURITY DEFINER.
--   AUD6-08 (BAIXO):
--     - Cria os índices parciais whatsapp_messages_fairness_partition_idx e whatsapp_messages_order_id_idx.
--   AUD6-09 (BAIXO):
--     - Protege public.whatsapp_manual_retry_audit com trigger de imutabilidade BEFORE UPDATE OR DELETE.

-- ============================================================================
-- 1. AUD6-09: IMUTABILIDADE DA TRILHA DE AUDITORIA WHATSAPP_MANUAL_RETRY_AUDIT
-- ============================================================================

CREATE OR REPLACE FUNCTION public.whatsapp_manual_retry_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Permite limpeza controlada exclusivamente de registros sintéticos de homologação
  -- quando a variável transacional local app.allow_audit_cleanup = 'on' for definida por role privilegiada
  IF TG_OP = 'DELETE'
     AND current_setting('app.allow_audit_cleanup', true) = 'on'
     AND current_user NOT IN ('authenticated', 'anon') THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Auditoria de reprocessamento manual (whatsapp_manual_retry_audit) é imutável e não pode ser alterada ou excluída'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_manual_retry_audit_immutable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS whatsapp_manual_retry_audit_immutable_trg ON public.whatsapp_manual_retry_audit;
CREATE TRIGGER whatsapp_manual_retry_audit_immutable_trg
  BEFORE UPDATE OR DELETE ON public.whatsapp_manual_retry_audit
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_manual_retry_audit_immutable();

-- ============================================================================
-- 2. AUD6-08: ÍNDICES DE DESEMPENHO PARA PARTIÇÃO DE FAIRNESS E FK ORDER_ID
-- ============================================================================

CREATE INDEX IF NOT EXISTS whatsapp_messages_fairness_partition_idx
  ON public.whatsapp_messages (company_id, direction, created_at ASC, id ASC)
  WHERE order_id IS NULL AND status IN ('aguardando', 'processando', 'erro');

CREATE INDEX IF NOT EXISTS whatsapp_messages_order_id_idx
  ON public.whatsapp_messages (order_id)
  WHERE order_id IS NOT NULL;

-- ============================================================================
-- 3. AUD6-07.C: PERMISSÕES MÍNIMAS POR COLUNA, RPC IGNORE E TRIGGER EM WHATSAPP_MESSAGES
-- ============================================================================

REVOKE INSERT, UPDATE, DELETE ON public.whatsapp_messages FROM anon, authenticated;
GRANT SELECT ON public.whatsapp_messages TO authenticated;
GRANT UPDATE (status) ON public.whatsapp_messages TO authenticated;
GRANT ALL ON public.whatsapp_messages TO service_role;

CREATE OR REPLACE FUNCTION public.guard_whatsapp_messages_protected_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  op_comp uuid;
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'Identificador da empresa (company_id) da mensagem não pode ser alterado'
      USING ERRCODE = '42501';
  END IF;

  -- Quando a atualização parte diretamente do cliente autenticado/anônimo (PostgREST)
  -- e não de uma RPC interna autorizada (app.whatsapp_rpc_context = 'on' com role privilegiada):
  IF current_user IN ('authenticated', 'anon')
     OR (auth.uid() IS NOT NULL AND current_setting('app.whatsapp_rpc_context', true) IS DISTINCT FROM 'on') THEN

    -- 1. Exige que o usuário autenticado seja operador autorizado da própria empresa
    op_comp := public.financial_require_operator();
    IF op_comp IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'Acesso negado para alterar mensagem de outra empresa'
        USING ERRCODE = '42501';
    END IF;

    -- 2. Bloqueia qualquer alteração em campos de controle operacional, concorrência ou vínculo financeiro
    IF (
      NEW.attempts,
      NEW.manual_retry_count,
      NEW.last_manual_retry_at,
      NEW.last_manual_retry_by,
      NEW.lease_generation,
      NEW.locked_by,
      NEW.locked_until,
      NEW.next_retry_at,
      NEW.last_error,
      NEW.order_id,
      NEW.customer_id,
      NEW.phone,
      NEW.direction,
      NEW.source,
      NEW.message_uid,
      NEW.body,
      NEW.parsed,
      NEW.qty_g,
      coalesce(NEW.qty_m, 0),
      NEW.qty_p,
      NEW.fiado,
      NEW.order_date
    ) IS DISTINCT FROM (
      OLD.attempts,
      OLD.manual_retry_count,
      OLD.last_manual_retry_at,
      OLD.last_manual_retry_by,
      OLD.lease_generation,
      OLD.locked_by,
      OLD.locked_until,
      OLD.next_retry_at,
      OLD.last_error,
      OLD.order_id,
      OLD.customer_id,
      OLD.phone,
      OLD.direction,
      OLD.source,
      OLD.message_uid,
      OLD.body,
      OLD.parsed,
      OLD.qty_g,
      coalesce(OLD.qty_m, 0),
      OLD.qty_p,
      OLD.fiado,
      OLD.order_date
    ) THEN
      RAISE EXCEPTION 'Alteração direta de campos de controle operacional ou financeiro em whatsapp_messages não é permitida'
        USING ERRCODE = '42501';
    END IF;

    -- 3. Na coluna status, o cliente autenticado só pode dispensar ('ignorado') mensagem ainda não vinculada a pedido
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NEW.status <> 'ignorado'
         OR OLD.order_id IS NOT NULL
         OR OLD.status = 'registrado' THEN
        RAISE EXCEPTION 'Transição direta para o status "%" não é permitida; utilize as RPCs oficiais do sistema', NEW.status
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_whatsapp_messages_protected_fields() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS whatsapp_messages_guard_client_update ON public.whatsapp_messages;
CREATE TRIGGER whatsapp_messages_guard_client_update
  BEFORE UPDATE ON public.whatsapp_messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_whatsapp_messages_protected_fields();

-- RPC dedicada para dispensar mensagem em revisão com limpeza segura de metadados de fila
CREATE OR REPLACE FUNCTION public.ignore_whatsapp_message(
  _message_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid;
  msg public.whatsapp_messages%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória'
      USING ERRCODE = '42501';
  END IF;

  comp := public.financial_require_operator();

  IF _message_id IS NULL THEN
    RAISE EXCEPTION 'Identificador da mensagem é obrigatório'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO msg
    FROM public.whatsapp_messages
   WHERE id = _message_id
     AND company_id = comp
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mensagem não encontrada nesta empresa'
      USING ERRCODE = 'P0002';
  END IF;

  IF msg.order_id IS NOT NULL OR msg.status = 'registrado' THEN
    RAISE EXCEPTION 'Mensagem já vinculada a pedido registrado não pode ser marcada como ignorada'
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  UPDATE public.whatsapp_messages
     SET status = 'ignorado',
         locked_until = NULL,
         locked_by = NULL,
         next_retry_at = NULL
   WHERE id = msg.id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.ignore_whatsapp_message(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ignore_whatsapp_message(uuid) TO authenticated, service_role;

-- ============================================================================
-- 4. AUD6-06: ATUALIZAÇÃO DE HAS_INFLIGHT_CUSTOMER_ORDER_MESSAGE E FUNÇÕES DE FILA
-- ============================================================================

CREATE OR REPLACE FUNCTION public.has_inflight_customer_order_message(
  _company_id uuid,
  _phone text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  norm_phone text := public.financial_phone_key(_phone);
BEGIN
  IF _company_id IS NULL OR norm_phone = '' THEN
    RETURN false;
  END IF;

  IF auth.uid() IS NOT NULL THEN
    IF _company_id IS DISTINCT FROM public.current_company_id() THEN
      RAISE EXCEPTION 'Acesso negado às mensagens de outra empresa'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.whatsapp_messages m
     WHERE m.company_id = _company_id
       AND m.direction = 'inbound'
       AND m.order_id IS NULL
       AND m.status IN ('aguardando', 'processando', 'erro')
       AND m.attempts < (5 + least(coalesce(m.manual_retry_count, 0), 3))
       AND public.financial_phone_key(m.phone) = norm_phone
       AND m.created_at >= clock_timestamp() - interval '15 minutes'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.has_inflight_customer_order_message(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_inflight_customer_order_message(uuid, text) TO authenticated, service_role;

-- Atualiza renew_whatsapp_message_lock, release_whatsapp_message_lock e complete_whatsapp_message_order
-- para sinalizar app.whatsapp_rpc_context = 'on' ao atualizar public.whatsapp_messages
CREATE OR REPLACE FUNCTION public.renew_whatsapp_message_lock(
  _message_id uuid,
  _worker_id text,
  _lock_seconds integer DEFAULT 60,
  _lease_generation bigint DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  updated_rows integer;
BEGIN
  IF _message_id IS NULL OR nullif(btrim(_worker_id), '') IS NULL THEN
    RETURN false;
  END IF;

  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  UPDATE public.whatsapp_messages
     SET locked_until = clock_timestamp() + make_interval(secs => greatest(coalesce(_lock_seconds, 60), 15))
   WHERE id = _message_id
     AND status = 'processando'
     AND order_id IS NULL
     AND locked_by = _worker_id
     AND (_lease_generation IS NULL OR lease_generation = _lease_generation);

  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RETURN (updated_rows > 0);
END;
$$;

REVOKE ALL ON FUNCTION public.renew_whatsapp_message_lock(uuid, text, integer, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_whatsapp_message_lock(uuid, text, integer, bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.release_whatsapp_message_lock(
  _message_id uuid,
  _worker_id text,
  _final_status text,
  _last_error text DEFAULT NULL,
  _next_retry_at timestamptz DEFAULT NULL,
  _lease_generation bigint DEFAULT NULL,
  _order_id uuid DEFAULT NULL,
  _parsed jsonb DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  updated_rows integer;
BEGIN
  IF _message_id IS NULL
     OR nullif(btrim(_worker_id), '') IS NULL
     OR _final_status NOT IN ('aguardando', 'registrado', 'revisar', 'ignorado', 'erro') THEN
    RETURN false;
  END IF;

  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  UPDATE public.whatsapp_messages
     SET status = _final_status,
         order_id = coalesce(_order_id, order_id),
         parsed = coalesce(_parsed, parsed),
         locked_until = NULL,
         locked_by = NULL,
         last_error = _last_error,
         next_retry_at = _next_retry_at
   WHERE id = _message_id
     AND locked_by = _worker_id
     AND (_lease_generation IS NULL OR lease_generation = _lease_generation);

  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RETURN (updated_rows > 0);
END;
$$;

REVOKE ALL ON FUNCTION public.release_whatsapp_message_lock(uuid, text, text, text, timestamptz, bigint, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_whatsapp_message_lock(uuid, text, text, text, timestamptz, bigint, uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_whatsapp_message_order(
  _message_id uuid,
  _company_id uuid,
  _customer_id uuid,
  _qty_p integer,
  _qty_m integer,
  _qty_g integer,
  _order_date date,
  _parsed jsonb,
  _creation_event uuid DEFAULT NULL,
  _phone_key text DEFAULT NULL,
  _source text DEFAULT 'mensagem',
  _worker_id text DEFAULT NULL,
  _lease_generation bigint DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  msg public.whatsapp_messages%ROWTYPE;
  cust public.customers%ROWTYPE;
  ord public.orders%ROWTYPE;
  ph text;
  conv text;
  det_event uuid := coalesce(_creation_event, md5(_company_id::text || ':wa_msg:' || _message_id::text)::uuid);
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF _company_id IS DISTINCT FROM public.financial_require_operator() THEN
      RAISE EXCEPTION 'Empresa inválida para o operador autenticado'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  SELECT * INTO msg FROM public.whatsapp_messages WHERE id = _message_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mensagem não encontrada';
  END IF;

  IF msg.order_id IS NOT NULL THEN
    RETURN msg.order_id;
  END IF;

  IF _worker_id IS NOT NULL AND msg.locked_by IS NOT NULL AND msg.locked_by IS DISTINCT FROM _worker_id THEN
    RAISE EXCEPTION 'LEASE_LOST: mensagem % foi reclamada por outro worker (%)', _message_id, msg.locked_by
      USING ERRCODE = '55P03';
  END IF;

  IF _lease_generation IS NOT NULL AND msg.lease_generation IS DISTINCT FROM _lease_generation THEN
    RAISE EXCEPTION 'LEASE_LOST: geração de lease obsoleta para mensagem % (esperada %, atual %)',
      _message_id, _lease_generation, msg.lease_generation
      USING ERRCODE = '55P03';
  END IF;

  SELECT * INTO cust FROM public.customers WHERE id = _customer_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente não encontrado';
  END IF;

  SELECT * INTO ord FROM public.orders WHERE company_id = _company_id AND financial_creation_event = det_event;
  IF NOT FOUND THEN
    ph := coalesce(nullif(btrim(_phone_key), ''), public.financial_phone_key(cust.phone));
    conv := 'wa:' || _company_id::text || ':' || cust.id::text;

    INSERT INTO public.orders(
      company_id, customer_id, qty_p, qty_m, qty_g, quantity, unit_price,
      order_date, paid, settled_by_payment, source, financial_state,
      financial_conversation_id, financial_phone, financial_creation_event
    )
    VALUES (
      _company_id, cust.id, coalesce(_qty_p, 0), coalesce(_qty_m, 0), coalesce(_qty_g, 0),
      coalesce(_qty_p, 0) + coalesce(_qty_m, 0) + coalesce(_qty_g, 0),
      0, _order_date, false, false, coalesce(nullif(btrim(_source), ''), 'mensagem'), 'aguardando_classificacao',
      conv, nullif(ph, ''), det_event
    )
    RETURNING * INTO ord;
  END IF;

  UPDATE public.whatsapp_messages
     SET customer_id = _customer_id,
         order_id = ord.id,
         status = 'registrado',
         qty_p = _qty_p,
         qty_m = _qty_m,
         qty_g = _qty_g,
         fiado = false,
         order_date = _order_date,
         parsed = _parsed,
         locked_until = NULL,
         locked_by = NULL,
         next_retry_at = NULL,
         last_error = NULL
   WHERE id = msg.id;

  RETURN ord.id;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_whatsapp_message_order(uuid, uuid, uuid, integer, integer, integer, date, jsonb, uuid, text, text, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_whatsapp_message_order(uuid, uuid, uuid, integer, integer, integer, date, jsonb, uuid, text, text, text, bigint) TO authenticated, service_role;

-- Atualiza create_manual_or_reviewed_order, lgpd_anonymize_customer_pii e lgpd_purge_expired_message_bodies
-- para definir app.whatsapp_rpc_context = 'on' antes de atualizar public.whatsapp_messages
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

  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  effective_event_id := coalesce(_whatsapp_message_id, _event_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(comp::text || ':manual_order:' || coalesce(effective_event_id::text, ''), 0));

  IF _whatsapp_message_id IS NOT NULL THEN
    SELECT * INTO msg
      FROM public.whatsapp_messages
     WHERE id = _whatsapp_message_id
       AND company_id = comp
       FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Mensagem para revisão não encontrada nesta empresa';
    END IF;

    IF msg.direction = 'outbound' OR msg.source = 'whatsapp_echo' OR upper(btrim(msg.body)) IN ('OK', 'OKK') THEN
      RAISE EXCEPTION 'Mensagem de confirmação comercial (OK/OKK) não pode criar um novo pedido; reconcilie o pedido existente do cliente'
        USING ERRCODE = '22023';
    END IF;

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

CREATE OR REPLACE FUNCTION public.lgpd_anonymize_customer_pii(
  _customer_id uuid,
  _scope text,
  _confirm_token text,
  _protocol text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid;
  cust public.customers%ROWTYPE;
  diag jsonb;
  seq_val bigint;
  synthetic_phone text;
  old_phone_key text;
  redacted_msgs int;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória';
  END IF;
  comp := public.financial_require_operator();

  IF _scope NOT IN ('dados_complementares', 'anonimizacao_completa') THEN
    RAISE EXCEPTION 'Escopo LGPD inválido: utilize dados_complementares ou anonimizacao_completa';
  END IF;

  IF coalesce(btrim(_confirm_token), '') <> ('LGPD_CONFIRM_' || _customer_id::text) THEN
    RAISE EXCEPTION 'Token de confirmação explícita inválido';
  END IF;

  IF length(btrim(coalesce(_protocol, ''))) < 3 THEN
    RAISE EXCEPTION 'Informe o protocolo ou justificativa da solicitação LGPD';
  END IF;

  SELECT * INTO cust FROM public.customers WHERE id = _customer_id AND company_id = comp FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente não encontrado';
  END IF;

  diag := public.lgpd_inspect_customer(_customer_id);

  IF _scope = 'anonimizacao_completa' AND (
    (diag->>'has_open_debt')::boolean OR (diag->>'has_pending_classification')::boolean
  ) THEN
    RAISE EXCEPTION 'Anonimização completa bloqueada: cliente possui débito em aberto ou pedido aguardando classificação. Utilize o escopo dados_complementares para remover endereço, notas e textos de mensagens.';
  END IF;

  old_phone_key := public.financial_phone_key(cust.phone);

  IF _scope = 'anonimizacao_completa' THEN
    seq_val := nextval('public.lgpd_anon_seq');
    synthetic_phone := '99900' || lpad(seq_val::text, 6, '0');
  END IF;

  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  UPDATE public.customers
     SET address = NULL,
         notes = NULL
   WHERE id = cust.id AND company_id = comp;

  UPDATE public.orders
     SET notes = NULL
   WHERE customer_id = cust.id AND company_id = comp AND notes IS NOT NULL;

  UPDATE public.payments
     SET notes = NULL
   WHERE customer_id = cust.id AND company_id = comp AND notes IS NOT NULL;

  UPDATE public.whatsapp_messages
     SET body = '[Conteúdo removido por solicitação LGPD]',
         profile_name = NULL,
         phone = CASE WHEN _scope = 'anonimizacao_completa' THEN synthetic_phone ELSE phone END,
         parsed = CASE
           WHEN parsed IS NOT NULL THEN jsonb_set(parsed - 'nome' - 'motivo', '{lgpd_redacted}', 'true'::jsonb)
           ELSE NULL
         END
   WHERE company_id = comp
     AND (
       customer_id = cust.id
       OR (old_phone_key <> '' AND public.financial_phone_key(phone) = old_phone_key)
     );
  GET DIAGNOSTICS redacted_msgs = ROW_COUNT;

  IF _scope = 'anonimizacao_completa' THEN
    UPDATE public.customers
       SET name = 'Titular Anonimizado #' || seq_val::text,
           phone = synthetic_phone
     WHERE id = cust.id AND company_id = comp;

    UPDATE public.orders
       SET financial_phone = NULL
     WHERE customer_id = cust.id AND company_id = comp AND financial_phone IS NOT NULL;

    PERFORM set_config('app.lgpd_redact_phone', 'on', true);
    UPDATE public.financial_events
       SET phone = NULL
     WHERE company_id = comp AND customer_id = cust.id AND phone IS NOT NULL;
    PERFORM set_config('app.lgpd_redact_phone', 'off', true);
  END IF;

  RETURN jsonb_build_object(
    'customer_id', cust.id,
    'scope_executed', _scope,
    'redacted_messages_count', redacted_msgs,
    'financial_records_preserved', true,
    'protocol', btrim(_protocol)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lgpd_anonymize_customer_pii(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lgpd_anonymize_customer_pii(uuid, text, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.lgpd_purge_expired_message_bodies(_retention_days integer DEFAULT 180)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid;
  purged_count integer;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    comp := public.financial_require_operator();
  END IF;

  IF coalesce(_retention_days, 180) < 30 THEN
    RAISE EXCEPTION 'Prazo mínimo de retenção operacional é de 30 dias';
  END IF;

  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  UPDATE public.whatsapp_messages m
     SET body = '[Texto expirado pela política de retenção LGPD]',
         profile_name = NULL,
         parsed = CASE
           WHEN m.parsed IS NOT NULL THEN jsonb_set(m.parsed - 'nome' - 'motivo', '{retention_purged}', 'true'::jsonb)
           ELSE NULL
         END
   WHERE (comp IS NULL OR m.company_id = comp)
     AND m.status IN ('registrado', 'ignorado')
     AND m.created_at < clock_timestamp() - make_interval(days => coalesce(_retention_days, 180))
     AND m.body NOT LIKE '[%LGPD]';

  GET DIAGNOSTICS purged_count = ROW_COUNT;
  RETURN purged_count;
END;
$$;

REVOKE ALL ON FUNCTION public.lgpd_purge_expired_message_bodies(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lgpd_purge_expired_message_bodies(integer) TO authenticated, service_role;

-- ============================================================================
-- 5. AUD6-02 & AUD6-05: PREPARE_MANUAL_WHATSAPP_RETRY (PERSISTENTE E COM LIMITES FIXOS)
-- ============================================================================

DROP FUNCTION IF EXISTS public.prepare_manual_whatsapp_retry(uuid, uuid);
DROP FUNCTION IF EXISTS public.prepare_manual_whatsapp_retry(uuid, uuid, uuid, integer, integer);

CREATE OR REPLACE FUNCTION public.prepare_manual_whatsapp_retry(
  _company_id uuid DEFAULT NULL,
  _message_id uuid DEFAULT NULL,
  _actor_id uuid DEFAULT NULL,
  _max_manual_retries integer DEFAULT 3,
  _cooldown_seconds integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid;
  effective_actor uuid;
  -- AUD6-05: Limites de negócio fixos e invioláveis no banco (cliente não pode ampliar > 3 nem reduzir < 30s)
  effective_max CONSTANT integer := 3;
  effective_cooldown CONSTANT integer := 30;
  actor_explicit_perm boolean;
  msg record;
  updated_count integer := 0;
  next_retry_num integer;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    -- AUD6-05: Exige permissão de operador financeiro/operacional da empresa
    comp := public.financial_require_operator();
    effective_actor := auth.uid();
    IF _company_id IS NOT NULL AND _company_id <> comp THEN
      RAISE EXCEPTION 'Acesso negado às mensagens de outra empresa'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    comp := _company_id;
    effective_actor := _actor_id;
    IF comp IS NULL THEN
      RAISE EXCEPTION 'Empresa obrigatória para reprocessamento manual'
        USING ERRCODE = '22023';
    END IF;
    IF effective_actor IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id = effective_actor AND p.company_id = comp
    ) THEN
      RAISE EXCEPTION 'Operador informado não pertence à empresa especificada'
        USING ERRCODE = '42501';
    END IF;

    SELECT fp.can_classify INTO actor_explicit_perm
      FROM public.financial_permissions fp
     WHERE fp.company_id = comp AND fp.user_id = effective_actor;

    IF actor_explicit_perm IS FALSE THEN
      RAISE EXCEPTION 'Permissão financeira/operacional necessária para solicitar reprocessamento manual'
        USING ERRCODE = '42501';
    END IF;

    IF actor_explicit_perm IS NULL
       AND NOT public.has_role(effective_actor, 'admin'::public.app_role)
       AND EXISTS (SELECT 1 FROM public.financial_permissions fp WHERE fp.company_id = comp) THEN
      RAISE EXCEPTION 'Permissão financeira/operacional necessária para solicitar reprocessamento manual'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  -- Serializa solicitações concorrentes de retry manual para a mesma empresa/mensagem
  PERFORM pg_advisory_xact_lock(
    hashtextextended(comp::text || ':manual_retry:' || coalesce(_message_id::text, 'batch'), 0)
  );

  -- Caso 1: Retry manual individual (_message_id especificado)
  -- AUD6-02: Grava auditoria persistente e atualiza status SEM disparar RAISE EXCEPTION após o INSERT/UPDATE,
  -- evitando que o PostgreSQL desfaça (rollback) o registro de bloqueio ou a transição para 'revisar'!
  IF _message_id IS NOT NULL THEN
    SELECT * INTO msg
      FROM public.whatsapp_messages m
     WHERE m.id = _message_id
       AND m.company_id = comp
       FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Mensagem não encontrada nesta empresa'
        USING ERRCODE = 'P0002';
    END IF;

    IF msg.order_id IS NOT NULL OR msg.status IN ('registrado', 'ignorado') THEN
      INSERT INTO public.whatsapp_manual_retry_audit(
        company_id, message_id, actor_id, manual_retry_number,
        previous_status, previous_attempts, outcome, reason
      ) VALUES (
        comp, msg.id, effective_actor, coalesce(msg.manual_retry_count, 0),
        msg.status, coalesce(msg.attempts, 0), 'blocked', 'MENSAGEM_JA_FINALIZADA'
      );

      RETURN jsonb_build_object(
        'authorized', false,
        'updated_count', 0,
        'outcome', 'blocked',
        'reason', 'MENSAGEM_JA_FINALIZADA',
        'error_code', '22023',
        'message', 'Esta mensagem já foi finalizada e não pode ser reprocessada.',
        'manual_retry_count', coalesce(msg.manual_retry_count, 0),
        'attempts', coalesce(msg.attempts, 0),
        'status', msg.status
      );
    END IF;

    IF msg.direction = 'outbound' OR msg.source = 'whatsapp_echo' OR upper(btrim(msg.body)) IN ('OK', 'OKK') THEN
      INSERT INTO public.whatsapp_manual_retry_audit(
        company_id, message_id, actor_id, manual_retry_number,
        previous_status, previous_attempts, outcome, reason
      ) VALUES (
        comp, msg.id, effective_actor, coalesce(msg.manual_retry_count, 0),
        msg.status, coalesce(msg.attempts, 0), 'blocked', 'ECO_COMERCIAL_REQUER_RECONCILIACAO'
      );

      RETURN jsonb_build_object(
        'authorized', false,
        'updated_count', 0,
        'outcome', 'blocked',
        'reason', 'ECO_COMERCIAL_REQUER_RECONCILIACAO',
        'error_code', '22023',
        'message', 'Ecos comerciais OK/OKK não usam reprocessamento IA; vincule ao pedido existente na revisão.',
        'manual_retry_count', coalesce(msg.manual_retry_count, 0),
        'attempts', coalesce(msg.attempts, 0),
        'status', msg.status
      );
    END IF;

    IF msg.status = 'processando' AND msg.locked_until IS NOT NULL AND msg.locked_until >= clock_timestamp() THEN
      INSERT INTO public.whatsapp_manual_retry_audit(
        company_id, message_id, actor_id, manual_retry_number,
        previous_status, previous_attempts, outcome, reason
      ) VALUES (
        comp, msg.id, effective_actor, coalesce(msg.manual_retry_count, 0),
        msg.status, coalesce(msg.attempts, 0), 'blocked', 'LEASE_ATIVO_EM_EXECUCAO'
      );

      RETURN jsonb_build_object(
        'authorized', false,
        'updated_count', 0,
        'outcome', 'blocked',
        'reason', 'LEASE_ATIVO_EM_EXECUCAO',
        'error_code', '55P03',
        'message', 'Mensagem já está em processamento ativo por outro worker.',
        'manual_retry_count', coalesce(msg.manual_retry_count, 0),
        'attempts', coalesce(msg.attempts, 0),
        'status', msg.status
      );
    END IF;

    IF coalesce(msg.manual_retry_count, 0) >= effective_max THEN
      IF msg.status IN ('erro', 'aguardando', 'processando') THEN
        UPDATE public.whatsapp_messages
           SET status = 'revisar',
               next_retry_at = NULL,
               locked_until = NULL,
               locked_by = NULL
         WHERE id = msg.id;
      END IF;

      INSERT INTO public.whatsapp_manual_retry_audit(
        company_id, message_id, actor_id, manual_retry_number,
        previous_status, previous_attempts, outcome, reason
      ) VALUES (
        comp, msg.id, effective_actor, coalesce(msg.manual_retry_count, 0),
        msg.status, coalesce(msg.attempts, 0), 'blocked', 'LIMITE_RETRIES_MANUAIS_ATINGIDO'
      );

      RETURN jsonb_build_object(
        'authorized', false,
        'updated_count', 0,
        'outcome', 'blocked',
        'reason', 'MANUAL_RETRY_LIMIT_REACHED',
        'error_code', 'MANUAL_RETRY_LIMIT_EXCEEDED',
        'message', format('Limite máximo de %s reprocessamentos manuais atingido para esta mensagem. Classifique manualmente na seção Revisar.', effective_max),
        'manual_retry_count', coalesce(msg.manual_retry_count, 0),
        'attempts', coalesce(msg.attempts, 0),
        'status', 'revisar'
      );
    END IF;

    IF msg.last_manual_retry_at IS NOT NULL
       AND msg.last_manual_retry_at > clock_timestamp() - make_interval(secs => effective_cooldown) THEN
      INSERT INTO public.whatsapp_manual_retry_audit(
        company_id, message_id, actor_id, manual_retry_number,
        previous_status, previous_attempts, outcome, reason
      ) VALUES (
        comp, msg.id, effective_actor, coalesce(msg.manual_retry_count, 0),
        msg.status, coalesce(msg.attempts, 0), 'blocked', 'COOLDOWN_MANUAL_ATIVO'
      );

      RETURN jsonb_build_object(
        'authorized', false,
        'updated_count', 0,
        'outcome', 'blocked',
        'reason', 'COOLDOWN_30S_ACTIVE',
        'error_code', 'MANUAL_RETRY_COOLDOWN_ACTIVE',
        'message', format('Aguarde pelo menos %s segundos entre reprocessamentos manuais da mesma mensagem.', effective_cooldown),
        'manual_retry_count', coalesce(msg.manual_retry_count, 0),
        'attempts', coalesce(msg.attempts, 0),
        'status', msg.status
      );
    END IF;

    next_retry_num := coalesce(msg.manual_retry_count, 0) + 1;

    -- Autoriza 1 tentativa adicional mantendo attempts intacto (ou alinhando attempts ao teto anterior se era < 5)
    UPDATE public.whatsapp_messages
       SET status = CASE WHEN status IN ('revisar', 'processando') THEN 'aguardando' ELSE status END,
           manual_retry_count = next_retry_num,
           last_manual_retry_at = clock_timestamp(),
           last_manual_retry_by = effective_actor,
           next_retry_at = clock_timestamp(),
           locked_until = NULL,
           locked_by = NULL
     WHERE id = msg.id;

    INSERT INTO public.whatsapp_manual_retry_audit(
      company_id, message_id, actor_id, manual_retry_number,
      previous_status, previous_attempts, outcome, reason
    ) VALUES (
      comp, msg.id, effective_actor, next_retry_num,
      msg.status, coalesce(msg.attempts, 0), 'authorized', 'RETRY_MANUAL_INDIVIDUAL_AUTORIZADO'
    );

    RETURN jsonb_build_object(
      'authorized', true,
      'updated_count', 1,
      'outcome', 'authorized',
      'reason', 'RETRY_MANUAL_INDIVIDUAL_AUTORIZADO',
      'error_code', NULL,
      'message', NULL,
      'manual_retry_count', next_retry_num,
      'attempts', coalesce(msg.attempts, 0),
      'status', CASE WHEN msg.status IN ('revisar', 'processando') THEN 'aguardando' ELSE msg.status END
    );
  END IF;

  -- Caso 2: Retry manual em lote (_message_id IS NULL)
  -- AUD6-06: Varre antes qualquer mensagem com lease expirado que já esgotou o limite máximo, movendo-a para 'revisar'
  UPDATE public.whatsapp_messages
     SET status = 'revisar',
         next_retry_at = NULL,
         locked_until = NULL,
         locked_by = NULL
   WHERE company_id = comp
     AND order_id IS NULL
     AND status IN ('erro', 'processando')
     AND (locked_until IS NULL OR locked_until < clock_timestamp())
     AND coalesce(manual_retry_count, 0) >= effective_max
     AND coalesce(attempts, 0) >= (5 + effective_max);

  FOR msg IN
    SELECT *
      FROM public.whatsapp_messages m
     WHERE m.company_id = comp
       AND m.order_id IS NULL
       AND m.direction = 'inbound'
       AND m.source <> 'whatsapp_echo'
       AND (
         m.status IN ('erro', 'aguardando')
         OR (m.status = 'processando' AND m.locked_until IS NOT NULL AND m.locked_until < clock_timestamp())
       )
       AND (m.locked_until IS NULL OR m.locked_until < clock_timestamp())
       AND coalesce(m.manual_retry_count, 0) < effective_max
       AND (
         m.last_manual_retry_at IS NULL
         OR m.last_manual_retry_at <= clock_timestamp() - make_interval(secs => effective_cooldown)
       )
     ORDER BY m.created_at ASC, m.id ASC
     LIMIT 25
     FOR UPDATE SKIP LOCKED
  LOOP
    next_retry_num := coalesce(msg.manual_retry_count, 0) + 1;

    UPDATE public.whatsapp_messages
       SET status = CASE WHEN status = 'processando' THEN 'aguardando' ELSE status END,
           manual_retry_count = next_retry_num,
           last_manual_retry_at = clock_timestamp(),
           last_manual_retry_by = effective_actor,
           next_retry_at = clock_timestamp(),
           locked_until = NULL,
           locked_by = NULL
     WHERE id = msg.id;

    INSERT INTO public.whatsapp_manual_retry_audit(
      company_id, message_id, actor_id, manual_retry_number,
      previous_status, previous_attempts, outcome, reason
    ) VALUES (
      comp, msg.id, effective_actor, next_retry_num,
      msg.status, coalesce(msg.attempts, 0), 'authorized', 'RETRY_MANUAL_LOTE_AUTORIZADO'
    );

    updated_count := updated_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'authorized', (updated_count > 0),
    'updated_count', updated_count,
    'outcome', CASE WHEN updated_count > 0 THEN 'authorized' ELSE 'noop' END,
    'reason', CASE WHEN updated_count > 0 THEN 'RETRY_MANUAL_LOTE_AUTORIZADO' ELSE 'NENHUMA_MENSAGEM_ELEGIVEL' END,
    'error_code', NULL,
    'message', NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_manual_whatsapp_retry(uuid, uuid, uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prepare_manual_whatsapp_retry(uuid, uuid, uuid, integer, integer) TO authenticated, service_role;

-- ============================================================================
-- 6. AUD6-06 & AUD6-08: CLAIM_WHATSAPP_QUEUE_BATCH COM RECUPERAÇÃO AUTOMÁTICA DE ÓRFÃS
-- ============================================================================

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
  slot_horizon integer := greatest(effective_limit * 2, 50);
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

  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  -- AUD6-06: Varredura preventiva de mensagens órfãs em status = 'processando' cujo lease expirou
  -- (locked_until < clock_timestamp()) e que já atingiram o teto de tentativas (ex.: crash do worker
  -- ou falha de rede pós-Gemini na 5ª tentativa automática ou na última tentativa manual).
  -- Move-as atomicamente para status = 'revisar' (dead-letter), garantindo que NENHUMA mensagem
  -- jamais fique permanentemente presa em 'processando'!
  UPDATE public.whatsapp_messages orphan
     SET status = 'revisar',
         locked_until = NULL,
         locked_by = NULL,
         next_retry_at = NULL,
         last_error = coalesce(
           orphan.last_error,
           'LEASE_EXPIRADO_APOS_LIMITE_DE_TENTATIVAS: encaminhada para revisão manual.'
         )
   WHERE orphan.order_id IS NULL
     AND (_company_id IS NULL OR orphan.company_id = _company_id)
     AND (_message_id IS NULL OR orphan.id = _message_id)
     AND orphan.status = 'processando'
     AND orphan.locked_until IS NOT NULL
     AND orphan.locked_until < clock_timestamp()
     AND orphan.attempts >= (5 + least(coalesce(orphan.manual_retry_count, 0), 3));

  RETURN QUERY
  WITH eligible AS MATERIALIZED (
    SELECT
      ranked.id,
      ranked.causal_wait,
      ranked.fairness_slot
    FROM (
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
               AND inb.attempts < (5 + least(coalesce(inb.manual_retry_count, 0), 3))
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
        AND m.attempts < (5 + least(coalesce(m.manual_retry_count, 0), 3))
        AND (
          (m.status = 'aguardando' AND (m.next_retry_at IS NULL OR m.next_retry_at <= clock_timestamp()))
          OR (m.status = 'erro' AND (m.next_retry_at IS NULL OR m.next_retry_at <= clock_timestamp()))
          OR (m.status = 'processando' AND m.locked_until IS NOT NULL AND m.locked_until < clock_timestamp())
        )
    ) ranked
    WHERE ranked.fairness_slot <= greatest(effective_limit * 2, 50)
  ),
  locked_rows AS (
    SELECT m.id
      FROM public.whatsapp_messages m
      JOIN eligible e ON e.id = m.id
     WHERE m.order_id IS NULL
       AND m.attempts < (5 + least(coalesce(m.manual_retry_count, 0), 3))
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
         next_retry_at = NULL,
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
-- 7. AUD6-07.A: RECONCILIAÇÃO TEMPORAL E TELEFÔNICA EM RECONCILE_REVIEWED_WHATSAPP_ECHO
-- ============================================================================

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
  cust public.customers%ROWTYPE;
  msg_phone_key text;
  cust_phone_key text;
  resolved_cmd text;
  v_echo_ts timestamptz;
  v_echo_date date;
  det_event_id uuid;
  classify_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória'
      USING ERRCODE = '42501';
  END IF;

  comp := public.financial_require_operator();

  IF _whatsapp_message_id IS NULL OR _order_id IS NULL THEN
    RAISE EXCEPTION 'Mensagem e pedido existente são obrigatórios para reconciliação'
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  PERFORM pg_advisory_xact_lock(hashtextextended(comp::text || ':reconcile_echo:' || _whatsapp_message_id::text, 0));

  SELECT * INTO msg
    FROM public.whatsapp_messages
   WHERE id = _whatsapp_message_id
     AND company_id = comp
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mensagem não encontrada nesta empresa'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO ord
    FROM public.orders
   WHERE id = _order_id
     AND company_id = comp;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado nesta empresa'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO cust
    FROM public.customers
   WHERE id = ord.customer_id
     AND company_id = comp;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente do pedido não encontrado nesta empresa'
      USING ERRCODE = 'P0002';
  END IF;

  -- AUD5-03 & AUD6-07: Validação estrita de cliente e telefone normalizado
  IF msg.customer_id IS NOT NULL AND msg.customer_id <> ord.customer_id THEN
    RAISE EXCEPTION 'Associação bloqueada: a mensagem pertence a outro cliente e não pode ser vinculada a este pedido'
      USING ERRCODE = '22023';
  END IF;

  msg_phone_key := public.financial_phone_key(msg.phone);
  cust_phone_key := public.financial_phone_key(cust.phone);

  IF length(coalesce(cust_phone_key, '')) < 8 OR length(coalesce(msg_phone_key, '')) < 8 THEN
    RAISE EXCEPTION 'Associação bloqueada: cliente ou mensagem sem telefone válido identificável'
      USING ERRCODE = '22023';
  END IF;

  IF cust_phone_key <> msg_phone_key THEN
    RAISE EXCEPTION 'Associação bloqueada: o telefone da mensagem (%) diverge do telefone do cliente do pedido (%)',
      msg_phone_key, cust_phone_key
      USING ERRCODE = '22023';
  END IF;

  -- Idempotência se a mensagem já foi reconciliada com este pedido antes
  IF msg.order_id IS NOT NULL AND msg.status = 'registrado' THEN
    IF msg.order_id <> _order_id THEN
      RAISE EXCEPTION 'Esta mensagem já foi reconciliada anteriormente com outro pedido'
        USING ERRCODE = '22023';
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
      RAISE EXCEPTION 'Comando de reconciliação inválido: utilize OK ou OKK'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- AUD6-07.A: Usa o timestamp real da mensagem (coalesce(msg.received_at, msg.created_at))
  -- e valida mesma data comercial (America/Sao_Paulo) e janela temporal em relação ao pedido (-1 min a +30 min)
  v_echo_ts := coalesce(msg.received_at, msg.created_at, clock_timestamp());
  v_echo_date := (v_echo_ts AT TIME ZONE 'America/Sao_Paulo')::date;

  IF v_echo_date <> ord.order_date THEN
    RETURN jsonb_build_object(
      'outcome', 'blocked',
      'reason', 'COMANDO_FORA_DA_DATA_DO_PEDIDO',
      'order_id', ord.id,
      'state', ord.financial_state,
      'total', ord.total,
      'message_id', msg.id
    );
  END IF;

  IF ord.created_at IS NOT NULL AND (
    v_echo_ts < ord.created_at - interval '1 minute'
    OR v_echo_ts > ord.created_at + interval '30 minutes'
  ) THEN
    RETURN jsonb_build_object(
      'outcome', 'blocked',
      'reason', 'OUTSIDE_RECONCILIATION_WINDOW',
      'order_id', ord.id,
      'state', ord.financial_state,
      'total', ord.total,
      'message_id', msg.id
    );
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
    _received_at => v_echo_ts,
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
