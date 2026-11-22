-- Migração 0021: Missão 07 — Correção Controlada dos Achados AF-01, AF-07, AF-08 e AF-10 (Argon 4)
-- 100% incremental, aditiva e não destrutiva (preserva intactas as migrations históricas 0000 a 0020).
--
-- Escopo desta migration:
--   1. AF-01 (P1 — Proteção contra roubo de lease na reentrega do webhook):
--      - Cria a RPC transacional atômica public.requeue_errored_whatsapp_webhook_message(_company_id, _message_uid, _now)
--        com bloqueio FOR UPDATE, impedindo que uma reentrega da Meta limpe locked_by ou locked_until
--        enquanto um worker possuir lease válido, preservando lease_generation monotônico e respeitando
--        o teto de tentativas.
--   2. AF-07 (P2 — Bloqueio de mutações diretas pelo browser e centralização em RPCs/Server Functions):
--      - Revoga privilégios de escrita direta (INSERT, UPDATE, DELETE) de anon e authenticated em
--        public.whatsapp_messages, public.companies e public.customers;
--      - Atualiza public.guard_whatsapp_messages_protected_fields() e public.ignore_whatsapp_message(_message_id)
--        para impedir que mensagens com lease ativo em processamento (status = 'processando' e
--        locked_until >= clock_timestamp()) sejam alteradas ou dispensadas concorrentemente;
--      - Cria as RPCs seguras public.update_company_prices(_price_p, _price_m, _price_g) (restrita a admin)
--        e public.upsert_company_customer(...) (restrita a operador autorizado da própria empresa,
--        derivando company_id exclusivamente da sessão autenticada).
--   3. AF-08 (P2 — Função financeira oficial financial_register_payment e revogação da legada register_payment):
--      - Cria public.financial_register_payment(_customer_id, _amount, _method, _notes, _idempotency_key)
--        exigindo obrigatoriamente _idempotency_key não vazia, operador autenticado, lock transacional
--        e validação em payment_attempts;
--      - Revoga EXECUTE de PUBLIC, anon e authenticated na função legada public.register_payment,
--        restringindo-a a service_role e bloqueando chamadas diretas de sessões de cliente (42501).
--   4. AF-10 (P2 — Governança LGPD e ciclo de vida dos dados):
--      - Cria a tabela de auditoria imutável public.lgpd_lifecycle_audit com RLS;
--      - Atualiza public.lgpd_anonymize_customer_pii e cria public.lgpd_anonymize_customer com registro
--        transacional obrigatório em public.lgpd_lifecycle_audit;
--      - Cria public.lgpd_purge_expired_operational_data(_retention_days) para expurgo agendado seguro
--        de dados operacionais expirados preservando integralmente registros fiscais e financeiros.

BEGIN;

-- ============================================================================
-- 1. AF-01: RPC TRANSACIONAL CONTRA ROUBO DE LEASE NA REENTREGA DO WEBHOOK
-- ============================================================================

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

  -- 2. Proteção estrita de lease ativo: nenhuma reentrega pode limpar locked_by ou locked_until
  --    enquanto outro worker detiver lease válido!
  IF (v_msg.locked_until IS NOT NULL AND v_msg.locked_until >= v_effective_now)
     OR (v_msg.status = 'processando' AND (v_msg.locked_until IS NULL OR v_msg.locked_until >= v_effective_now)) THEN
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
    RETURN jsonb_build_object(
      'requeued', false,
      'reason', 'ALREADY_QUEUED',
      'id', v_msg.id,
      'status', v_msg.status,
      'lease_generation', v_msg.lease_generation
    );
  END IF;

  -- 4. Respeita o teto máximo de tentativas (5 automáticas + até 3 manuais)
  v_max_attempts := 5 + least(coalesce(v_msg.manual_retry_count, 0), 3);
  IF coalesce(v_msg.attempts, 0) >= v_max_attempts THEN
    RETURN jsonb_build_object(
      'requeued', false,
      'reason', 'MAX_ATTEMPTS_REACHED',
      'id', v_msg.id,
      'status', v_msg.status,
      'lease_generation', v_msg.lease_generation
    );
  END IF;

  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  -- 5. Transição atômica: apenas se estiver em 'erro' (ou 'processando' com lease já vencido),
  --    preservando lease_generation monotônico e respeitando o agendamento de retry (next_retry_at)
  UPDATE public.whatsapp_messages
     SET status = 'aguardando',
         locked_by = NULL,
         locked_until = NULL,
         next_retry_at = coalesce(v_msg.next_retry_at, v_effective_now)
   WHERE id = v_msg.id
     AND company_id = _company_id
     AND order_id IS NULL
     AND status IN ('erro', 'processando')
     AND (locked_until IS NULL OR locked_until < v_effective_now);

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
    'lease_generation', v_msg.lease_generation
  );
END;
$$;

REVOKE ALL ON FUNCTION public.requeue_errored_whatsapp_webhook_message(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.requeue_errored_whatsapp_webhook_message(uuid, text, timestamptz) TO service_role;

-- ============================================================================
-- 2. AF-07: BLOQUEIO DE MUTAÇÕES DIRETAS PELO BROWSER E RPCS SEGURAS NO SERVIDOR
-- ============================================================================

-- Revoga escrita direta de anon e authenticated nas tabelas operacionais (toda escrita passa por RPC/Server Function)
REVOKE INSERT, UPDATE, DELETE ON public.whatsapp_messages FROM anon, authenticated;
GRANT SELECT ON public.whatsapp_messages TO authenticated;
GRANT ALL ON public.whatsapp_messages TO service_role;

REVOKE INSERT, UPDATE, DELETE ON public.companies FROM anon, authenticated;
GRANT SELECT ON public.companies TO authenticated;
GRANT ALL ON public.companies TO service_role;

REVOKE INSERT, UPDATE, DELETE ON public.customers FROM anon, authenticated;
GRANT SELECT ON public.customers TO authenticated;
GRANT ALL ON public.customers TO service_role;

-- Reforça o trigger de guarda em public.whatsapp_messages para bloquear alteração de mensagens sob lease ativo
CREATE OR REPLACE FUNCTION public.guard_whatsapp_messages_protected_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  op_comp uuid;
  v_jwt_role text := public.request_jwt_role();
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'Identificador da empresa (company_id) da mensagem não pode ser alterado'
      USING ERRCODE = '42501';
  END IF;

  IF current_user IN ('authenticated', 'anon')
     OR session_user IN ('authenticated', 'anon')
     OR (
       (v_jwt_role IN ('authenticated', 'anon') OR (SELECT auth.uid()) IS NOT NULL)
       AND current_setting('app.whatsapp_rpc_context', true) IS DISTINCT FROM 'on'
     ) THEN

    IF current_user = 'anon'
       OR session_user = 'anon'
       OR v_jwt_role = 'anon'
       OR (SELECT auth.uid()) IS NULL THEN
      RAISE EXCEPTION 'Acesso negado: autenticação de operador obrigatória para atualizar whatsapp_messages'
        USING ERRCODE = '42501';
    END IF;

    BEGIN
      op_comp := public.financial_require_operator();
    EXCEPTION
      WHEN OTHERS THEN
        RAISE EXCEPTION 'Permissão de operador necessária para atualizar mensagem do WhatsApp (%)' , SQLERRM
          USING ERRCODE = '42501';
    END;

    IF op_comp IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'Acesso negado para alterar mensagem de outra empresa'
        USING ERRCODE = '42501';
    END IF;

    -- AF-01 & AF-07: Nunca permite alterar uma mensagem que está em processamento com lease ativo
    IF (OLD.locked_until IS NOT NULL AND OLD.locked_until >= clock_timestamp())
       OR (OLD.status = 'processando' AND (OLD.locked_until IS NULL OR OLD.locked_until >= clock_timestamp())) THEN
      RAISE EXCEPTION 'Mensagem está em processamento ativo por um worker; aguarde a conclusão antes de alterá-la'
        USING ERRCODE = '55P03';
    END IF;

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
      NEW.order_date,
      NEW.profile_name,
      NEW.phone_number_id,
      NEW.received_at,
      NEW.created_at
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
      OLD.order_date,
      OLD.profile_name,
      OLD.phone_number_id,
      OLD.received_at,
      OLD.created_at
    ) THEN
      RAISE EXCEPTION 'Alteração direta de campos de controle operacional ou financeiro em whatsapp_messages não é permitida'
        USING ERRCODE = '42501';
    END IF;

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

-- Atualiza public.ignore_whatsapp_message para proteger leases ativos e preservar lease_generation
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
  IF (SELECT auth.uid()) IS NULL THEN
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

  IF (msg.locked_until IS NOT NULL AND msg.locked_until >= clock_timestamp())
     OR (msg.status = 'processando' AND (msg.locked_until IS NULL OR msg.locked_until >= clock_timestamp())) THEN
    RAISE EXCEPTION 'Mensagem está em processamento ativo por um worker; aguarde o término antes de dispensá-la'
      USING ERRCODE = '55P03';
  END IF;

  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  UPDATE public.whatsapp_messages
     SET status = 'ignorado',
         locked_until = NULL,
         locked_by = NULL,
         next_retry_at = NULL
   WHERE id = msg.id
     AND company_id = comp;

  PERFORM set_config('app.whatsapp_rpc_context', 'off', true);

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.ignore_whatsapp_message(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ignore_whatsapp_message(uuid) TO authenticated, service_role;

-- RPC segura para atualização de preços da empresa (deriva company_id da sessão e exige admin)
CREATE OR REPLACE FUNCTION public.update_company_prices(
  _price_p numeric,
  _price_m numeric,
  _price_g numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_comp uuid;
  v_updated public.companies%ROWTYPE;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória'
      USING ERRCODE = '42501';
  END IF;

  v_comp := public.current_company_id();
  IF v_comp IS NULL THEN
    RAISE EXCEPTION 'Empresa não encontrada para o usuário autenticado'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_company_admin(v_comp) THEN
    RAISE EXCEPTION 'Permissão administrativa necessária para alterar os preços da empresa'
      USING ERRCODE = '42501';
  END IF;

  IF _price_p IS NULL OR _price_m IS NULL OR _price_g IS NULL
     OR _price_p < 0 OR _price_m < 0 OR _price_g < 0
     OR NOT (_price_p < 'Infinity'::numeric)
     OR NOT (_price_m < 'Infinity'::numeric)
     OR NOT (_price_g < 'Infinity'::numeric) THEN
    RAISE EXCEPTION 'Informe preços válidos (maiores ou iguais a zero) para P, M e G'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.companies
     SET price_p = round(_price_p, 2),
         price_m = round(_price_m, 2),
         price_g = round(_price_g, 2)
   WHERE id = v_comp
  RETURNING * INTO v_updated;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Empresa não encontrada'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object(
    'id', v_updated.id,
    'price_p', v_updated.price_p,
    'price_m', v_updated.price_m,
    'price_g', v_updated.price_g
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_company_prices(numeric, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_company_prices(numeric, numeric, numeric) TO authenticated, service_role;

-- RPC segura para criação e edição de clientes (deriva company_id da sessão e exige operador autorizado)
CREATE OR REPLACE FUNCTION public.upsert_company_customer(
  _customer_id uuid DEFAULT NULL,
  _name text DEFAULT NULL,
  _phone text DEFAULT NULL,
  _address text DEFAULT NULL,
  _notes text DEFAULT NULL,
  _payment_cycle public.payment_cycle DEFAULT 'semanal'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_comp uuid;
  v_clean_name text := btrim(coalesce(_name, ''));
  v_norm_phone text := public.financial_phone_key(_phone);
  v_existing public.customers%ROWTYPE;
  v_saved public.customers%ROWTYPE;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória'
      USING ERRCODE = '42501';
  END IF;

  v_comp := public.financial_require_operator();

  IF length(v_clean_name) < 2 OR length(v_clean_name) > 160 THEN
    RAISE EXCEPTION 'Informe o nome válido do cliente (2 a 160 caracteres)'
      USING ERRCODE = '22023';
  END IF;

  IF length(v_norm_phone) < 10 OR length(v_norm_phone) > 15 THEN
    RAISE EXCEPTION 'Telefone inválido. Use DDD + número (10 a 15 dígitos)'
      USING ERRCODE = '22023';
  END IF;

  IF _customer_id IS NOT NULL THEN
    SELECT * INTO v_existing
      FROM public.customers
     WHERE id = _customer_id
       FOR UPDATE;

    IF NOT FOUND OR v_existing.company_id IS DISTINCT FROM v_comp THEN
      RAISE EXCEPTION 'Acesso negado: cliente não encontrado na empresa do operador autenticado'
        USING ERRCODE = '42501';
    END IF;

    IF public.financial_phone_key(v_existing.phone) IS DISTINCT FROM v_norm_phone THEN
      IF EXISTS (
        SELECT 1
          FROM public.orders o
         WHERE o.company_id = v_comp
           AND o.customer_id = v_existing.id
           AND o.delivery_status <> 'cancelado'
           AND o.financial_state = 'aguardando_classificacao'
      ) THEN
        RAISE EXCEPTION 'Não é permitido alterar o telefone do cliente enquanto houver pedido aguardando classificação financeira (OK/OKK). Confirme ou cancele o pedido pendente antes de alterar o telefone.'
          USING ERRCODE = '22023';
      END IF;
    END IF;

    PERFORM set_config('app.customer_rpc_context', 'on', true);

    UPDATE public.customers
       SET name = v_clean_name,
           phone = v_norm_phone,
           address = nullif(btrim(coalesce(_address, '')), ''),
           notes = nullif(btrim(coalesce(_notes, '')), ''),
           payment_cycle = coalesce(_payment_cycle, v_existing.payment_cycle)
     WHERE id = v_existing.id
       AND company_id = v_comp
    RETURNING * INTO v_saved;

    PERFORM set_config('app.customer_rpc_context', 'off', true);
  ELSE
    PERFORM set_config('app.customer_rpc_context', 'on', true);

    INSERT INTO public.customers(
      company_id,
      name,
      phone,
      address,
      notes,
      payment_cycle,
      status
    )
    VALUES (
      v_comp,
      v_clean_name,
      v_norm_phone,
      nullif(btrim(coalesce(_address, '')), ''),
      nullif(btrim(coalesce(_notes, '')), ''),
      coalesce(_payment_cycle, 'semanal'::public.payment_cycle),
      'em_dia'::public.customer_status
    )
    RETURNING * INTO v_saved;

    PERFORM set_config('app.customer_rpc_context', 'off', true);
  END IF;

  RETURN to_jsonb(v_saved);
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_company_customer(uuid, text, text, text, text, public.payment_cycle) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_company_customer(uuid, text, text, text, text, public.payment_cycle) TO authenticated, service_role;

-- ============================================================================
-- 3. AF-08: FUNÇÃO OFICIAL FINANCIAL_REGISTER_PAYMENT E BLOQUEIO DE REGISTER_PAYMENT
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
BEGIN
  IF (SELECT auth.uid()) IS NOT NULL THEN
    comp := public.financial_require_operator();
  ELSE
    comp := public.current_company_id();
  END IF;

  IF comp IS NULL THEN
    RAISE EXCEPTION 'Empresa não encontrada para o usuário'
      USING ERRCODE = '42501';
  END IF;

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

-- AF-08: Endurece a função legada public.register_payment e revoga EXECUTE de authenticated/anon/PUBLIC
DROP FUNCTION IF EXISTS public.register_payment(uuid, numeric, text, text);
CREATE OR REPLACE FUNCTION public.register_payment(
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
  v_jwt_role text := public.request_jwt_role();
BEGIN
  IF current_user IN ('authenticated', 'anon')
     OR session_user IN ('authenticated', 'anon')
     OR v_jwt_role IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'Acesso negado: a função legada register_payment foi desativada para clientes (AF-08). Utilize public.financial_register_payment.'
      USING ERRCODE = '42501';
  END IF;

  RETURN public.financial_register_payment(
    _customer_id,
    _amount,
    _method,
    _notes,
    _idempotency_key
  );
END;
$$;

REVOKE ALL ON FUNCTION public.register_payment(uuid, numeric, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_payment(uuid, numeric, text, text, text) TO service_role;

-- ============================================================================
-- 4. AF-10: GOVERNANÇA LGPD E CICLO DE VIDA DOS DADOS COM AUDITORIA IMUTÁVEL
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.lgpd_lifecycle_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  operation text NOT NULL CHECK (operation IN ('anonymize_customer', 'purge_expired_operational_data')),
  scope text NOT NULL,
  protocol text,
  affected_messages_count integer NOT NULL DEFAULT 0,
  financial_records_preserved boolean NOT NULL DEFAULT true,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS lgpd_lifecycle_audit_company_created_idx
  ON public.lgpd_lifecycle_audit (company_id, created_at DESC);

REVOKE ALL ON public.lgpd_lifecycle_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.lgpd_lifecycle_audit TO authenticated;
GRANT ALL ON public.lgpd_lifecycle_audit TO service_role;
ALTER TABLE public.lgpd_lifecycle_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lgpd_lifecycle_audit_admin_read ON public.lgpd_lifecycle_audit;
CREATE POLICY lgpd_lifecycle_audit_admin_read
  ON public.lgpd_lifecycle_audit
  FOR SELECT
  TO authenticated
  USING (
    company_id = (SELECT public.current_company_id())
    AND (SELECT public.is_company_admin(company_id))
  );

CREATE OR REPLACE FUNCTION public.lgpd_lifecycle_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_db_name text := current_database();
  v_app_env text := coalesce(current_setting('app.environment', true), '');
BEGIN
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

  IF TG_OP = 'DELETE'
     AND current_setting('app.allow_audit_cleanup', true) = 'on'
     AND current_user NOT IN ('authenticated', 'anon')
     AND session_user NOT IN ('authenticated', 'anon')
     AND v_app_env NOT ILIKE '%prod%'
     AND v_db_name NOT ILIKE '%prod%' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Trilha de auditoria LGPD (lgpd_lifecycle_audit) é imutável e não pode ser alterada ou excluída'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.lgpd_lifecycle_audit_immutable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS lgpd_lifecycle_audit_immutable_trg ON public.lgpd_lifecycle_audit;
CREATE TRIGGER lgpd_lifecycle_audit_immutable_trg
  BEFORE UPDATE OR DELETE ON public.lgpd_lifecycle_audit
  FOR EACH ROW EXECUTE FUNCTION public.lgpd_lifecycle_audit_immutable();

-- Atualiza lgpd_anonymize_customer_pii para registrar auditoria transacional em lgpd_lifecycle_audit
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
  v_actor uuid := (SELECT auth.uid());
  cust public.customers%ROWTYPE;
  diag jsonb;
  seq_val bigint;
  synthetic_phone text;
  old_phone_key text;
  redacted_msgs int;
  audit_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória'
      USING ERRCODE = '42501';
  END IF;

  comp := public.financial_require_operator();

  IF NOT public.is_company_admin(comp) THEN
    RAISE EXCEPTION 'Permissão administrativa necessária para executar anonimização LGPD de cliente'
      USING ERRCODE = '42501';
  END IF;

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
  PERFORM set_config('app.customer_rpc_context', 'on', true);

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

  PERFORM set_config('app.customer_rpc_context', 'off', true);
  PERFORM set_config('app.whatsapp_rpc_context', 'off', true);

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
    comp,
    v_actor,
    cust.id,
    'anonymize_customer',
    _scope,
    btrim(_protocol),
    redacted_msgs,
    true,
    jsonb_build_object(
      'orders_preserved', coalesce((diag->>'orders_count')::int, 0),
      'payments_preserved', coalesce((diag->>'payments_count')::int, 0)
    )
  )
  RETURNING id INTO audit_id;

  RETURN jsonb_build_object(
    'customer_id', cust.id,
    'scope_executed', _scope,
    'redacted_messages_count', redacted_msgs,
    'financial_records_preserved', true,
    'protocol', btrim(_protocol),
    'audit_id', audit_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lgpd_anonymize_customer_pii(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lgpd_anonymize_customer_pii(uuid, text, text, text) TO authenticated, service_role;

-- Função canônica AF-10: lgpd_anonymize_customer
CREATE OR REPLACE FUNCTION public.lgpd_anonymize_customer(
  _customer_id uuid,
  _scope text DEFAULT 'anonimizacao_completa',
  _confirm_token text DEFAULT NULL,
  _protocol text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN public.lgpd_anonymize_customer_pii(
    _customer_id,
    _scope,
    _confirm_token,
    _protocol
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lgpd_anonymize_customer(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lgpd_anonymize_customer(uuid, text, text, text) TO authenticated, service_role;

-- Função canônica AF-10: lgpd_purge_expired_operational_data (expurgo agendado com auditoria)
CREATE OR REPLACE FUNCTION public.lgpd_purge_expired_operational_data(
  _retention_days integer DEFAULT 180
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
  v_purged_msgs integer := 0;
  v_purged_attempt_notes integer := 0;
  v_audit_id uuid;
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

  v_purged_msgs := public.lgpd_purge_expired_message_bodies(v_effective_days);

  -- Limpa observações livres antigas em payment_attempts preservando integralmente chaves, valores e vínculos
  UPDATE public.payment_attempts pa
     SET notes = NULL
   WHERE (v_comp IS NULL OR pa.company_id = v_comp)
     AND pa.notes IS NOT NULL
     AND pa.created_at < clock_timestamp() - make_interval(days => v_effective_days);
  GET DIAGNOSTICS v_purged_attempt_notes = ROW_COUNT;

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

  RETURN jsonb_build_object(
    'retention_days', v_effective_days,
    'purged_messages_count', v_purged_msgs,
    'purged_payment_attempt_notes_count', v_purged_attempt_notes,
    'financial_records_preserved', true,
    'audit_id', v_audit_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lgpd_purge_expired_operational_data(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lgpd_purge_expired_operational_data(integer) TO authenticated, service_role;

COMMIT;
