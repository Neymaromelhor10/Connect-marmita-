-- Migração 0023: Missão 07.4 — Correção Cirúrgica dos Achados AUD-07.3-02 (P0) e AUD-07.3-04 (P2)
-- 100% incremental, aditiva e não destrutiva (preserva intactas byte a byte as migrations históricas 0000 a 0022).
--
-- Escopo desta migration:
--   1. AUD-07.3-02 (P0 — Autorização determinística e isolamento de roles em public.financial_register_payment
--      e public.register_payment):
--      - Corrige a vulnerabilidade de identificação de role dentro de funções SECURITY DEFINER (onde current_user
--        passa a ser o owner da função, como 'postgres' ou 'supabase_admin', e current_setting('role', true)
--        retorna 'none' devido a InLocalUserIdChange()).
--      - Separa a execução privilegiada em duas funções SECURITY DEFINER com ACLs disjuntas no PostgreSQL:
--          (a) public._financial_register_payment_as_operator: exclusiva para operadores autenticados, sem
--              nenhum ramo service_role, exigindo obrigatoriamente auth.uid() IS NOT NULL,
--              public.request_jwt_role() = 'authenticated', public.financial_require_operator() e vínculo
--              estrito cust_comp = comp;
--          (b) public._financial_register_payment_as_service: exclusiva para service_role / administração
--              (REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO service_role), inacessível
--              em nível de permissão do próprio motor PostgreSQL para authenticated e anon, e bloqueando
--              qualquer chamada que contenha claims/sessão de cliente.
--      - Converte o ponto de entrada public.financial_register_payment (e public.register_payment) para
--        SECURITY INVOKER, preservando current_user e current_setting('role', true) reais do chamador
--        antes da transição para SECURITY DEFINER:
--          * Cenário A (authenticated): exige claims JWT válidos e delega exclusivamente para
--            _financial_register_payment_as_operator; se claims estiverem vazios/incompletos, falha com 42501
--            sem jamais cair no caminho privilegiado;
--          * Cenário B (anon): bloqueado por REVOKE e por verificação explícita (42501);
--          * Cenário C (service_role): autorizado via _financial_register_payment_as_service (com ou sem JWT),
--            independentemente de o owner das funções ser postgres ou supabase_admin;
--          * Cenário D (postgres / execução administrativa): autorizado apenas quando não houver role/claims
--            de cliente ativos;
--          * Cenário E (isolamento multiempresa): valida cust_comp = comp com bloqueio FOR UPDATE.
--   2. AUD-07.3-04 (P2 — Proteção da função auxiliar public.lgpd_purge_expired_message_bodies):
--      - Revoga EXECUTE de PUBLIC, anon e authenticated em public.lgpd_purge_expired_message_bodies(integer),
--        mantendo EXECUTE apenas para service_role (e para o owner em chamadas internas de
--        public.lgpd_purge_expired_operational_data);
--      - Reforça guarda interna exigindo contexto autorizado (app.lgpd_operational_purge_context = 'on')
--        ou administrador validado quando houver sessão autenticada.

BEGIN;

-- ============================================================================
-- 1. AUD-07.3-02 (P0): SEPARAÇÃO DE ACL E IDENTIFICAÇÃO DETERMINÍSTICA DE ROLE
--    EM PUBLIC.FINANCIAL_REGISTER_PAYMENT E PUBLIC.REGISTER_PAYMENT
-- ============================================================================

-- 1.1. Executor SECURITY DEFINER estrito para operadores autenticados (JAMAIS possui ramo service_role)
CREATE OR REPLACE FUNCTION public._financial_register_payment_as_operator(
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
  v_auth_uid uuid := (SELECT auth.uid());
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

  -- Exige obrigatoriamente claims JWT válidos de usuário autenticado e operador autorizado
  IF v_jwt_role IS DISTINCT FROM 'authenticated' OR v_auth_uid IS NULL THEN
    RAISE EXCEPTION 'Autenticação de operador com claims JWT válidos é obrigatória para registrar pagamento'
      USING ERRCODE = '42501';
  END IF;

  comp := public.financial_require_operator();
  IF comp IS NULL THEN
    RAISE EXCEPTION 'Empresa não encontrada para o operador autenticado'
      USING ERRCODE = '42501';
  END IF;

  -- Ordem global padronizada: bloqueia e valida o vínculo do cliente ANTES de consultar/gravar tentativas
  SELECT c.company_id INTO cust_comp
    FROM public.customers c
   WHERE c.id = _customer_id
     FOR UPDATE;

  IF cust_comp IS NULL OR cust_comp IS DISTINCT FROM comp THEN
    RAISE EXCEPTION 'Cliente não encontrado na empresa do operador autenticado'
      USING ERRCODE = 'P0002';
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

REVOKE ALL ON FUNCTION public._financial_register_payment_as_operator(uuid, numeric, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._financial_register_payment_as_operator(uuid, numeric, text, text, text) TO authenticated, service_role;

-- 1.2. Executor SECURITY DEFINER estrito para service_role / administração (REVOGADO de authenticated e anon)
CREATE OR REPLACE FUNCTION public._financial_register_payment_as_service(
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
  credit numeric;
  ord record;
  payment_id uuid;
  clean_key text := nullif(btrim(coalesce(_idempotency_key, '')), '');
  rounded_amt numeric := round(coalesce(_amount, 0), 2);
  existing_pay public.payments%ROWTYPE;
  att public.payment_attempts%ROWTYPE;
  v_desired_status public.customer_status;
  v_jwt_role text := public.request_jwt_role();
BEGIN
  -- Defesa em profundidade: além do REVOKE EXECUTE para anon e authenticated,
  -- recusa qualquer execução que carregue claims ou UID de cliente final.
  IF session_user IN ('authenticated', 'anon')
     OR v_jwt_role IN ('authenticated', 'anon')
     OR (SELECT auth.uid()) IS NOT NULL THEN
    RAISE EXCEPTION 'Acesso negado: caminho privilegiado exclusivo para service_role sem sessão de cliente'
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

  -- Ordem global padronizada: bloqueia CUSTOMERS primeiro e deriva company_id do vínculo real do cliente
  SELECT c.company_id INTO comp
    FROM public.customers c
   WHERE c.id = _customer_id
     FOR UPDATE;

  IF comp IS NULL THEN
    RAISE EXCEPTION 'Cliente não encontrado'
      USING ERRCODE = 'P0002';
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

REVOKE ALL ON FUNCTION public._financial_register_payment_as_service(uuid, numeric, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._financial_register_payment_as_service(uuid, numeric, text, text, text) TO service_role;

-- 1.3. Ponto de entrada oficial SECURITY INVOKER:
--      Como é SECURITY INVOKER, current_user e current_setting('role', true) refletem exatamente
--      a role ativa do chamador (SET LOCAL ROLE authenticated / anon / service_role / postgres)
--      sem serem sobrescritos pelo owner da função!
CREATE OR REPLACE FUNCTION public.financial_register_payment(
  _customer_id uuid,
  _amount numeric,
  _method text DEFAULT 'manual',
  _notes text DEFAULT NULL,
  _idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_user text := current_user;
  v_active_role text := coalesce(nullif(btrim(current_setting('role', true)), ''), 'none');
  v_jwt_role text := public.request_jwt_role();
  v_auth_uid uuid := (SELECT auth.uid());
BEGIN
  -- Cenário B (anon): Bloqueio explícito e imediato
  IF v_caller_user = 'anon'
     OR session_user = 'anon'
     OR v_active_role = 'anon'
     OR v_jwt_role = 'anon' THEN
    RAISE EXCEPTION 'Acesso negado: role anon não pode registrar pagamentos'
      USING ERRCODE = '42501';
  END IF;

  -- Cenário A (authenticated): Qualquer sessão cuja role seja authenticated ou que apresente
  -- claim/UID de usuário autenticado DEVE obrigatoriamente validar claims completos e operar via
  -- _financial_register_payment_as_operator. Jamais cai no caminho privilegiado!
  IF v_caller_user = 'authenticated'
     OR session_user = 'authenticated'
     OR v_active_role = 'authenticated'
     OR v_jwt_role = 'authenticated'
     OR v_auth_uid IS NOT NULL THEN
    IF v_jwt_role IS DISTINCT FROM 'authenticated' OR v_auth_uid IS NULL THEN
      RAISE EXCEPTION 'Autenticação de operador com claims JWT válidos é obrigatória para registrar pagamento'
        USING ERRCODE = '42501';
    END IF;

    RETURN public._financial_register_payment_as_operator(
      _customer_id,
      _amount,
      _method,
      _notes,
      _idempotency_key
    );
  END IF;

  -- Cenário C e D (service_role / postgres / supabase_admin sem sessão de cliente):
  -- Funciona tanto via PostgREST (service_role key com ou sem JWT claims) quanto via SQL direto,
  -- independentemente de o owner das funções SECURITY DEFINER ser postgres ou supabase_admin.
  IF v_caller_user IN ('service_role', 'postgres', 'supabase_admin')
     OR v_active_role = 'service_role'
     OR v_jwt_role = 'service_role' THEN
    RETURN public._financial_register_payment_as_service(
      _customer_id,
      _amount,
      _method,
      _notes,
      _idempotency_key
    );
  END IF;

  RAISE EXCEPTION 'Contexto de execução não autorizado para registrar pagamento'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.financial_register_payment(uuid, numeric, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.financial_register_payment(uuid, numeric, text, text, text) TO authenticated, service_role;

-- 1.4. Atualiza a função legada public.register_payment para SECURITY INVOKER com bloqueio determinístico
CREATE OR REPLACE FUNCTION public.register_payment(
  _customer_id uuid,
  _amount numeric,
  _method text DEFAULT 'manual',
  _notes text DEFAULT NULL,
  _idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_active_role text := coalesce(nullif(btrim(current_setting('role', true)), ''), 'none');
  v_jwt_role text := public.request_jwt_role();
BEGIN
  IF current_user IN ('authenticated', 'anon')
     OR session_user IN ('authenticated', 'anon')
     OR v_active_role IN ('authenticated', 'anon')
     OR v_jwt_role IN ('authenticated', 'anon')
     OR (SELECT auth.uid()) IS NOT NULL THEN
    RAISE EXCEPTION 'Acesso negado: a função legada register_payment foi desativada para clientes (AF-08). Utilize public.financial_register_payment.'
      USING ERRCODE = '42501';
  END IF;

  RETURN public._financial_register_payment_as_service(
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
-- 2. AUD-07.3-04 (P2): PROTEÇÃO DA FUNÇÃO AUXILIAR PUBLIC.LGPD_PURGE_EXPIRED_MESSAGE_BODIES
-- ============================================================================

CREATE OR REPLACE FUNCTION public.lgpd_purge_expired_message_bodies(_retention_days integer DEFAULT 180)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid;
  purged_count integer;
  v_jwt_role text := public.request_jwt_role();
  v_auth_uid uuid := (SELECT auth.uid());
BEGIN
  -- Impede invocação direta por operadores comuns ou sessões de cliente fora do fluxo oficial
  -- public.lgpd_purge_expired_operational_data (que define app.lgpd_operational_purge_context = 'on')
  IF current_setting('app.lgpd_operational_purge_context', true) IS DISTINCT FROM 'on' THEN
    IF session_user IN ('authenticated', 'anon')
       OR v_jwt_role IN ('authenticated', 'anon')
       OR v_auth_uid IS NOT NULL THEN
      RAISE EXCEPTION 'Acesso negado: execute o expurgo através da função oficial public.lgpd_purge_expired_operational_data'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_auth_uid IS NOT NULL THEN
    comp := public.financial_require_operator();
    IF NOT public.is_company_admin(comp) THEN
      RAISE EXCEPTION 'Permissão administrativa necessária para executar expurgo LGPD'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF coalesce(_retention_days, 180) < 30 THEN
    RAISE EXCEPTION 'Prazo mínimo de retenção operacional é de 30 dias'
      USING ERRCODE = '22023';
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
     AND m.status IN ('registrado', 'ignorado', 'revisar', 'erro')
     AND (m.locked_until IS NULL OR m.locked_until < clock_timestamp())
     AND m.created_at < clock_timestamp() - make_interval(days => coalesce(_retention_days, 180))
     AND m.body NOT LIKE '[%LGPD]';

  GET DIAGNOSTICS purged_count = ROW_COUNT;

  PERFORM set_config('app.whatsapp_rpc_context', 'off', true);

  RETURN purged_count;
END;
$$;

-- AUD-07.3-04: Revoga execução direta de PUBLIC, anon e authenticated na função auxiliar!
-- Chamadas internas a partir de public.lgpd_purge_expired_operational_data (SECURITY DEFINER)
-- executam sob a identidade do owner da função (postgres/supabase_admin) e continuam funcionando.
REVOKE ALL ON FUNCTION public.lgpd_purge_expired_message_bodies(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lgpd_purge_expired_message_bodies(integer) TO service_role;

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
  v_jwt_role text := public.request_jwt_role();
  v_comp uuid := NULL;
  v_effective_days integer := coalesce(_retention_days, 180);
  v_task_key text;
  v_last_run timestamptz;
  v_purged_msgs integer := 0;
  v_purged_attempt_notes integer := 0;
  v_audit_id uuid := NULL;
  v_result jsonb;
BEGIN
  IF session_user = 'anon' OR v_jwt_role = 'anon' THEN
    RAISE EXCEPTION 'Acesso negado: role anon não pode executar expurgo LGPD'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor IS NOT NULL OR session_user = 'authenticated' OR v_jwt_role = 'authenticated' THEN
    IF v_actor IS NULL OR v_jwt_role IS DISTINCT FROM 'authenticated' THEN
      RAISE EXCEPTION 'Autenticação administrativa válida é obrigatória para executar expurgo LGPD'
        USING ERRCODE = '42501';
    END IF;
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

  -- Respeita janela de 24 horas entre execuções quando _force = false
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

  PERFORM set_config('app.lgpd_operational_purge_context', 'on', true);
  v_purged_msgs := public.lgpd_purge_expired_message_bodies(v_effective_days);
  PERFORM set_config('app.lgpd_operational_purge_context', 'off', true);

  UPDATE public.payment_attempts pa
     SET notes = NULL
   WHERE (v_comp IS NULL OR pa.company_id = v_comp)
     AND pa.notes IS NOT NULL
     AND pa.created_at < clock_timestamp() - make_interval(days => v_effective_days);
  GET DIAGNOSTICS v_purged_attempt_notes = ROW_COUNT;

  -- Registra em lgpd_lifecycle_audit apenas quando houver dados efetivamente expurgados
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
