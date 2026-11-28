create role anon;
create role authenticated;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function auth.jwt() returns jsonb language sql stable
as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;

create table public.members (
  id uuid primary key default gen_random_uuid(), card_id text unique not null, full_name text not null,
  phone text, join_date date default current_date, expiry_date date not null, membership_fee numeric default 100,
  payment_method text default 'Cash', status text default 'active', notes text, created_at timestamptz default now(),
  email text, birthday date, suburb text, gender text, referral_source text, preferred_therapist text,
  home_store text default 'Abbotsford', sold_by text, deleted boolean default false, receipt_sent boolean default false,
  receipt_sent_at timestamptz
);
create table public.checkouts (
  id uuid primary key default gen_random_uuid(), member_id uuid references public.members on delete set null,
  customer_name text, customer_type text default 'guest', service_name text not null, duration numeric not null,
  original_price numeric not null, final_price numeric not null, staff_pay numeric not null, shop_profit numeric not null,
  payment_method text default 'Cash', created_at timestamptz default now(), discount_amount numeric default 0,
  price_override boolean default false, price_note text, therapist text, customer_suburb text,
  discount_type text default '$', discount_value numeric default 0, service_price numeric default 0,
  deleted boolean default false
);
create table public.service_items (
  id text primary key, name text not null, duration numeric default 1, price numeric default 0,
  staff_pay numeric default 30, member_allowed boolean default true, active boolean default true,
  created_at timestamptz default now(), discount_type text default '$', discount_value numeric default 0,
  member_price numeric default 0, normal_price numeric default 0
);
create table public.sales_people (
  id uuid primary key default gen_random_uuid(), name text unique not null,
  active boolean default true, created_at timestamptz default now()
);
create table public.system_settings (key text primary key, value text);
create table public.clients (id uuid primary key default gen_random_uuid());
create table public.intake_forms (id uuid primary key default gen_random_uuid());
create table public.soap_notes (id uuid primary key default gen_random_uuid());

do $$
declare t text;
begin
  foreach t in array array['members','checkouts','service_items','sales_people','system_settings','clients','intake_forms','soap_notes'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('grant all on public.%I to anon, authenticated',t);
    execute format('create policy legacy_public on public.%I for all using (true) with check (true)',t);
  end loop;
end;
$$;
