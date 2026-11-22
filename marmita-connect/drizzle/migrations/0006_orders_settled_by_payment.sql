ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS settled_by_payment boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.orders.settled_by_payment IS 'true quando o pedido foi quitado por um pagamento posterior (register_payment); pedidos pagos na hora ficam false.';

-- Backfill: pedidos pagos mais antigos cobertos pelos pagamentos já registrados.
WITH paid AS (
  SELECT o.id, o.customer_id,
         sum(o.total) OVER (PARTITION BY o.customer_id ORDER BY o.order_date, o.created_at) AS cum
  FROM public.orders o
  WHERE o.paid = true AND o.delivery_status <> 'cancelado'
), pay AS (
  SELECT customer_id, sum(amount) AS total FROM public.payments GROUP BY customer_id
)
UPDATE public.orders o SET settled_by_payment = true
FROM paid JOIN pay ON pay.customer_id = paid.customer_id
WHERE o.id = paid.id AND paid.cum <= pay.total;

CREATE OR REPLACE FUNCTION public.register_payment(_customer_id uuid, _amount numeric, _method text DEFAULT 'manual'::text, _notes text DEFAULT NULL::text)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  my_company uuid := public.current_company_id();
  cust_company uuid;
  credit numeric;
  ord record;
  payment_id uuid;
begin
  if my_company is null then raise exception 'Empresa não encontrada para o usuário'; end if;
  if _amount is null or _amount <= 0 then raise exception 'Valor do pagamento deve ser maior que zero'; end if;

  select company_id into cust_company from public.customers where id = _customer_id for update;
  if cust_company is null or cust_company <> my_company then raise exception 'Cliente não encontrado'; end if;

  insert into public.payments (company_id, customer_id, amount, method, notes)
  values (my_company, _customer_id, round(_amount, 2), coalesce(_method, 'manual'), _notes)
  returning id into payment_id;

  -- crédito = pagamentos posteriores - pedidos já quitados por pagamento (pedidos pagos na hora não entram)
  select coalesce((select sum(amount) from public.payments where customer_id = _customer_id and company_id = my_company), 0)
       - coalesce((select sum(total) from public.orders where customer_id = _customer_id and company_id = my_company
                     and paid = true and settled_by_payment = true and delivery_status <> 'cancelado'), 0)
    into credit;

  for ord in
    select id, total from public.orders
    where customer_id = _customer_id and company_id = my_company and paid = false and delivery_status <> 'cancelado'
    order by order_date asc, created_at asc
    for update
  loop
    exit when credit < ord.total;
    update public.orders set paid = true, settled_by_payment = true where id = ord.id;
    credit := credit - ord.total;
  end loop;

  update public.customers set status = case
       when exists (select 1 from public.orders where customer_id = _customer_id and company_id = my_company
                       and paid = false and delivery_status <> 'cancelado')
       then 'pendente'::customer_status else 'em_dia'::customer_status end
   where id = _customer_id;

  return payment_id;
end;
$function$;