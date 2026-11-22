-- 1. Tamanho M (Média) aditivo para empresas, pedidos e mensagens (mantendo P e G existentes)
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS price_m NUMERIC NOT NULL DEFAULT 19.50;
ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_price_m_nonneg;
ALTER TABLE public.companies ADD CONSTRAINT companies_price_m_nonneg CHECK (price_m >= 0);

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS qty_m INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_qty_m_nonneg;
ALTER TABLE public.orders ADD CONSTRAINT orders_qty_m_nonneg CHECK (qty_m >= 0);

ALTER TABLE public.whatsapp_messages ADD COLUMN IF NOT EXISTS qty_m INTEGER;

-- 2. Cálculo de total no backend com proteção estrita de histórico:
-- Em UPDATE, se (company_id, quantity, qty_g, qty_m, qty_p, unit_price) não mudaram,
-- preserva new.total e new.unit_price originais sem consultar a tabela de preços atual.
CREATE OR REPLACE FUNCTION public.set_order_total()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
declare
  pg_price numeric;
  pm_price numeric;
  pp_price numeric;
begin
  if tg_op = 'UPDATE' and (new.company_id, new.quantity, new.qty_g, coalesce(new.qty_m, 0), new.qty_p, new.unit_price)
      is not distinct from (old.company_id, old.quantity, old.qty_g, coalesce(old.qty_m, 0), old.qty_p, old.unit_price) then
    new.total := old.total;
    new.unit_price := old.unit_price;
    return new;
  end if;

  if coalesce(new.qty_g, 0) + coalesce(new.qty_m, 0) + coalesce(new.qty_p, 0) > 0 then
    select price_g, price_m, price_p into pg_price, pm_price, pp_price from public.companies where id = new.company_id;
    new.quantity := coalesce(new.qty_g, 0) + coalesce(new.qty_m, 0) + coalesce(new.qty_p, 0);
    new.total := round(
      coalesce(new.qty_g, 0) * coalesce(pg_price, 0) +
      coalesce(new.qty_m, 0) * coalesce(pm_price, 0) +
      coalesce(new.qty_p, 0) * coalesce(pp_price, 0),
      2
    );
    new.unit_price := round(new.total / greatest(new.quantity, 1), 2);
  else
    new.total := round(coalesce(new.quantity, 0) * coalesce(new.unit_price, 0), 2);
  end if;
  return new;
end;
$$;

REVOKE ALL ON FUNCTION public.set_order_total() FROM public, anon, authenticated;

-- 3. Preservação do histórico financeiro: bloquear DELETE direto pelo cliente autenticado
-- e proteger pagamentos contra edição pós-registro.
REVOKE DELETE ON public.orders, public.payments, public.customers, public.whatsapp_messages, public.companies FROM authenticated, anon;
REVOKE UPDATE ON public.payments FROM authenticated, anon;

-- 4. Alternância segura de pagamento de pedido individual:
-- Impede corrupção de saldo quando o pedido foi quitado via FIFO (settled_by_payment = true)
-- ou quando o cliente possui crédito/pagamento parcial não alocado, e mantém customers.status sincronizado.
CREATE OR REPLACE FUNCTION public.toggle_order_paid(_order_id uuid, _paid boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare
  my_company uuid := public.current_company_id();
  ord public.orders%rowtype;
  unallocated_credit numeric;
begin
  if my_company is null then
    raise exception 'Empresa não encontrada para o usuário';
  end if;

  select * into ord from public.orders where id = _order_id and company_id = my_company for update;
  if not found then
    raise exception 'Pedido não encontrado';
  end if;

  if ord.settled_by_payment then
    raise exception 'Este pedido foi quitado por um recebimento no Fiado e seu histórico financeiro está protegido.';
  end if;

  if _paid = true and not ord.paid then
    select coalesce((select sum(amount) from public.payments
                      where customer_id = ord.customer_id and company_id = my_company), 0)
         - coalesce((select sum(total) from public.orders
                      where customer_id = ord.customer_id and company_id = my_company
                        and paid = true and settled_by_payment = true and delivery_status <> 'cancelado'), 0)
      into unallocated_credit;

    if unallocated_credit > 0 then
      raise exception 'Cliente possui pagamento parcial em aberto. Registre o restante pela aba Fiado para abater o saldo corretamente.';
    end if;
  end if;

  update public.orders
     set paid = coalesce(_paid, false),
         settled_by_payment = false
   where id = ord.id;

  update public.customers
     set status = case
       when exists (select 1 from public.orders
                     where customer_id = ord.customer_id and company_id = my_company
                       and paid = false and delivery_status <> 'cancelado')
       then 'pendente'::public.customer_status else 'em_dia'::public.customer_status end
   where id = ord.customer_id and company_id = my_company;
end;
$$;

REVOKE ALL ON FUNCTION public.toggle_order_paid(uuid, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.toggle_order_paid(uuid, boolean) TO authenticated, service_role;

-- 5. Sincronizar status de pedido (ex.: cancelamento atualiza o status do cliente se não restarem dívidas)
CREATE OR REPLACE FUNCTION public.sync_customer_status_on_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
begin
  if new.customer_id is not null and (tg_op = 'INSERT' or old.paid is distinct from new.paid or old.delivery_status is distinct from new.delivery_status) then
    update public.customers
       set status = case
         when exists (select 1 from public.orders
                       where customer_id = new.customer_id and company_id = new.company_id
                         and paid = false and delivery_status <> 'cancelado')
         then 'pendente'::public.customer_status else 'em_dia'::public.customer_status end
     where id = new.customer_id and company_id = new.company_id;
  end if;
  return new;
end;
$$;

REVOKE ALL ON FUNCTION public.sync_customer_status_on_order() FROM public, anon, authenticated;
DROP TRIGGER IF EXISTS orders_sync_customer_status ON public.orders;
CREATE TRIGGER orders_sync_customer_status
  AFTER INSERT OR UPDATE OF paid, delivery_status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.sync_customer_status_on_order();
