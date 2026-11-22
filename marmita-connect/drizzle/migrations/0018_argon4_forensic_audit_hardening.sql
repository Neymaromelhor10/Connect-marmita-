-- Migração 0018: Rodada de Correção Forense Avançada (Argon 4 + Supabase Agent Skills — FOR-02, FOR-04, FOR-06, FOR-07 e FOR-12)
-- 100% incremental, aditiva e não destrutiva (preserva intactas as migrations históricas 0000 a 0017).
-- Escopo:
--   FOR-02 (ALTO — Hardening de Escrita e Integridade em public.customers):
--     - Revoga INSERT/UPDATE/DELETE amplos de anon e authenticated em public.customers;
--     - Concede apenas SELECT, INSERT (id, company_id, name, phone, address, notes, payment_cycle)
--       e UPDATE (name, phone, address, notes, payment_cycle) para authenticated (impedindo escrita
--       direta em customers.status, company_id ou created_at via PostgREST);
--     - Cria trigger SECURITY INVOKER public.guard_customers_protected_fields() (BEFORE INSERT OR UPDATE)
--       que exige public.financial_require_operator() para escritas de clientes autenticados, impede
--       adulteração de status e bloqueia alteração de customers.phone enquanto o cliente possuir pedido
--       ativo em financial_state = 'aguardando_classificacao' (evitando divergência com orders.financial_phone
--       e bloqueio CONTEXTO_CONFLITANTE na confirmação OK/OKK).
--   FOR-04 (MÉDIO — Privilégios Mínimos em RPCs):
--     - Revoga EXECUTE de authenticated na RPC legada public.financial_create_pending (mantendo service_role);
--     - Exige public.financial_require_operator() em public.get_or_create_customer_by_phone quando
--       auth.uid() IS NOT NULL;
--     - Restringe public.has_role(_user_id, _role) para impedir enumeração de papéis de usuários de
--       outras empresas por clientes autenticados, preservando todos os usos internos legítimos.
--   FOR-06 (MÉDIO — Otimização RLS initPlan Caching conforme Supabase Agent Skills):
--     - Atualiza public.current_company_id() e todas as políticas RLS das tabelas públicas para utilizar
--       (SELECT auth.uid()), (SELECT public.current_company_id()) e (SELECT public.is_company_admin(id)).
--   FOR-07 (MÉDIO — Índices de Chaves Estrangeiras e ON DELETE SET NULL seguro para auth.users):
--     - Cria os 6 índices de chaves estrangeiras ausentes (financial_events.order_id,
--       financial_events.customer_id, payment_attempts.customer_id, payment_attempts.payment_id,
--       whatsapp_messages.last_manual_retry_by, whatsapp_manual_retry_audit.actor_id);
--     - Configura ON DELETE SET NULL nas FKs para auth.users(id) em whatsapp_messages.last_manual_retry_by
--       e whatsapp_manual_retry_audit.actor_id, permitindo desprovisionamento de usuário no Supabase Auth
--       enquanto preserva integralmente os registros históricos de auditoria.
--   FOR-12 (BAIXO — Retenção e Governança LGPD):
--     - Atualiza public.lgpd_purge_expired_message_bodies para expurgar também mensagens expiradas em
--       status IN ('revisar', 'erro') que não estejam sob lease ativo (locked_until IS NULL OR locked_until < clock_timestamp());
--     - Exige public.is_company_admin(comp) em public.lgpd_anonymize_customer_pii.

BEGIN;

-- ============================================================================
-- 1. FOR-04: ENDURECIMENTO DE RPCS (HAS_ROLE, FINANCIAL_CREATE_PENDING, GET_OR_CREATE_CUSTOMER_BY_PHONE)
-- ============================================================================

REVOKE ALL ON FUNCTION public.financial_create_pending(uuid, integer, integer, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.financial_create_pending(uuid, integer, integer, uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := (SELECT auth.uid());
BEGIN
  IF _user_id IS NULL OR _role IS NULL THEN
    RETURN false;
  END IF;

  -- Quando invocada por uma sessão autenticada consultando outro usuário, exige que pertençam à mesma empresa
  IF v_caller IS NOT NULL AND _user_id IS DISTINCT FROM v_caller THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.profiles caller_prof
        JOIN public.profiles target_prof
          ON target_prof.company_id = caller_prof.company_id
       WHERE caller_prof.id = v_caller
         AND target_prof.id = _user_id
    ) THEN
      RAISE EXCEPTION 'Acesso negado para consultar papéis de usuário de outra empresa'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.user_roles ur
     WHERE ur.user_id = _user_id
       AND ur.role = _role
  );
END;
$$;

REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;

-- ============================================================================
-- 2. FOR-02: PRIVILÉGIOS POR COLUNA E TRIGGER DE GUARDA EM PUBLIC.CUSTOMERS
-- ============================================================================

REVOKE INSERT, UPDATE, DELETE ON public.customers FROM anon, authenticated;
GRANT SELECT ON public.customers TO authenticated;
GRANT INSERT (id, company_id, name, phone, address, notes, payment_cycle) ON public.customers TO authenticated;
GRANT UPDATE (name, phone, address, notes, payment_cycle) ON public.customers TO authenticated;
GRANT ALL ON public.customers TO service_role;

CREATE OR REPLACE FUNCTION public.guard_customers_protected_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  op_comp uuid;
  v_jwt_role text := public.request_jwt_role();
  v_is_client_call boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'Identificador do cliente (id) não pode ser alterado'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'Identificador da empresa (company_id) do cliente não pode ser alterado'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  v_is_client_call := (
    current_user IN ('authenticated', 'anon')
    OR session_user IN ('authenticated', 'anon')
    OR (
      (v_jwt_role IN ('authenticated', 'anon') OR (SELECT auth.uid()) IS NOT NULL)
      AND current_setting('app.customer_rpc_context', true) IS DISTINCT FROM 'on'
    )
  );

  IF v_is_client_call THEN
    IF current_user = 'anon'
       OR session_user = 'anon'
       OR v_jwt_role = 'anon'
       OR (SELECT auth.uid()) IS NULL THEN
      RAISE EXCEPTION 'Acesso negado: autenticação de operador obrigatória para alterar clientes'
        USING ERRCODE = '42501';
    END IF;

    BEGIN
      op_comp := public.financial_require_operator();
    EXCEPTION
      WHEN OTHERS THEN
        RAISE EXCEPTION 'Permissão financeira/operacional necessária para cadastrar ou editar clientes (%)' , SQLERRM
          USING ERRCODE = '42501';
    END;

    IF op_comp IS DISTINCT FROM coalesce(OLD.company_id, NEW.company_id) THEN
      RAISE EXCEPTION 'Acesso negado para cadastrar ou alterar cliente de outra empresa'
        USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'INSERT' THEN
      IF NEW.status IS DISTINCT FROM 'em_dia'::public.customer_status THEN
        RAISE EXCEPTION 'Status financeiro inicial do cliente deve ser obrigatoriamente em_dia'
          USING ERRCODE = '42501';
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'Alteração direta do status financeiro do cliente (status) não é permitida; o status é calculado automaticamente pelos pedidos e pagamentos'
          USING ERRCODE = '42501';
      END IF;

      IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Data de criação (created_at) do cliente não pode ser alterada'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- FOR-02: Estratégia transacional segura para integridade de telefone:
  -- Bloqueia a alteração de customers.phone enquanto houver pedido ativo do cliente em
  -- financial_state = 'aguardando_classificacao' (exceto durante anonimização LGPD que já barra pendências),
  -- garantindo que orders.financial_phone e customers.phone jamais divirjam antes da confirmação OK/OKK.
  IF TG_OP = 'UPDATE'
     AND current_setting('app.customer_rpc_context', true) IS DISTINCT FROM 'on'
     AND public.financial_phone_key(NEW.phone) IS DISTINCT FROM public.financial_phone_key(OLD.phone) THEN
    IF EXISTS (
      SELECT 1
        FROM public.orders o
       WHERE o.company_id = OLD.company_id
         AND o.customer_id = OLD.id
         AND o.delivery_status <> 'cancelado'
         AND o.financial_state = 'aguardando_classificacao'
    ) THEN
      RAISE EXCEPTION 'Não é permitido alterar o telefone do cliente enquanto houver pedido aguardando classificação financeira (OK/OKK). Confirme ou cancele o pedido pendente antes de alterar o telefone.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_customers_protected_fields() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_customers_guard_protected_fields ON public.customers;
CREATE TRIGGER a_customers_guard_protected_fields
  BEFORE INSERT OR UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.guard_customers_protected_fields();

-- Atualiza sync_customer_status_on_order, register_payment e get_or_create_customer_by_phone
-- para sinalizar app.customer_rpc_context = 'on' de forma escopada durante mutações internas autorizadas
CREATE OR REPLACE FUNCTION public.sync_customer_status_on_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_desired public.customer_status;
BEGIN
  IF current_setting('app.defer_customer_status_sync', true) = 'on' THEN
    RETURN new;
  END IF;

  IF new.customer_id IS NOT NULL AND (
    tg_op = 'INSERT'
    OR old.paid IS DISTINCT FROM new.paid
    OR old.delivery_status IS DISTINCT FROM new.delivery_status
    OR old.financial_state IS DISTINCT FROM new.financial_state
  ) THEN
    v_desired := CASE
      WHEN EXISTS (
        SELECT 1 FROM public.orders
         WHERE company_id = new.company_id
           AND customer_id = new.customer_id
           AND paid = false
           AND delivery_status <> 'cancelado'
           AND financial_state IS DISTINCT FROM 'aguardando_classificacao'
      )
      THEN 'pendente'::public.customer_status
      ELSE 'em_dia'::public.customer_status
    END;

    PERFORM set_config('app.customer_rpc_context', 'on', true);
    UPDATE public.customers
       SET status = v_desired
     WHERE id = new.customer_id
       AND company_id = new.company_id
       AND status IS DISTINCT FROM v_desired;
    PERFORM set_config('app.customer_rpc_context', 'off', true);
  END IF;

  RETURN new;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_customer_status_on_order() FROM PUBLIC, anon, authenticated;

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
    RAISE EXCEPTION 'Empresa não encontrada para o usuário';
  END IF;
  IF _amount IS NULL OR rounded_amt <= 0 OR NOT (rounded_amt < 'Infinity'::numeric) THEN
    RAISE EXCEPTION 'Valor do pagamento deve ser maior que zero';
  END IF;

  IF clean_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(comp::text || ':payment_attempt:' || clean_key, 0));

    SELECT * INTO att FROM public.payment_attempts WHERE company_id = comp AND idempotency_key = clean_key FOR UPDATE;
    IF FOUND THEN
      IF att.status = 'cancelled' THEN
        RAISE EXCEPTION 'Tentativa de pagamento já foi cancelada e não pode mais ser concluída';
      END IF;
      IF att.customer_id <> _customer_id OR att.amount <> rounded_amt THEN
        RAISE EXCEPTION 'Conflito de idempotência: chave já utilizada com valor ou cliente divergente';
      END IF;
      IF att.status = 'succeeded' AND att.payment_id IS NOT NULL THEN
        RETURN att.payment_id;
      END IF;
    END IF;

    SELECT * INTO existing_pay FROM public.payments WHERE company_id = comp AND idempotency_key = clean_key;
    IF FOUND THEN
      IF existing_pay.customer_id <> _customer_id OR existing_pay.amount <> rounded_amt THEN
        RAISE EXCEPTION 'Conflito de idempotência: chave já utilizada com valor ou cliente divergente';
      END IF;
      RETURN existing_pay.id;
    END IF;
  END IF;

  -- Ordem global padronizada: bloqueia CUSTOMERS primeiro e ORDERS em segundo
  SELECT company_id INTO cust_comp FROM public.customers WHERE id = _customer_id FOR UPDATE;
  IF cust_comp IS NULL OR cust_comp <> comp THEN
    RAISE EXCEPTION 'Cliente não encontrado';
  END IF;

  INSERT INTO public.payments(company_id, customer_id, amount, method, notes, idempotency_key)
  VALUES (comp, _customer_id, rounded_amt, coalesce(_method, 'manual'), _notes, clean_key)
  RETURNING id INTO payment_id;

  IF clean_key IS NOT NULL THEN
    INSERT INTO public.payment_attempts(company_id, idempotency_key, customer_id, amount, method, notes, status, payment_id, updated_at)
    VALUES (comp, clean_key, _customer_id, rounded_amt, coalesce(_method, 'manual'), _notes, 'succeeded', payment_id, clock_timestamp())
    ON CONFLICT (company_id, idempotency_key)
    DO UPDATE SET status = 'succeeded', payment_id = EXCLUDED.payment_id, updated_at = clock_timestamp();
  END IF;

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

REVOKE ALL ON FUNCTION public.register_payment(uuid, numeric, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_payment(uuid, numeric, text, text, text) TO authenticated, service_role;

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
  op_comp uuid;
BEGIN
  IF _company_id IS NULL OR length(norm_key) < 8 OR length(norm_key) > 15 THEN
    RETURN;
  END IF;

  -- FOR-04: Quando chamado por sessão autenticada, exige operador autorizado da própria empresa
  IF (SELECT auth.uid()) IS NOT NULL THEN
    BEGIN
      op_comp := public.financial_require_operator();
    EXCEPTION
      WHEN OTHERS THEN
        RAISE EXCEPTION 'Permissão financeira/operacional necessária para localizar ou criar cliente (%)' , SQLERRM
          USING ERRCODE = '42501';
    END;

    IF _company_id IS DISTINCT FROM op_comp THEN
      RAISE EXCEPTION 'Acesso negado aos clientes de outra empresa'
        USING ERRCODE = '42501';
    END IF;
  END IF;

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

  BEGIN
    PERFORM set_config('app.customer_rpc_context', 'on', true);
    INSERT INTO public.customers(company_id, phone, name)
    VALUES (_company_id, norm_key, resolved_name)
    RETURNING customers.id, customers.name, customers.phone
    INTO found_rec;
    PERFORM set_config('app.customer_rpc_context', 'off', true);

    RETURN QUERY SELECT found_rec.id, found_rec.name, found_rec.phone, true;
    RETURN;
  EXCEPTION
    WHEN unique_violation THEN
      PERFORM set_config('app.customer_rpc_context', 'off', true);
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
    WHEN OTHERS THEN
      PERFORM set_config('app.customer_rpc_context', 'off', true);
      RAISE;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.get_or_create_customer_by_phone(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_or_create_customer_by_phone(uuid, text, text) TO authenticated, service_role;

-- ============================================================================
-- 3. FOR-06: OTIMIZAÇÃO DAS POLÍTICAS RLS COM (SELECT AUTH.UID()) E (SELECT PUBLIC.CURRENT_COMPANY_ID())
-- ============================================================================

CREATE OR REPLACE FUNCTION public.current_company_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT company_id FROM public.profiles WHERE id = (SELECT auth.uid())
$$;

REVOKE ALL ON FUNCTION public.current_company_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_company_id() TO authenticated, service_role;

-- 3.1. public.companies
DROP POLICY IF EXISTS "own company" ON public.companies;
CREATE POLICY "own company"
  ON public.companies
  FOR SELECT
  TO authenticated
  USING (id = (SELECT public.current_company_id()));

DROP POLICY IF EXISTS "update own company" ON public.companies;
CREATE POLICY "update own company"
  ON public.companies
  FOR UPDATE
  TO authenticated
  USING (id = (SELECT public.current_company_id()))
  WITH CHECK (
    id = (SELECT public.current_company_id())
    AND (SELECT public.is_company_admin(id))
  );

-- 3.2. public.profiles
DROP POLICY IF EXISTS "own profile select" ON public.profiles;
CREATE POLICY "own profile select"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR company_id = (SELECT public.current_company_id())
  );

DROP POLICY IF EXISTS "own profile update" ON public.profiles;
CREATE POLICY "own profile update"
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (id = (SELECT auth.uid()))
  WITH CHECK (
    id = (SELECT auth.uid())
    AND company_id = (SELECT public.current_company_id())
  );

-- 3.3. public.user_roles
DROP POLICY IF EXISTS "own roles" ON public.user_roles;
CREATE POLICY "own roles"
  ON public.user_roles
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- 3.4. public.customers
DROP POLICY IF EXISTS "company customers" ON public.customers;
CREATE POLICY "company customers"
  ON public.customers
  FOR ALL
  TO authenticated
  USING (company_id = (SELECT public.current_company_id()))
  WITH CHECK (company_id = (SELECT public.current_company_id()));

-- 3.5. public.orders
DROP POLICY IF EXISTS "company orders" ON public.orders;
CREATE POLICY "company orders"
  ON public.orders
  FOR ALL
  TO authenticated
  USING (company_id = (SELECT public.current_company_id()))
  WITH CHECK (company_id = (SELECT public.current_company_id()));

-- 3.6. public.payments
DROP POLICY IF EXISTS "company payments" ON public.payments;
CREATE POLICY "company payments"
  ON public.payments
  FOR ALL
  TO authenticated
  USING (company_id = (SELECT public.current_company_id()))
  WITH CHECK (company_id = (SELECT public.current_company_id()));

-- 3.7. public.whatsapp_messages
DROP POLICY IF EXISTS "company messages" ON public.whatsapp_messages;
CREATE POLICY "company messages"
  ON public.whatsapp_messages
  FOR ALL
  TO authenticated
  USING (company_id = (SELECT public.current_company_id()))
  WITH CHECK (company_id = (SELECT public.current_company_id()));

-- 3.8. public.whatsapp_connections
DROP POLICY IF EXISTS "company whatsapp connections read" ON public.whatsapp_connections;
CREATE POLICY "company whatsapp connections read"
  ON public.whatsapp_connections
  FOR SELECT
  TO authenticated
  USING (company_id = (SELECT public.current_company_id()));

-- 3.9. public.financial_permissions
DROP POLICY IF EXISTS financial_permission_own_read ON public.financial_permissions;
CREATE POLICY financial_permission_own_read
  ON public.financial_permissions
  FOR SELECT
  TO authenticated
  USING (
    company_id = (SELECT public.current_company_id())
    AND user_id = (SELECT auth.uid())
  );

-- 3.10. public.financial_events
DROP POLICY IF EXISTS financial_events_company_read ON public.financial_events;
CREATE POLICY financial_events_company_read
  ON public.financial_events
  FOR SELECT
  TO authenticated
  USING (company_id = (SELECT public.current_company_id()));

-- 3.11. public.payment_attempts
DROP POLICY IF EXISTS payment_attempts_company_read ON public.payment_attempts;
CREATE POLICY payment_attempts_company_read
  ON public.payment_attempts
  FOR SELECT
  TO authenticated
  USING (company_id = (SELECT public.current_company_id()));

-- 3.12. public.whatsapp_manual_retry_audit
DROP POLICY IF EXISTS whatsapp_manual_retry_audit_company_read ON public.whatsapp_manual_retry_audit;
CREATE POLICY whatsapp_manual_retry_audit_company_read
  ON public.whatsapp_manual_retry_audit
  FOR SELECT
  TO authenticated
  USING (company_id = (SELECT public.current_company_id()));

-- ============================================================================
-- 4. FOR-07: ÍNDICES DE CHAVES ESTRANGEIRAS E ON DELETE SET NULL SEGURO PARA AUTH.USERS
-- ============================================================================

CREATE INDEX IF NOT EXISTS financial_events_order_id_idx
  ON public.financial_events (order_id)
  WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS financial_events_company_customer_idx
  ON public.financial_events (company_id, customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_attempts_company_customer_idx
  ON public.payment_attempts (company_id, customer_id);

CREATE INDEX IF NOT EXISTS payment_attempts_payment_id_idx
  ON public.payment_attempts (payment_id)
  WHERE payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS whatsapp_messages_last_manual_retry_by_idx
  ON public.whatsapp_messages (last_manual_retry_by)
  WHERE last_manual_retry_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS whatsapp_manual_retry_audit_actor_id_idx
  ON public.whatsapp_manual_retry_audit (actor_id)
  WHERE actor_id IS NOT NULL;

-- Permite que a exclusão de um usuário em auth.users limpe apenas actor_id = NULL via FK
-- sem nunca permitir adulteração de outros campos ou UPDATE manual enquanto o usuário existir
CREATE OR REPLACE FUNCTION public.whatsapp_manual_retry_audit_immutable()
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
  -- FOR-07: Permite exclusivamente a ação referencial ON DELETE SET NULL de auth.users(id)
  -- quando o usuário referenciado em OLD.actor_id já foi removido de auth.users e nenhuma outra coluna mudou
  IF TG_OP = 'UPDATE'
     AND OLD.actor_id IS NOT NULL
     AND NEW.actor_id IS NULL
     AND current_user NOT IN ('authenticated', 'anon')
     AND session_user NOT IN ('authenticated', 'anon')
     AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.actor_id)
     AND (
       NEW.id,
       NEW.company_id,
       NEW.message_id,
       NEW.manual_retry_number,
       NEW.previous_status,
       NEW.previous_attempts,
       NEW.outcome,
       NEW.reason,
       NEW.created_at
     ) IS NOT DISTINCT FROM (
       OLD.id,
       OLD.company_id,
       OLD.message_id,
       OLD.manual_retry_number,
       OLD.previous_status,
       OLD.previous_attempts,
       OLD.outcome,
       OLD.reason,
       OLD.created_at
     ) THEN
    RETURN NEW;
  END IF;

  -- Permite limpeza controlada exclusivamente de registros sintéticos de homologação/teste
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

  RAISE EXCEPTION 'Auditoria de reprocessamento manual (whatsapp_manual_retry_audit) é imutável e não pode ser alterada ou excluída'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_manual_retry_audit_immutable() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.whatsapp_messages
  DROP CONSTRAINT IF EXISTS whatsapp_messages_last_manual_retry_by_fkey;

ALTER TABLE public.whatsapp_messages
  ADD CONSTRAINT whatsapp_messages_last_manual_retry_by_fkey
  FOREIGN KEY (last_manual_retry_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.whatsapp_manual_retry_audit
  DROP CONSTRAINT IF EXISTS whatsapp_manual_retry_audit_actor_id_fkey;

ALTER TABLE public.whatsapp_manual_retry_audit
  ADD CONSTRAINT whatsapp_manual_retry_audit_actor_id_fkey
  FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- ============================================================================
-- 5. FOR-12: GOVERNANÇA LGPD (ANONIMIZAÇÃO EXIGE ADMIN + EXPURGO DE REVISAR/ERRO EXPIRADOS)
-- ============================================================================

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
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória'
      USING ERRCODE = '42501';
  END IF;

  comp := public.financial_require_operator();

  -- FOR-12: Exige privilégio administrativo (is_company_admin) para anonimização LGPD
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
  IF (SELECT auth.uid()) IS NOT NULL THEN
    comp := public.financial_require_operator();
  END IF;

  IF coalesce(_retention_days, 180) < 30 THEN
    RAISE EXCEPTION 'Prazo mínimo de retenção operacional é de 30 dias';
  END IF;

  PERFORM set_config('app.whatsapp_rpc_context', 'on', true);

  -- FOR-12: Inclui mensagens expiradas em 'registrado', 'ignorado', 'revisar' e 'erro'
  -- desde que não possuam lease ativo em andamento (locked_until IS NULL OR locked_until < clock_timestamp())
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

REVOKE ALL ON FUNCTION public.lgpd_purge_expired_message_bodies(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lgpd_purge_expired_message_bodies(integer) TO authenticated, service_role;

COMMIT;
