-- 1. Lock down anonymous access to every application table
revoke all on public.companies, public.profiles, public.user_roles, public.customers,
  public.orders, public.payments, public.whatsapp_messages from anon;

revoke all on public.profiles from authenticated;
grant select, update on public.profiles to authenticated;
revoke all on public.companies from authenticated;
grant select, update on public.companies to authenticated;
revoke all on public.user_roles from authenticated;
grant select on public.user_roles to authenticated;

grant all on public.companies, public.profiles, public.user_roles, public.customers,
  public.orders, public.payments, public.whatsapp_messages to service_role;

-- 2. Security definer helpers must not be callable anonymously
revoke all on function public.current_company_id() from public, anon;
revoke all on function public.has_role(uuid, public.app_role) from public, anon;
grant execute on function public.current_company_id() to authenticated, service_role;
grant execute on function public.has_role(uuid, public.app_role) to authenticated, service_role;

-- 3. CRITICAL: a user could previously update their own profile row and move
--    company_id to another tenant, gaining full access to that tenant's data.
drop policy if exists "own profile update" on public.profiles;
create policy "own profile update"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and company_id = public.current_company_id());

-- companies: pin the with check too
drop policy if exists "update own company" on public.companies;
create policy "update own company"
  on public.companies for update to authenticated
  using (id = public.current_company_id())
  with check (id = public.current_company_id());

-- 4. Financial / data integrity constraints
alter table public.orders
  add constraint orders_quantity_positive check (quantity > 0),
  add constraint orders_unit_price_nonneg check (unit_price >= 0);
alter table public.payments
  add constraint payments_amount_positive check (amount > 0);
alter table public.companies
  add constraint companies_default_unit_price_nonneg check (default_unit_price >= 0),
  add constraint companies_name_not_blank check (length(btrim(name)) > 0);
alter table public.customers
  add constraint customers_name_not_blank check (length(btrim(name)) > 0),
  add constraint customers_phone_digits check (length(regexp_replace(phone, '\D', '', 'g')) between 8 and 15);

-- 5. Cross-tenant row stitching guard: a child row must reference records of the same company
create or replace function public.assert_same_company()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cust_company uuid;
  ord_company uuid;
begin
  if new.customer_id is not null then
    select company_id into cust_company from public.customers where id = new.customer_id;
    if cust_company is null or cust_company <> new.company_id then
      raise exception 'Cliente não pertence à empresa do registro';
    end if;
  end if;

  if tg_table_name = 'whatsapp_messages' and new.order_id is not null then
    select company_id into ord_company from public.orders where id = new.order_id;
    if ord_company is null or ord_company <> new.company_id then
      raise exception 'Pedido não pertence à empresa do registro';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.assert_same_company() from public, anon;

create trigger orders_same_company before insert or update on public.orders
  for each row execute function public.assert_same_company();
create trigger payments_same_company before insert or update on public.payments
  for each row execute function public.assert_same_company();
create trigger whatsapp_messages_same_company before insert or update on public.whatsapp_messages
  for each row execute function public.assert_same_company();

-- 6. Missing indexes for tenant-scoped reads
create index if not exists customers_company_id_name_idx on public.customers (company_id, name);
create index if not exists payments_company_id_paid_at_idx on public.payments (company_id, paid_at desc);
create index if not exists payments_customer_id_idx on public.payments (customer_id);
create index if not exists orders_company_id_paid_idx on public.orders (company_id, paid) where paid = false;
create index if not exists whatsapp_messages_customer_id_idx on public.whatsapp_messages (customer_id);
create index if not exists profiles_company_id_idx on public.profiles (company_id);

-- 7. Atomic payment registration with FIFO allocation (supports partial payments)
create or replace function public.register_payment(
  _customer_id uuid,
  _amount numeric,
  _method text default 'manual',
  _notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  my_company uuid := public.current_company_id();
  cust_company uuid;
  credit numeric;
  ord record;
  payment_id uuid;
begin
  if my_company is null then
    raise exception 'Empresa não encontrada para o usuário';
  end if;
  if _amount is null or _amount <= 0 then
    raise exception 'Valor do pagamento deve ser maior que zero';
  end if;

  select company_id into cust_company from public.customers where id = _customer_id for update;
  if cust_company is null or cust_company <> my_company then
    raise exception 'Cliente não encontrado';
  end if;

  insert into public.payments (company_id, customer_id, amount, method, notes)
  values (my_company, _customer_id, round(_amount, 2), coalesce(_method, 'manual'), _notes)
  returning id into payment_id;

  -- available credit = everything already paid minus everything already settled
  select coalesce((select sum(amount) from public.payments
                    where customer_id = _customer_id and company_id = my_company), 0)
       - coalesce((select sum(total) from public.orders
                    where customer_id = _customer_id and company_id = my_company
                      and paid = true and delivery_status <> 'cancelado'), 0)
    into credit;

  for ord in
    select id, total from public.orders
    where customer_id = _customer_id and company_id = my_company
      and paid = false and delivery_status <> 'cancelado'
    order by order_date asc, created_at asc
    for update
  loop
    exit when credit < ord.total;
    update public.orders set paid = true where id = ord.id;
    credit := credit - ord.total;
  end loop;

  update public.customers
     set status = case
       when exists (select 1 from public.orders
                     where customer_id = _customer_id and company_id = my_company
                       and paid = false and delivery_status <> 'cancelado')
       then 'pendente'::customer_status else 'em_dia'::customer_status end
   where id = _customer_id;

  return payment_id;
end;
$$;

revoke all on function public.register_payment(uuid, numeric, text, text) from public, anon;
grant execute on function public.register_payment(uuid, numeric, text, text) to authenticated;