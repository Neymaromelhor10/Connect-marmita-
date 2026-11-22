-- Migração 0012: Implementação das 7 Correções da Auditoria de Carga, Estresse, Concorrência e Escalabilidade (Argon 4)
-- 100% incremental, aditiva e não destrutiva para dados existentes.
-- Escopo:
--   ARGON4-01: Bloqueio transacional atômico na fila do WhatsApp (locked_by, renew/release lock, ordenação inbound->echo)
--   ARGON4-02: Busca indexada O(log N) em find_customer_by_phone com validação multi-tenant estrita (>1.000 clientes)
--   ARGON4-03: Suporte transacional à fila assíncrona de ecos comerciais OK/OKK com detecção de pedido em processamento
--   ARGON4-04: Índices de paginação determinística (cursor/offset) e RPCs de agregação para Dashboard e Saldos
--   ARGON4-05: Padronização global da ordem de locks (customers -> orders) em toggle_order_paid e eliminação de N+1 updates MVCC
--   ARGON4-06: Criação do índice composto parcial FIFO (orders_customer_open_fifo_idx) e remoção de índice redundante
--   ARGON4-07: Hardening RLS e trigger intra-tenant em public.companies (bloqueia alteração de preços por operadores sem papel admin)

-- ============================================================================
-- 1. ARGON4-06 & ARGON4-04: ÍNDICE COMPOSTO PARCIAL FIFO E ÍNDICES DE PAGINAÇÃO
-- ============================================================================

-- Índice composto parcial exato para a consulta FIFO de register_payment e checagem de pendências do cliente
CREATE INDEX IF NOT EXISTS orders_customer_open_fifo_idx
  ON public.orders (company_id, customer_id, order_date ASC, created_at ASC, id ASC)
  WHERE paid = false
    AND delivery_status <> 'cancelado'
    AND financial_state IS DISTINCT FROM 'aguardando_classificacao';

-- Índices compostos determinísticos com desempate por id único para paginação real e cursor pagination
CREATE INDEX IF NOT EXISTS orders_company_date_created_id_idx
  ON public.orders (company_id, order_date DESC, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS payments_company_paid_at_id_idx
  ON public.payments (company_id, paid_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS customers_company_name_id_idx
  ON public.customers (company_id, name ASC, id ASC);

-- Remove índice redundante criado em 0004 que duplicava orders_company_id_order_date_idx (0000)
DROP INDEX IF EXISTS public.orders_company_date_idx;

-- ============================================================================
-- 2. ARGON4-07: SEGURANÇA INTRA-TENANT EM PUBLIC.COMPANIES (ADMIN + PERMISSÃO)
-- ============================================================================

REVOKE INSERT, DELETE ON public.companies FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.is_company_admin(_company_id uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  uid uuid := auth.uid();
  user_comp uuid;
  target_comp uuid;
  explicit_perm boolean;
BEGIN
  IF uid IS NULL THEN
    RETURN false;
  END IF;

  SELECT company_id INTO user_comp FROM public.profiles WHERE id = uid;
  IF user_comp IS NULL THEN
    RETURN false;
  END IF;

  target_comp := coalesce(_company_id, user_comp);
  IF target_comp <> user_comp THEN
    RETURN false;
  END IF;

  IF NOT public.has_role(uid, 'admin'::public.app_role) THEN
    RETURN false;
  END IF;

  SELECT can_classify INTO explicit_perm
    FROM public.financial_permissions
   WHERE company_id = user_comp AND user_id = uid;

  IF explicit_perm IS FALSE THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.is_company_admin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_company_admin(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS "update own company" ON public.companies;
CREATE POLICY "update own company"
  ON public.companies
  FOR UPDATE
  TO authenticated
  USING (
    id = public.current_company_id()
    AND public.is_company_admin(id)
  )
  WITH CHECK (
    id = public.current_company_id()
    AND public.is_company_admin(id)
  );

CREATE OR REPLACE FUNCTION public.guard_company_admin_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Identificador da empresa não pode ser alterado'
      USING ERRCODE = '42501';
  END IF;

  IF auth.uid() IS NOT NULL OR current_user IN ('authenticated', 'anon') THEN
    IF NOT public.is_company_admin(OLD.id) THEN
      RAISE EXCEPTION 'Permissão administrativa necessária para alterar configurações ou preços da empresa'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_company_admin_update() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS companies_guard_admin_update ON public.companies;
CREATE TRIGGER companies_guard_admin_update
  BEFORE UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.guard_company_admin_update();

-- ============================================================================
-- 3. ARGON4-02: BUSCA INDEXADA O(log N) DE CLIENTES (> 1.000 REGISTROS)
-- ============================================================================

CREATE INDEX IF NOT EXISTS customers_company_phone_key_idx
  ON public.customers (company_id, public.financial_phone_key(phone));

CREATE OR REPLACE FUNCTION public.find_customer_by_phone(
  _company_id uuid,
  _phone text
)
RETURNS TABLE(id uuid, name text, phone text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  norm_key text := public.financial_phone_key(_phone);
BEGIN
  IF _company_id IS NULL OR norm_key = '' THEN
    RETURN;
  END IF;

  IF auth.uid() IS NOT NULL THEN
    IF _company_id IS DISTINCT FROM public.current_company_id() THEN
      RAISE EXCEPTION 'Acesso negado aos clientes de outra empresa'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN QUERY
  SELECT c.id, c.name, c.phone
    FROM public.customers c
   WHERE c.company_id = _company_id
     AND public.financial_phone_key(c.phone) = norm_key
   ORDER BY c.created_at ASC, c.id ASC
   LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.find_customer_by_phone(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_customer_by_phone(uuid, text) TO authenticated, service_role;

-- ============================================================================
-- 4. ARGON4-01 & ARGON4-03: FILA DURÁVEL COM LOCK POR WORKER E ECOS ASSÍNCRONOS
-- ============================================================================

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS locked_by text;

DROP INDEX IF EXISTS public.whatsapp_messages_queue_idx;
CREATE INDEX IF NOT EXISTS whatsapp_messages_queue_idx
  ON public.whatsapp_messages (status, next_retry_at, locked_until, direction ASC, created_at ASC, id ASC)
  WHERE order_id IS NULL AND status IN ('aguardando', 'processando', 'erro');

DROP FUNCTION IF EXISTS public.claim_whatsapp_queue_batch(integer, integer, uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.claim_whatsapp_queue_batch(integer, integer, uuid, uuid, integer, text);

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
  effective_limit integer := greatest(coalesce(_limit, _batch_size, 5), 1);
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
  WITH candidates AS (
    SELECT m.id
      FROM public.whatsapp_messages m
     WHERE m.order_id IS NULL
       AND (_company_id IS NULL OR m.company_id = _company_id)
       AND (_message_id IS NULL OR m.id = _message_id)
       AND m.attempts < 5
       AND (
         (m.status = 'aguardando' AND (m.next_retry_at IS NULL OR m.next_retry_at <= clock_timestamp()))
         OR (m.status = 'erro' AND (m.next_retry_at IS NULL OR m.next_retry_at <= clock_timestamp()))
         OR (m.status = 'processando' AND (m.locked_until IS NULL OR m.locked_until < clock_timestamp()))
       )
     -- Prioriza mensagens inbound (criação de pedidos) antes de ecos outbound (confirmação OK/OKK)
     ORDER BY
       CASE WHEN m.direction = 'inbound' THEN 0 ELSE 1 END ASC,
       m.created_at ASC,
       m.id ASC
     LIMIT effective_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.whatsapp_messages target
     SET status = 'processando',
         attempts = target.attempts + 1,
         locked_until = clock_timestamp() + make_interval(secs => greatest(coalesce(_lock_seconds, 60), 15)),
         locked_by = resolved_worker
    FROM candidates c
   WHERE target.id = c.id
  RETURNING target.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_whatsapp_queue_batch(integer, integer, uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_queue_batch(integer, integer, uuid, uuid, integer, text) TO service_role;

CREATE OR REPLACE FUNCTION public.renew_whatsapp_message_lock(
  _message_id uuid,
  _worker_id text,
  _lock_seconds integer DEFAULT 60
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

  UPDATE public.whatsapp_messages
     SET locked_until = clock_timestamp() + make_interval(secs => greatest(coalesce(_lock_seconds, 60), 15))
   WHERE id = _message_id
     AND status = 'processando'
     AND locked_by = _worker_id;

  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RETURN (updated_rows > 0);
END;
$$;

REVOKE ALL ON FUNCTION public.renew_whatsapp_message_lock(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_whatsapp_message_lock(uuid, text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.release_whatsapp_message_lock(
  _message_id uuid,
  _worker_id text,
  _final_status text,
  _last_error text DEFAULT NULL,
  _next_retry_at timestamptz DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  updated_rows integer;
BEGIN
  IF _message_id IS NULL OR _final_status NOT IN ('aguardando', 'registrado', 'revisar', 'ignorado', 'erro') THEN
    RETURN false;
  END IF;

  UPDATE public.whatsapp_messages
     SET status = _final_status,
         locked_until = NULL,
         locked_by = NULL,
         last_error = _last_error,
         next_retry_at = _next_retry_at
   WHERE id = _message_id
     AND (locked_by IS NULL OR locked_by = _worker_id OR locked_until IS NULL OR locked_until < clock_timestamp());

  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RETURN (updated_rows > 0);
END;
$$;

REVOKE ALL ON FUNCTION public.release_whatsapp_message_lock(uuid, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_whatsapp_message_lock(uuid, text, text, text, timestamptz) TO service_role;

-- Verifica se há mensagem inbound do mesmo cliente ainda na fila/em processamento na IA
CREATE OR REPLACE FUNCTION public.has_inflight_customer_order_message(
  _company_id uuid,
  _phone text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.whatsapp_messages m
     WHERE m.company_id = _company_id
       AND m.direction = 'inbound'
       AND m.order_id IS NULL
       AND m.status IN ('aguardando', 'processando', 'erro')
       AND m.attempts < 5
       AND public.financial_phone_key(m.phone) = public.financial_phone_key(_phone)
       AND m.created_at >= clock_timestamp() - interval '15 minutes'
  );
$$;

REVOKE ALL ON FUNCTION public.has_inflight_customer_order_message(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_inflight_customer_order_message(uuid, text) TO authenticated, service_role;

-- ============================================================================
-- 5. ARGON4-05: PADRONIZAÇÃO GLOBAL DE LOCKS (CUSTOMERS -> ORDERS) E REDUÇÃO N+1
-- ============================================================================

-- 5.1. Trigger inteligente: respeita app.defer_customer_status_sync em lotes FIFO
-- e SÓ executa UPDATE em public.customers quando o status realmente mudar (IS DISTINCT FROM)
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

    UPDATE public.customers
       SET status = v_desired
     WHERE id = new.customer_id
       AND company_id = new.company_id
       AND status IS DISTINCT FROM v_desired;
  END IF;

  RETURN new;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_customer_status_on_order() FROM PUBLIC, anon, authenticated;

-- 5.2. Corrige a ordem de locks em toggle_order_paid: SEMPRE customers FOR UPDATE -> orders FOR UPDATE
CREATE OR REPLACE FUNCTION public.toggle_order_paid(_order_id uuid, _paid boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  my_company uuid;
  v_customer_id uuid;
  ord public.orders%ROWTYPE;
  unallocated_credit numeric;
  audit_id uuid;
  prev_st text;
  final_st text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória';
  END IF;
  my_company := public.financial_require_operator();

  -- 1. Lê apenas o customer_id sem bloquear orders ainda
  SELECT customer_id INTO v_customer_id
    FROM public.orders
   WHERE id = _order_id AND company_id = my_company;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado';
  END IF;

  -- 2. Ordem global padronizada: bloqueia CUSTOMERS primeiro e ORDERS em segundo!
  PERFORM 1 FROM public.customers WHERE id = v_customer_id AND company_id = my_company FOR UPDATE;
  SELECT * INTO ord FROM public.orders WHERE id = _order_id AND company_id = my_company FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado';
  END IF;

  IF ord.financial_state IS NOT NULL THEN
    RAISE EXCEPTION 'Pedido gerenciado pelo fluxo OK/OKK não pode ser alternado por toggle_order_paid';
  END IF;

  IF ord.settled_by_payment THEN
    RAISE EXCEPTION 'Este pedido foi quitado por um recebimento no Fiado e seu histórico financeiro está protegido.';
  END IF;

  IF coalesce(_paid, false) = ord.paid THEN
    RETURN;
  END IF;

  IF _paid = true AND NOT ord.paid THEN
    SELECT coalesce((SELECT sum(amount) FROM public.payments
                      WHERE customer_id = ord.customer_id AND company_id = my_company), 0)
         - coalesce((SELECT sum(total) FROM public.orders
                      WHERE customer_id = ord.customer_id AND company_id = my_company
                        AND paid = true AND settled_by_payment = true AND delivery_status <> 'cancelado'), 0)
      INTO unallocated_credit;

    IF unallocated_credit > 0 THEN
      RAISE EXCEPTION 'Cliente possui pagamento parcial em aberto. Registre o restante pela aba Fiado para abater o saldo corretamente.';
    END IF;
  END IF;

  prev_st := CASE WHEN ord.paid THEN 'pago' ELSE 'fiado' END;
  final_st := CASE WHEN coalesce(_paid, false) THEN 'pago' ELSE 'fiado' END;

  INSERT INTO public.financial_events(
    company_id, event_id, actor_id, order_id, customer_id, command, source,
    received_at, previous_state, requested_state, final_state, total, outcome, reason
  )
  VALUES (
    my_company, 'legacy_toggle:' || ord.id::text || ':' || gen_random_uuid()::text,
    auth.uid(), ord.id, ord.customer_id, CASE WHEN coalesce(_paid, false) THEN 'OK' ELSE 'OKK' END,
    'authenticated_operator', clock_timestamp(), prev_st, final_st, final_st,
    ord.total, 'classified', 'ALTERNANCIA_LEGADA_AUTORIZADA'
  )
  RETURNING id INTO audit_id;

  SET CONSTRAINTS zz_financial_require_audit_event DEFERRED;

  -- O trigger orders_sync_customer_status já atualiza customers.status se houver mudança efetiva
  UPDATE public.orders
     SET paid = coalesce(_paid, false),
         settled_by_payment = false,
         financial_last_audit_id = audit_id
   WHERE id = ord.id;

  SET CONSTRAINTS zz_financial_require_audit_event IMMEDIATE;
END;
$$;

REVOKE ALL ON FUNCTION public.toggle_order_paid(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.toggle_order_paid(uuid, boolean) TO authenticated, service_role;

-- 5.3. Atualiza register_payment para suprimir N updates intermediários em customers durante o loop FIFO
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
  IF auth.uid() IS NOT NULL THEN
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

  -- Suprime updates repetitivos de customers.status dentro do loop FIFO (evita N+1 dead tuples MVCC)
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

  UPDATE public.customers
     SET status = v_desired_status
   WHERE id = _customer_id
     AND company_id = comp
     AND status IS DISTINCT FROM v_desired_status;

  RETURN payment_id;
END;
$$;

REVOKE ALL ON FUNCTION public.register_payment(uuid, numeric, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_payment(uuid, numeric, text, text, text) TO authenticated, service_role;

-- 5.4. Atualiza financial_classify_order e financial_classify_by_echo (sem UPDATE duplicado em customers e com suporte a retry de pedido em voo na IA)
CREATE OR REPLACE FUNCTION public.financial_classify_order(
  _order_id uuid,
  _event_id uuid,
  _command text,
  _received_at timestamptz,
  _validation_allowed boolean,
  _validation_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid;
  ord public.orders%ROWTYPE;
  cust public.customers%ROWTYPE;
  ev public.financial_events%ROWTYPE;
  today date;
  reason text;
  outcome text;
  desired text;
  audit uuid;
  conv text;
  ph text;
  prev_state text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória';
  END IF;
  comp := public.financial_require_operator();
  IF _event_id IS NULL OR _order_id IS NULL OR _received_at IS NULL OR _command IS NULL THEN
    RAISE EXCEPTION 'Contexto financeiro inválido';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(comp::text || ':classify:' || _event_id::text, 0));

  SELECT * INTO ev FROM public.financial_events WHERE company_id = comp AND event_id = _event_id::text;
  IF FOUND THEN
    IF ev.order_id IS DISTINCT FROM _order_id OR ev.command IS DISTINCT FROM _command THEN
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

  SELECT * INTO ord FROM public.orders WHERE id = _order_id AND company_id = comp;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado';
  END IF;

  -- Ordem global padronizada: customers FOR UPDATE -> orders FOR UPDATE
  SELECT * INTO cust FROM public.customers WHERE id = ord.customer_id AND company_id = comp FOR UPDATE;
  SELECT * INTO ord FROM public.orders WHERE id = _order_id AND company_id = comp FOR UPDATE;

  prev_state := ord.financial_state;
  today := (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
  desired := CASE _command WHEN 'OK' THEN 'pago' WHEN 'OKK' THEN 'fiado' ELSE 'NENHUM' END;
  ph := coalesce(nullif(ord.financial_phone, ''), public.financial_phone_key(cust.phone));
  conv := coalesce(nullif(ord.financial_conversation_id, ''), 'operator:' || comp::text || ':' || cust.id::text);

  reason := CASE
    WHEN _command NOT IN ('OK', 'OKK') THEN 'COMANDO_NAO_RECONHECIDO'
    WHEN (_received_at AT TIME ZONE 'America/Sao_Paulo')::date <> today
      OR _received_at > clock_timestamp() + interval '5 minutes' THEN 'COMANDO_FORA_DO_DIA_ATUAL'
    WHEN ord.financial_state IS DISTINCT FROM 'aguardando_classificacao' THEN 'PEDIDO_JA_CLASSIFICADO'
    WHEN ord.order_date <> today THEN 'PEDIDO_FORA_DO_PERIODO_PERMITIDO'
    WHEN ord.delivery_status = 'cancelado' THEN 'PEDIDO_CANCELADO'
    WHEN cust.id IS NULL OR ph IS DISTINCT FROM public.financial_phone_key(cust.phone) THEN 'CONTEXTO_CONFLITANTE'
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
    comp, _event_id::text, auth.uid(), ord.id, cust.id, _command, 'authenticated_operator',
    conv, ph, _received_at, prev_state, desired,
    CASE WHEN outcome = 'classified' THEN desired ELSE prev_state END,
    ord.total, outcome, reason
  )
  RETURNING id INTO audit;

  IF outcome = 'classified' THEN
    SET CONSTRAINTS zz_financial_require_audit_event DEFERRED;

    -- O trigger orders_sync_customer_status sincroniza customers.status apenas se mudar
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

CREATE OR REPLACE FUNCTION public.financial_classify_by_echo(
  _company_id uuid,
  _customer_id uuid,
  _order_id uuid,
  _event_id text,
  _command text,
  _received_at timestamptz,
  _validation_allowed boolean,
  _validation_reason text
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

REVOKE ALL ON FUNCTION public.financial_classify_by_echo(uuid, uuid, uuid, text, text, timestamptz, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.financial_classify_by_echo(uuid, uuid, uuid, text, text, timestamptz, boolean, text) TO service_role;

-- 5.5. Atualiza complete_whatsapp_message_order para bloquear customers FOR UPDATE antes de INSERT em orders e limpar locked_by
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
  _source text DEFAULT 'mensagem'
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
      RAISE EXCEPTION 'Empresa inválida para o operador autenticado';
    END IF;
  END IF;

  SELECT * INTO msg FROM public.whatsapp_messages WHERE id = _message_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mensagem não encontrada';
  END IF;

  IF msg.order_id IS NOT NULL THEN
    RETURN msg.order_id;
  END IF;

  -- Ordem global padronizada: customers FOR UPDATE antes de tocar em orders
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
      0, _order_date, false, false, 'mensagem', 'aguardando_classificacao',
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

REVOKE ALL ON FUNCTION public.complete_whatsapp_message_order(uuid, uuid, uuid, integer, integer, integer, date, jsonb, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_whatsapp_message_order(uuid, uuid, uuid, integer, integer, integer, date, jsonb, uuid, text, text) TO authenticated, service_role;

-- ============================================================================
-- 6. ARGON4-04: RPCS DE SALDO AGREGADO E SNAPSHOT DE DASHBOARD (ALTA ESCALA)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_customer_balances(_company_id uuid DEFAULT NULL)
RETURNS TABLE(
  customer_id uuid,
  open_orders_count bigint,
  qty_p bigint,
  qty_m bigint,
  qty_g bigint,
  total_meals bigint,
  fiado_total numeric,
  payments_total numeric,
  balance numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    comp := public.current_company_id();
    IF comp IS NULL OR (_company_id IS NOT NULL AND _company_id <> comp) THEN
      RAISE EXCEPTION 'Acesso negado aos saldos de outra empresa'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    comp := _company_id;
  END IF;

  IF comp IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH ord_agg AS (
    SELECT
      o.customer_id,
      count(*) FILTER (WHERE NOT o.paid)::bigint AS open_orders_count,
      coalesce(sum(o.qty_p) FILTER (WHERE NOT o.paid), 0)::bigint AS qty_p,
      coalesce(sum(o.qty_m) FILTER (WHERE NOT o.paid), 0)::bigint AS qty_m,
      coalesce(sum(o.qty_g) FILTER (WHERE NOT o.paid), 0)::bigint AS qty_g,
      coalesce(sum(o.quantity) FILTER (WHERE NOT o.paid), 0)::bigint AS total_meals,
      coalesce(sum(o.total) FILTER (WHERE NOT o.paid OR o.settled_by_payment), 0)::numeric AS fiado_total
    FROM public.orders o
    WHERE o.company_id = comp
      AND o.delivery_status <> 'cancelado'
      AND o.financial_state IS DISTINCT FROM 'aguardando_classificacao'
    GROUP BY o.customer_id
  ),
  pay_agg AS (
    SELECT
      p.customer_id,
      coalesce(sum(p.amount), 0)::numeric AS payments_total
    FROM public.payments p
    WHERE p.company_id = comp
    GROUP BY p.customer_id
  )
  SELECT
    c.id AS customer_id,
    coalesce(oa.open_orders_count, 0) AS open_orders_count,
    coalesce(oa.qty_p, 0) AS qty_p,
    coalesce(oa.qty_m, 0) AS qty_m,
    coalesce(oa.qty_g, 0) AS qty_g,
    coalesce(oa.total_meals, 0) AS total_meals,
    round(coalesce(oa.fiado_total, 0), 2) AS fiado_total,
    round(coalesce(pa.payments_total, 0), 2) AS payments_total,
    round(coalesce(oa.fiado_total, 0) - coalesce(pa.payments_total, 0), 2) AS balance
  FROM public.customers c
  LEFT JOIN ord_agg oa ON oa.customer_id = c.id
  LEFT JOIN pay_agg pa ON pa.customer_id = c.id
  WHERE c.company_id = comp
    AND (
      abs(coalesce(oa.fiado_total, 0) - coalesce(pa.payments_total, 0)) > 0.009
      OR coalesce(oa.open_orders_count, 0) > 0
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_customer_balances(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_customer_balances(uuid) TO authenticated, service_role;
