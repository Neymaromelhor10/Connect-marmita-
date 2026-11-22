-- Migração 0011: Hardening de Pré-Produção (Segurança Financeira, Tentativas Persistentes de Pagamento,
-- Fila Durável WhatsApp, Serialização de Telefones, Índices de Performance e Governança LGPD).
-- 100% aditiva e não destrutiva para dados existentes.

-- ============================================================================
-- 1. SEGURANÇA FINANCEIRA E INVARIANTE DE AUDITORIA TRANSACIONAL EM ORDERS
-- ============================================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS financial_last_audit_id uuid REFERENCES public.financial_events(id);

CREATE UNIQUE INDEX IF NOT EXISTS orders_financial_last_audit_id_uidx
  ON public.orders (financial_last_audit_id)
  WHERE financial_last_audit_id IS NOT NULL;

-- Revoga escrita direta via PostgREST (anon / authenticated) em tabelas financeiras críticas.
-- Toda criação, classificação, baixa ou alteração de entrega passa obrigatoriamente pelas RPCs.
REVOKE INSERT, UPDATE, DELETE ON public.orders FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.payments FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.financial_events FROM anon, authenticated;

-- Atualiza zz_financial_guard_order (BEFORE trigger: invariantes intrínsecas da linha)
CREATE OR REPLACE FUNCTION public.financial_guard_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.financial_state IS NOT NULL OR OLD.paid OR OLD.settled_by_payment THEN
      RAISE EXCEPTION 'Pedido financeiro não pode ser excluído';
    END IF;
    RETURN OLD;
  END IF;

  -- Pedidos originados de mensagens do WhatsApp sempre nascem aguardando_classificacao
  IF TG_OP = 'INSERT' AND NEW.source IN ('mensagem', 'whatsapp', 'whatsapp_cloud') THEN
    IF NEW.financial_state IS DISTINCT FROM 'aguardando_classificacao' OR NEW.paid OR NEW.settled_by_payment THEN
      RAISE EXCEPTION 'Pedido recebido por mensagem deve nascer obrigatoriamente como aguardando_classificacao';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.financial_last_audit_id IS NOT NULL AND NEW.financial_last_audit_id IS NULL THEN
      RAISE EXCEPTION 'Vínculo de auditoria financeira (financial_last_audit_id) não pode ser removido';
    END IF;
    IF OLD.financial_state IN ('pago', 'fiado') AND NEW.financial_state IS DISTINCT FROM OLD.financial_state THEN
      RAISE EXCEPTION 'Pedido já possui classificação financeira definitiva';
    END IF;
    IF OLD.financial_state IS NULL AND NEW.financial_state IS NOT NULL THEN
      RAISE EXCEPTION 'Pedido legado não pode ser reclassificado';
    END IF;
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

-- Função do Constraint Trigger AFTER INSERT OR UPDATE (verifica vínculo determinístico com financial_events)
CREATE OR REPLACE FUNCTION public.financial_assert_audit_event_exists()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_ord public.orders%ROWTYPE;
  requires_transition_audit boolean := false;
  expected_prev text := NULL;
  expected_final text := NULL;
  total_payments numeric;
  total_settled numeric;
BEGIN
  -- Lê o estado atual consolidado da linha em public.orders no momento da verificação da constraint
  -- (suporta transações que fazem INSERT com SET CONSTRAINTS DEFERRED seguido de UPDATE do financial_last_audit_id)
  SELECT * INTO current_ord FROM public.orders WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Caso 1: Criação de pedido já classificado como 'pago' ou 'fiado'
  IF TG_OP = 'INSERT' AND current_ord.financial_state IN ('pago', 'fiado') THEN
    requires_transition_audit := true;
    expected_prev := NULL;
    expected_final := current_ord.financial_state;
  END IF;

  -- Caso 2: Mudança de financial_state para 'pago' ou 'fiado'
  IF TG_OP = 'UPDATE' AND OLD.financial_state IS DISTINCT FROM current_ord.financial_state AND current_ord.financial_state IN ('pago', 'fiado') THEN
    requires_transition_audit := true;
    expected_prev := OLD.financial_state;
    expected_final := current_ord.financial_state;
  END IF;

  -- Caso 3: Alteração de paid em pedido legado (financial_state IS NULL) fora de baixa FIFO
  IF TG_OP = 'UPDATE' AND current_ord.financial_state IS NULL AND OLD.paid IS DISTINCT FROM current_ord.paid AND NOT COALESCE(current_ord.settled_by_payment, false) THEN
    requires_transition_audit := true;
    expected_prev := CASE WHEN OLD.paid THEN 'pago' ELSE 'fiado' END;
    expected_final := CASE WHEN current_ord.paid THEN 'pago' ELSE 'fiado' END;
  END IF;

  -- Caso 4: Quitação por pagamento posterior (settled_by_payment = true) deve ter cobertura real em public.payments
  IF TG_OP = 'UPDATE' AND current_ord.settled_by_payment AND NOT COALESCE(OLD.settled_by_payment, false) THEN
    SELECT coalesce(sum(amount), 0) INTO total_payments
      FROM public.payments
     WHERE company_id = current_ord.company_id AND customer_id = current_ord.customer_id;

    SELECT coalesce(sum(total), 0) INTO total_settled
      FROM public.orders
     WHERE company_id = current_ord.company_id
       AND customer_id = current_ord.customer_id
       AND paid = true
       AND settled_by_payment = true
       AND delivery_status <> 'cancelado';

    IF total_payments < total_settled THEN
      RAISE EXCEPTION 'Quitação FIFO inválida: pagamentos registrados são insuficientes para cobrir o pedido';
    END IF;
  END IF;

  -- Invariante permanente: todo pedido em estado 'pago' ou 'fiado' (ou transição auditada)
  -- DEVE possuir financial_last_audit_id válido apontando para financial_events
  IF requires_transition_audit OR current_ord.financial_state IN ('pago', 'fiado') THEN
    IF current_ord.financial_last_audit_id IS NULL THEN
      RAISE EXCEPTION 'Violação de integridade financeira: classificação exige vínculo com evento de auditoria (financial_last_audit_id)';
    END IF;

    IF requires_transition_audit AND TG_OP = 'UPDATE' AND current_ord.financial_last_audit_id IS NOT DISTINCT FROM OLD.financial_last_audit_id THEN
      RAISE EXCEPTION 'Violação de integridade financeira: transição exige um novo evento de auditoria exclusivo';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.financial_events e
       WHERE e.id = current_ord.financial_last_audit_id
         AND e.company_id = current_ord.company_id
         AND e.order_id = current_ord.id
         AND e.customer_id = current_ord.customer_id
         AND e.final_state = coalesce(expected_final, current_ord.financial_state)
         AND (NOT requires_transition_audit OR e.previous_state IS NOT DISTINCT FROM expected_prev)
         AND e.outcome = 'classified'
         AND e.total = current_ord.total
    ) THEN
      RAISE EXCEPTION 'Violação de integridade financeira: evento de auditoria correspondente não encontrado ou divergente em financial_events';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.financial_assert_audit_event_exists() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_financial_require_audit_event ON public.orders;
CREATE CONSTRAINT TRIGGER zz_financial_require_audit_event
  AFTER INSERT OR UPDATE ON public.orders
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.financial_assert_audit_event_exists();

-- Atualiza financial_classify_order para usar SET CONSTRAINTS e vincular financial_last_audit_id
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

    UPDATE public.orders
       SET financial_state = desired,
           paid = (_command = 'OK'),
           settled_by_payment = false,
           financial_phone = ph,
           financial_conversation_id = conv,
           financial_last_audit_id = audit
     WHERE id = ord.id;

    SET CONSTRAINTS zz_financial_require_audit_event IMMEDIATE;

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

-- Atualiza financial_classify_by_echo para respeitar a invariante de auditoria (financial_last_audit_id)
-- e restringe execução exclusivamente a service_role (chamado apenas pelo webhook verificado da Meta)
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

-- RPC segura para criação de pedidos manuais (Pedidos) ou revisados (Mensagens)
DROP FUNCTION IF EXISTS public.create_manual_or_reviewed_order(uuid, integer, integer, integer, date, text, text, uuid);
CREATE OR REPLACE FUNCTION public.create_manual_or_reviewed_order(
  _customer_id uuid,
  _qty_p integer,
  _qty_m integer,
  _qty_g integer,
  _order_date date,
  _financial_state text DEFAULT NULL,
  _source text DEFAULT 'manual',
  _event_id uuid DEFAULT gen_random_uuid(),
  _whatsapp_message_id uuid DEFAULT NULL,
  _condition text DEFAULT NULL
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
  ph text;
  conv text;
  audit_id uuid;
  new_order_id uuid := gen_random_uuid();
  cmd text;
  ev_key text;
  resolved_state text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória';
  END IF;

  comp := public.financial_require_operator();
  resolved_state := coalesce(nullif(btrim(_financial_state), ''), nullif(btrim(_condition), ''));

  IF _customer_id IS NULL OR _order_date IS NULL THEN
    RAISE EXCEPTION 'Cliente e data são obrigatórios';
  END IF;

  IF coalesce(_qty_p, 0) < 0 OR coalesce(_qty_m, 0) < 0 OR coalesce(_qty_g, 0) < 0
     OR (coalesce(_qty_p, 0) + coalesce(_qty_m, 0) + coalesce(_qty_g, 0)) < 1 THEN
    RAISE EXCEPTION 'Informe pelo menos uma marmita';
  END IF;

  IF resolved_state NOT IN ('pago', 'fiado', 'aguardando_classificacao') THEN
    RAISE EXCEPTION 'Condição financeira inválida';
  END IF;

  IF _source NOT IN ('manual', 'mensagem') THEN
    RAISE EXCEPTION 'Origem inválida';
  END IF;

  IF _source = 'mensagem' AND resolved_state <> 'aguardando_classificacao' THEN
    RAISE EXCEPTION 'Pedido originado de mensagem deve iniciar como aguardando_classificacao';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(comp::text || ':manual_order:' || coalesce(_event_id::text, ''), 0));

  IF _event_id IS NOT NULL THEN
    SELECT * INTO ord FROM public.orders WHERE company_id = comp AND financial_creation_event = _event_id;
    IF FOUND THEN
      RETURN to_jsonb(ord);
    END IF;
  END IF;

  SELECT * INTO cust FROM public.customers WHERE id = _customer_id AND company_id = comp FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente não encontrado';
  END IF;

  ph := public.financial_phone_key(cust.phone);
  conv := CASE WHEN _source = 'manual' THEN 'operator:' ELSE 'wa:' END || comp::text || ':' || cust.id::text;

  SET CONSTRAINTS zz_financial_require_audit_event DEFERRED;

  INSERT INTO public.orders(
    id, company_id, customer_id, qty_p, qty_m, qty_g, quantity, unit_price,
    order_date, paid, settled_by_payment, source, financial_state,
    financial_conversation_id, financial_phone, financial_creation_event
  )
  VALUES (
    new_order_id, comp, cust.id, coalesce(_qty_p, 0), coalesce(_qty_m, 0), coalesce(_qty_g, 0),
    coalesce(_qty_p, 0) + coalesce(_qty_m, 0) + coalesce(_qty_g, 0),
    0, _order_date, (resolved_state = 'pago'), false, _source, resolved_state,
    conv, nullif(ph, ''), _event_id
  )
  RETURNING * INTO ord;

  IF resolved_state IN ('pago', 'fiado') THEN
    cmd := CASE WHEN resolved_state = 'pago' THEN 'OK' ELSE 'OKK' END;
    ev_key := 'manual_create:' || ord.id::text;

    INSERT INTO public.financial_events(
      company_id, event_id, actor_id, order_id, customer_id, command, source,
      conversation_id, phone, received_at, previous_state, requested_state,
      final_state, total, outcome, reason
    )
    VALUES (
      comp, ev_key, auth.uid(), ord.id, cust.id, cmd, 'authenticated_operator',
      conv, ph, clock_timestamp(), NULL, resolved_state,
      resolved_state, ord.total, 'classified', 'CRIACAO_MANUAL_CLASSIFICADA'
    )
    RETURNING id INTO audit_id;

    UPDATE public.orders SET financial_last_audit_id = audit_id WHERE id = ord.id RETURNING * INTO ord;
  END IF;

  IF _whatsapp_message_id IS NOT NULL THEN
    UPDATE public.whatsapp_messages
       SET status = 'registrado',
           order_id = ord.id,
           customer_id = cust.id,
           qty_p = coalesce(_qty_p, 0),
           qty_m = coalesce(_qty_m, 0),
           qty_g = coalesce(_qty_g, 0),
           fiado = false,
           order_date = _order_date,
           locked_until = NULL,
           next_retry_at = NULL,
           last_error = NULL
     WHERE id = _whatsapp_message_id
       AND company_id = comp;
  END IF;

  SET CONSTRAINTS zz_financial_require_audit_event IMMEDIATE;

  RETURN to_jsonb(ord);
END;
$$;

REVOKE ALL ON FUNCTION public.create_manual_or_reviewed_order(uuid, integer, integer, integer, date, text, text, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_manual_or_reviewed_order(uuid, integer, integer, integer, date, text, text, uuid, uuid, text) TO authenticated, service_role;

-- Atualiza toggle_order_paid (para pedidos legados sem financial_state) gravando auditoria e respeitando zz_financial_require_audit_event
CREATE OR REPLACE FUNCTION public.toggle_order_paid(_order_id uuid, _paid boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  my_company uuid;
  ord public.orders%rowtype;
  unallocated_credit numeric;
  audit_id uuid;
  prev_st text;
  final_st text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória';
  END IF;
  my_company := public.financial_require_operator();

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

  UPDATE public.orders
     SET paid = coalesce(_paid, false),
         settled_by_payment = false,
         financial_last_audit_id = audit_id
   WHERE id = ord.id;

  SET CONSTRAINTS zz_financial_require_audit_event IMMEDIATE;

  UPDATE public.customers
     SET status = CASE
       WHEN EXISTS (SELECT 1 FROM public.orders
                     WHERE customer_id = ord.customer_id AND company_id = my_company
                       AND paid = false AND delivery_status <> 'cancelado'
                       AND financial_state IS DISTINCT FROM 'aguardando_classificacao')
       THEN 'pendente'::public.customer_status ELSE 'em_dia'::public.customer_status END
   WHERE id = ord.customer_id AND company_id = my_company;
END;
$$;

-- Atualiza financial_update_delivery permitindo qualquer pedido da empresa do operador
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
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória';
  END IF;
  comp := public.financial_require_operator();
  SELECT customer_id INTO cust FROM public.orders WHERE id = _order_id AND company_id = comp;
  IF NOT FOUND OR _status IS NULL THEN
    RAISE EXCEPTION 'Pedido não encontrado';
  END IF;
  PERFORM 1 FROM public.customers WHERE id = cust AND company_id = comp FOR UPDATE;
  PERFORM 1 FROM public.orders WHERE id = _order_id AND company_id = comp FOR UPDATE;
  UPDATE public.orders SET delivery_status = _status WHERE id = _order_id;
END;
$$;

-- ============================================================================
-- 2. CONTROLE PERSISTENTE DE TENTATIVAS E IDEMPOTÊNCIA EM REGISTER_PAYMENT
-- ============================================================================

ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS payments_company_idempotency_key_uidx
  ON public.payments (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.payment_attempts (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  method text NOT NULL DEFAULT 'manual',
  notes text,
  status text NOT NULL CHECK (status IN ('in_progress', 'succeeded', 'cancelled')),
  payment_id uuid REFERENCES public.payments(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (company_id, idempotency_key)
);

REVOKE ALL ON public.payment_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.payment_attempts TO authenticated;
GRANT ALL ON public.payment_attempts TO service_role;
ALTER TABLE public.payment_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_attempts_company_read ON public.payment_attempts;
CREATE POLICY payment_attempts_company_read ON public.payment_attempts
  FOR SELECT TO authenticated
  USING (company_id = public.current_company_id());

-- Registra ou recupera tentativa persistente antes do disparo da baixa
CREATE OR REPLACE FUNCTION public.begin_payment_attempt(
  _customer_id uuid,
  _amount numeric,
  _idempotency_key text,
  _method text DEFAULT 'manual',
  _notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid;
  att public.payment_attempts%ROWTYPE;
  clean_key text := nullif(btrim(coalesce(_idempotency_key, '')), '');
  rounded_amt numeric := round(coalesce(_amount, 0), 2);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória';
  END IF;
  comp := public.financial_require_operator();

  IF clean_key IS NULL THEN
    RAISE EXCEPTION 'Chave de idempotência obrigatória';
  END IF;
  IF rounded_amt <= 0 OR NOT (rounded_amt < 'Infinity'::numeric) THEN
    RAISE EXCEPTION 'Valor do pagamento deve ser maior que zero';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(comp::text || ':payment_attempt:' || clean_key, 0));

  SELECT * INTO att FROM public.payment_attempts WHERE company_id = comp AND idempotency_key = clean_key FOR UPDATE;
  IF FOUND THEN
    IF att.customer_id <> _customer_id OR att.amount <> rounded_amt THEN
      RAISE EXCEPTION 'Conflito de idempotência: chave já vinculada a outro valor ou cliente';
    END IF;
    RETURN to_jsonb(att) || jsonb_build_object('already_completed', (att.status = 'succeeded'));
  END IF;

  INSERT INTO public.payment_attempts(company_id, idempotency_key, customer_id, amount, method, notes, status)
  VALUES (comp, clean_key, _customer_id, rounded_amt, coalesce(_method, 'manual'), _notes, 'in_progress')
  RETURNING * INTO att;

  RETURN to_jsonb(att) || jsonb_build_object('already_completed', false);
END;
$$;

REVOKE ALL ON FUNCTION public.begin_payment_attempt(uuid, numeric, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.begin_payment_attempt(uuid, numeric, text, text, text) TO authenticated, service_role;

-- Reconcilia ou cancela com tombstone transacional uma tentativa de pagamento cujo retorno foi incerto
CREATE OR REPLACE FUNCTION public.reconcile_payment_attempt(
  _idempotency_key text,
  _action text DEFAULT 'check',
  _customer_id uuid DEFAULT NULL,
  _amount numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid;
  clean_key text := nullif(btrim(coalesce(_idempotency_key, '')), '');
  att public.payment_attempts%ROWTYPE;
  pay public.payments%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória';
  END IF;
  comp := public.financial_require_operator();

  IF clean_key IS NULL THEN
    RAISE EXCEPTION 'Chave de idempotência obrigatória';
  END IF;
  IF _action NOT IN ('check', 'cancel') THEN
    RAISE EXCEPTION 'Ação de reconciliação inválida';
  END IF;

  -- Adquire o MESMO lock transacional de register_payment: se houver uma chamada em voo,
  -- aguarda sua conclusão antes de ler o estado!
  PERFORM pg_advisory_xact_lock(hashtextextended(comp::text || ':payment_attempt:' || clean_key, 0));

  SELECT * INTO pay FROM public.payments WHERE company_id = comp AND idempotency_key = clean_key;
  IF FOUND THEN
    UPDATE public.payment_attempts
       SET status = 'succeeded', payment_id = pay.id, updated_at = clock_timestamp()
     WHERE company_id = comp AND idempotency_key = clean_key;

    RETURN jsonb_build_object(
      'status', 'succeeded',
      'found', true,
      'payment_id', pay.id,
      'customer_id', pay.customer_id,
      'amount', pay.amount,
      'paid_at', pay.paid_at,
      'can_release_new_key', true
    );
  END IF;

  SELECT * INTO att FROM public.payment_attempts WHERE company_id = comp AND idempotency_key = clean_key FOR UPDATE;

  IF _action = 'cancel' THEN
    IF FOUND THEN
      UPDATE public.payment_attempts
         SET status = 'cancelled', updated_at = clock_timestamp()
       WHERE company_id = comp AND idempotency_key = clean_key
       RETURNING * INTO att;
    ELSIF _customer_id IS NOT NULL AND _amount IS NOT NULL AND _amount > 0 THEN
      -- Cria tombstone 'cancelled' mesmo se o pacote original não tiver chegado ao banco ainda,
      -- impedindo que um pacote atrasado da rede seja processado depois!
      INSERT INTO public.payment_attempts(company_id, idempotency_key, customer_id, amount, status)
      VALUES (comp, clean_key, _customer_id, round(_amount, 2), 'cancelled')
      RETURNING * INTO att;
    ELSE
      RAISE EXCEPTION 'Informe cliente e valor para registrar o cancelamento seguro da tentativa';
    END IF;

    RETURN jsonb_build_object(
      'status', 'cancelled',
      'found', false,
      'payment_id', NULL,
      'can_release_new_key', true
    );
  END IF;

  -- _action = 'check' e pagamento ainda não efetivado: NUNCA libera nova chave automaticamente;
  -- permite apenas reenviar com a MESMA chave ou solicitar cancelamento explícito com tombstone.
  RETURN jsonb_build_object(
    'status', coalesce(att.status, 'not_started'),
    'found', false,
    'payment_id', NULL,
    'can_release_new_key', (att.status = 'cancelled')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_payment_attempt(text, text, uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_payment_attempt(text, text, uuid, numeric) TO authenticated, service_role;

-- Atualiza register_payment com suporte a _idempotency_key e sincronização com payment_attempts
-- Remove a sobrecarga antiga de 4 parâmetros (0001/0006/0010) para evitar ambiguidade (42725) no PostgreSQL/PostgREST
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
  comp uuid;
  cust_comp uuid;
  credit numeric;
  ord record;
  payment_id uuid;
  clean_key text := nullif(btrim(coalesce(_idempotency_key, '')), '');
  rounded_amt numeric := round(coalesce(_amount, 0), 2);
  existing_pay public.payments%ROWTYPE;
  att public.payment_attempts%ROWTYPE;
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

REVOKE ALL ON FUNCTION public.register_payment(uuid, numeric, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_payment(uuid, numeric, text, text, text) TO authenticated, service_role;

-- ============================================================================
-- 3. FILA DURÁVEL DO WHATSAPP (6 ESTADOS, LOCK, RETRY E CRIAÇÃO ATÔMICA)
-- ============================================================================

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text;

ALTER TABLE public.whatsapp_messages DROP CONSTRAINT IF EXISTS whatsapp_messages_status_check;
ALTER TABLE public.whatsapp_messages ADD CONSTRAINT whatsapp_messages_status_check
  CHECK (status IN ('aguardando', 'processando', 'registrado', 'revisar', 'ignorado', 'erro'));

CREATE INDEX IF NOT EXISTS whatsapp_messages_queue_idx
  ON public.whatsapp_messages (status, next_retry_at, locked_until, created_at ASC)
  WHERE order_id IS NULL AND status IN ('aguardando', 'processando', 'erro');

-- Reserva lote de mensagens elegíveis da fila com FOR UPDATE SKIP LOCKED.
-- Garante que mensagens em 'revisar', 'registrado' ou 'ignorado' NUNCA sejam reprocessadas automaticamente.
DROP FUNCTION IF EXISTS public.claim_whatsapp_queue_batch(integer, integer, uuid);
CREATE OR REPLACE FUNCTION public.claim_whatsapp_queue_batch(
  _batch_size integer DEFAULT 5,
  _lock_seconds integer DEFAULT 60,
  _company_id uuid DEFAULT NULL,
  _message_id uuid DEFAULT NULL,
  _limit integer DEFAULT NULL
)
RETURNS SETOF public.whatsapp_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  effective_limit integer := greatest(coalesce(_limit, _batch_size, 5), 1);
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT m.id
      FROM public.whatsapp_messages m
     WHERE m.order_id IS NULL
       AND (_company_id IS NULL OR m.company_id = _company_id)
       AND (_message_id IS NULL OR m.id = _message_id)
       AND m.attempts < 5
       AND (
         m.status = 'aguardando'
         OR (m.status = 'erro' AND (m.next_retry_at IS NULL OR m.next_retry_at <= clock_timestamp()))
         OR (m.status = 'processando' AND m.locked_until IS NOT NULL AND m.locked_until < clock_timestamp())
       )
     ORDER BY m.created_at ASC, m.id ASC
     LIMIT effective_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.whatsapp_messages target
     SET status = 'processando',
         attempts = target.attempts + 1,
         locked_until = clock_timestamp() + make_interval(secs => greatest(coalesce(_lock_seconds, 60), 15))
    FROM candidates c
   WHERE target.id = c.id
  RETURNING target.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_whatsapp_queue_batch(integer, integer, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_queue_batch(integer, integer, uuid, uuid, integer) TO service_role;

-- Finaliza de forma transacional atômica a criação do pedido a partir de uma mensagem da fila,
-- impedindo criação de pedidos duplicados em retomadas graças a financial_creation_event único.
DROP FUNCTION IF EXISTS public.complete_whatsapp_message_order(uuid, uuid, uuid, integer, integer, integer, date, jsonb, uuid);
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

  -- Idempotência: se a mensagem já possui order_id vinculado, retorna imediatamente sem duplicar
  IF msg.order_id IS NOT NULL THEN
    RETURN msg.order_id;
  END IF;

  -- Verifica se o pedido já foi criado por tentativa anterior usando o evento determinístico
  SELECT * INTO ord FROM public.orders WHERE company_id = _company_id AND financial_creation_event = det_event;
  IF NOT FOUND THEN
    SELECT * INTO cust FROM public.customers WHERE id = _customer_id AND company_id = _company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cliente não encontrado';
    END IF;

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
         next_retry_at = NULL,
         last_error = NULL
   WHERE id = msg.id;

  RETURN ord.id;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_whatsapp_message_order(uuid, uuid, uuid, integer, integer, integer, date, jsonb, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_whatsapp_message_order(uuid, uuid, uuid, integer, integer, integer, date, jsonb, uuid, text, text) TO authenticated, service_role;

-- ============================================================================
-- 4. NORMALIZAÇÃO E PROTEÇÃO TRANSACIONAL CONTRA TELEFONES DUPLICADOS + ÍNDICES
-- ============================================================================

CREATE INDEX IF NOT EXISTS customers_company_phone_key_idx
  ON public.customers (company_id, public.financial_phone_key(phone));

CREATE INDEX IF NOT EXISTS orders_customer_settled_idx
  ON public.orders (company_id, customer_id)
  WHERE paid = true AND settled_by_payment = true AND delivery_status <> 'cancelado';

CREATE OR REPLACE FUNCTION public.guard_customer_phone_uniqueness()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  norm_phone text;
BEGIN
  norm_phone := public.financial_phone_key(NEW.phone);
  IF length(norm_phone) < 8 OR length(norm_phone) > 15 THEN
    RAISE EXCEPTION 'Telefone inválido: informe DDD + número (8 a 15 dígitos)';
  END IF;

  NEW.phone := norm_phone;

  -- Serializa inserções/edições simultâneas do mesmo número na mesma empresa
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.company_id::text || ':customer_phone:' || norm_phone, 0)
  );

  IF EXISTS (
    SELECT 1
      FROM public.customers c
     WHERE c.company_id = NEW.company_id
       AND c.id <> coalesce(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
       AND public.financial_phone_key(c.phone) = norm_phone
  ) THEN
    RAISE EXCEPTION 'Já existe um cliente cadastrado com este telefone nesta empresa'
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_customer_phone_uniqueness() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS customers_guard_phone_uniqueness ON public.customers;
CREATE TRIGGER customers_guard_phone_uniqueness
  BEFORE INSERT OR UPDATE OF phone, company_id ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.guard_customer_phone_uniqueness();

-- Busca indexada O(log N) de cliente pelo telefone normalizado
CREATE OR REPLACE FUNCTION public.find_customer_by_phone(
  _company_id uuid,
  _phone text
)
RETURNS TABLE(id uuid, name text, phone text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.name, c.phone
    FROM public.customers c
   WHERE c.company_id = _company_id
     AND public.financial_phone_key(c.phone) = public.financial_phone_key(_phone)
   ORDER BY c.created_at ASC
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.find_customer_by_phone(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_customer_by_phone(uuid, text) TO authenticated, service_role;

-- ============================================================================
-- 5. GOVERNANÇA LGPD (PRÉ-VALIDAÇÃO, ANONIMIZAÇÃO REAL IRREVERSÍVEL E RETENÇÃO)
-- ============================================================================

CREATE SEQUENCE IF NOT EXISTS public.lgpd_anon_seq START WITH 100001 INCREMENT BY 1;
REVOKE ALL ON SEQUENCE public.lgpd_anon_seq FROM PUBLIC, anon, authenticated;

-- Permite que a função de anonimização LGPD limpe exclusivamente o campo phone em financial_events
-- sem permitir alteração de nenhum valor financeiro, estado, comando ou exclusão de linha.
CREATE OR REPLACE FUNCTION public.financial_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('app.lgpd_redact_phone', true) = 'on'
     AND NEW.phone IS NULL
     AND (
       NEW.id, NEW.company_id, NEW.event_id, NEW.actor_id, NEW.order_id, NEW.customer_id,
       NEW.command, NEW.source, NEW.conversation_id, NEW.received_at, NEW.processed_at,
       NEW.previous_state, NEW.requested_state, NEW.final_state, NEW.total, NEW.outcome, NEW.reason
     ) IS NOT DISTINCT FROM (
       OLD.id, OLD.company_id, OLD.event_id, OLD.actor_id, OLD.order_id, OLD.customer_id,
       OLD.command, OLD.source, OLD.conversation_id, OLD.received_at, OLD.processed_at,
       OLD.previous_state, OLD.requested_state, OLD.final_state, OLD.total, OLD.outcome, OLD.reason
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Auditoria financeira é imutável';
END;
$$;

-- 5.1. Pré-validação LGPD (Somente leitura / Dry-Run)
CREATE OR REPLACE FUNCTION public.lgpd_inspect_customer(_customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  comp uuid;
  cust public.customers%ROWTYPE;
  open_debt numeric;
  pending_orders int;
  total_orders int;
  total_payments int;
  total_messages int;
  cust_phone_key text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória';
  END IF;
  comp := public.financial_require_operator();

  SELECT * INTO cust FROM public.customers WHERE id = _customer_id AND company_id = comp;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente não encontrado';
  END IF;

  cust_phone_key := public.financial_phone_key(cust.phone);

  SELECT coalesce((
    SELECT sum(total) FROM public.orders
     WHERE company_id = comp AND customer_id = cust.id
       AND delivery_status <> 'cancelado'
       AND financial_state IS DISTINCT FROM 'aguardando_classificacao'
       AND (NOT paid OR settled_by_payment)
  ), 0) - coalesce((
    SELECT sum(amount) FROM public.payments
     WHERE company_id = comp AND customer_id = cust.id
  ), 0) INTO open_debt;

  open_debt := greatest(round(open_debt, 2), 0);

  SELECT count(*)::int INTO pending_orders
    FROM public.orders
   WHERE company_id = comp AND customer_id = cust.id
     AND delivery_status <> 'cancelado'
     AND financial_state = 'aguardando_classificacao';

  SELECT count(*)::int INTO total_orders FROM public.orders WHERE company_id = comp AND customer_id = cust.id;
  SELECT count(*)::int INTO total_payments FROM public.payments WHERE company_id = comp AND customer_id = cust.id;
  SELECT count(*)::int INTO total_messages
    FROM public.whatsapp_messages
   WHERE company_id = comp
     AND (
       customer_id = cust.id
       OR (cust_phone_key <> '' AND public.financial_phone_key(phone) = cust_phone_key)
     );

  RETURN jsonb_build_object(
    'customer_id', cust.id,
    'has_open_debt', (open_debt > 0),
    'open_debt_amount', open_debt,
    'has_pending_classification', (pending_orders > 0),
    'pending_orders_count', pending_orders,
    'orders_count', total_orders,
    'payments_count', total_payments,
    'messages_count', total_messages,
    'allowed_scopes', CASE
      WHEN open_debt > 0 OR pending_orders > 0 THEN jsonb_build_array('dados_complementares')
      ELSE jsonb_build_array('dados_complementares', 'anonimizacao_completa')
    END,
    'legal_basis_summary', CASE
      WHEN open_debt > 0 OR pending_orders > 0 THEN
        'Nome e telefone necessários para exercício regular de direitos e cobrança (Art. 7º, V e X da LGPD). Endereço, observações e mensagens de texto podem ser eliminados via escopo dados_complementares.'
      ELSE
        'Sem pendências financeiras: elegível para anonimizacao_completa de dados pessoais (Art. 18, IV e VI), preservando apenas lançamentos contábeis agregados (Art. 16, I da LGPD).'
    END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lgpd_inspect_customer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lgpd_inspect_customer(uuid) TO authenticated, service_role;

-- 5.2. Execução controlada de anonimização irreversível (nunca usa hash do telefone original)
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
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Autenticação obrigatória';
  END IF;
  comp := public.financial_require_operator();

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

  -- 1. Limpa dados complementares e textos conversacionais em ambos os escopos
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

  -- 2. Se for anonimização completa, substitui nome e telefone por identificador sintético sequencial
  -- (sem qualquer relação matemática ou hash com o telefone original, impedindo reversão por força bruta)
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

-- 5.3. Expurgo periódico de textos de mensagens antigas (evita retenção indefinida de conversas)
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
  IF auth.uid() IS NOT NULL THEN
    comp := public.financial_require_operator();
  END IF;

  IF coalesce(_retention_days, 180) < 30 THEN
    RAISE EXCEPTION 'Prazo mínimo de retenção operacional é de 30 dias';
  END IF;

  UPDATE public.whatsapp_messages m
     SET body = '[Texto expirado pela política de retenção LGPD]',
         profile_name = NULL,
         parsed = CASE
           WHEN m.parsed IS NOT NULL THEN jsonb_set(m.parsed - 'nome' - 'motivo', '{retention_purged}', 'true'::jsonb)
           ELSE NULL
         END
   WHERE (comp IS NULL OR m.company_id = comp)
     AND m.status IN ('registrado', 'ignorado')
     AND m.created_at < clock_timestamp() - make_interval(days => coalesce(_retention_days, 180))
     AND m.body NOT LIKE '[%LGPD]';

  GET DIAGNOSTICS purged_count = ROW_COUNT;
  RETURN purged_count;
END;
$$;

REVOKE ALL ON FUNCTION public.lgpd_purge_expired_message_bodies(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lgpd_purge_expired_message_bodies(integer) TO authenticated, service_role;
