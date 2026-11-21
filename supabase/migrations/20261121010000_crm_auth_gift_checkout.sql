begin;

create schema crm_private;
revoke all on schema crm_private from public, anon, authenticated;
grant usage on schema crm_private to authenticated;

create function crm_private.app_role()
returns text language sql stable security definer set search_path = ''
as $$
  select role from gift_private.users
  where user_id = auth.uid() and active and coalesce(auth.jwt()->>'is_anonymous', 'false') <> 'true'
$$;
revoke all on function crm_private.app_role() from public, anon, authenticated;
grant execute on function crm_private.app_role() to authenticated;

create function public.membership_crm_role()
returns text language sql stable security invoker set search_path = ''
as $$ select crm_private.app_role() $$;
revoke all on function public.membership_crm_role() from public, anon, authenticated;
grant execute on function public.membership_crm_role() to authenticated;

-- Replace existing permissive application policies on the five CRM tables only.
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['members','checkouts','service_items','sales_people','system_settings'] loop
    for p in select policyname from pg_catalog.pg_policies
        where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('create policy crm_owner on public.%I for all to authenticated
      using ((select crm_private.app_role()) = ''owner'')
      with check ((select crm_private.app_role()) = ''owner'')', t);
  end loop;
end;
$$;

alter table gift_private.services add constraint crm_gift_service_reference
  foreign key (code) references public.service_items(id) not valid;

alter table public.checkouts
  add column gift_request_id uuid unique references gift_private.events(request_id),
  add column gift_applied numeric check (gift_applied >= 0),
  add column gift_unused_value numeric check (gift_unused_value >= 0),
  add column cash_received numeric check (cash_received >= 0),
  add constraint crm_gift_checkout_amounts check (
    (gift_request_id is null and gift_applied is null and gift_unused_value is null and cash_received is null)
    or (gift_request_id is not null and gift_unused_value is not null and
      gift_applied is not null and cash_received is not null and
      final_price is not null and final_price = gift_applied + cash_received)
  );
create index crm_checkout_member_time on public.checkouts(member_id, created_at desc);

create function crm_private.protect_linked_checkout()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  if current_user in ('anon','authenticated') and
     ((tg_op <> 'INSERT' and old.gift_request_id is not null)
      or (tg_op <> 'DELETE' and new.gift_request_id is not null)) then
    raise exception 'Linked gift checkouts require a ledger-controlled operation';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function crm_private.protect_linked_checkout() from public, anon, authenticated;
create trigger crm_checkout_ledger_guard before insert or update or delete on public.checkouts
for each row execute function crm_private.protect_linked_checkout();

create function crm_private.crm(action_name text, args jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  employee_role text := crm_private.app_role();
  member_row public.members%rowtype;
  service_row public.service_items%rowtype;
  member_key uuid := nullif(args->>'member_id','')::uuid;
  payment text := args->>'payment_method';
  therapist_name text := nullif(btrim(args->>'therapist'),'');
  business_day date := (now() at time zone 'Australia/Melbourne')::date;
  checkout_day date := coalesce(nullif(args->>'checkout_date','')::date, (now() at time zone 'UTC')::date);
  configured_fee numeric;
  normal_price numeric;
  final_price numeric;
  checkout_note text;
  answer jsonb;
begin
  if employee_role is null then raise exception 'CRM access is required'; end if;

  if action_name = 'snapshot' then
    select jsonb_build_object(
      'members',coalesce((select jsonb_agg(
        case when employee_role='owner' then to_jsonb(m) else
          jsonb_build_object('id',m.id,'card_id',m.card_id,'full_name',m.full_name,'phone',m.phone,
            'email',m.email,'birthday',m.birthday,'suburb',m.suburb,'join_date',m.join_date,
            'expiry_date',m.expiry_date,'status',m.status,'deleted',m.deleted,'created_at',m.created_at) end
        order by m.created_at desc) from public.members m where employee_role='owner' or m.deleted=false),'[]'::jsonb),
      'checkouts',coalesce((select jsonb_agg(
        case when employee_role='owner' then to_jsonb(c) else
          jsonb_build_object('id',c.id,'member_id',c.member_id,'customer_name',c.customer_name,
          'customer_type',c.customer_type,'service_name',c.service_name,'duration',c.duration,
          'final_price',c.final_price,'created_at',c.created_at,'therapist',c.therapist,
          'deleted',c.deleted,'gift_applied',c.gift_applied,'gift_unused_value',c.gift_unused_value,
          'cash_received',c.cash_received,'payment_method',c.payment_method) end
        order by c.created_at desc) from public.checkouts c where employee_role='owner' or c.deleted=false),'[]'::jsonb),
      'services',coalesce((select jsonb_agg(
        case when employee_role='owner' then to_jsonb(s) else jsonb_build_object('id',s.id,'name',s.name,'duration',s.duration,'price',s.price,
          'normal_price',s.normal_price,'member_price',s.member_price,'member_allowed',s.member_allowed,
          'discount_type',s.discount_type,'discount_value',s.discount_value,'active',s.active) end order by s.name)
        from public.service_items s where employee_role='owner' or s.active is distinct from false),'[]'::jsonb),
      'sellers',coalesce((select jsonb_agg(s.name order by s.name)
        from public.sales_people s where s.active is distinct from false),'[]'::jsonb),
      'membership_fee',coalesce((select value from public.system_settings where key='membership_fee'),'100')
    ) into answer;
    return answer;
  end if;

  if action_name = 'receipts' then
    if employee_role <> 'owner' then raise exception 'Owner access is required'; end if;
    with entries as (
      select c.created_at,coalesce(c.cash_received,c.final_price,0) as amount, 'checkout'::text as kind
      from public.checkouts c where c.deleted=false
      union all
      select e.created_at,(e.result->>'cash_sale')::numeric/100,'gift_sale'
      from gift_private.events e where e.action='sale'
      union all
      -- Older standalone gift redemptions had no checkout row.
      select e.created_at,(e.result->>'topup')::numeric/100,'older_gift_topup'
      from gift_private.events e where e.action in ('redeem','exchange') and
        not exists (select 1 from public.checkouts c where c.gift_request_id=e.request_id)
    )
    select jsonb_build_object(
      'total',coalesce(sum(amount),0),
      'checkouts',coalesce(sum(amount) filter (where kind='checkout'),0),
      'gift_sales',coalesce(sum(amount) filter (where kind='gift_sale'),0),
      'older_topups',coalesce(sum(amount) filter (where kind='older_gift_topup'),0),
      'today',coalesce(sum(amount) filter (where (created_at at time zone 'Australia/Melbourne')::date=business_day),0),
      'month',coalesce(sum(amount) filter (where date_trunc('month',created_at at time zone 'Australia/Melbourne')=date_trunc('month',business_day::timestamp)),0)
    ) into answer from entries;
    return answer;
  end if;

  if action_name in ('renew_member','mark_receipt') or (action_name='checkout' and member_key is not null) then
    select * into member_row from public.members where id=member_key and deleted=false for share;
    if not found then raise exception 'Active member record not found'; end if;
  end if;

  if action_name in ('add_member','renew_member') then
    select coalesce((select value from public.system_settings where key='membership_fee'),'100')::numeric into configured_fee;
  end if;

  case action_name
  when 'add_member' then
    if nullif(btrim(args->>'full_name'),'') is null or nullif(btrim(args->>'card_id'),'') is null then
      raise exception 'Member name and card number are required';
    end if;
    insert into public.members(card_id,full_name,phone,email,birthday,suburb,gender,referral_source,
      sold_by,home_store,expiry_date,payment_method,notes,join_date,membership_fee,status,deleted,receipt_sent)
    values(btrim(args->>'card_id'),btrim(args->>'full_name'),args->>'phone',args->>'email',
      nullif(args->>'birthday','')::date,args->>'suburb',args->>'gender',args->>'referral_source',
      args->>'sold_by',args->>'home_store',coalesce(nullif(args->>'expiry_date','')::date,(business_day+interval '1 year')::date),
      args->>'payment_method',args->>'notes',business_day,configured_fee,'active',false,false)
    returning * into member_row;
    -- The receipt generator needs the submitted fields and the database-set fee.
    return to_jsonb(member_row);
  when 'renew_member' then
    update public.members set expiry_date=(business_day+interval '1 year')::date,
      status='active',membership_fee=configured_fee where id=member_key and deleted=false;
  when 'mark_receipt' then
    update public.members set receipt_sent=true,receipt_sent_at=now() where id=member_key and deleted=false;
  when 'checkout' then
    select * into service_row from public.service_items where id=args->>'service_id' and active is distinct from false;
    if not found then raise exception 'Select an active service'; end if;
    if payment is null or payment not in ('Cash','Card','Bank Transfer','Redeem First Hour Massage') then
      raise exception 'Select a payment method';
    end if;
    normal_price:=coalesce(service_row.normal_price,service_row.price,0);
    final_price:=normal_price;
    checkout_note:='Guest / normal price applied.';
    if member_key is not null then
      if member_row.expiry_date < (now() at time zone 'UTC')::date then
        checkout_note:='Member expired. Normal price applied.';
      elsif service_row.member_allowed then
        final_price:=coalesce(nullif(service_row.member_price,0),normal_price);
        checkout_note:='Member price applied.';
      else
        checkout_note:='This service is not eligible for member price.';
      end if;
    end if;
    if payment='Redeem First Hour Massage' then
      if coalesce(nullif(service_row.duration,0),1)<1 then raise exception 'First Hour requires at least 60 minutes'; end if;
      final_price:=greatest(normal_price-100,0);
      checkout_note:='Redeem First Hour applied.';
    end if;
    if (args->>'expected_price')::numeric is distinct from final_price then raise exception 'Price changed. Refresh checkout before saving'; end if;
    insert into public.checkouts(member_id,customer_name,customer_type,service_name,duration,
      original_price,final_price,staff_pay,shop_profit,payment_method,therapist,customer_suburb,
      price_note,service_price,deleted,created_at)
    values(member_key,coalesce(member_row.full_name,'Guest'),case when member_key is null then 'guest' else 'member' end,
      service_row.name,coalesce(nullif(service_row.duration,0),1),normal_price,final_price,coalesce(service_row.staff_pay,0),
      final_price-coalesce(service_row.staff_pay,0),payment,therapist_name,coalesce(member_row.suburb,''),
      coalesce(case when employee_role='owner' then nullif(btrim(args->>'price_note'),'') end,checkout_note),
      final_price,false,(checkout_day+time '12:00') at time zone 'Australia/Melbourne');
  else raise exception 'Unknown CRM operation';
  end case;
  return jsonb_build_object('saved',true);
end;
$$;
revoke all on function crm_private.crm(text,jsonb) from public, anon, authenticated;
grant execute on function crm_private.crm(text,jsonb) to authenticated;
create function public.membership_crm(action_name text, args jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$ select crm_private.crm(action_name,args) $$;
revoke all on function public.membership_crm(text,jsonb) from public, anon, authenticated;
grant execute on function public.membership_crm(text,jsonb) to authenticated;

create function crm_private.integrated_gift(action_name text, args jsonb, operation_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  outcome jsonb;
  member_key uuid;
  member_row public.members%rowtype;
  service_row public.service_items%rowtype;
  price numeric;
  cash_amount numeric;
begin
  if crm_private.app_role() is null then raise exception 'CRM access is required'; end if;

  if action_name in ('redeem','exchange') then
    if coalesce((args->'quote'->>'service_value_released')::bigint,0)>0
       and args->'unused_value_confirmed' is distinct from 'true'::jsonb then
      raise exception 'Customer confirmation is required for unused service gift value';
    end if;
  end if;

  if action_name='set_service' and not exists
    (select 1 from public.service_items where id=btrim(args->>'service_code')) then
    raise exception 'Select an existing CRM service for this gift service';
  end if;

  -- The original operation handles locking, quote verification and idempotency.
  outcome:=gift_private.operate(action_name,args,operation_id);
  if action_name not in ('redeem','exchange') then return outcome; end if;

  if exists (select 1 from public.checkouts where gift_request_id=operation_id) then return outcome; end if;

  member_key:=nullif(args->>'member_id','')::uuid;
  if member_key is not null then
    select * into member_row from public.members where id=member_key and deleted=false for share;
    if not found then raise exception 'Active member record not found'; end if;
  end if;
  select * into service_row from public.service_items where id=outcome->>'service_code' for share;
  if not found then raise exception 'Link the gift service to a CRM service before redeeming'; end if;
  price:=(outcome->>'service_price')::numeric/100;
  cash_amount:=(outcome->>'topup')::numeric/100;

  insert into public.checkouts(member_id,customer_name,customer_type,service_name,duration,
    original_price,final_price,staff_pay,shop_profit,payment_method,therapist,customer_suburb,
    price_note,service_price,deleted,gift_request_id,gift_applied,gift_unused_value,cash_received)
  values(member_key,coalesce(member_row.full_name,'Guest'),case when member_key is null then 'guest' else 'member' end,
    outcome->>'service_name',coalesce(nullif(service_row.duration,0),1),price,price,coalesce(service_row.staff_pay,0),
    price-coalesce(service_row.staff_pay,0),'Gift Card'||coalesce(' + '||(outcome->>'payment'),''),
    nullif(btrim(args->>'therapist'),''),coalesce(member_row.suburb,''),'Gift card redemption',price,false,
    operation_id,(outcome->>'redeemed')::numeric/100,(outcome->>'service_value_released')::numeric/100,cash_amount);
  return outcome;
end;
$$;
revoke execute on function gift_private.operate(text,jsonb,uuid) from public, anon, authenticated;
revoke all on function crm_private.integrated_gift(text,jsonb,uuid) from public, anon, authenticated;
grant execute on function crm_private.integrated_gift(text,jsonb,uuid) to authenticated;
create or replace function public.membership_gift_card(action_name text, args jsonb default '{}'::jsonb, operation_id uuid default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select crm_private.integrated_gift(action_name,args,operation_id) $$;
commit;
