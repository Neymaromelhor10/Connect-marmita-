-- ENUMS
create type public.payment_cycle as enum ('diario','semanal','quinzenal','mensal');
create type public.customer_status as enum ('em_dia','pendente','atrasado');
create type public.delivery_status as enum ('pendente','preparando','em_rota','entregue','cancelado');
create type public.app_role as enum ('admin','user');

-- COMPANIES
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  default_unit_price numeric(10,2) not null default 20.00,
  whatsapp_connected boolean not null default false,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.companies to authenticated;
grant all on public.companies to service_role;
alter table public.companies enable row level security;

-- PROFILES
create table public.profiles (
  id uuid primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  full_name text,
  email text,
  created_at timestamptz not null default now()
);
grant select, insert, update on public.profiles to authenticated;
grant all on public.profiles to service_role;
alter table public.profiles enable row level security;

-- USER ROLES
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  role public.app_role not null,
  unique (user_id, role)
);
grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;

-- helper: current company
create or replace function public.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select company_id from public.profiles where id = auth.uid()
$$;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

-- CUSTOMERS
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  phone text not null,
  address text,
  notes text,
  payment_cycle public.payment_cycle not null default 'semanal',
  status public.customer_status not null default 'em_dia',
  created_at timestamptz not null default now(),
  unique (company_id, phone)
);
grant select, insert, update, delete on public.customers to authenticated;
grant all on public.customers to service_role;
alter table public.customers enable row level security;

-- ORDERS
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  quantity integer not null default 1,
  unit_price numeric(10,2) not null default 0,
  total numeric(10,2) not null default 0,
  order_date date not null default current_date,
  delivery_status public.delivery_status not null default 'pendente',
  paid boolean not null default false,
  source text not null default 'manual',
  notes text,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.orders to authenticated;
grant all on public.orders to service_role;
alter table public.orders enable row level security;

-- PAYMENTS
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  amount numeric(10,2) not null,
  paid_at timestamptz not null default now(),
  method text,
  notes text
);
grant select, insert, update, delete on public.payments to authenticated;
grant all on public.payments to service_role;
alter table public.payments enable row level security;

-- WHATSAPP MESSAGES
create table public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  phone text not null,
  direction text not null default 'inbound',
  body text not null,
  parsed jsonb,
  order_id uuid references public.orders(id) on delete set null,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.whatsapp_messages to authenticated;
grant all on public.whatsapp_messages to service_role;
alter table public.whatsapp_messages enable row level security;

-- POLICIES
create policy "own company" on public.companies for select to authenticated
  using (id = public.current_company_id());
create policy "update own company" on public.companies for update to authenticated
  using (id = public.current_company_id());

create policy "own profile select" on public.profiles for select to authenticated
  using (id = auth.uid() or company_id = public.current_company_id());
create policy "own profile update" on public.profiles for update to authenticated
  using (id = auth.uid());

create policy "own roles" on public.user_roles for select to authenticated
  using (user_id = auth.uid());

create policy "company customers" on public.customers for all to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

create policy "company orders" on public.orders for all to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

create policy "company payments" on public.payments for all to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

create policy "company messages" on public.whatsapp_messages for all to authenticated
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- order total trigger
create or replace function public.set_order_total()
returns trigger language plpgsql set search_path = public as $$
begin
  new.total := coalesce(new.quantity,0) * coalesce(new.unit_price,0);
  return new;
end; $$;
create trigger orders_total before insert or update on public.orders
  for each row execute function public.set_order_total();

create index on public.orders (company_id, order_date);
create index on public.orders (customer_id);
create index on public.whatsapp_messages (company_id, created_at desc);