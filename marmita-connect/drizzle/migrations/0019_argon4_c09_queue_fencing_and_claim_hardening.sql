-- Migração 0019: Missão 01 — Correção Crítica de Claim, Lease e Fencing Token da Fila WhatsApp (C-09 / M-02)
-- 100% incremental, aditiva e não destrutiva (preserva intactas as migrations históricas 0000 a 0018).
-- Justificativa técnica da migration 0019:
--   1. Em 0016, public.renew_whatsapp_message_lock e public.release_whatsapp_message_lock aceitavam
--      (_lease_generation IS NULL OR lease_generation = _lease_generation), permitindo renovação ou
--      finalização sem comparação obrigatória do fencing token caso _lease_generation fosse omitido/NULL.
--   2. Em 0016, public.renew_whatsapp_message_lock não exigia que o lease ainda estivesse dentro da
--      janela de validade (locked_until >= clock_timestamp()).
--   3. Em 0016, public.release_whatsapp_message_lock não exigia status = 'processando' AND order_id IS NULL.
--   4. Em 0016, public.complete_whatsapp_message_order verificava (msg.locked_by IS NOT NULL AND msg.locked_by IS DISTINCT FROM _worker_id),
--      o que deixava de rejeitar um worker obsoleto caso locked_by tivesse sido limpo para NULL (ex.: por
--      prepare_manual_whatsapp_retry) antes do próximo claim.
--   5. Em 0016, public.prepare_manual_whatsapp_retry limpava locked_until = NULL e locked_by = NULL sem
--      incrementar lease_generation, não invalidando imediatamente a geração anterior no ato da preparação.

BEGIN;

-- ============================================================================
-- 1. HARDENING DE RENEW_WHATSAPP_MESSAGE_LOCK (HEARTBEAT COM FENCING OBRIGATÓRIO)
-- ============================================================================

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
  -- C-09 (4.2 & 4.3): Exige obrigatoriamente _message_id, _worker_id e _lease_generation >= 1
  IF _message_id IS NULL
     OR nullif(btrim(_worker_id), '') IS NULL
     OR _lease_generation IS NULL
     OR _lease_generation < 1 THEN
    RETURN false;
  END IF;

  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  UPDATE public.whatsapp_messages
     SET locked_until = clock_timestamp() + make_interval(secs => greatest(coalesce(_lock_seconds, 60), 15))
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

REVOKE ALL ON FUNCTION public.renew_whatsapp_message_lock(uuid, text, integer, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_whatsapp_message_lock(uuid, text, integer, bigint) TO service_role;

-- ============================================================================
-- 2. HARDENING DE RELEASE_WHATSAPP_MESSAGE_LOCK (FINALIZAÇÃO COM FENCING OBRIGATÓRIO)
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
  -- C-09 (4.2 & 4.4): Exige obrigatoriamente _message_id, _worker_id, _lease_generation >= 1 e estado válido
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
     AND lease_generation = _lease_generation;

  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  PERFORM set_config('app.whatsapp_rpc_context', 'off', true);

  RETURN (updated_rows > 0);
END;
$$;

REVOKE ALL ON FUNCTION public.release_whatsapp_message_lock(uuid, text, text, text, timestamptz, bigint, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_whatsapp_message_lock(uuid, text, text, text, timestamptz, bigint, uuid, jsonb) TO service_role;

-- ============================================================================
-- 3. HARDENING DE COMPLETE_WHATSAPP_MESSAGE_ORDER (VALIDAÇÃO ESTRITA DE POSSE E GERAÇÃO)
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

  -- FQ-18: Idempotência se a mensagem já foi concluída e vinculada a um pedido
  IF msg.order_id IS NOT NULL THEN
    PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
    RETURN msg.order_id;
  END IF;

  -- C-09 (4.2 & 4.4): Se a mensagem possui geração de lease ativa (ou se _worker_id/_lease_generation foram informados),
  -- exige correspondência exata de status = 'processando', locked_by = _worker_id e lease_generation = _lease_generation
  IF _worker_id IS NOT NULL OR _lease_generation IS NOT NULL OR coalesce(msg.lease_generation, 0) > 0 THEN
    IF nullif(btrim(_worker_id), '') IS NULL OR _lease_generation IS NULL OR _lease_generation < 1 THEN
      PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
      RAISE EXCEPTION 'LEASE_LOST: worker_id e lease_generation válidos são obrigatórios para finalizar mensagem da fila'
        USING ERRCODE = '55P03';
    END IF;

    IF msg.status IS DISTINCT FROM 'processando'
       OR msg.locked_by IS NULL
       OR msg.locked_by IS DISTINCT FROM _worker_id THEN
      PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
      RAISE EXCEPTION 'LEASE_LOST: mensagem % foi reclamada por outro worker ou perdeu o lease (locked_by=% status=%)',
        _message_id, coalesce(msg.locked_by, 'NULL'), coalesce(msg.status, 'NULL')
        USING ERRCODE = '55P03';
    END IF;

    IF msg.lease_generation IS DISTINCT FROM _lease_generation THEN
      PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
      RAISE EXCEPTION 'LEASE_LOST: geração de lease obsoleta para mensagem % (esperada %, atual %)',
        _message_id, _lease_generation, msg.lease_generation
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

REVOKE ALL ON FUNCTION public.complete_whatsapp_message_order(uuid, uuid, uuid, integer, integer, integer, date, jsonb, uuid, text, text, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_whatsapp_message_order(uuid, uuid, uuid, integer, integer, integer, date, jsonb, uuid, text, text, text, bigint) TO authenticated, service_role;

-- ============================================================================
-- 4. HARDENING DE PREPARE_MANUAL_WHATSAPP_RETRY (INCREMENTA LEASE_GENERATION AO REVOGAR LEASE)
-- ============================================================================

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
  effective_max CONSTANT integer := 3;
  effective_cooldown CONSTANT integer := 30;
  actor_explicit_perm boolean;
  msg record;
  updated_count integer := 0;
  next_retry_num integer;
BEGIN
  IF (SELECT auth.uid()) IS NOT NULL THEN
    comp := public.financial_require_operator();
    effective_actor := (SELECT auth.uid());
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

  PERFORM pg_advisory_xact_lock(
    hashtextextended(comp::text || ':manual_retry:' || coalesce(_message_id::text, 'batch'), 0)
  );

  IF _message_id IS NOT NULL THEN
    SELECT * INTO msg
      FROM public.whatsapp_messages m
     WHERE m.id = _message_id
       AND m.company_id = comp
       FOR UPDATE;

    IF NOT FOUND THEN
      PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
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
      PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
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
      PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
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
      PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
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
               locked_by = NULL,
               lease_generation = coalesce(lease_generation, 0) + 1
         WHERE id = msg.id;
      END IF;

      INSERT INTO public.whatsapp_manual_retry_audit(
        company_id, message_id, actor_id, manual_retry_number,
        previous_status, previous_attempts, outcome, reason
      ) VALUES (
        comp, msg.id, effective_actor, coalesce(msg.manual_retry_count, 0),
        msg.status, coalesce(msg.attempts, 0), 'blocked', 'LIMITE_RETRIES_MANUAIS_ATINGIDO'
      );
      PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
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
      PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
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

    -- C-09: Incrementa lease_generation ao limpar locked_until/locked_by para invalidar imediatamente
    -- qualquer geração anterior antes mesmo do próximo claim_whatsapp_queue_batch
    UPDATE public.whatsapp_messages
       SET status = CASE WHEN status IN ('revisar', 'processando') THEN 'aguardando' ELSE status END,
           manual_retry_count = next_retry_num,
           last_manual_retry_at = clock_timestamp(),
           last_manual_retry_by = effective_actor,
           next_retry_at = clock_timestamp(),
           locked_until = NULL,
           locked_by = NULL,
           lease_generation = coalesce(lease_generation, 0) + 1
     WHERE id = msg.id;

    INSERT INTO public.whatsapp_manual_retry_audit(
      company_id, message_id, actor_id, manual_retry_number,
      previous_status, previous_attempts, outcome, reason
    ) VALUES (
      comp, msg.id, effective_actor, next_retry_num,
      msg.status, coalesce(msg.attempts, 0), 'authorized', 'RETRY_MANUAL_INDIVIDUAL_AUTORIZADO'
    );

    PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
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

  -- Caso 2: Retry manual em lote
  UPDATE public.whatsapp_messages
     SET status = 'revisar',
         next_retry_at = NULL,
         locked_until = NULL,
         locked_by = NULL,
         lease_generation = coalesce(lease_generation, 0) + 1
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
           locked_by = NULL,
           lease_generation = coalesce(lease_generation, 0) + 1
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

  PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
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

COMMIT;
