create or replace function public.assert_same_company()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  rec jsonb := to_jsonb(new);
  cust uuid := nullif(rec->>'customer_id','')::uuid;
  ord uuid := nullif(rec->>'order_id','')::uuid;
  comp uuid := nullif(rec->>'company_id','')::uuid;
  found_company uuid;
begin
  if cust is not null then
    select company_id into found_company from public.customers where id = cust;
    if found_company is null or found_company <> comp then
      raise exception 'Cliente não pertence à empresa do registro';
    end if;
  end if;

  if ord is not null then
    select company_id into found_company from public.orders where id = ord;
    if found_company is null or found_company <> comp then
      raise exception 'Pedido não pertence à empresa do registro';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.assert_same_company() from public, anon;