-- Migração 0015: Quinta Rodada de Correções e Hardening (Argon 4 — AUD5-01 a AUD5-05)
-- 100% incremental, aditiva e não destrutiva (preserva intactas as migrations históricas 0000 a 0014).
-- Escopo:
--   AUD5-02 (MÉDIO): Implementa controle persistente de retries manuais (manual_retry_count,
--                    last_manual_retry_at, last_manual_retry_by), tabela de auditoria
--                    public.whatsapp_manual_retry_audit, limite máximo configurável (padrão: 3 retries
--                    manuais adicionais além das 5 tentativas automáticas, sem jamais regredir attempts
--                    de 5 para 4) e cooldown mínimo de 30s entre tentativas manuais.
--   AUD5-03 (MÉDIO): Endurece public.reconcile_reviewed_whatsapp_echo exigindo correspondência estrita
--                    de empresa, customer_id e telefone normalizado (public.financial_phone_key) entre
--                    a mensagem revisada e o cliente do pedido, bloqueando cliente/mensagem sem telefone
--                    válido ou com telefone divergente.
--   AUD5-05 (BAIXO): Otimiza public.claim_whatsapp_queue_batch limpando next_retry_at = NULL no momento
--                    do claim (enquanto status = 'processando' e locked_until futuro garantem exclusão
--                    mútua), respeitando o teto (5 + manual_retry_count) e podando fairness_slot na CTE
--                    eligible para evitar ordenação excessiva sob backlogs extremos (> 10.000 mensagens).

-- ============================================================================
-- 1. AUD5-02: COLUNAS PERSISTENTES E AUDITORIA DE RETRIES MANUAIS NA FILA
-- ============================================================================

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS manual_retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_manual_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_manual_retry_by uuid REFERENCES auth.users(id);

CREATE TABLE IF NOT EXISTS public.whatsapp_manual_retry_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  message_id uuid REFERENCES public.whatsapp_messages(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users(id),
  manual_retry_number integer NOT NULL DEFAULT 0,
  previous_status text,
  previous_attempts integer,
  outcome text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS whatsapp_manual_retry_audit_company_msg_idx
  ON public.whatsapp_manual_retry_audit (company_id, message_id, created_at DESC);

REVOKE ALL ON public.whatsapp_manual_retry_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.whatsapp_manual_retry_audit TO authenticated;
GRANT ALL ON public.whatsapp_manual_retry_audit TO service_role;

ALTER TABLE public.whatsapp_manual_retry_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_manual_retry_audit_company_read ON public.whatsapp_manual_retry_audit;
CREATE POLICY whatsapp_manual_retry_audit_company_read
  ON public.whatsapp_manual_retry_audit
  FOR SELECT
  TO authenticated
  USING (company_id = public.current_company_id());

-- Substitui prepare_manual_whatsapp_retry eliminando a regressão infinita attempts 5 -> 4
DROP FUNCTION IF EXISTS public.prepare_manual_whatsapp_retry(uuid, uuid);
DROP FUNCTION IF EXISTS public.prepare_manual_whatsapp_retry(uuid, uuid, uuid, integer, integer);

CREATE OR REPLACE FUNCTION public.prepare_manual_whatsapp_retry(
  _company_id uuid DEFAULT NULL,
  _message_id uuid DEFAULT NULL,
  _actor_id uuid DEFAULT NULL,
  _max_manual_retries integer DEFAULT 3,
  _cooldown_seconds integer DEFAULT 30
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid;
  effective_actor uuid;
  effective_max integer := least(greatest(coalesce(_max_manual_retries, 3), 1), 10);
  effective_cooldown integer := least(greatest(coalesce(_cooldown_seconds, 30), 5), 3600);
  msg record;
  updated_count integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    comp := public.current_company_id();
    effective_actor := auth.uid();
    IF comp IS NULL OR (_company_id IS NOT NULL AND _company_id <> comp) THEN
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
    IF effective_actor IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id = effective_actor AND p.company_id = comp
    ) THEN
      RAISE EXCEPTION 'Operador informado não pertence à empresa especificada'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Serializa solicitações concorrentes de retry manual para a mesma empresa/mensagem
  PERFORM pg_advisory_xact_lock(
    hashtextextended(comp::text || ':manual_retry:' || coalesce(_message_id::text, 'batch'), 0)
  );

  -- Caso 1: Retry manual individual (_message_id especificado) -> validação estrita com erro explícito
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
      RAISE EXCEPTION 'Esta mensagem já foi finalizada e não pode ser reprocessada'
        USING ERRCODE = '22023';
    END IF;

    IF msg.direction = 'outbound' OR msg.source = 'whatsapp_echo' OR upper(btrim(msg.body)) IN ('OK', 'OKK') THEN
      INSERT INTO public.whatsapp_manual_retry_audit(
        company_id, message_id, actor_id, manual_retry_number,
        previous_status, previous_attempts, outcome, reason
      ) VALUES (
        comp, msg.id, effective_actor, coalesce(msg.manual_retry_count, 0),
        msg.status, coalesce(msg.attempts, 0), 'blocked', 'ECO_COMERCIAL_REQUER_RECONCILIACAO'
      );
      RAISE EXCEPTION 'Ecos comerciais OK/OKK não usam reprocessamento IA; vincule ao pedido existente na revisão'
        USING ERRCODE = '22023';
    END IF;

    IF msg.status = 'processando' AND msg.locked_until IS NOT NULL AND msg.locked_until >= clock_timestamp() THEN
      INSERT INTO public.whatsapp_manual_retry_audit(
        company_id, message_id, actor_id, manual_retry_number,
        previous_status, previous_attempts, outcome, reason
      ) VALUES (
        comp, msg.id, effective_actor, coalesce(msg.manual_retry_count, 0),
        msg.status, coalesce(msg.attempts, 0), 'blocked', 'LEASE_ATIVO_EM_EXECUCAO'
      );
      RAISE EXCEPTION 'Mensagem já está em processamento ativo por outro worker'
        USING ERRCODE = '55P03';
    END IF;

    IF coalesce(msg.manual_retry_count, 0) >= effective_max THEN
      IF msg.status = 'erro' THEN
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

      RAISE EXCEPTION 'Limite máximo de % reprocessamentos manuais atingido para esta mensagem. Classifique manualmente na seção Revisar.', effective_max
        USING ERRCODE = 'P0001';
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

      RAISE EXCEPTION 'Aguarde pelo menos % segundos entre reprocessamentos manuais da mesma mensagem.', effective_cooldown
        USING ERRCODE = 'P0001';
    END IF;

    -- Autoriza 1 tentativa adicional mantendo attempts intacto (nunca regride attempts!)
    UPDATE public.whatsapp_messages
       SET status = CASE WHEN status = 'revisar' THEN 'aguardando' ELSE status END,
           manual_retry_count = coalesce(manual_retry_count, 0) + 1,
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
      comp, msg.id, effective_actor, coalesce(msg.manual_retry_count, 0) + 1,
      msg.status, coalesce(msg.attempts, 0), 'authorized', 'RETRY_MANUAL_INDIVIDUAL_AUTORIZADO'
    );

    RETURN 1;
  END IF;

  -- Caso 2: Retry manual em lote (_message_id IS NULL) -> processa apenas mensagens elegíveis que respeitem limite e cooldown
  FOR msg IN
    SELECT *
      FROM public.whatsapp_messages m
     WHERE m.company_id = comp
       AND m.order_id IS NULL
       AND m.direction = 'inbound'
       AND m.source <> 'whatsapp_echo'
       AND m.status IN ('erro', 'aguardando')
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
    UPDATE public.whatsapp_messages
       SET manual_retry_count = coalesce(manual_retry_count, 0) + 1,
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
      comp, msg.id, effective_actor, coalesce(msg.manual_retry_count, 0) + 1,
      msg.status, coalesce(msg.attempts, 0), 'authorized', 'RETRY_MANUAL_LOTE_AUTORIZADO'
    );

    updated_count := updated_count + 1;
  END LOOP;

  RETURN updated_count;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_manual_whatsapp_retry(uuid, uuid, uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prepare_manual_whatsapp_retry(uuid, uuid, uuid, integer, integer) TO authenticated, service_role;

-- ============================================================================
-- 2. AUD5-05 & AUD5-02: OTIMIZAÇÃO DE CLAIM_WHATSAPP_QUEUE_BATCH
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
-- 3. AUD5-03: VALIDAÇÃO DE CLIENTE E TELEFONE EM RECONCILE_REVIEWED_WHATSAPP_ECHO
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

  -- AUD5-03 (Regra 2): Se msg.customer_id estiver preenchido, deve corresponder a ord.customer_id
  IF msg.customer_id IS NOT NULL AND msg.customer_id <> ord.customer_id THEN
    RAISE EXCEPTION 'Associação bloqueada: a mensagem pertence a outro cliente e não pode ser vinculada a este pedido'
      USING ERRCODE = '22023';
  END IF;

  -- AUD5-03 (Regras 3, 4 e 5): Normaliza telefones com public.financial_phone_key e exige correspondência exata
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

  -- AUD5-03 (Regra 6): Idempotência se a mensagem já foi reconciliada com este pedido antes
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
