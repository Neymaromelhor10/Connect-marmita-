-- Migração 0022: Missão 07.2 — Correção Cirúrgica das Pendências da Auditoria 07.1 e Regressões REG-M07-01 / REG-M07-02
-- 100% incremental, aditiva e não destrutiva (preserva intactas as migrations históricas 0000 a 0021).
--
-- Escopo desta migration:
--   1. AF-01 (AUD-07.1-01 & AUD-07.1-02 — Lease, reentrega e recuperação de mensagens órfãs/nulas):
--      - Saneia registros existentes em public.whatsapp_messages onde status = 'processando' e locked_until IS NULL;
--      - Adiciona constraint whatsapp_messages_processing_requires_lease_chk exigindo locked_until IS NOT NULL
--        sempre que status = 'processando';
--      - Atualiza public.claim_whatsapp_queue_batch para recuperar mensagens em processando com locked_until nulo ou expirado
--        e incrementar lease_generation na transição de órfãs para 'revisar';
--      - Atualiza public.requeue_errored_whatsapp_webhook_message para:
--          (a) nunca transicionar mensagem em 'erro' para 'aguardando' antes de next_retry_at (BACKOFF_NOT_ELAPSED);
--          (b) recuperar mensagens em 'processando' com locked_until IS NULL em vez de bloqueá-las como lease ativo;
--          (c) incrementar lease_generation = coalesce(lease_generation, 0) + 1 sempre que invalidar/limpar um lease anterior.
--   2. AF-05 (AUD-07.1-04 — Rate limit distribuído e persistente no PostgreSQL):
--      - Cria tabela public.whatsapp_webhook_rate_limits (restrita a service_role com RLS ativo) e RPC atômica
--        public.check_whatsapp_webhook_rate_limit(_bucket_key, _max_requests, _window_seconds, _now) compartilhada
--        entre todas as instâncias serverless.
--   3. AF-07 (REG-M07-01 — Restauração cirúrgica dos grants por coluna das migrations 0016 a 0018):
--      - Restaura exclusivamente os grants por coluna em public.whatsapp_messages (UPDATE (status)),
--        public.companies (UPDATE de colunas de preço/cadastro) e public.customers (INSERT/UPDATE de colunas
--        cadastrais, nunca status) para authenticated, mantendo todas as políticas RLS e os triggers SECURITY INVOKER
--        (guard_whatsapp_messages_protected_fields, guard_company_admin_update, guard_customers_protected_fields)
--        e preservando REVOKE total de escrita em orders, payments, financial_events, payment_attempts,
--        whatsapp_manual_retry_audit e lgpd_lifecycle_audit.
--   4. AF-08 (AUD-07.1-06 — Caminho privilegiado explícito e seguro para service_role em financial_register_payment):
--      - Permite que chamadas legítimas de service_role (sem JWT de cliente) resolvam a empresa a partir do vínculo
--        verificado do cliente (SELECT company_id FROM public.customers WHERE id = _customer_id FOR UPDATE),
--        impedindo que anon ou authenticated utilizem esse caminho e preservando idempotência, advisory lock e FIFO.
--   5. AF-10 (REG-M07-02 & AUD-07.1-08 — Trigger de imutabilidade LGPD compatível com ON DELETE SET NULL em customer_id
--      e controle persistente de periodicidade de expurgo):
--      - Atualiza public.lgpd_lifecycle_audit_immutable() para permitir exclusivamente a ação referencial
--        ON DELETE SET NULL de customer_id quando o cliente referenciado já foi removido de public.customers;
--      - Cria tabela public.operational_scheduler_state para persistir no banco o controle de periodicidade
--        do expurgo LGPD entre cold starts e atualiza public.lgpd_purge_expired_operational_data para registrar
--        auditoria apenas quando houver trabalho efetivo de expurgo, evitando registros vazios repetitivos.

BEGIN;

-- ============================================================================
-- 1. AF-01 (AUD-07.1-01 & AUD-07.1-02): SANEAMENTO, CONSTRAINT E RECUPERAÇÃO DE LEASE
-- ============================================================================

DO $$
BEGIN
  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  -- Saneia de forma segura eventuais linhas legadas/órfãs em status = 'processando' com locked_until IS NULL
  UPDATE public.whatsapp_messages
     SET status = CASE
           WHEN order_id IS NOT NULL THEN 'registrado'
           WHEN coalesce(attempts, 0) >= (5 + least(coalesce(manual_retry_count, 0), 3)) THEN 'revisar'
           ELSE 'aguardando'
         END,
         locked_by = NULL,
         locked_until = NULL,
         next_retry_at = CASE
           WHEN order_id IS NOT NULL OR coalesce(attempts, 0) >= (5 + least(coalesce(manual_retry_count, 0), 3)) THEN NULL
           ELSE coalesce(next_retry_at, clock_timestamp())
         END,
         lease_generation = coalesce(lease_generation, 0) + 1
   WHERE status = 'processando'
     AND locked_until IS NULL;

  PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
END $$;

ALTER TABLE public.whatsapp_messages
  DROP CONSTRAINT IF EXISTS whatsapp_messages_processing_requires_lease_chk;

ALTER TABLE public.whatsapp_messages
  ADD CONSTRAINT whatsapp_messages_processing_requires_lease_chk
  CHECK (status <> 'processando' OR locked_until IS NOT NULL);

-- Atualiza claim_whatsapp_queue_batch para incrementar lease_generation no sweep de órfãs
-- e recuperar qualquer mensagem com lease expirado
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
  resolved_worker text := nullif(btrim(coalesce(_worker_id, '')), '');
  caller_comp uuid;
BEGIN
  IF resolved_worker IS NULL THEN
    RAISE EXCEPTION 'Identificador do worker (_worker_id) é obrigatório para claim da fila WhatsApp'
      USING ERRCODE = '22023';
  END IF;

  IF (SELECT auth.uid()) IS NOT NULL THEN
    caller_comp := public.current_company_id();
    IF caller_comp IS NULL OR (_company_id IS NOT NULL AND _company_id <> caller_comp) THEN
      RAISE EXCEPTION 'Acesso negado à fila de outra empresa'
        USING ERRCODE = '42501';
    END IF;
    _company_id := caller_comp;
  END IF;

  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  -- AUD6-06 & AUD-07.1-02: Varredura preventiva de mensagens órfãs em status = 'processando'
  -- cujo lease expirou (ou esteja nulo) após atingir o limite máximo de tentativas,
  -- incrementando lease_generation para invalidar qualquer worker antigo.
  UPDATE public.whatsapp_messages orphan
     SET status = 'revisar',
         locked_until = NULL,
         locked_by = NULL,
         next_retry_at = NULL,
         lease_generation = coalesce(orphan.lease_generation, 0) + 1,
         last_error = coalesce(
           orphan.last_error,
           'LEASE_EXPIRADO_APOS_LIMITE_DE_TENTATIVAS: encaminhada para revisão manual.'
         )
   WHERE orphan.order_id IS NULL
     AND (_company_id IS NULL OR orphan.company_id = _company_id)
     AND (_message_id IS NULL OR orphan.id = _message_id)
     AND orphan.status = 'processando'
     AND (orphan.locked_until IS NULL OR orphan.locked_until < clock_timestamp())
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
          OR (m.status = 'processando' AND (m.locked_until IS NULL OR m.locked_until < clock_timestamp()))
        )
    ) ranked
    WHERE ranked.fairness_slot <= slot_horizon
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
         OR (m.status = 'processando' AND (m.locked_until IS NULL OR m.locked_until < clock_timestamp()))
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

  PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_whatsapp_queue_batch(integer, integer, uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_queue_batch(integer, integer, uuid, uuid, integer, text) TO service_role;

-- Atualiza requeue_errored_whatsapp_webhook_message (AUD-07.1-01 & AUD-07.1-02):
-- 1. Só protege lease como ativo quando locked_until IS NOT NULL AND locked_until >= v_effective_now;
-- 2. Se locked_until IS NULL em status = 'processando', recupera a linha com segurança;
-- 3. Não muda status de 'erro' para 'aguardando' antes de next_retry_at (retorna BACKOFF_NOT_ELAPSED);
-- 4. Incrementa lease_generation = coalesce(lease_generation, 0) + 1 sempre que limpar/invalidar um lease anterior.
CREATE OR REPLACE FUNCTION public.requeue_errored_whatsapp_webhook_message(
  _company_id uuid,
  _message_uid text,
  _now timestamptz DEFAULT clock_timestamp()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_effective_now timestamptz := coalesce(_now, clock_timestamp());
  v_msg public.whatsapp_messages%ROWTYPE;
  v_max_attempts integer;
  v_new_gen bigint;
BEGIN
  IF _company_id IS NULL OR nullif(btrim(coalesce(_message_uid, '')), '') IS NULL THEN
    RETURN jsonb_build_object(
      'requeued', false,
      'reason', 'INVALID_ARGUMENTS',
      'id', NULL,
      'status', NULL
    );
  END IF;

  SELECT * INTO v_msg
    FROM public.whatsapp_messages
   WHERE company_id = _company_id
     AND message_uid = btrim(_message_uid)
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'requeued', false,
      'reason', 'NOT_FOUND',
      'id', NULL,
      'status', NULL
    );
  END IF;

  -- 1. Mensagens já associadas a pedido ou em estado terminal nunca voltam para a fila
  IF v_msg.order_id IS NOT NULL OR v_msg.status IN ('registrado', 'revisar', 'ignorado') THEN
    RETURN jsonb_build_object(
      'requeued', false,
      'reason', 'ALREADY_FINALIZED',
      'id', v_msg.id,
      'status', v_msg.status,
      'order_id', v_msg.order_id,
      'lease_generation', v_msg.lease_generation
    );
  END IF;

  -- 2. Proteção estrita de lease ativo: somente quando locked_until for não nulo e >= v_effective_now
  IF v_msg.locked_until IS NOT NULL AND v_msg.locked_until >= v_effective_now THEN
    RETURN jsonb_build_object(
      'requeued', false,
      'reason', 'ACTIVE_LEASE_PROTECTED',
      'id', v_msg.id,
      'status', v_msg.status,
      'locked_by', v_msg.locked_by,
      'locked_until', v_msg.locked_until,
      'lease_generation', v_msg.lease_generation
    );
  END IF;

  -- 3. Se já está aguardando sem lease ativo, mantém na fila sem alterar geração nem estado
  IF v_msg.status = 'aguardando' THEN
    IF v_msg.next_retry_at IS NOT NULL AND v_msg.next_retry_at > v_effective_now THEN
      RETURN jsonb_build_object(
        'requeued', false,
        'reason', 'BACKOFF_NOT_ELAPSED',
        'id', v_msg.id,
        'status', v_msg.status,
        'next_retry_at', v_msg.next_retry_at,
        'lease_generation', v_msg.lease_generation
      );
    END IF;
    RETURN jsonb_build_object(
      'requeued', false,
      'reason', 'ALREADY_QUEUED',
      'id', v_msg.id,
      'status', v_msg.status,
      'lease_generation', v_msg.lease_generation
    );
  END IF;

  -- 4. AUD-07.1-01: Se está em 'erro' mas o horário de retry (next_retry_at) ainda não chegou,
  --    NÃO antecipa nem altera o status para 'aguardando' antes da janela permitida!
  IF v_msg.status = 'erro' AND v_msg.next_retry_at IS NOT NULL AND v_msg.next_retry_at > v_effective_now THEN
    RETURN jsonb_build_object(
      'requeued', false,
      'reason', 'BACKOFF_NOT_ELAPSED',
      'id', v_msg.id,
      'status', v_msg.status,
      'next_retry_at', v_msg.next_retry_at,
      'lease_generation', v_msg.lease_generation
    );
  END IF;

  -- 5. Respeita o teto máximo de tentativas (5 automáticas + até 3 manuais)
  v_max_attempts := 5 + least(coalesce(v_msg.manual_retry_count, 0), 3);
  IF coalesce(v_msg.attempts, 0) >= v_max_attempts THEN
    IF v_msg.status = 'processando' THEN
      PERFORM set_config('app.whatsapp_rpc_context', 'on', true);
      UPDATE public.whatsapp_messages
         SET status = 'revisar',
             locked_by = NULL,
             locked_until = NULL,
             next_retry_at = NULL,
             lease_generation = coalesce(lease_generation, 0) + 1
       WHERE id = v_msg.id
         AND company_id = _company_id
         AND order_id IS NULL
      RETURNING lease_generation INTO v_new_gen;
      PERFORM set_config('app.whatsapp_rpc_context', 'off', true);
      RETURN jsonb_build_object(
        'requeued', false,
        'reason', 'MAX_ATTEMPTS_REACHED',
        'id', v_msg.id,
        'status', 'revisar',
        'lease_generation', coalesce(v_new_gen, v_msg.lease_generation)
      );
    END IF;

    RETURN jsonb_build_object(
      'requeued', false,
      'reason', 'MAX_ATTEMPTS_REACHED',
      'id', v_msg.id,
      'status', v_msg.status,
      'lease_generation', v_msg.lease_generation
    );
  END IF;

  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  -- 6. AUD-07.1-01 & AUD-07.1-02: Transiciona para 'aguardando' e incrementa lease_generation
  --    sempre que limpar/invalidar um lease anterior (status = 'processando' ou locked_by/locked_until presentes).
  UPDATE public.whatsapp_messages
     SET status = 'aguardando',
         locked_by = NULL,
         locked_until = NULL,
         next_retry_at = v_effective_now,
         lease_generation = CASE
           WHEN v_msg.status = 'processando'
                OR v_msg.locked_by IS NOT NULL
                OR v_msg.locked_until IS NOT NULL
           THEN coalesce(v_msg.lease_generation, 0) + 1
           ELSE coalesce(v_msg.lease_generation, 0)
         END
   WHERE id = v_msg.id
     AND company_id = _company_id
     AND order_id IS NULL
     AND status IN ('erro', 'processando')
     AND (locked_until IS NULL OR locked_until < v_effective_now)
  RETURNING lease_generation INTO v_new_gen;

  PERFORM set_config('app.whatsapp_rpc_context', 'off', true);

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'requeued', false,
      'reason', 'CONCURRENT_STATE_CHANGE',
      'id', v_msg.id,
      'status', v_msg.status,
      'lease_generation', v_msg.lease_generation
    );
  END IF;

  RETURN jsonb_build_object(
    'requeued', true,
    'reason', 'REQUEUED_SAFELY',
    'id', v_msg.id,
    'status', 'aguardando',
    'lease_generation', v_new_gen
  );
END;
$$;

REVOKE ALL ON FUNCTION public.requeue_errored_whatsapp_webhook_message(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.requeue_errored_whatsapp_webhook_message(uuid, text, timestamptz) TO service_role;

-- ============================================================================
-- 2. AF-05 (AUD-07.1-04): RATE LIMIT DISTRIBUÍDO E PERSISTENTE NO POSTGRESQL
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.whatsapp_webhook_rate_limits (
  bucket_key text NOT NULL,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 1 CHECK (request_count >= 1),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (bucket_key, window_start)
);

CREATE INDEX IF NOT EXISTS whatsapp_webhook_rate_limits_window_idx
  ON public.whatsapp_webhook_rate_limits (window_start);

REVOKE ALL ON public.whatsapp_webhook_rate_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.whatsapp_webhook_rate_limits TO service_role;
ALTER TABLE public.whatsapp_webhook_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.check_whatsapp_webhook_rate_limit(
  _bucket_key text,
  _max_requests integer DEFAULT 120,
  _window_seconds integer DEFAULT 60,
  _now timestamptz DEFAULT clock_timestamp()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text := left(coalesce(nullif(btrim(_bucket_key), ''), 'global'), 128);
  v_max integer := greatest(1, coalesce(_max_requests, 120));
  v_win_sec integer := greatest(1, coalesce(_window_seconds, 60));
  v_now timestamptz := coalesce(_now, clock_timestamp());
  v_window_start timestamptz;
  v_count integer;
  v_elapsed_sec numeric;
  v_retry_after integer;
BEGIN
  v_window_start := to_timestamp(floor(extract(epoch FROM v_now) / v_win_sec) * v_win_sec);

  -- Limpeza oportunística de janelas expiradas (> 15 minutos) para manter a tabela enxuta
  IF random() < 0.05 THEN
    DELETE FROM public.whatsapp_webhook_rate_limits
     WHERE window_start < v_now - interval '15 minutes';
  END IF;

  INSERT INTO public.whatsapp_webhook_rate_limits(
    bucket_key,
    window_start,
    request_count,
    updated_at
  )
  VALUES (
    v_key,
    v_window_start,
    1,
    v_now
  )
  ON CONFLICT (bucket_key, window_start)
  DO UPDATE SET
    request_count = public.whatsapp_webhook_rate_limits.request_count + 1,
    updated_at = v_now
  RETURNING request_count INTO v_count;

  v_elapsed_sec := greatest(0, extract(epoch FROM (v_now - v_window_start)));
  v_retry_after := greatest(1, ceil(v_win_sec - v_elapsed_sec)::int);

  RETURN jsonb_build_object(
    'allowed', (v_count <= v_max),
    'count', v_count,
    'remaining', greatest(0, v_max - v_count),
    'retry_after_seconds', CASE WHEN v_count <= v_max THEN 0 ELSE v_retry_after END,
    'window_start', v_window_start
  );
END;
$$;

REVOKE ALL ON FUNCTION public.check_whatsapp_webhook_rate_limit(text, integer, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_whatsapp_webhook_rate_limit(text, integer, integer, timestamptz) TO service_role;

-- ============================================================================
-- 3. AF-07 (REG-M07-01): RESTAURAÇÃO CIRÚRGICA DOS GRANTS POR COLUNA (0016 A 0018)
-- ============================================================================

-- 3.1. public.whatsapp_messages: permite exclusivamente SELECT e UPDATE (status) para authenticated
--      (protegido por RLS e pelo trigger SECURITY INVOKER guard_whatsapp_messages_protected_fields)
REVOKE INSERT, UPDATE, DELETE ON public.whatsapp_messages FROM anon, authenticated;
GRANT SELECT ON public.whatsapp_messages TO authenticated;
GRANT UPDATE (status) ON public.whatsapp_messages TO authenticated;
GRANT ALL ON public.whatsapp_messages TO service_role;

-- 3.2. public.companies: permite exclusivamente SELECT e UPDATE das colunas de configuração/preços para authenticated
--      (protegido por RLS e pelo trigger SECURITY INVOKER guard_company_admin_update, que exige is_company_admin)
REVOKE INSERT, UPDATE, DELETE ON public.companies FROM anon, authenticated;
GRANT SELECT ON public.companies TO authenticated;
GRANT UPDATE (name, phone, default_unit_price, price_p, price_m, price_g) ON public.companies TO authenticated;
GRANT ALL ON public.companies TO service_role;

-- 3.3. public.customers: permite exclusivamente SELECT, INSERT cadastral e UPDATE cadastral (sem status/created_at)
--      (protegido por RLS e pelo trigger SECURITY INVOKER guard_customers_protected_fields, que exige financial_require_operator)
REVOKE INSERT, UPDATE, DELETE ON public.customers FROM anon, authenticated;
GRANT SELECT ON public.customers TO authenticated;
GRANT INSERT (id, company_id, name, phone, address, notes, payment_cycle) ON public.customers TO authenticated;
GRANT UPDATE (name, phone, address, notes, payment_cycle) ON public.customers TO authenticated;
GRANT ALL ON public.customers TO service_role;

-- 3.4. Confirma que tabelas financeiras e de auditoria permanecem 100% sem escrita direta para anon e authenticated
REVOKE INSERT, UPDATE, DELETE ON public.orders FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.payments FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.financial_events FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.payment_attempts FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.whatsapp_manual_retry_audit FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.lgpd_lifecycle_audit FROM anon, authenticated;

-- Reforça guard_company_admin_update para impedir que sessões de cliente alterem whatsapp_connected ou created_at
CREATE OR REPLACE FUNCTION public.guard_company_admin_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_jwt_role text := public.request_jwt_role();
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Identificador da empresa não pode ser alterado'
      USING ERRCODE = '42501';
  END IF;

  IF current_user IN ('authenticated', 'anon')
     OR session_user IN ('authenticated', 'anon')
     OR v_jwt_role IN ('authenticated', 'anon')
     OR (SELECT auth.uid()) IS NOT NULL THEN

    IF current_user = 'anon'
       OR session_user = 'anon'
       OR v_jwt_role = 'anon'
       OR (SELECT auth.uid()) IS NULL
       OR NOT public.is_company_admin(OLD.id) THEN
      RAISE EXCEPTION 'Permissão administrativa necessária para alterar configurações ou preços da empresa'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.whatsapp_connected IS DISTINCT FROM OLD.whatsapp_connected
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Campos internos de conexão e criação da empresa não podem ser alterados diretamente pelo cliente'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_company_admin_update() FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 4. AF-08 (AUD-07.1-06): CAMINHO PRIVILEGIADO SEGURO PARA SERVICE_ROLE EM FINANCIAL_REGISTER_PAYMENT
-- ============================================================================

CREATE OR REPLACE FUNCTION public.financial_register_payment(
  _customer_id uuid,
  _amount numeric,
  _method text DEFAULT 'manual',
  _notes text DEFAULT NULL,
  _idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid;
  cust_comp uuid;
  credit numeric;
  ord record;
  payment_id uuid;
  clean_key text := nullif(btrim(coalesce(_idempotency_key, '')), '');
  rounded_amt numeric := round(coalesce(_amount, 0), 2);
  existing_pay public.payments%ROWTYPE;
  att public.payment_attempts%ROWTYPE;
  v_desired_status public.customer_status;
  v_jwt_role text := public.request_jwt_role();
  v_is_client_role boolean;
BEGIN
  IF _customer_id IS NULL THEN
    RAISE EXCEPTION 'Cliente obrigatório para registrar pagamento'
      USING ERRCODE = '22023';
  END IF;

  IF _amount IS NULL OR rounded_amt <= 0 OR NOT (rounded_amt < 'Infinity'::numeric) THEN
    RAISE EXCEPTION 'Valor do pagamento deve ser maior que zero'
      USING ERRCODE = '22023';
  END IF;

  IF clean_key IS NULL THEN
    RAISE EXCEPTION 'Chave de idempotência (_idempotency_key) é obrigatória para registrar pagamento'
      USING ERRCODE = '22023';
  END IF;

  v_is_client_role := (
    current_user IN ('authenticated', 'anon')
    OR session_user IN ('authenticated', 'anon')
    OR v_jwt_role IN ('authenticated', 'anon')
  );

  -- 1. Caminho autenticado de cliente/operador: exige sessão válida e financial_require_operator()
  IF v_is_client_role OR (SELECT auth.uid()) IS NOT NULL THEN
    IF current_user = 'anon'
       OR session_user = 'anon'
       OR v_jwt_role = 'anon'
       OR (SELECT auth.uid()) IS NULL THEN
      RAISE EXCEPTION 'Autenticação de operador obrigatória para registrar pagamento'
        USING ERRCODE = '42501';
    END IF;
    comp := public.financial_require_operator();
  -- 2. AUD-07.1-06: Caminho privilegiado explícito e restrito para service_role / postgres sem JWT:
  --    Jamais acessível por anon ou authenticated; deriva a empresa diretamente do vínculo real do cliente.
  ELSIF current_user IN ('service_role', 'postgres')
     OR session_user IN ('service_role', 'postgres') THEN
    SELECT c.company_id INTO comp
      FROM public.customers c
     WHERE c.id = _customer_id;
    IF comp IS NULL THEN
      RAISE EXCEPTION 'Cliente não encontrado'
        USING ERRCODE = 'P0002';
    END IF;
  ELSE
    RAISE EXCEPTION 'Contexto de execução não autorizado para registrar pagamento'
      USING ERRCODE = '42501';
  END IF;

  IF comp IS NULL THEN
    RAISE EXCEPTION 'Empresa não encontrada para o usuário'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(comp::text || ':payment_attempt:' || clean_key, 0));

  SELECT * INTO att
    FROM public.payment_attempts
   WHERE company_id = comp
     AND idempotency_key = clean_key
     FOR UPDATE;

  IF FOUND THEN
    IF att.status = 'cancelled' THEN
      RAISE EXCEPTION 'Tentativa de pagamento já foi cancelada e não pode mais ser concluída'
        USING ERRCODE = '22023';
    END IF;
    IF att.customer_id <> _customer_id OR att.amount <> rounded_amt THEN
      RAISE EXCEPTION 'Conflito de idempotência: chave já utilizada com valor ou cliente divergente'
        USING ERRCODE = '22023';
    END IF;
    IF att.status = 'succeeded' AND att.payment_id IS NOT NULL THEN
      RETURN att.payment_id;
    END IF;
  END IF;

  SELECT * INTO existing_pay
    FROM public.payments
   WHERE company_id = comp
     AND idempotency_key = clean_key;

  IF FOUND THEN
    IF existing_pay.customer_id <> _customer_id OR existing_pay.amount <> rounded_amt THEN
      RAISE EXCEPTION 'Conflito de idempotência: chave já utilizada com valor ou cliente divergente'
        USING ERRCODE = '22023';
    END IF;
    RETURN existing_pay.id;
  END IF;

  -- Ordem global padronizada: bloqueia CUSTOMERS primeiro e ORDERS em segundo
  SELECT company_id INTO cust_comp
    FROM public.customers
   WHERE id = _customer_id
     FOR UPDATE;

  IF cust_comp IS NULL OR cust_comp <> comp THEN
    RAISE EXCEPTION 'Cliente não encontrado'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.payments(company_id, customer_id, amount, method, notes, idempotency_key)
  VALUES (comp, _customer_id, rounded_amt, coalesce(_method, 'manual'), _notes, clean_key)
  RETURNING id INTO payment_id;

  INSERT INTO public.payment_attempts(
    company_id, idempotency_key, customer_id, amount, method, notes, status, payment_id, updated_at
  )
  VALUES (
    comp, clean_key, _customer_id, rounded_amt, coalesce(_method, 'manual'), _notes, 'succeeded', payment_id, clock_timestamp()
  )
  ON CONFLICT (company_id, idempotency_key)
  DO UPDATE SET status = 'succeeded', payment_id = EXCLUDED.payment_id, updated_at = clock_timestamp();

  SELECT coalesce((SELECT sum(amount) FROM public.payments WHERE customer_id = _customer_id AND company_id = comp), 0)
       - coalesce((SELECT sum(total) FROM public.orders WHERE customer_id = _customer_id AND company_id = comp
                     AND paid = true AND settled_by_payment = true AND delivery_status <> 'cancelado'), 0)
    INTO credit;

  PERFORM set_config('app.defer_customer_status_sync', 'on', true);

  FOR ord IN
    SELECT id, total FROM public.orders
    WHERE company_id = comp
      AND customer_id = _customer_id
      AND paid = false
      AND delivery_status <> 'cancelado'
      AND financial_state IS DISTINCT FROM 'aguardando_classificacao'
    ORDER BY order_date ASC, created_at ASC, id ASC
    FOR UPDATE
  LOOP
    EXIT WHEN credit < ord.total;
    UPDATE public.orders SET paid = true, settled_by_payment = true WHERE id = ord.id;
    credit := credit - ord.total;
  END LOOP;

  PERFORM set_config('app.defer_customer_status_sync', 'off', true);

  v_desired_status := CASE
    WHEN EXISTS (
      SELECT 1 FROM public.orders
      WHERE company_id = comp
        AND customer_id = _customer_id
        AND paid = false
        AND delivery_status <> 'cancelado'
        AND financial_state IS DISTINCT FROM 'aguardando_classificacao'
    )
    THEN 'pendente'::public.customer_status
    ELSE 'em_dia'::public.customer_status
  END;

  PERFORM set_config('app.customer_rpc_context', 'on', true);
  UPDATE public.customers
     SET status = v_desired_status
   WHERE id = _customer_id
     AND company_id = comp
     AND status IS DISTINCT FROM v_desired_status;
  PERFORM set_config('app.customer_rpc_context', 'off', true);

  RETURN payment_id;
END;
$$;

REVOKE ALL ON FUNCTION public.financial_register_payment(uuid, numeric, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.financial_register_payment(uuid, numeric, text, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.register_payment(uuid, numeric, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_payment(uuid, numeric, text, text, text) TO service_role;

-- ============================================================================
-- 5. AF-10 (REG-M07-02 & AUD-07.1-08): IMUTABILIDADE LGPD COMPATÍVEL COM ON DELETE SET NULL
--    EM CUSTOMER_ID E CONTROLE PERSISTENTE DE PERIODICIDADE DE EXPURGO NO BANCO
-- ============================================================================

CREATE OR REPLACE FUNCTION public.lgpd_lifecycle_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_db_name text := current_database();
  v_db_comment text;
  v_app_env text := coalesce(current_setting('app.environment', true), '');
BEGIN
  -- 1. Permite exclusivamente a ação referencial ON DELETE SET NULL de auth.users(id) em actor_id
  IF TG_OP = 'UPDATE'
     AND OLD.actor_id IS NOT NULL
     AND NEW.actor_id IS NULL
     AND current_user NOT IN ('authenticated', 'anon')
     AND session_user NOT IN ('authenticated', 'anon')
     AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.actor_id)
     AND (
       NEW.id, NEW.company_id, NEW.customer_id, NEW.operation, NEW.scope,
       NEW.protocol, NEW.affected_messages_count, NEW.financial_records_preserved,
       NEW.details, NEW.created_at
     ) IS NOT DISTINCT FROM (
       OLD.id, OLD.company_id, OLD.customer_id, OLD.operation, OLD.scope,
       OLD.protocol, OLD.affected_messages_count, OLD.financial_records_preserved,
       OLD.details, OLD.created_at
     ) THEN
    RETURN NEW;
  END IF;

  -- 2. REG-M07-02: Permite exclusivamente a ação referencial ON DELETE SET NULL de public.customers(id)
  --    em customer_id quando o cliente referenciado já foi removido de public.customers e nenhuma outra coluna mudou!
  IF TG_OP = 'UPDATE'
     AND OLD.customer_id IS NOT NULL
     AND NEW.customer_id IS NULL
     AND current_user NOT IN ('authenticated', 'anon')
     AND session_user NOT IN ('authenticated', 'anon')
     AND NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = OLD.customer_id)
     AND (
       NEW.id, NEW.company_id, NEW.actor_id, NEW.operation, NEW.scope,
       NEW.protocol, NEW.affected_messages_count, NEW.financial_records_preserved,
       NEW.details, NEW.created_at
     ) IS NOT DISTINCT FROM (
       OLD.id, OLD.company_id, OLD.actor_id, OLD.operation, OLD.scope,
       OLD.protocol, OLD.affected_messages_count, OLD.financial_records_preserved,
       OLD.details, OLD.created_at
     ) THEN
    RETURN NEW;
  END IF;

  -- 3. Permite limpeza controlada de registros sintéticos de homologação/teste fora de produção
  IF TG_OP = 'DELETE'
     AND current_setting('app.allow_audit_cleanup', true) = 'on'
     AND current_user NOT IN ('authenticated', 'anon')
     AND session_user NOT IN ('authenticated', 'anon')
     AND v_app_env NOT ILIKE '%prod%'
     AND v_db_name NOT ILIKE '%prod%' THEN

    SELECT shobj_description(oid, 'pg_database')
      INTO v_db_comment
      FROM pg_database
     WHERE datname = v_db_name;

    IF coalesce(v_db_comment, '') NOT ILIKE '%production%'
       AND coalesce(v_db_comment, '') NOT ILIKE '%producao%' THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION 'Trilha de auditoria LGPD (lgpd_lifecycle_audit) é imutável e não pode ser alterada ou excluída'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.lgpd_lifecycle_audit_immutable() FROM PUBLIC, anon, authenticated;

-- Tabela persistente para controle de periodicidade de tarefas operacionais entre cold starts (AUD-07.1-08)
CREATE TABLE IF NOT EXISTS public.operational_scheduler_state (
  task_key text PRIMARY KEY,
  last_executed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_result jsonb NOT NULL DEFAULT '{}'::jsonb
);

REVOKE ALL ON public.operational_scheduler_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.operational_scheduler_state TO service_role;
ALTER TABLE public.operational_scheduler_state ENABLE ROW LEVEL SECURITY;

-- Remove a assinatura antiga de 1 argumento para substituí-la pela assinatura compatível com defaults
DROP FUNCTION IF EXISTS public.lgpd_purge_expired_operational_data(integer);

CREATE OR REPLACE FUNCTION public.lgpd_purge_expired_operational_data(
  _retention_days integer DEFAULT 180,
  _force boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_comp uuid := NULL;
  v_effective_days integer := coalesce(_retention_days, 180);
  v_task_key text;
  v_last_run timestamptz;
  v_purged_msgs integer := 0;
  v_purged_attempt_notes integer := 0;
  v_audit_id uuid := NULL;
  v_result jsonb;
BEGIN
  IF v_actor IS NOT NULL THEN
    v_comp := public.financial_require_operator();
    IF NOT public.is_company_admin(v_comp) THEN
      RAISE EXCEPTION 'Permissão administrativa necessária para executar expurgo LGPD'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_effective_days < 30 THEN
    RAISE EXCEPTION 'Prazo mínimo de retenção operacional é de 30 dias'
      USING ERRCODE = '22023';
  END IF;

  v_task_key := 'lgpd_retention_purge:' || coalesce(v_comp::text, 'global');

  -- Serializa execuções simultâneas para evitar trabalho duplicado em instâncias concorrentes
  PERFORM pg_advisory_xact_lock(hashtextextended(v_task_key, 0));

  SELECT s.last_executed_at
    INTO v_last_run
    FROM public.operational_scheduler_state s
   WHERE s.task_key = v_task_key
     FOR UPDATE;

  -- AUD-07.1-08: Se já executou nas últimas 24h e _force não foi solicitado, retorna sem revarrer nem gerar auditoria vazia
  IF NOT coalesce(_force, false)
     AND v_last_run IS NOT NULL
     AND v_last_run >= clock_timestamp() - interval '24 hours' THEN
    RETURN jsonb_build_object(
      'skipped_by_schedule', true,
      'last_executed_at', v_last_run,
      'retention_days', v_effective_days,
      'purged_messages_count', 0,
      'purged_payment_attempt_notes_count', 0,
      'financial_records_preserved', true,
      'audit_id', NULL
    );
  END IF;

  v_purged_msgs := public.lgpd_purge_expired_message_bodies(v_effective_days);

  UPDATE public.payment_attempts pa
     SET notes = NULL
   WHERE (v_comp IS NULL OR pa.company_id = v_comp)
     AND pa.notes IS NOT NULL
     AND pa.created_at < clock_timestamp() - make_interval(days => v_effective_days);
  GET DIAGNOSTICS v_purged_attempt_notes = ROW_COUNT;

  -- AUD-07.1-08: Registra em lgpd_lifecycle_audit apenas quando houver dados efetivamente expurgados
  IF (v_purged_msgs + v_purged_attempt_notes) > 0 THEN
    INSERT INTO public.lgpd_lifecycle_audit(
      company_id,
      actor_id,
      customer_id,
      operation,
      scope,
      protocol,
      affected_messages_count,
      financial_records_preserved,
      details
    )
    VALUES (
      v_comp,
      v_actor,
      NULL,
      'purge_expired_operational_data',
      'retencao_' || v_effective_days::text || 'd',
      'RETENCAO_AUTOMATICA_LGPD',
      v_purged_msgs,
      true,
      jsonb_build_object(
        'retention_days', v_effective_days,
        'purged_messages_count', v_purged_msgs,
        'purged_payment_attempt_notes_count', v_purged_attempt_notes
      )
    )
    RETURNING id INTO v_audit_id;
  END IF;

  v_result := jsonb_build_object(
    'skipped_by_schedule', false,
    'last_executed_at', clock_timestamp(),
    'retention_days', v_effective_days,
    'purged_messages_count', v_purged_msgs,
    'purged_payment_attempt_notes_count', v_purged_attempt_notes,
    'financial_records_preserved', true,
    'audit_id', v_audit_id
  );

  INSERT INTO public.operational_scheduler_state(task_key, last_executed_at, last_result)
  VALUES (v_task_key, clock_timestamp(), v_result)
  ON CONFLICT (task_key)
  DO UPDATE SET
    last_executed_at = EXCLUDED.last_executed_at,
    last_result = EXCLUDED.last_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.lgpd_purge_expired_operational_data(integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lgpd_purge_expired_operational_data(integer, boolean) TO authenticated, service_role;

COMMIT;
