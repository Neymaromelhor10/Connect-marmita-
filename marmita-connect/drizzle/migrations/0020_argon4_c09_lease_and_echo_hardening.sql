-- Migração 0020: Missão 03 — Correção Controlada dos Achados AUD-M02-01 e AUD-M02-03 (Fechamento C-09 / M-02)
-- 100% incremental, aditiva e não destrutiva (preserva intactas as migrations históricas 0000 a 0019).
--
-- Justificativa técnica da migration 0020:
--   1. AUD-M02-01 (Release): Em 0019, public.release_whatsapp_message_lock validava status = 'processando',
--      order_id IS NULL, locked_by = _worker_id e lease_generation = _lease_generation, mas não exigia
--      no SQL que o lease ainda estivesse temporalmente válido (locked_until IS NOT NULL AND locked_until >= clock_timestamp()).
--   2. AUD-M02-01 (Complete): Em 0019, public.complete_whatsapp_message_order validava status, locked_by e
--      lease_generation dentro da transação com FOR UPDATE, mas não exigia que locked_until IS NOT NULL
--      AND locked_until >= clock_timestamp(), permitindo que um worker com lease expirado concluísse
--      caso nenhum outro worker tivesse executado claim_whatsapp_queue_batch nesse intervalo.
--   3. AUD-M02-03 (Fencing no fluxo financeiro de ecos OK/OKK): Atualiza public.financial_classify_by_echo
--      para aceitar (_message_id uuid DEFAULT NULL, _worker_id text DEFAULT NULL, _lease_generation bigint DEFAULT NULL)
--      e validar transacionalmente (com FOR UPDATE na linha de public.whatsapp_messages) que a mensagem de
--      eco pertence à empresa, está com status = 'processando', locked_by = _worker_id,
--      lease_generation = _lease_generation e locked_until >= clock_timestamp(), impedindo qualquer janela
--      TOCTOU ou bypass por worker zumbi, enquanto preserva 100% da idempotência de _event_id e dos fluxos
--      legítimos fora da fila (onde não há linha em whatsapp_messages com lease_generation > 0).

BEGIN;

-- ============================================================================
-- 1. AUD-M02-01: HARDENING TEMPORAL DE RELEASE_WHATSAPP_MESSAGE_LOCK
-- ============================================================================

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
  -- C-09 & AUD-M02-01: Exige obrigatoriamente _message_id, _worker_id, _lease_generation >= 1 e estado válido
  IF _message_id IS NULL
     OR nullif(btrim(_worker_id), '') IS NULL
     OR _lease_generation IS NULL
     OR _lease_generation < 1
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
     AND status = 'processando'
     AND order_id IS NULL
     AND locked_by = _worker_id
     AND lease_generation = _lease_generation
     AND locked_until IS NOT NULL
     AND locked_until >= clock_timestamp();

  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  PERFORM set_config('app.whatsapp_rpc_context', 'off', true);

  RETURN (updated_rows > 0);
END;
$$;

REVOKE ALL ON FUNCTION public.release_whatsapp_message_lock(uuid, text, text, text, timestamptz, bigint, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_whatsapp_message_lock(uuid, text, text, text, timestamptz, bigint, uuid, jsonb) TO service_role;

-- ============================================================================
-- 2. AUD-M02-01: HARDENING TEMPORAL DE COMPLETE_WHATSAPP_MESSAGE_ORDER
-- ============================================================================

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
  IF (SELECT auth.uid()) IS NOT NULL THEN
    IF _company_id IS DISTINCT FROM public.financial_require_operator() THEN
      RAISE EXCEPTION 'Empresa inválida para o operador autenticado'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  SELECT * INTO msg FROM public.whatsapp_messages WHERE id = _message_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
    RAISE EXCEPTION 'Mensagem não encontrada';
  END IF;

  -- Idempotência se a mensagem já foi concluída e vinculada a um pedido
  IF msg.order_id IS NOT NULL THEN
    PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
    RETURN msg.order_id;
  END IF;

  -- C-09 & AUD-M02-01: Se a mensagem possui geração de lease ativa (ou se _worker_id/_lease_generation foram informados),
  -- exige correspondência cumulativa de:
  --   1) _worker_id não vazio e _lease_generation >= 1
  --   2) msg.status = 'processando'
  --   3) msg.locked_by = _worker_id
  --   4) msg.lease_generation = _lease_generation
  --   5) msg.locked_until IS NOT NULL AND msg.locked_until >= clock_timestamp() (autoridade temporal do PostgreSQL)
  IF _worker_id IS NOT NULL OR _lease_generation IS NOT NULL OR coalesce(msg.lease_generation, 0) > 0 THEN
    IF nullif(btrim(_worker_id), '') IS NULL OR _lease_generation IS NULL OR _lease_generation < 1 THEN
      PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
      RAISE EXCEPTION 'MESSAGE_LEASE_LOST: worker_id e lease_generation válidos são obrigatórios para finalizar mensagem da fila'
        USING ERRCODE = '55P03';
    END IF;

    IF msg.status IS DISTINCT FROM 'processando'
       OR msg.locked_by IS NULL
       OR msg.locked_by IS DISTINCT FROM _worker_id THEN
      PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
      RAISE EXCEPTION 'MESSAGE_LEASE_LOST: mensagem % foi reclamada por outro worker ou perdeu o lease (locked_by=% status=%)',
        _message_id, coalesce(msg.locked_by, 'NULL'), coalesce(msg.status, 'NULL')
        USING ERRCODE = '55P03';
    END IF;

    IF msg.lease_generation IS DISTINCT FROM _lease_generation THEN
      PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
      RAISE EXCEPTION 'MESSAGE_LEASE_LOST: geração de lease obsoleta para mensagem % (esperada %, atual %)',
        _message_id, _lease_generation, msg.lease_generation
        USING ERRCODE = '55P03';
    END IF;

    IF msg.locked_until IS NULL OR msg.locked_until < clock_timestamp() THEN
      PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
      RAISE EXCEPTION 'MESSAGE_LEASE_LOST: lease expirado ou nulo para mensagem % (locked_until=%, now=%)',
        _message_id, coalesce(msg.locked_until::text, 'NULL'), clock_timestamp()::text
        USING ERRCODE = '55P03';
    END IF;
  END IF;

  SELECT * INTO cust FROM public.customers WHERE id = _customer_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
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

  PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
  RETURN ord.id;
END;
$$;

-- Nota de segurança documentada (AUD-M02-04): complete_whatsapp_message_order revoga PUBLIC e anon
-- e concede EXECUTE a authenticated e service_role porque valida internamente auth.uid() e
-- public.financial_require_operator() (linhas 119-124) quando invocada por sessão autenticada.
REVOKE ALL ON FUNCTION public.complete_whatsapp_message_order(uuid, uuid, uuid, integer, integer, integer, date, jsonb, uuid, text, text, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_whatsapp_message_order(uuid, uuid, uuid, integer, integer, integer, date, jsonb, uuid, text, text, text, bigint) TO authenticated, service_role;

-- ============================================================================
-- 3. AUD-M02-03: HARDENING TRANSACIONAL DE FINANCIAL_CLASSIFY_BY_ECHO COM FENCING
-- ============================================================================

DROP FUNCTION IF EXISTS public.financial_classify_by_echo(uuid, uuid, uuid, text, text, timestamptz, boolean, text);

CREATE OR REPLACE FUNCTION public.financial_classify_by_echo(
  _company_id uuid,
  _customer_id uuid,
  _order_id uuid,
  _event_id text,
  _command text,
  _received_at timestamptz,
  _validation_allowed boolean,
  _validation_reason text,
  _message_id uuid DEFAULT NULL,
  _worker_id text DEFAULT NULL,
  _lease_generation bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ord public.orders%ROWTYPE;
  cust public.customers%ROWTYPE;
  ev public.financial_events%ROWTYPE;
  echo_msg public.whatsapp_messages%ROWTYPE;
  has_echo_msg boolean := false;
  today date := (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
  reason text;
  outcome text;
  desired text;
  audit uuid;
  conv text;
  ph text;
  eligible_count integer;
  prev_state text;
BEGIN
  IF _company_id IS NULL OR _customer_id IS NULL OR _event_id IS NULL OR _received_at IS NULL OR _command IS NULL THEN
    RAISE EXCEPTION 'Contexto financeiro inválido';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_company_id::text || ':echo:' || _event_id, 0));

  -- AUD-M02-03: Localiza e bloqueia (FOR UPDATE) a mensagem de origem em whatsapp_messages
  -- quando _message_id é fornecido ou quando existe registro correspondente a (_company_id, _event_id).
  IF _message_id IS NOT NULL THEN
    SELECT * INTO echo_msg
      FROM public.whatsapp_messages
     WHERE id = _message_id
       AND company_id = _company_id
       FOR UPDATE;
    has_echo_msg := FOUND;
    IF NOT has_echo_msg THEN
      RAISE EXCEPTION 'MESSAGE_LEASE_LOST: mensagem de eco % não encontrada para a empresa %', _message_id, _company_id
        USING ERRCODE = '55P03';
    END IF;
  ELSE
    SELECT * INTO echo_msg
      FROM public.whatsapp_messages
     WHERE company_id = _company_id
       AND message_uid = _event_id
       FOR UPDATE;
    has_echo_msg := FOUND;
  END IF;

  -- AUD-M02-03: Validação obrigatória de posse, geração e validade temporal do lease ANTES de qualquer
  -- efeito ou retorno quando a operação vem de um worker da fila (_worker_id/_lease_generation/_message_id)
  -- ou quando a mensagem em whatsapp_messages possui lease_generation > 0 (impedindo bypass por omissão de parâmetros).
  IF _message_id IS NOT NULL
     OR _worker_id IS NOT NULL
     OR _lease_generation IS NOT NULL
     OR (has_echo_msg AND coalesce(echo_msg.lease_generation, 0) > 0) THEN

    IF NOT has_echo_msg THEN
      RAISE EXCEPTION 'MESSAGE_LEASE_LOST: mensagem de origem do eco comercial não encontrada para validação de lease'
        USING ERRCODE = '55P03';
    END IF;

    IF nullif(btrim(_worker_id), '') IS NULL
       OR _lease_generation IS NULL
       OR _lease_generation < 1 THEN
      RAISE EXCEPTION 'MESSAGE_LEASE_LOST: worker_id e lease_generation >= 1 são obrigatórios para classificar eco comercial da fila (msg=%)',
        echo_msg.id
        USING ERRCODE = '55P03';
    END IF;

    IF echo_msg.status IS DISTINCT FROM 'processando'
       OR echo_msg.locked_by IS NULL
       OR echo_msg.locked_by IS DISTINCT FROM _worker_id THEN
      RAISE EXCEPTION 'MESSAGE_LEASE_LOST: eco comercial % perdeu a posse do lease (locked_by=%, esperado=%, status=%)',
        echo_msg.id, coalesce(echo_msg.locked_by, 'NULL'), _worker_id, coalesce(echo_msg.status, 'NULL')
        USING ERRCODE = '55P03';
    END IF;

    IF echo_msg.lease_generation IS DISTINCT FROM _lease_generation THEN
      RAISE EXCEPTION 'MESSAGE_LEASE_LOST: geração de lease obsoleta para eco comercial % (esperada %, atual %)',
        echo_msg.id, _lease_generation, echo_msg.lease_generation
        USING ERRCODE = '55P03';
    END IF;

    IF echo_msg.locked_until IS NULL OR echo_msg.locked_until < clock_timestamp() THEN
      RAISE EXCEPTION 'MESSAGE_LEASE_LOST: lease expirado para eco comercial % (locked_until=%, now=%)',
        echo_msg.id, coalesce(echo_msg.locked_until::text, 'NULL'), clock_timestamp()::text
        USING ERRCODE = '55P03';
    END IF;
  END IF;

  SELECT * INTO ev FROM public.financial_events WHERE company_id = _company_id AND event_id = _event_id;
  IF FOUND THEN
    IF ev.command IS DISTINCT FROM _command OR (ev.order_id IS NOT NULL AND _order_id IS NOT NULL AND ev.order_id <> _order_id) THEN
      RETURN jsonb_build_object(
        'outcome', 'conflict',
        'reason', 'EVENTO_CONFLITANTE',
        'order_id', _order_id,
        'state', NULL,
        'total', NULL,
        'audit_id', ev.id
      );
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'duplicate',
      'reason', ev.reason,
      'order_id', ev.order_id,
      'state', ev.final_state,
      'total', ev.total,
      'audit_id', ev.id
    );
  END IF;

  -- Ordem global padronizada: customers FOR UPDATE -> orders FOR UPDATE
  SELECT * INTO cust FROM public.customers WHERE id = _customer_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente não encontrado';
  END IF;

  ph := public.financial_phone_key(cust.phone);
  conv := 'wa:' || _company_id::text || ':' || cust.id::text;
  desired := CASE _command WHEN 'OK' THEN 'pago' WHEN 'OKK' THEN 'fiado' ELSE 'NENHUM' END;

  SELECT count(*)::int INTO eligible_count
  FROM public.orders
  WHERE company_id = _company_id
    AND customer_id = cust.id
    AND order_date = today
    AND delivery_status <> 'cancelado'
    AND financial_state = 'aguardando_classificacao';

  -- ARGON4-03: se o atendente enviou OK/OKK enquanto a mensagem do cliente ainda está sendo processada
  -- pelo Gemini, sinaliza retry_pending_order sem gravar bloqueio definitivo em financial_events!
  IF eligible_count = 0 AND public.has_inflight_customer_order_message(_company_id, cust.phone) THEN
    RETURN jsonb_build_object(
      'outcome', 'retry_pending_order',
      'reason', 'PEDIDO_EM_PROCESSAMENTO_IA',
      'order_id', NULL,
      'state', NULL,
      'total', NULL,
      'audit_id', NULL
    );
  END IF;

  IF _order_id IS NOT NULL THEN
    SELECT * INTO ord FROM public.orders WHERE id = _order_id AND company_id = _company_id AND customer_id = cust.id FOR UPDATE;
  END IF;

  prev_state := ord.financial_state;

  reason := CASE
    WHEN _command NOT IN ('OK', 'OKK') THEN 'COMANDO_NAO_RECONHECIDO'
    WHEN (_received_at AT TIME ZONE 'America/Sao_Paulo')::date <> today
      OR _received_at > clock_timestamp() + interval '5 minutes' THEN 'COMANDO_FORA_DO_DIA_ATUAL'
    WHEN eligible_count > 1 THEN 'MULTIPLOS_PEDIDOS_ELEGIVEIS'
    WHEN eligible_count = 0 OR ord.id IS NULL THEN coalesce(_validation_reason, 'SEM_PEDIDO_ELEGIVEL')
    WHEN ord.financial_state IS DISTINCT FROM 'aguardando_classificacao' THEN 'PEDIDO_JA_CLASSIFICADO'
    WHEN ord.order_date <> today THEN 'PEDIDO_FORA_DO_PERIODO_PERMITIDO'
    WHEN ord.delivery_status = 'cancelado' THEN 'PEDIDO_CANCELADO'
    WHEN ord.settled_by_payment THEN 'PAGAMENTO_PARCIAL_OU_NAO_RASTREAVEL'
    WHEN ord.total <= 0 OR NOT (ord.total < 'Infinity'::numeric) THEN 'VALOR_INVALIDO'
    WHEN _validation_allowed IS DISTINCT FROM true THEN coalesce(_validation_reason, 'VALIDACAO_NAO_APROVADA')
    ELSE 'CONFIRMACAO_VALIDADA'
  END;

  outcome := CASE WHEN reason = 'CONFIRMACAO_VALIDADA' THEN 'classified' ELSE 'blocked' END;

  INSERT INTO public.financial_events(
    company_id, event_id, actor_id, order_id, customer_id, command, source,
    conversation_id, phone, received_at, previous_state, requested_state,
    final_state, total, outcome, reason
  )
  VALUES (
    _company_id, _event_id, NULL, ord.id, cust.id, _command, 'verified_business_echo',
    conv, ph, _received_at, prev_state, desired,
    CASE WHEN outcome = 'classified' THEN desired ELSE prev_state END,
    ord.total, outcome, reason
  )
  RETURNING id INTO audit;

  IF outcome = 'classified' THEN
    SET CONSTRAINTS zz_financial_require_audit_event DEFERRED;

    UPDATE public.orders
       SET financial_state = desired,
           paid = (_command = 'OK'),
           settled_by_payment = false,
           financial_phone = ph,
           financial_conversation_id = conv,
           financial_last_audit_id = audit
     WHERE id = ord.id;

    SET CONSTRAINTS zz_financial_require_audit_event IMMEDIATE;
  END IF;

  RETURN jsonb_build_object(
    'outcome', outcome,
    'reason', reason,
    'order_id', ord.id,
    'state', CASE WHEN outcome = 'classified' THEN desired ELSE prev_state END,
    'total', ord.total,
    'audit_id', audit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.financial_classify_by_echo(uuid, uuid, uuid, text, text, timestamptz, boolean, text, uuid, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.financial_classify_by_echo(uuid, uuid, uuid, text, text, timestamptz, boolean, text, uuid, text, bigint) TO service_role;

COMMIT;
