begin;

create schema gift_private;
revoke all on schema gift_private from public, anon, authenticated;

create table gift_private.users (
  user_id uuid primary key references auth.users(id),
  role text not null check (role in ('owner', 'staff')),
  display_name text not null check (length(trim(display_name)) between 1 and 100),
  active boolean not null default true
);

create table gift_private.services (
  code text primary key,
  name text not null,
  price bigint not null check (price between 1 and 100000000),
  active boolean not null default true
);

create table gift_private.cards (
  barcode text primary key check (barcode ~ '^[A-Za-z0-9._/-]{1,100}$'),
  status text not null check (status in ('stock', 'pending', 'rejected', 'active', 'spent', 'exchanged')),
  kind text not null default 'dollar' check (kind in ('dollar', 'service', 'legacy')),
  balance bigint not null default 0 check (balance between 0 and 100000000),
  expires_on date,
  service_code text references gift_private.services(code),
  service_name text,
  service_value bigint,
  check ((status = 'active') = (balance > 0)),
  check (status <> 'active' or expires_on is not null)
);

create table gift_private.events (
  request_id uuid primary key,
  actor uuid not null references gift_private.users(user_id),
  action text not null,
  barcode text references gift_private.cards(barcode),
  related_barcode text references gift_private.cards(barcode),
  request jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
create index gift_events_barcode on gift_private.events(barcode, created_at desc);
create index gift_events_related on gift_private.events(related_barcode, created_at desc);

alter table gift_private.users enable row level security;
alter table gift_private.services enable row level security;
alter table gift_private.cards enable row level security;
alter table gift_private.events enable row level security;
revoke all on all tables in schema gift_private from public, anon, authenticated;

create function gift_private.operate(action_name text, args jsonb, operation_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text;
  actor_name text;
  card_code text := btrim(args->>'barcode');
  replacement text := btrim(args->>'replacement');
  chosen_code text := btrim(args->>'service_code');
  expires date := nullif(args->>'expires_on','')::date;
  business_day date := (now() at time zone 'Australia/Melbourne')::date;
  amount bigint := nullif(args->>'amount','')::bigint;
  payment text := args->>'payment';
  reason text := nullif(btrim(args->>'reason'),'');
  card gift_private.cards%rowtype;
  recipient gift_private.cards%rowtype;
  service gift_private.services%rowtype;
  prior gift_private.events%rowtype;
  result jsonb;
  before_balance bigint;
  after_balance bigint;
  price bigint;
  redeemed bigint;
  topup bigint;
  transferred bigint := 0;
begin
  select role, display_name into actor_role, actor_name
    from gift_private.users where user_id = actor_id and active;
  if actor_role is null then raise exception 'Gift Card access is required'; end if;
  if action_name in ('stock','approve','reject','adjust','set_service','report','pending')
     and actor_role <> 'owner' then raise exception 'Owner access is required'; end if;

  if action_name = 'overview' then
    return jsonb_build_object('role',actor_role,'name',actor_name,'services',
      coalesce((select jsonb_agg(to_jsonb(s) order by s.name)
      from gift_private.services s where s.active or actor_role = 'owner'),'[]'::jsonb));
  elsif action_name = 'pending' then
    return coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object('claim',e.result) order by e.created_at)
      from gift_private.cards c join gift_private.events e on e.barcode=c.barcode and e.action='claim'
      where c.status='pending'),'[]'::jsonb);
  elsif action_name = 'report' then
    return jsonb_build_object(
      'sold',(select coalesce(sum((e.result->>'cash_sale')::bigint),0) from gift_private.events e),
      'redeemed',(select coalesce(sum((e.result->>'redeemed')::bigint),0) from gift_private.events e),
      'topup',(select coalesce(sum((e.result->>'topup')::bigint),0) from gift_private.events e),
      'transferred',(select coalesce(sum((e.result->>'transferred')::bigint),0) from gift_private.events e),
      'outstanding',(select coalesce(sum(balance),0) from gift_private.cards where status='active' and expires_on>=business_day),
      'expired_balance',(select coalesce(sum(balance),0) from gift_private.cards where status='active' and expires_on<business_day),
      'events',coalesce((select jsonb_agg(to_jsonb(e)-'request' order by e.created_at desc, e.request_id)
        from (select * from gift_private.events order by created_at desc, request_id limit 100) e),'[]'::jsonb));
  end if;

  if action_name <> 'set_service' then
    if card_code is null or card_code !~ '^[A-Za-z0-9._/-]{1,100}$' then
      raise exception 'Scan or enter a valid barcode';
    end if;
    select * into card from gift_private.cards where barcode=card_code;
  end if;

  if action_name = 'lookup' then
    if card.barcode is null then raise exception 'Card not found'; end if;
    return to_jsonb(card) || jsonb_build_object('is_expired',coalesce(card.expires_on<business_day,false),
      'history',coalesce((select jsonb_agg(jsonb_build_object('action',e.action,'created_at',e.created_at,'result',
      case when actor_role='owner' then e.result else e.result-'reason'-'actor_name' end)
      order by e.created_at desc, e.request_id) from (select * from gift_private.events
      where barcode=card_code or related_barcode=card_code order by created_at desc, request_id limit 100) e
      where actor_role='owner' or e.action in ('sale','redeem','exchange','transfer')),'[]'::jsonb));
  end if;

  if action_name <> 'quote' then
    if operation_id is null then raise exception 'Operation ID is required'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(operation_id::text, 0));
    select * into prior from gift_private.events where request_id=operation_id;
    if found then
      if prior.actor<>actor_id or prior.action<>action_name or prior.request<>args then
        raise exception 'Operation ID already used';
      end if;
      return prior.result;
    end if;
  end if;

  if action_name not in ('stock','claim','set_service','quote') then
    -- Lock both cards in the same order for every operation involving two cards.
    perform barcode from gift_private.cards where barcode=card_code
      or (action_name in ('exchange','transfer') and barcode=replacement) order by barcode for update;
    select * into card from gift_private.cards where barcode=card_code;
    if not found then raise exception 'Card not found'; end if;
  end if;

  before_balance := coalesce(card.balance,0);
  if action_name in ('sale','quote','redeem','exchange') and chosen_code is not null then
    select * into service from gift_private.services where code=chosen_code and (active or (action_name<>'sale' and card.kind='service' and card.service_code=code));
    if not found then raise exception 'Select a currently available gift card service'; end if;
  end if;

  case action_name
  when 'set_service' then
    if chosen_code is null or chosen_code !~ '^[A-Za-z0-9_-]{1,80}$'
       or amount is null or amount not between 1 and 100000000
       or nullif(btrim(args->>'name'),'') is null or length(args->>'name')>200 then
      raise exception 'Enter a service code, name and positive price';
    end if;
    insert into gift_private.services values (chosen_code,btrim(args->>'name'),amount,coalesce((args->>'active')::boolean,true))
      on conflict (code) do update set name=excluded.name,price=excluded.price,active=excluded.active;
    result := jsonb_build_object('service_code',chosen_code,'price',amount,
      'name',btrim(args->>'name'),'active',coalesce((args->>'active')::boolean,true));
  when 'stock' then
    insert into gift_private.cards(barcode,status) values (card_code,'stock');
    result := jsonb_build_object('status','stock');
  when 'claim' then
    if amount is null or amount not between 1 and 100000000 or reason is null or length(reason)>1000 then
      raise exception 'Enter the claimed value and supporting details';
    end if;
    insert into gift_private.cards(barcode,status,kind) values(card_code,'pending','legacy');
    result := jsonb_build_object('status','pending','claimed',amount,'reason',reason);
  when 'approve', 'reject' then
    if card.status<>'pending' or reason is null or length(reason)>1000 then
      raise exception 'A pending claim and review reason are required';
    end if;
    if action_name='approve' then
      if amount is null or amount not between 1 and 100000000 or expires is null or expires<business_day then
        raise exception 'Enter the approved balance and a valid expiry';
      end if;
      update gift_private.cards set status='active',balance=amount,expires_on=expires where barcode=card_code;
      result := jsonb_build_object('status','active','before',0,'after',amount,'expires_on',expires,'reason',reason);
    else
      update gift_private.cards set status='rejected' where barcode=card_code;
      result := jsonb_build_object('status','rejected','reason',reason);
    end if;
  when 'sale' then
    if card.status<>'stock' or expires is null or expires<business_day
       or payment is null or payment not in ('Cash','Tyro','Stripe','Bank Transfer','Other') then
      raise exception 'An unused stock card, valid expiry and payment method are required';
    end if;
    amount := coalesce(service.price,amount);
    if amount is null or amount not between 1 and 100000000 then raise exception 'Enter a positive card value'; end if;
    update gift_private.cards set status='active',kind=case when service.code is null then 'dollar' else 'service' end,
      balance=amount,expires_on=expires,service_code=service.code,service_name=service.name,service_value=service.price
      where barcode=card_code;
    result := jsonb_build_object('before',0,'after',amount,'cash_sale',amount,'payment',payment,'expires_on',expires,
      'service_name',service.name,'service_value',service.price);
  when 'adjust' then
    if card.status not in ('active','spent') or amount is null
       or amount not between 0 and 100000000 or reason is null or length(reason)>1000 then
      raise exception 'Enter a new balance and reason for an issued card';
    end if;
    if card.kind='service' and (card.status<>'active' or amount<>0) then
      raise exception 'An owner can void an unused service gift with a zero balance. Its original value is fixed';
    end if;
    update gift_private.cards set balance=amount,status=case when amount=0 then 'spent' else 'active' end
      where barcode=card_code;
    result := jsonb_build_object('before',before_balance,'after',amount,'reason',reason);
  when 'transfer' then
    select * into recipient from gift_private.cards where barcode=replacement;
    if card.kind<>'legacy' or card.status<>'active' or card.expires_on<business_day
       or recipient.status is distinct from 'stock' or args->>'old_card_collected' is distinct from 'true' then
      raise exception 'Collect the active old legacy card and scan an unused replacement';
    end if;
    if amount is distinct from before_balance then raise exception 'Balance changed. Scan the old card again'; end if;
    update gift_private.cards set status='active',balance=before_balance,expires_on=card.expires_on
      where barcode=replacement;
    update gift_private.cards set balance=0,status='exchanged' where barcode=card_code;
    result := jsonb_build_object('before',before_balance,'after',0,'transferred',before_balance,'replacement',replacement);
  when 'quote', 'redeem', 'exchange' then
    if card.status is distinct from 'active' or card.expires_on<business_day or service.code is null then
      raise exception 'An active unexpired card and an available service are required';
    end if;
    price := case when card.kind='service' and card.service_code=service.code then card.service_value else service.price end;
    redeemed := least(before_balance,price);
    topup := price-redeemed;
    after_balance := case when card.kind='service' then 0 else before_balance-redeemed end;
    result := jsonb_build_object('before',before_balance,'after',after_balance,'service_price',price,
      'redeemed',redeemed,'topup',topup,'service_name',case when card.kind='service' and card.service_code=service.code then card.service_name else service.name end,'service_code',service.code,
      'service_value_released',before_balance-redeemed-after_balance);
    if action_name='quote' then return result; end if;
    if args->'quote' is distinct from result then raise exception 'Price or balance changed. Refresh the quote'; end if;
    if topup>0 and (payment is null or payment not in ('Cash','Tyro','Stripe','Bank Transfer','Other')
       or args->>'payment_confirmed' is distinct from 'true') then
      raise exception 'Confirm the balance payment and select its payment method';
    end if;
    if action_name='exchange' then
      select * into recipient from gift_private.cards where barcode=replacement;
      if card.kind<>'legacy' or after_balance<=0 or recipient.status is distinct from 'stock'
         or args->>'old_card_collected' is distinct from 'true' then
        raise exception 'Collect the old legacy card and scan an unused replacement for the remaining balance';
      end if;
      transferred := after_balance;
      after_balance := 0;
      update gift_private.cards set status='active',balance=transferred,expires_on=card.expires_on
        where barcode=replacement;
    end if;
    update gift_private.cards set balance=after_balance,status=case when action_name='exchange' then 'exchanged'
      when after_balance=0 then 'spent' else 'active' end where barcode=card_code;
    result := result || jsonb_build_object('after',after_balance,'transferred',transferred,
      'replacement',case when action_name='exchange' then replacement end,'payment',case when topup>0 then payment end);
  else raise exception 'Unknown Gift Card operation';
  end case;

  result := result || jsonb_build_object('actor_name',actor_name,'barcode',card_code);
  insert into gift_private.events(request_id,actor,action,barcode,related_barcode,request,result)
    values(operation_id,actor_id,action_name,card_code,case when action_name in ('exchange','transfer') then replacement end,args,result);
  return result;
end;
$$;

revoke all on function gift_private.operate(text,jsonb,uuid) from public, anon, authenticated;
grant usage on schema gift_private to authenticated;
grant execute on function gift_private.operate(text,jsonb,uuid) to authenticated;

create function public.membership_gift_card(action_name text, args jsonb default '{}'::jsonb, operation_id uuid default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select gift_private.operate(action_name,args,operation_id) $$;
revoke all on function public.membership_gift_card(text,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.membership_gift_card(text,jsonb,uuid) to authenticated;
commit;
