-- Migração 0013: Segunda Rodada de Correções e Hardening Pós-Auditoria Independente Argon 4 (AUD-01 a AUD-10)
-- 100% incremental, aditiva e não destrutiva (preserva integralmente 0000 a 0012).
-- Escopo:
--   AUD-01: Lease fencing (lease_generation) e validação estrita de propriedade (locked_by + lease_generation)
--           em claim_whatsapp_queue_batch, renew_whatsapp_message_lock, release_whatsapp_message_lock e
--           complete_whatsapp_message_order (impede que worker com lease expirado sobrescreva estado final).
--   AUD-03: RPC atômica get_or_create_customer_by_phone com advisory lock por telefone normalizado
--           (elimina varredura completa de clientes em telefones novos).
--   AUD-04: Escalonamento justo multi-tenant e causal por cliente em claim_whatsapp_queue_batch
--           (elimina inanição/starvation de ecos comerciais OK/OKK sob backlog elevado de mensagens inbound).
--   AUD-08: RPCs de paginação por cursor real (keyset pagination) no PostgreSQL (list_orders_cursor,
--           list_payments_cursor, list_customers_cursor) utilizando índices compostos determinísticos.
--   AUD-10: Política RLS "update own company" + trigger BEFORE UPDATE em public.companies que levanta
--           exceção explícita (SQLSTATE 42501) para operadores não-admin da mesma empresa (nunca UPDATE 0 silencioso).

-- ============================================================================
-- 1. AUD-01 & AUD-04: LEASE FENCING (LEASE_GENERATION) E ESCALONAMENTO JUSTO NA FILA
-- ============================================================================

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS lease_generation bigint NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS public.whatsapp_messages_queue_idx;
CREATE INDEX IF NOT EXISTS whatsapp_messages_queue_idx
  ON public.whatsapp_messages (company_id, status, direction, next_retry_at, locked_until, created_at ASC, id ASC)
  WHERE order_id IS NULL AND status IN ('aguardando', 'processando', 'erro');

CREATE INDEX IF NOT EXISTS whatsapp_messages_inflight_phone_idx
  ON public.whatsapp_messages (company_id, public.financial_phone_key(phone), created_at DESC)
  WHERE direction = 'inbound' AND order_id IS NULL AND status IN ('aguardando', 'processando', 'erro');

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
  WITH eligible AS (
    SELECT
      m.id,
      m.company_id,
      m.direction,
      m.created_at,
      -- Ordem causal por cliente: um eco outbound só aguarda atrás de inbound se houver
      -- mensagem inbound elegível/em processamento para o MESMO (company_id, telefone normalizado)
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
      -- Intercalação justa (round-robin) por (company_id, direction) para impedir que um
      -- backlog de 1.000+ mensagens inbound ou de uma única empresa cause starvation de ecos OK/OKK
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
        OR (m.status = 'processando' AND (m.locked_until IS NULL OR m.locked_until < clock_timestamp()))
      )
  ),
  candidates AS (
    SELECT e.id
      FROM eligible e
     ORDER BY
       e.causal_wait ASC,
       e.fairness_slot ASC,
       CASE WHEN e.direction = 'inbound' THEN 0 ELSE 1 END ASC,
       e.created_at ASC,
       e.id ASC
     LIMIT effective_limit
     FOR UPDATE OF e SKIP LOCKED
  ),
  locked_rows AS (
    SELECT m.id
      FROM public.whatsapp_messages m
      JOIN candidates c ON c.id = m.id
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

DROP FUNCTION IF EXISTS public.renew_whatsapp_message_lock(uuid, text, integer);
DROP FUNCTION IF EXISTS public.renew_whatsapp_message_lock(uuid, text, integer, bigint);

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

DROP FUNCTION IF EXISTS public.release_whatsapp_message_lock(uuid, text, text, text, timestamptz);
DROP FUNCTION IF EXISTS public.release_whatsapp_message_lock(uuid, text, text, text, timestamptz, bigint, uuid, jsonb);

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

  -- AUD-01: Validação estrita de posse do lease!
  -- Nunca permite que um worker cujo lease expirou e foi adquirido por outro worker
  -- sobrescreva o status ou libere o lock pertencente ao novo worker.
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

-- AUD-01: Atualiza complete_whatsapp_message_order com validação de fencing (_worker_id e _lease_generation)
DROP FUNCTION IF EXISTS public.complete_whatsapp_message_order(uuid, uuid, uuid, integer, integer, integer, date, jsonb, uuid, text, text);
DROP FUNCTION IF EXISTS public.complete_whatsapp_message_order(uuid, uuid, uuid, integer, integer, integer, date, jsonb, uuid, text, text, text, bigint);

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

  -- AUD-01: Validação de posse do lease antes de criar pedido ou concluir a mensagem
  IF _worker_id IS NOT NULL AND msg.locked_by IS NOT NULL AND msg.locked_by IS DISTINCT FROM _worker_id THEN
    RAISE EXCEPTION 'LEASE_LOST: mensagem % foi reclamada por outro worker (%)', _message_id, msg.locked_by
      USING ERRCODE = '55P03';
  END IF;

  IF _lease_generation IS NOT NULL AND msg.lease_generation IS DISTINCT FROM _lease_generation THEN
    RAISE EXCEPTION 'LEASE_LOST: geração de lease obsoleta para mensagem % (esperada %, atual %)',
      _message_id, _lease_generation, msg.lease_generation
      USING ERRCODE = '55P03';
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

-- ============================================================================
-- 2. AUD-03: RPC ATÔMICA GET_OR_CREATE_CUSTOMER_BY_PHONE (SEM FULL SCAN)
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
  IF _company_id IS NULL OR length(norm_key) < 8 THEN
    RETURN;
  END IF;

  IF auth.uid() IS NOT NULL THEN
    IF _company_id IS DISTINCT FROM public.current_company_id() THEN
      RAISE EXCEPTION 'Acesso negado aos clientes de outra empresa'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Serializa criação/busca por (company_id, telefone normalizado) sem varrer a tabela
  PERFORM pg_advisory_xact_lock(hashtextextended(_company_id::text || ':cust_phone:' || norm_key, 0));

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

  INSERT INTO public.customers(company_id, phone, name)
  VALUES (_company_id, norm_key, resolved_name)
  RETURNING customers.id, customers.name, customers.phone
  INTO found_rec;

  RETURN QUERY SELECT found_rec.id, found_rec.name, found_rec.phone, true;
END;
$$;

REVOKE ALL ON FUNCTION public.get_or_create_customer_by_phone(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_or_create_customer_by_phone(uuid, text, text) TO authenticated, service_role;

-- ============================================================================
-- 3. AUD-08: RPCS DE PAGINAÇÃO POR CURSOR REAL (KEYSET PAGINATION) NO POSTGRESQL
-- ============================================================================

CREATE OR REPLACE FUNCTION public.list_orders_cursor(
  _company_id uuid DEFAULT NULL,
  _from_date date DEFAULT NULL,
  _to_date date DEFAULT NULL,
  _only_unpaid boolean DEFAULT false,
  _cursor_order_date date DEFAULT NULL,
  _cursor_created_at timestamptz DEFAULT NULL,
  _cursor_id uuid DEFAULT NULL,
  _page_size integer DEFAULT 100
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid;
  eff_limit integer := least(greatest(coalesce(_page_size, 100), 1), 1000);
BEGIN
  IF auth.uid() IS NOT NULL THEN
    comp := public.current_company_id();
    IF comp IS NULL OR (_company_id IS NOT NULL AND _company_id <> comp) THEN
      RAISE EXCEPTION 'Acesso negado aos pedidos de outra empresa'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    comp := _company_id;
  END IF;

  IF comp IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    to_jsonb(o) || jsonb_build_object(
      'customers',
      CASE
        WHEN c.id IS NOT NULL THEN jsonb_build_object('name', c.name, 'phone', c.phone)
        ELSE NULL
      END
    )
  FROM public.orders o
  LEFT JOIN public.customers c
    ON c.id = o.customer_id AND c.company_id = o.company_id
  WHERE o.company_id = comp
    AND (_from_date IS NULL OR o.order_date >= _from_date)
    AND (_to_date IS NULL OR o.order_date <= _to_date)
    AND (NOT coalesce(_only_unpaid, false) OR (o.paid = false AND o.delivery_status <> 'cancelado'))
    AND (
      _cursor_order_date IS NULL
      OR _cursor_created_at IS NULL
      OR _cursor_id IS NULL
      OR (o.order_date, o.created_at, o.id) < (_cursor_order_date, _cursor_created_at, _cursor_id)
    )
  ORDER BY o.order_date DESC, o.created_at DESC, o.id DESC
  LIMIT eff_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.list_orders_cursor(uuid, date, date, boolean, date, timestamptz, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_orders_cursor(uuid, date, date, boolean, date, timestamptz, uuid, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_payments_cursor(
  _company_id uuid DEFAULT NULL,
  _customer_id uuid DEFAULT NULL,
  _from_paid_at timestamptz DEFAULT NULL,
  _to_paid_at timestamptz DEFAULT NULL,
  _cursor_paid_at timestamptz DEFAULT NULL,
  _cursor_id uuid DEFAULT NULL,
  _page_size integer DEFAULT 100
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid;
  eff_limit integer := least(greatest(coalesce(_page_size, 100), 1), 1000);
BEGIN
  IF auth.uid() IS NOT NULL THEN
    comp := public.current_company_id();
    IF comp IS NULL OR (_company_id IS NOT NULL AND _company_id <> comp) THEN
      RAISE EXCEPTION 'Acesso negado aos pagamentos de outra empresa'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    comp := _company_id;
  END IF;

  IF comp IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    to_jsonb(p) || jsonb_build_object(
      'customers',
      CASE
        WHEN c.id IS NOT NULL THEN jsonb_build_object('name', c.name)
        ELSE NULL
      END
    )
  FROM public.payments p
  LEFT JOIN public.customers c
    ON c.id = p.customer_id AND c.company_id = p.company_id
  WHERE p.company_id = comp
    AND (_customer_id IS NULL OR p.customer_id = _customer_id)
    AND (_from_paid_at IS NULL OR p.paid_at >= _from_paid_at)
    AND (_to_paid_at IS NULL OR p.paid_at <= _to_paid_at)
    AND (
      _cursor_paid_at IS NULL
      OR _cursor_id IS NULL
      OR (p.paid_at, p.id) < (_cursor_paid_at, _cursor_id)
    )
  ORDER BY p.paid_at DESC, p.id DESC
  LIMIT eff_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.list_payments_cursor(uuid, uuid, timestamptz, timestamptz, timestamptz, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_payments_cursor(uuid, uuid, timestamptz, timestamptz, timestamptz, uuid, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_customers_cursor(
  _company_id uuid DEFAULT NULL,
  _statuses public.customer_status[] DEFAULT NULL,
  _search text DEFAULT NULL,
  _cursor_name text DEFAULT NULL,
  _cursor_id uuid DEFAULT NULL,
  _page_size integer DEFAULT 100
)
RETURNS SETOF public.customers
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid;
  eff_limit integer := least(greatest(coalesce(_page_size, 100), 1), 1000);
  clean_search text := nullif(btrim(coalesce(_search, '')), '');
BEGIN
  IF auth.uid() IS NOT NULL THEN
    comp := public.current_company_id();
    IF comp IS NULL OR (_company_id IS NOT NULL AND _company_id <> comp) THEN
      RAISE EXCEPTION 'Acesso negado aos clientes de outra empresa'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    comp := _company_id;
  END IF;

  IF comp IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT c.*
    FROM public.customers c
   WHERE c.company_id = comp
     AND (_statuses IS NULL OR c.status = ANY(_statuses))
     AND (clean_search IS NULL OR c.name ILIKE '%' || clean_search || '%')
     AND (
       _cursor_name IS NULL
       OR _cursor_id IS NULL
       OR (c.name, c.id) > (_cursor_name, _cursor_id)
     )
   ORDER BY c.name ASC, c.id ASC
   LIMIT eff_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.list_customers_cursor(uuid, public.customer_status[], text, text, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_customers_cursor(uuid, public.customer_status[], text, text, uuid, integer) TO authenticated, service_role;

-- ============================================================================
-- 4. AUD-10: ERRO EXPLÍCITO (42501) EM TENTATIVA DE ALTERAÇÃO DE PREÇOS POR NÃO-ADMIN
-- ============================================================================

-- Ao manter USING (id = public.current_company_id()) e exigir public.is_company_admin(id)
-- no WITH CHECK e no trigger BEFORE UPDATE companies_guard_admin_update, qualquer operador
-- autenticado sem permissão administrativa da própria empresa encontra a linha da sua empresa
-- e aciona imediatamente o trigger BEFORE UPDATE / WITH CHECK, que levanta ERRCODE = '42501'
-- em vez de retornar UPDATE 0 silencioso. Operadores de outras empresas continuam isolados pelo USING.
DROP POLICY IF EXISTS "update own company" ON public.companies;
CREATE POLICY "update own company"
  ON public.companies
  FOR UPDATE
  TO authenticated
  USING (
    id = public.current_company_id()
  )
  WITH CHECK (
    id = public.current_company_id()
    AND public.is_company_admin(id)
  );
