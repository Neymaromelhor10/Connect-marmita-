-- PROPOSAL ONLY. Not in migration history. Never apply to production without specific authorization.
-- No backfill, no historical UPDATE, no automatic role assignment, no webhook activation.
BEGIN;
CREATE ROLE financial_executor NOLOGIN NOINHERIT;
GRANT USAGE ON SCHEMA public, auth TO financial_executor;
GRANT EXECUTE ON FUNCTION auth.uid() TO financial_executor;
GRANT SELECT ON public.profiles, public.companies TO financial_executor;
GRANT SELECT, INSERT, UPDATE ON public.orders, public.payments TO financial_executor;
GRANT SELECT, UPDATE ON public.customers TO financial_executor;
GRANT EXECUTE ON FUNCTION public.current_company_id() TO financial_executor;
-- Dedicated function owner bypasses tenant policies only inside narrowly verified functions.
ALTER ROLE financial_executor BYPASSRLS;

ALTER TABLE public.orders ADD COLUMN financial_state text;
ALTER TABLE public.orders ADD COLUMN financial_conversation_id text;
ALTER TABLE public.orders ADD COLUMN financial_phone text;
ALTER TABLE public.orders ADD COLUMN financial_creation_event uuid;
COMMENT ON COLUMN public.orders.financial_state IS 'NULL preserves legacy paid/settled_by_payment; explicit pending is neither cash nor confirmed debt. No historical backfill.';
CREATE UNIQUE INDEX orders_financial_creation_event_unique ON public.orders(company_id, financial_creation_event) WHERE financial_creation_event IS NOT NULL;
CREATE INDEX orders_financial_pending_customer ON public.orders(company_id, customer_id, order_date) WHERE financial_state = 'aguardando_classificacao';

CREATE TABLE public.financial_permissions (
  company_id uuid NOT NULL REFERENCES public.companies(id),
  user_id uuid NOT NULL,
  can_classify boolean NOT NULL DEFAULT false,
  PRIMARY KEY (company_id, user_id)
);
GRANT SELECT ON public.financial_permissions TO authenticated;
GRANT ALL ON public.financial_permissions TO service_role;
GRANT SELECT, UPDATE ON public.financial_permissions TO financial_executor;
ALTER TABLE public.financial_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY financial_permission_own_read ON public.financial_permissions FOR SELECT TO authenticated
  USING (company_id = public.current_company_id() AND user_id = auth.uid());

CREATE TABLE public.financial_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  event_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  order_id uuid NOT NULL,
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
-- No cascading FK: audit survives deletion of customers/orders/company.
GRANT SELECT ON public.financial_events TO authenticated;
GRANT SELECT, INSERT ON public.financial_events TO service_role;
GRANT SELECT, INSERT ON public.financial_events TO financial_executor;
ALTER TABLE public.financial_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY financial_events_company_read ON public.financial_events FOR SELECT TO authenticated
  USING (company_id = public.current_company_id());

CREATE FUNCTION public.financial_require_operator() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE comp uuid;
BEGIN
  SELECT company_id INTO comp FROM public.profiles WHERE id = auth.uid();
  IF comp IS NULL THEN RAISE EXCEPTION 'Empresa não encontrada'; END IF;
  PERFORM 1 FROM public.financial_permissions
    WHERE company_id = comp AND user_id = auth.uid() AND can_classify FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Permissão financeira necessária'; END IF;
  RETURN comp;
END; $$;
ALTER FUNCTION public.financial_require_operator() OWNER TO financial_executor;
REVOKE ALL ON FUNCTION public.financial_require_operator() FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.financial_phone_key(raw text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN length(d) IN (12,13) AND left(d,2)='55' THEN substr(d,3) ELSE d END
  FROM (SELECT regexp_replace(coalesce(raw,''),'[^0-9]','','g') AS d) x;
$$;
REVOKE ALL ON FUNCTION public.financial_phone_key(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.financial_phone_key(text) TO authenticated, financial_executor;

CREATE FUNCTION public.financial_guard_order() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE managed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.financial_state IS NOT NULL THEN RAISE EXCEPTION 'Pedido financeiro não pode ser excluído'; END IF;
    RETURN OLD;
  END IF;
  managed := NEW.financial_state IS NOT NULL;
  IF TG_OP = 'UPDATE' THEN
    managed := managed OR OLD.financial_state IS NOT NULL;
    IF (NEW.financial_state,NEW.financial_conversation_id,NEW.financial_phone,NEW.financial_creation_event)
       IS DISTINCT FROM (OLD.financial_state,OLD.financial_conversation_id,OLD.financial_phone,OLD.financial_creation_event)
       AND current_user <> 'financial_executor' THEN RAISE EXCEPTION 'Campos financeiros protegidos'; END IF;
    IF OLD.financial_state IS NULL AND NEW.financial_state IS NOT NULL THEN
      RAISE EXCEPTION 'Pedido legado não pode ser reclassificado';
    END IF;
    IF managed AND current_user <> 'financial_executor' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Use a operação financeira validada';
    END IF;
    IF managed AND (NEW.company_id,NEW.customer_id,NEW.order_date,NEW.quantity,NEW.qty_g,NEW.qty_p,NEW.unit_price,NEW.total,
        NEW.financial_conversation_id,NEW.financial_phone,NEW.financial_creation_event)
       IS DISTINCT FROM (OLD.company_id,OLD.customer_id,OLD.order_date,OLD.quantity,OLD.qty_g,OLD.qty_p,OLD.unit_price,OLD.total,
        OLD.financial_conversation_id,OLD.financial_phone,OLD.financial_creation_event) THEN
      RAISE EXCEPTION 'Pedido financeiro preserva vínculos e valor original';
    END IF;
  ELSE
    IF (managed OR NEW.financial_conversation_id IS NOT NULL OR NEW.financial_phone IS NOT NULL OR NEW.financial_creation_event IS NOT NULL)
       AND current_user <> 'financial_executor' THEN RAISE EXCEPTION 'Criação financeira protegida'; END IF;
    IF managed AND NEW.financial_state <> 'aguardando_classificacao' THEN RAISE EXCEPTION 'Novo pedido deve aguardar classificação'; END IF;
  END IF;
  IF managed THEN
    IF NEW.financial_state NOT IN ('aguardando_classificacao','pago','fiado') OR NEW.financial_state IS NULL
       OR NEW.financial_conversation_id IS NULL OR NEW.financial_phone IS NULL OR NEW.financial_creation_event IS NULL
       OR NEW.total <= 0 OR NOT (NEW.total < 'Infinity'::numeric) THEN RAISE EXCEPTION 'Estado financeiro inválido'; END IF;
    IF NEW.financial_state = 'aguardando_classificacao' AND (NEW.paid OR NEW.settled_by_payment) THEN
      RAISE EXCEPTION 'Pendência não é pagamento nem fiado'; END IF;
    IF NEW.financial_state = 'pago' AND (NOT NEW.paid OR NEW.settled_by_payment) THEN
      RAISE EXCEPTION 'Classificação pago deve ser pagamento na hora'; END IF;
    IF NEW.financial_state = 'fiado' AND NEW.paid <> NEW.settled_by_payment THEN
      RAISE EXCEPTION 'Fiado só pode ser quitado por recebimento'; END IF;
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.financial_guard_order() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER zz_financial_guard_order BEFORE INSERT OR UPDATE OR DELETE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.financial_guard_order();

CREATE FUNCTION public.financial_guard_payment() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE target uuid; prior uuid;
BEGIN
  IF TG_OP='DELETE' THEN target := OLD.customer_id; ELSE target := NEW.customer_id; END IF;
  IF TG_OP='UPDATE' THEN prior := OLD.customer_id; END IF;
  IF current_user <> 'financial_executor' AND EXISTS(
    SELECT 1 FROM public.orders WHERE customer_id IN (target,prior) AND financial_state IS NOT NULL
  ) THEN RAISE EXCEPTION 'Recebimento financeiro deve usar FIFO validado'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$;
REVOKE ALL ON FUNCTION public.financial_guard_payment() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER financial_guard_payment BEFORE INSERT OR UPDATE OR DELETE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.financial_guard_payment();

CREATE FUNCTION public.financial_audit_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN RAISE EXCEPTION 'Auditoria financeira é imutável'; END; $$;
REVOKE ALL ON FUNCTION public.financial_audit_immutable() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER financial_audit_immutable BEFORE UPDATE OR DELETE ON public.financial_events
  FOR EACH ROW EXECUTE FUNCTION public.financial_audit_immutable();

-- Preserve the original price formula, but status-only writes must not reprice recorded sales.
CREATE OR REPLACE FUNCTION public.set_order_total() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE pg_price numeric; pp_price numeric;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.company_id,NEW.quantity,NEW.qty_g,NEW.qty_p,NEW.unit_price)
      IS NOT DISTINCT FROM (OLD.company_id,OLD.quantity,OLD.qty_g,OLD.qty_p,OLD.unit_price) THEN
    NEW.total := OLD.total;
    RETURN NEW;
  END IF;
  IF coalesce(NEW.qty_g,0)+coalesce(NEW.qty_p,0)>0 THEN
    SELECT price_g,price_p INTO pg_price,pp_price FROM public.companies WHERE id=NEW.company_id;
    NEW.quantity := coalesce(NEW.qty_g,0)+coalesce(NEW.qty_p,0);
    NEW.total := round(coalesce(NEW.qty_g,0)*coalesce(pg_price,0)+coalesce(NEW.qty_p,0)*coalesce(pp_price,0),2);
    NEW.unit_price := round(NEW.total/greatest(NEW.quantity,1),2);
  ELSE NEW.total := round(coalesce(NEW.quantity,0)*coalesce(NEW.unit_price,0),2); END IF;
  RETURN NEW;
END; $$;

CREATE FUNCTION public.financial_create_pending(_customer_id uuid,_qty_g integer,_qty_p integer,_event_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE comp uuid; cust public.customers%ROWTYPE; ord public.orders%ROWTYPE; phone text;
BEGIN
  comp := public.financial_require_operator();
  IF _event_id IS NULL OR _qty_g IS NULL OR _qty_p IS NULL OR _qty_g<0 OR _qty_p<0 OR _qty_g::bigint+_qty_p<1 OR _qty_g::bigint+_qty_p>10000 THEN
    RAISE EXCEPTION 'Quantidades ou evento inválidos'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(comp::text||':create:'||_event_id::text,0));
  SELECT * INTO ord FROM public.orders WHERE company_id=comp AND financial_creation_event=_event_id;
  IF FOUND THEN
    IF ord.customer_id<>_customer_id OR ord.qty_g<>_qty_g OR ord.qty_p<>_qty_p THEN RAISE EXCEPTION 'Evento de criação conflitante'; END IF;
    RETURN to_jsonb(ord);
  END IF;
  SELECT * INTO cust FROM public.customers WHERE id=_customer_id AND company_id=comp FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cliente não encontrado'; END IF;
  phone := public.financial_phone_key(cust.phone);
  IF phone !~ '^[0-9]{10,11}$' THEN RAISE EXCEPTION 'Telefone do cliente inválido'; END IF;
  INSERT INTO public.orders(company_id,customer_id,qty_g,qty_p,quantity,unit_price,order_date,paid,settled_by_payment,
    financial_state,financial_conversation_id,financial_phone,financial_creation_event,source)
  VALUES(comp,cust.id,_qty_g,_qty_p,_qty_g+_qty_p,0,(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,false,false,
    'aguardando_classificacao','operator:'||comp::text||':'||cust.id::text,phone,_event_id,'financial_operator') RETURNING * INTO ord;
  RETURN to_jsonb(ord);
END; $$;
ALTER FUNCTION public.financial_create_pending(uuid,integer,integer,uuid) OWNER TO financial_executor;
REVOKE ALL ON FUNCTION public.financial_create_pending(uuid,integer,integer,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.financial_create_pending(uuid,integer,integer,uuid) TO authenticated;

CREATE FUNCTION public.financial_command_context(_order_id uuid,_event_id uuid,_command text,_received_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE comp uuid; ord public.orders%ROWTYPE; cust public.customers%ROWTYPE; credit numeric; partial text;
BEGIN
  comp := public.financial_require_operator();
  SELECT * INTO ord FROM public.orders WHERE id=_order_id AND company_id=comp;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pedido não encontrado'; END IF;
  SELECT * INTO cust FROM public.customers WHERE id=ord.customer_id AND company_id=comp;
  SELECT coalesce((SELECT sum(amount) FROM public.payments WHERE company_id=comp AND customer_id=ord.customer_id),0)
    -coalesce((SELECT sum(total) FROM public.orders WHERE company_id=comp AND customer_id=ord.customer_id AND paid AND settled_by_payment AND delivery_status<>'cancelado'),0)
    INTO credit;
  partial := CASE WHEN credit<>0 OR ord.settled_by_payment THEN 'UNKNOWN' ELSE 'NONE' END;
  RETURN jsonb_build_object('body',_command,'eventId',_event_id,'source','authenticated_operator',
    'actorAuthorized',true,'provenanceVerified',true,'standalone',true,'quoted',false,'forwarded',false,
    'companyId',comp,'customerId',cust.id,'conversationId',ord.financial_conversation_id,'phone',cust.phone,
    'today',(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text,
    'commandDate',(_received_at AT TIME ZONE 'America/Sao_Paulo')::date::text,'explicitOrderId',ord.id,
    'processedEventIds',coalesce((SELECT jsonb_agg(event_id::text) FROM public.financial_events WHERE company_id=comp AND event_id=_event_id),'[]'::jsonb),
    'orders',jsonb_build_array(jsonb_build_object('id',ord.id,'companyId',comp,'customerId',ord.customer_id,
      'conversationId',coalesce(ord.financial_conversation_id,''),'phone',coalesce(ord.financial_phone,''),
      'date',ord.order_date::text,'total',ord.total,'state',CASE ord.financial_state WHEN 'aguardando_classificacao' THEN 'PENDENTE' WHEN 'pago' THEN 'PAGO' ELSE 'FIADO' END,
      'cancelled',ord.delivery_status='cancelado','paymentState',partial,'confirmed',ord.financial_state IS DISTINCT FROM 'aguardando_classificacao')));
END; $$;
ALTER FUNCTION public.financial_command_context(uuid,uuid,text,timestamptz) OWNER TO financial_executor;
REVOKE ALL ON FUNCTION public.financial_command_context(uuid,uuid,text,timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.financial_command_context(uuid,uuid,text,timestamptz) TO authenticated;

CREATE FUNCTION public.financial_classify_order(_order_id uuid,_event_id uuid,_command text,_received_at timestamptz,_validation_allowed boolean,_validation_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE comp uuid; ord public.orders%ROWTYPE; cust public.customers%ROWTYPE; ev public.financial_events%ROWTYPE;
  credit numeric; today date; reason text; outcome text; desired text; audit uuid; result jsonb;
BEGIN
  comp := public.financial_require_operator();
  IF _event_id IS NULL OR _order_id IS NULL OR _received_at IS NULL OR _command IS NULL THEN RAISE EXCEPTION 'Contexto financeiro inválido'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(comp::text||':classify:'||_event_id::text,0));
  SELECT * INTO ev FROM public.financial_events WHERE company_id=comp AND event_id=_event_id;
  IF FOUND THEN
    IF ev.actor_id<>auth.uid() OR ev.order_id<>_order_id OR ev.command<>_command THEN
      RETURN jsonb_build_object('outcome','conflict','reason','EVENTO_CONFLITANTE','order_id',_order_id,'state',NULL,'total',NULL,'audit_id',ev.id);
    END IF;
    RETURN jsonb_build_object('outcome','duplicate','reason',ev.reason,'order_id',ev.order_id,'state',ev.final_state,'total',ev.total,'audit_id',ev.id);
  END IF;
  SELECT * INTO ord FROM public.orders WHERE id=_order_id AND company_id=comp;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pedido não encontrado'; END IF;
  -- Read immutable managed customer ID first; all managed writes use customer -> order.
  SELECT * INTO cust FROM public.customers WHERE id=ord.customer_id AND company_id=comp FOR UPDATE;
  SELECT * INTO ord FROM public.orders WHERE id=_order_id AND company_id=comp FOR UPDATE;
  today := (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
  desired := CASE _command WHEN 'OK' THEN 'pago' WHEN 'OKK' THEN 'fiado' ELSE 'NENHUM' END;
  SELECT coalesce((SELECT sum(amount) FROM public.payments WHERE company_id=comp AND customer_id=cust.id),0)
    -coalesce((SELECT sum(total) FROM public.orders WHERE company_id=comp AND customer_id=cust.id AND paid AND settled_by_payment AND delivery_status<>'cancelado'),0)
    INTO credit;
  reason := CASE
    WHEN _command NOT IN ('OK','OKK') THEN 'COMANDO_NAO_RECONHECIDO'
    WHEN (_received_at AT TIME ZONE 'America/Sao_Paulo')::date<>today OR _received_at>clock_timestamp()+interval '5 seconds' THEN 'COMANDO_FORA_DO_DIA_ATUAL'
    WHEN ord.financial_state IS DISTINCT FROM 'aguardando_classificacao' THEN 'PEDIDO_JA_CLASSIFICADO'
    WHEN ord.order_date<>today THEN 'PEDIDO_FORA_DO_PERIODO_PERMITIDO'
    WHEN ord.delivery_status='cancelado' THEN 'PEDIDO_CANCELADO'
    WHEN cust.id IS NULL OR ord.financial_conversation_id IS DISTINCT FROM 'operator:'||comp::text||':'||cust.id::text
      OR ord.financial_phone IS DISTINCT FROM public.financial_phone_key(cust.phone) THEN 'CONTEXTO_CONFLITANTE'
    WHEN credit<>0 OR ord.settled_by_payment THEN 'PAGAMENTO_PARCIAL_OU_NAO_RASTREAVEL'
    WHEN ord.total<=0 OR NOT(ord.total<'Infinity'::numeric) THEN 'VALOR_INVALIDO'
    WHEN _validation_allowed IS DISTINCT FROM true THEN 'VALIDACAO_NAO_APROVADA'
    ELSE 'CONFIRMACAO_VALIDADA' END;
  outcome := CASE WHEN reason='CONFIRMACAO_VALIDADA' THEN 'classified' ELSE 'blocked' END;
  IF outcome='classified' THEN
    UPDATE public.orders SET financial_state=desired,paid=(_command='OK'),settled_by_payment=false WHERE id=ord.id;
    UPDATE public.customers SET status=CASE WHEN EXISTS(SELECT 1 FROM public.orders WHERE company_id=comp AND customer_id=cust.id
      AND NOT paid AND delivery_status<>'cancelado' AND financial_state IS DISTINCT FROM 'aguardando_classificacao')
      THEN 'pendente'::public.customer_status ELSE 'em_dia'::public.customer_status END WHERE id=cust.id;
  END IF;
  INSERT INTO public.financial_events(company_id,event_id,actor_id,order_id,customer_id,command,conversation_id,phone,received_at,
    previous_state,requested_state,final_state,total,outcome,reason)
  VALUES(comp,_event_id,auth.uid(),ord.id,cust.id,_command,ord.financial_conversation_id,ord.financial_phone,_received_at,
    ord.financial_state,desired,CASE WHEN outcome='classified' THEN desired ELSE ord.financial_state END,ord.total,outcome,reason) RETURNING id INTO audit;
  RETURN jsonb_build_object('outcome',outcome,'reason',reason,'order_id',ord.id,'state',CASE WHEN outcome='classified' THEN desired ELSE ord.financial_state END,'total',ord.total,'audit_id',audit);
END; $$;
ALTER FUNCTION public.financial_classify_order(uuid,uuid,text,timestamptz,boolean,text) OWNER TO financial_executor;
REVOKE ALL ON FUNCTION public.financial_classify_order(uuid,uuid,text,timestamptz,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.financial_classify_order(uuid,uuid,text,timestamptz,boolean,text) TO authenticated;

CREATE FUNCTION public.financial_update_delivery(_order_id uuid,_status public.delivery_status) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE comp uuid; cust uuid;
BEGIN
  comp := public.financial_require_operator();
  SELECT customer_id INTO cust FROM public.orders WHERE id=_order_id AND company_id=comp AND financial_state IS NOT NULL;
  IF NOT FOUND OR _status IS NULL THEN RAISE EXCEPTION 'Pedido financeiro não encontrado'; END IF;
  PERFORM 1 FROM public.customers WHERE id=cust AND company_id=comp FOR UPDATE;
  PERFORM 1 FROM public.orders WHERE id=_order_id AND company_id=comp FOR UPDATE;
  UPDATE public.orders SET delivery_status=_status WHERE id=_order_id;
END; $$;
ALTER FUNCTION public.financial_update_delivery(uuid,public.delivery_status) OWNER TO financial_executor;
REVOKE ALL ON FUNCTION public.financial_update_delivery(uuid,public.delivery_status) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.financial_update_delivery(uuid,public.delivery_status) TO authenticated;

-- Legacy FIFO formula and signature retained. Explicit pending orders cannot consume credit.
CREATE OR REPLACE FUNCTION public.register_payment(_customer_id uuid,_amount numeric,_method text DEFAULT 'manual',_notes text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE comp uuid; cust_comp uuid; credit numeric; ord record; payment_id uuid;
BEGIN
  comp := public.current_company_id();
  IF comp IS NULL THEN RAISE EXCEPTION 'Empresa não encontrada para o usuário'; END IF;
  IF _amount IS NULL OR _amount<=0 OR NOT(_amount<'Infinity'::numeric) THEN RAISE EXCEPTION 'Valor do pagamento deve ser maior que zero'; END IF;
  SELECT company_id INTO cust_comp FROM public.customers WHERE id=_customer_id FOR UPDATE;
  IF cust_comp IS NULL OR cust_comp<>comp THEN RAISE EXCEPTION 'Cliente não encontrado'; END IF;
  INSERT INTO public.payments(company_id,customer_id,amount,method,notes)
    VALUES(comp,_customer_id,round(_amount,2),coalesce(_method,'manual'),_notes) RETURNING id INTO payment_id;
  SELECT coalesce((SELECT sum(amount) FROM public.payments WHERE customer_id=_customer_id AND company_id=comp),0)
    -coalesce((SELECT sum(total) FROM public.orders WHERE customer_id=_customer_id AND company_id=comp
      AND paid AND settled_by_payment AND delivery_status<>'cancelado'),0) INTO credit;
  FOR ord IN SELECT id,total FROM public.orders WHERE customer_id=_customer_id AND company_id=comp
    AND NOT paid AND delivery_status<>'cancelado' AND financial_state IS DISTINCT FROM 'aguardando_classificacao'
    ORDER BY order_date,created_at,id FOR UPDATE
  LOOP
    EXIT WHEN credit<ord.total;
    UPDATE public.orders SET paid=true,settled_by_payment=true WHERE id=ord.id;
    credit := credit-ord.total;
  END LOOP;
  UPDATE public.customers SET status=CASE WHEN EXISTS(SELECT 1 FROM public.orders WHERE customer_id=_customer_id AND company_id=comp
    AND NOT paid AND delivery_status<>'cancelado' AND financial_state IS DISTINCT FROM 'aguardando_classificacao')
    THEN 'pendente'::public.customer_status ELSE 'em_dia'::public.customer_status END WHERE id=_customer_id;
  RETURN payment_id;
END; $$;
ALTER FUNCTION public.register_payment(uuid,numeric,text,text) OWNER TO financial_executor;
REVOKE ALL ON FUNCTION public.register_payment(uuid,numeric,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_payment(uuid,numeric,text,text) TO authenticated;
COMMIT;
