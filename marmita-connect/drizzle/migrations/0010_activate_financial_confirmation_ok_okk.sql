-- Migração 0010: Ativação do fluxo de confirmação financeira OK / OKK
-- 100% aditiva e não destrutiva: preserva histórico (financial_state = NULL), sem backfill,
-- e não exige CREATE ROLE ... BYPASSRLS (usa SECURITY DEFINER compatível com Supabase/Cloud).

-- 1. Colunas financeiras em public.orders
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS financial_state text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS financial_conversation_id text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS financial_phone text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS financial_creation_event uuid;

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_financial_state_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_financial_state_check
  CHECK (financial_state IS NULL OR financial_state IN ('aguardando_classificacao', 'pago', 'fiado'));

COMMENT ON COLUMN public.orders.financial_state IS
  'NULL preserva pedidos legados; aguardando_classificacao não entra em vendas pagas nem em Contas a Receber até confirmação OK (pago) ou OKK (fiado).';

CREATE UNIQUE INDEX IF NOT EXISTS orders_financial_creation_event_unique
  ON public.orders(company_id, financial_creation_event)
  WHERE financial_creation_event IS NOT NULL;

CREATE INDEX IF NOT EXISTS orders_financial_pending_customer
  ON public.orders(company_id, customer_id, order_date)
  WHERE financial_state = 'aguardando_classificacao';

-- 2. Tabelas de permissões e auditoria imutável
CREATE TABLE IF NOT EXISTS public.financial_permissions (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  can_classify boolean NOT NULL DEFAULT true,
  PRIMARY KEY (company_id, user_id)
);

GRANT SELECT ON public.financial_permissions TO authenticated;
GRANT ALL ON public.financial_permissions TO service_role;
ALTER TABLE public.financial_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS financial_permission_own_read ON public.financial_permissions;
CREATE POLICY financial_permission_own_read ON public.financial_permissions
  FOR SELECT TO authenticated
  USING (company_id = public.current_company_id() AND user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.financial_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  event_id text NOT NULL,
  actor_id uuid,
  order_id uuid,
  customer_id uuid,
  command text NOT NULL,
  source text NOT NULL DEFAULT 'authenticated_operator',
  conversation_id text,
  phone text,
  received_at timestamptz NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  previous_state text,
  requested_state text NOT NULL,
  final_state text,
  total numeric,
  outcome text NOT NULL,
  reason text NOT NULL,
  UNIQUE(company_id, event_id)
);

GRANT SELECT ON public.financial_events TO authenticated;
GRANT SELECT, INSERT ON public.financial_events TO service_role;
ALTER TABLE public.financial_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS financial_events_company_read ON public.financial_events;
CREATE POLICY financial_events_company_read ON public.financial_events
  FOR SELECT TO authenticated
  USING (company_id = public.current_company_id());

CREATE OR REPLACE FUNCTION public.financial_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Auditoria financeira é imutável';
END;
$$;

REVOKE ALL ON FUNCTION public.financial_audit_immutable() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS financial_audit_immutable ON public.financial_events;
CREATE TRIGGER financial_audit_immutable
  BEFORE UPDATE OR DELETE ON public.financial_events
  FOR EACH ROW EXECUTE FUNCTION public.financial_audit_immutable();

-- 3. Normalizador de telefone no banco (idêntico a phoneKey do backend)
CREATE OR REPLACE FUNCTION public.financial_phone_key(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN length(d) IN (12,13) AND left(d,2) = '55' THEN substr(d,3) ELSE d END
  FROM (SELECT regexp_replace(coalesce(raw,''), '[^0-9]', '', 'g') AS d) x;
$$;

REVOKE ALL ON FUNCTION public.financial_phone_key(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.financial_phone_key(text) TO authenticated, service_role;

-- 4. Verificação de permissão do operador da marmitaria:
-- Autoriza usuários vinculados à empresa em public.profiles que sejam admin em user_roles,
-- ou possuam can_classify = true em financial_permissions, ou sejam membros ativos da empresa
-- sem bloqueio explícito (can_classify = false).
CREATE OR REPLACE FUNCTION public.financial_require_operator()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid;
  explicit_perm boolean;
BEGIN
  SELECT company_id INTO comp FROM public.profiles WHERE id = auth.uid();
  IF comp IS NULL THEN
    RAISE EXCEPTION 'Empresa não encontrada';
  END IF;

  SELECT can_classify INTO explicit_perm
  FROM public.financial_permissions
  WHERE company_id = comp AND user_id = auth.uid();

  IF explicit_perm IS FALSE THEN
    RAISE EXCEPTION 'Permissão financeira necessária';
  END IF;

  IF explicit_perm IS NULL AND NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    -- Caso a tabela financial_permissions já tenha registros na empresa mas não para este usuário
    IF EXISTS (SELECT 1 FROM public.financial_permissions WHERE company_id = comp) THEN
      RAISE EXCEPTION 'Permissão financeira necessária';
    END IF;
  END IF;

  RETURN comp;
END;
$$;

REVOKE ALL ON FUNCTION public.financial_require_operator() FROM PUBLIC, anon, authenticated;

-- 5. Proteção de consistência em public.orders para estados financeiros (OK / OKK / aguardando_classificacao)
CREATE OR REPLACE FUNCTION public.financial_guard_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.financial_state IS NOT NULL THEN
      RAISE EXCEPTION 'Pedido financeiro não pode ser excluído';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Nunca permitir que um pedido já classificado (pago ou fiado) volte para aguardando_classificacao
    -- ou troque sua classificação inicial (pago <-> fiado) sem passar por pagamento no Fiado.
    IF OLD.financial_state IN ('pago', 'fiado') AND NEW.financial_state IS DISTINCT FROM OLD.financial_state THEN
      RAISE EXCEPTION 'Pedido já possui classificação financeira definitiva';
    END IF;
    IF OLD.financial_state IS NULL AND NEW.financial_state IS NOT NULL THEN
      RAISE EXCEPTION 'Pedido legado não pode ser reclassificado';
    END IF;
    -- Preserva valor e quantidades de pedidos gerenciados após criação
    IF OLD.financial_state IS NOT NULL AND (
      NEW.company_id, NEW.customer_id, NEW.order_date, NEW.quantity,
      NEW.qty_g, coalesce(NEW.qty_m, 0), NEW.qty_p, NEW.unit_price, NEW.total
    ) IS DISTINCT FROM (
      OLD.company_id, OLD.customer_id, OLD.order_date, OLD.quantity,
      OLD.qty_g, coalesce(OLD.qty_m, 0), OLD.qty_p, OLD.unit_price, OLD.total
    ) THEN
      RAISE EXCEPTION 'Pedido financeiro preserva vínculos, quantidades e valor original';
    END IF;
  END IF;

  IF NEW.financial_state IS NOT NULL THEN
    IF NEW.financial_state = 'aguardando_classificacao' AND (NEW.paid OR NEW.settled_by_payment) THEN
      RAISE EXCEPTION 'Pedido aguardando classificação não pode estar pago nem quitado';
    END IF;
    IF NEW.financial_state = 'pago' AND (NOT NEW.paid OR NEW.settled_by_payment) THEN
      RAISE EXCEPTION 'Classificação OK (pago) deve ser pagamento na hora';
    END IF;
    IF NEW.financial_state = 'fiado' AND NEW.paid <> NEW.settled_by_payment THEN
      RAISE EXCEPTION 'Pedido fiado só pode ser quitado por recebimento no Contas a Receber';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.financial_guard_order() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_financial_guard_order ON public.orders;
CREATE TRIGGER zz_financial_guard_order
  BEFORE INSERT OR UPDATE OR DELETE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.financial_guard_order();

-- 6. Sincronização de status do cliente: pedidos aguardando_classificacao NUNCA deixam o cliente 'pendente'
CREATE OR REPLACE FUNCTION public.sync_customer_status_on_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF new.customer_id IS NOT NULL AND (
    tg_op = 'INSERT'
    OR old.paid IS DISTINCT FROM new.paid
    OR old.delivery_status IS DISTINCT FROM new.delivery_status
    OR old.financial_state IS DISTINCT FROM new.financial_state
  ) THEN
    UPDATE public.customers
       SET status = CASE
         WHEN EXISTS (
           SELECT 1 FROM public.orders
           WHERE customer_id = new.customer_id
             AND company_id = new.company_id
             AND paid = false
             AND delivery_status <> 'cancelado'
             AND financial_state IS DISTINCT FROM 'aguardando_classificacao'
         )
         THEN 'pendente'::public.customer_status
         ELSE 'em_dia'::public.customer_status
       END
     WHERE id = new.customer_id AND company_id = new.company_id;
  END IF;
  RETURN new;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_customer_status_on_order() FROM public, anon, authenticated;
DROP TRIGGER IF EXISTS orders_sync_customer_status ON public.orders;
CREATE TRIGGER orders_sync_customer_status
  AFTER INSERT OR UPDATE OF paid, delivery_status, financial_state ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.sync_customer_status_on_order();

-- 7. Baixa FIFO de pagamentos (register_payment): ignora pedidos aguardando_classificacao
CREATE OR REPLACE FUNCTION public.register_payment(
  _customer_id uuid,
  _amount numeric,
  _method text DEFAULT 'manual',
  _notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid := public.current_company_id();
  cust_comp uuid;
  credit numeric;
  ord record;
  payment_id uuid;
BEGIN
  IF comp IS NULL THEN
    RAISE EXCEPTION 'Empresa não encontrada para o usuário';
  END IF;
  IF _amount IS NULL OR _amount <= 0 OR NOT (_amount < 'Infinity'::numeric) THEN
    RAISE EXCEPTION 'Valor do pagamento deve ser maior que zero';
  END IF;

  SELECT company_id INTO cust_comp FROM public.customers WHERE id = _customer_id FOR UPDATE;
  IF cust_comp IS NULL OR cust_comp <> comp THEN
    RAISE EXCEPTION 'Cliente não encontrado';
  END IF;

  INSERT INTO public.payments(company_id, customer_id, amount, method, notes)
  VALUES (comp, _customer_id, round(_amount, 2), coalesce(_method, 'manual'), _notes)
  RETURNING id INTO payment_id;

  SELECT coalesce((SELECT sum(amount) FROM public.payments WHERE customer_id = _customer_id AND company_id = comp), 0)
       - coalesce((SELECT sum(total) FROM public.orders WHERE customer_id = _customer_id AND company_id = comp
                     AND paid = true AND settled_by_payment = true AND delivery_status <> 'cancelado'), 0)
    INTO credit;

  FOR ord IN
    SELECT id, total FROM public.orders
    WHERE customer_id = _customer_id
      AND company_id = comp
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

  UPDATE public.customers
     SET status = CASE
       WHEN EXISTS (
         SELECT 1 FROM public.orders
         WHERE customer_id = _customer_id
           AND company_id = comp
           AND paid = false
           AND delivery_status <> 'cancelado'
           AND financial_state IS DISTINCT FROM 'aguardando_classificacao'
       )
       THEN 'pendente'::public.customer_status
       ELSE 'em_dia'::public.customer_status
     END
   WHERE id = _customer_id;

  RETURN payment_id;
END;
$$;

REVOKE ALL ON FUNCTION public.register_payment(uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_payment(uuid, numeric, text, text) TO authenticated, service_role;

-- 8. Contexto financeiro para avaliação de comando OK / OKK pelo operador autenticado
CREATE OR REPLACE FUNCTION public.financial_command_context(
  _order_id uuid,
  _event_id uuid,
  _command text,
  _received_at timestamptz
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
  conv text;
  ph text;
BEGIN
  comp := public.financial_require_operator();

  SELECT * INTO ord FROM public.orders WHERE id = _order_id AND company_id = comp;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado';
  END IF;

  SELECT * INTO cust FROM public.customers WHERE id = ord.customer_id AND company_id = comp;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente não encontrado';
  END IF;

  ph := coalesce(nullif(ord.financial_phone, ''), public.financial_phone_key(cust.phone));
  conv := coalesce(nullif(ord.financial_conversation_id, ''), 'operator:' || comp::text || ':' || cust.id::text);

  RETURN jsonb_build_object(
    'body', _command,
    'eventId', _event_id::text,
    'source', 'authenticated_operator',
    'actorAuthorized', true,
    'provenanceVerified', true,
    'standalone', true,
    'quoted', false,
    'forwarded', false,
    'companyId', comp,
    'customerId', cust.id,
    'conversationId', conv,
    'phone', cust.phone,
    'today', (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text,
    'commandDate', (_received_at AT TIME ZONE 'America/Sao_Paulo')::date::text,
    'explicitOrderId', ord.id,
    'processedEventIds', coalesce(
      (SELECT jsonb_agg(event_id) FROM public.financial_events WHERE company_id = comp AND event_id = _event_id::text),
      '[]'::jsonb
    ),
    'orders', jsonb_build_array(
      jsonb_build_object(
        'id', ord.id,
        'companyId', comp,
        'customerId', ord.customer_id,
        'conversationId', conv,
        'phone', ph,
        'date', ord.order_date::text,
        'total', ord.total,
        'state', CASE ord.financial_state
          WHEN 'aguardando_classificacao' THEN 'PENDENTE'
          WHEN 'pago' THEN 'PAGO'
          ELSE 'FIADO'
        END,
        'cancelled', ord.delivery_status = 'cancelado',
        'paymentState', CASE WHEN ord.settled_by_payment THEN 'UNKNOWN' ELSE 'NONE' END,
        'confirmed', ord.financial_state IS DISTINCT FROM 'aguardando_classificacao'
      )
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.financial_command_context(uuid, uuid, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.financial_command_context(uuid, uuid, text, timestamptz) TO authenticated;

-- 9. Commit transacional de classificação financeira OK / OKK pelo operador autenticado
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
BEGIN
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

  -- Ordem fixa de lock (customer -> order) para impedir deadlocks em chamadas concorrentes
  SELECT * INTO cust FROM public.customers WHERE id = ord.customer_id AND company_id = comp FOR UPDATE;
  SELECT * INTO ord FROM public.orders WHERE id = _order_id AND company_id = comp FOR UPDATE;

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

  IF outcome = 'classified' THEN
    UPDATE public.orders
       SET financial_state = desired,
           paid = (_command = 'OK'),
           settled_by_payment = false,
           financial_phone = ph,
           financial_conversation_id = conv
     WHERE id = ord.id;

    UPDATE public.customers
       SET status = CASE
         WHEN EXISTS (
           SELECT 1 FROM public.orders
           WHERE company_id = comp
             AND customer_id = cust.id
             AND NOT paid
             AND delivery_status <> 'cancelado'
             AND financial_state IS DISTINCT FROM 'aguardando_classificacao'
         )
         THEN 'pendente'::public.customer_status
         ELSE 'em_dia'::public.customer_status
       END
     WHERE id = cust.id;
  END IF;

  INSERT INTO public.financial_events(
    company_id, event_id, actor_id, order_id, customer_id, command, source,
    conversation_id, phone, received_at, previous_state, requested_state,
    final_state, total, outcome, reason
  )
  VALUES (
    comp, _event_id::text, auth.uid(), ord.id, cust.id, _command, 'authenticated_operator',
    conv, ph, _received_at, ord.financial_state, desired,
    CASE WHEN outcome = 'classified' THEN desired ELSE ord.financial_state END,
    ord.total, outcome, reason
  )
  RETURNING id INTO audit;

  RETURN jsonb_build_object(
    'outcome', outcome,
    'reason', reason,
    'order_id', ord.id,
    'state', CASE WHEN outcome = 'classified' THEN desired ELSE ord.financial_state END,
    'total', ord.total,
    'audit_id', audit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.financial_classify_order(uuid, uuid, text, timestamptz, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.financial_classify_order(uuid, uuid, text, timestamptz, boolean, text) TO authenticated, service_role;

-- 10. Criação optante de pedido pendente via RPC (compatibilidade com suíte de testes)
CREATE OR REPLACE FUNCTION public.financial_create_pending(
  _customer_id uuid,
  _qty_g integer,
  _qty_p integer,
  _event_id uuid,
  _qty_m integer DEFAULT 0
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
  phone text;
  m_val integer := coalesce(_qty_m, 0);
BEGIN
  comp := public.financial_require_operator();
  IF _event_id IS NULL OR _qty_g IS NULL OR _qty_p IS NULL OR _qty_g < 0 OR _qty_p < 0 OR m_val < 0
     OR (_qty_g::bigint + _qty_p + m_val) < 1 OR (_qty_g::bigint + _qty_p + m_val) > 10000 THEN
    RAISE EXCEPTION 'Quantidades ou evento inválidos';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(comp::text || ':create:' || _event_id::text, 0));

  SELECT * INTO ord FROM public.orders WHERE company_id = comp AND financial_creation_event = _event_id;
  IF FOUND THEN
    IF ord.customer_id <> _customer_id OR ord.qty_g <> _qty_g OR ord.qty_p <> _qty_p OR coalesce(ord.qty_m, 0) <> m_val THEN
      RAISE EXCEPTION 'Evento de criação conflitante';
    END IF;
    RETURN to_jsonb(ord);
  END IF;

  SELECT * INTO cust FROM public.customers WHERE id = _customer_id AND company_id = comp FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente não encontrado';
  END IF;

  phone := public.financial_phone_key(cust.phone);
  IF phone !~ '^[0-9]{10,11}$' THEN
    RAISE EXCEPTION 'Telefone do cliente inválido';
  END IF;

  INSERT INTO public.orders(
    company_id, customer_id, qty_g, qty_m, qty_p, quantity, unit_price, order_date,
    paid, settled_by_payment, financial_state, financial_conversation_id,
    financial_phone, financial_creation_event, source
  )
  VALUES (
    comp, cust.id, _qty_g, m_val, _qty_p, _qty_g + m_val + _qty_p, 0,
    (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,
    false, false, 'aguardando_classificacao',
    'operator:' || comp::text || ':' || cust.id::text,
    phone, _event_id, 'financial_operator'
  )
  RETURNING * INTO ord;

  RETURN to_jsonb(ord);
END;
$$;

REVOKE ALL ON FUNCTION public.financial_create_pending(uuid, integer, integer, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.financial_create_pending(uuid, integer, integer, uuid, integer) TO authenticated, service_role;

-- 11. Atualização de status de entrega de pedido financeiro
CREATE OR REPLACE FUNCTION public.financial_update_delivery(
  _order_id uuid,
  _status public.delivery_status
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid;
  cust uuid;
BEGIN
  comp := public.financial_require_operator();
  SELECT customer_id INTO cust FROM public.orders WHERE id = _order_id AND company_id = comp AND financial_state IS NOT NULL;
  IF NOT FOUND OR _status IS NULL THEN
    RAISE EXCEPTION 'Pedido financeiro não encontrado';
  END IF;
  PERFORM 1 FROM public.customers WHERE id = cust AND company_id = comp FOR UPDATE;
  PERFORM 1 FROM public.orders WHERE id = _order_id AND company_id = comp FOR UPDATE;
  UPDATE public.orders SET delivery_status = _status WHERE id = _order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.financial_update_delivery(uuid, public.delivery_status) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.financial_update_delivery(uuid, public.delivery_status) TO authenticated, service_role;
-- 12. Contexto e Commit para Eco Comercial Verificado da Meta (smb_message_echoes)
CREATE OR REPLACE FUNCTION public.financial_echo_context(
  _company_id uuid,
  _customer_id uuid,
  _event_id text,
  _command text,
  _received_at timestamptz,
  _standalone boolean DEFAULT true,
  _quoted boolean DEFAULT false,
  _forwarded boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  cust public.customers%ROWTYPE;
  today date := (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
  conv text;
  ph text;
  credit numeric;
  partial text;
BEGIN
  SELECT * INTO cust FROM public.customers WHERE id = _customer_id AND company_id = _company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente não encontrado';
  END IF;

  ph := public.financial_phone_key(cust.phone);
  conv := 'wa:' || _company_id::text || ':' || cust.id::text;

  SELECT coalesce((SELECT sum(amount) FROM public.payments WHERE company_id = _company_id AND customer_id = cust.id), 0)
       - coalesce((SELECT sum(total) FROM public.orders WHERE company_id = _company_id AND customer_id = cust.id
                     AND paid = true AND settled_by_payment = true AND delivery_status <> 'cancelado'), 0)
    INTO credit;

  partial := CASE WHEN credit <> 0 THEN 'UNKNOWN' ELSE 'NONE' END;

  RETURN jsonb_build_object(
    'body', _command,
    'eventId', _event_id,
    'source', 'verified_business_echo',
    'actorAuthorized', true,
    'provenanceVerified', true,
    'standalone', _standalone,
    'quoted', _quoted,
    'forwarded', _forwarded,
    'companyId', _company_id,
    'customerId', cust.id,
    'conversationId', conv,
    'phone', cust.phone,
    'today', today::text,
    'commandDate', (_received_at AT TIME ZONE 'America/Sao_Paulo')::date::text,
    'explicitOrderId', NULL,
    'processedEventIds', coalesce(
      (SELECT jsonb_agg(event_id) FROM public.financial_events WHERE company_id = _company_id AND event_id = _event_id),
      '[]'::jsonb
    ),
    'orders', coalesce(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', o.id,
            'companyId', o.company_id,
            'customerId', o.customer_id,
            'conversationId', conv,
            'phone', coalesce(nullif(o.financial_phone, ''), ph),
            'date', o.order_date::text,
            'total', o.total,
            'state', CASE o.financial_state
              WHEN 'aguardando_classificacao' THEN 'PENDENTE'
              WHEN 'pago' THEN 'PAGO'
              ELSE 'FIADO'
            END,
            'cancelled', o.delivery_status = 'cancelado',
            'paymentState', CASE WHEN o.settled_by_payment OR partial <> 'NONE' THEN 'UNKNOWN' ELSE 'NONE' END,
            'confirmed', o.financial_state IS DISTINCT FROM 'aguardando_classificacao'
          )
          ORDER BY o.created_at ASC, o.id ASC
        )
        FROM public.orders o
        WHERE o.company_id = _company_id
          AND o.customer_id = cust.id
          AND o.order_date = today
      ),
      '[]'::jsonb
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.financial_echo_context(uuid, uuid, text, text, timestamptz, boolean, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.financial_echo_context(uuid, uuid, text, text, timestamptz, boolean, boolean, boolean) TO service_role;

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

  IF _order_id IS NOT NULL THEN
    SELECT * INTO ord FROM public.orders WHERE id = _order_id AND company_id = _company_id AND customer_id = cust.id FOR UPDATE;
  END IF;

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

  IF outcome = 'classified' THEN
    UPDATE public.orders
       SET financial_state = desired,
           paid = (_command = 'OK'),
           settled_by_payment = false,
           financial_phone = ph,
           financial_conversation_id = conv
     WHERE id = ord.id;

    UPDATE public.customers
       SET status = CASE
         WHEN EXISTS (
           SELECT 1 FROM public.orders
           WHERE company_id = _company_id
             AND customer_id = cust.id
             AND NOT paid
             AND delivery_status <> 'cancelado'
             AND financial_state IS DISTINCT FROM 'aguardando_classificacao'
         )
         THEN 'pendente'::public.customer_status
         ELSE 'em_dia'::public.customer_status
       END
     WHERE id = cust.id;
  END IF;

  INSERT INTO public.financial_events(
    company_id, event_id, actor_id, order_id, customer_id, command, source,
    conversation_id, phone, received_at, previous_state, requested_state,
    final_state, total, outcome, reason
  )
  VALUES (
    _company_id, _event_id, NULL, ord.id, cust.id, _command, 'verified_business_echo',
    conv, ph, _received_at, ord.financial_state, desired,
    CASE WHEN outcome = 'classified' THEN desired ELSE ord.financial_state END,
    ord.total, outcome, reason
  )
  RETURNING id INTO audit;

  RETURN jsonb_build_object(
    'outcome', outcome,
    'reason', reason,
    'order_id', ord.id,
    'state', CASE WHEN outcome = 'classified' THEN desired ELSE ord.financial_state END,
    'total', ord.total,
    'audit_id', audit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.financial_classify_by_echo(uuid, uuid, uuid, text, text, timestamptz, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.financial_classify_by_echo(uuid, uuid, uuid, text, text, timestamptz, boolean, text) TO service_role;
