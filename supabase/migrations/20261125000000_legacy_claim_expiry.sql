begin;

create or replace function gift_private.operate(action_name text, args jsonb, operation_id uuid)
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
  old_expires date;
  expires date := nullif(args->>'expires_on','')::date;
  business_day date := (now() at time zone 'Australia/Melbourne')::date;
  amount bigint := nullif(args->>'amount','')::bigint;
  payment text := args->>'payment';
  reason text := nullif(btrim(args->>'reason'),'');
  card gift_private.cards%rowtype;
  recipient gift_private.cards%rowtype;
  service gift_private.crm_service_catalog%rowtype;
  prior gift_private.events%rowtype;
  result jsonb;
  before_balance bigint;
  after_balance bigint;
  price bigint;
  redeemed bigint;
  topup bigint;
  transferred bigint := 0;
  inserted_count integer;
  redeem_amount bigint;
begin
  select role, display_name into actor_role, actor_name
    from gift_private.users where user_id = actor_id and active;
  if actor_role is null then raise exception 'Gift Card access is required'; end if;
  if action_name in ('stock','approve','reject','adjust','set_service','report','pending','cancel_card','correct_card','manage_lookup','stock_batch','manage_list')
     and actor_role <> 'owner' then raise exception 'Owner access is required'; end if;

  if action_name = 'overview' then
    return jsonb_build_object('role',actor_role,'name',actor_name,'services',
      coalesce((select jsonb_agg(to_jsonb(s) order by s.name)
      from gift_private.crm_service_catalog s where s.active),'[]'::jsonb));
  elsif action_name = 'pending' then
    return coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object('claim',e.result,'submitted_at',e.created_at) order by e.created_at)
      from gift_private.cards c join gift_private.events e on e.barcode=c.barcode and e.action='claim'
      where c.status='pending' and (args->>'barcode' is null or c.barcode=args->>'barcode')),'[]'::jsonb);
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

  if action_name = 'manage_list' then
    return coalesce((
      select jsonb_agg(jsonb_build_object(
        'barcode', c.barcode, 'status', c.status, 'balance', c.balance,
        'expires_on', c.expires_on, 'is_expired', coalesce(c.expires_on < business_day,false),
        'original_value', coalesce(c.service_value, issued.value)
      ) order by c.barcode)
      from (
        select * from gift_private.cards
        where barcode > coalesce(args->>'after','')
        order by barcode limit 51
      ) c
      left join lateral (
        select case when e.action='sale' then (e.result->>'cash_sale')::bigint
          when e.action='approve' then (e.result->>'after')::bigint
          else (e.result->>'transferred')::bigint end as value
        from gift_private.events e
        where (e.barcode=c.barcode and e.action in ('sale','approve'))
           or (e.related_barcode=c.barcode and e.action in ('transfer','exchange'))
        order by e.created_at,e.request_id limit 1
      ) issued on true
    ),'[]'::jsonb);
  end if;

  if action_name not in ('set_service','stock_batch') then
    if card_code is null or card_code !~ '^[A-Za-z0-9._/-]{1,100}$' then
      raise exception 'Scan or enter a valid barcode';
    end if;
    select * into card from gift_private.cards where barcode=card_code;
  end if;

  if action_name in ('lookup','manage_lookup') then
    if card.barcode is null then raise exception 'Card not found'; end if;
    return (case when actor_role='owner' then to_jsonb(card) else to_jsonb(card)-'registration_note' end)
      || jsonb_build_object('can_cancel',actor_role='owner'
      and card.status='stock'
      and not exists (select 1 from gift_private.events where (barcode=card_code or related_barcode=card_code)
        and action in ('sale','approve','redeem','exchange','transfer','adjust')),
      'is_expired',coalesce(card.expires_on<business_day,false),
      'history',coalesce((select jsonb_agg(jsonb_build_object('action',e.action,'created_at',e.created_at,'result',
      case when actor_role='owner' then e.result else e.result-'reason'-'actor_name' end)
      order by e.created_at desc, e.request_id) from (select * from gift_private.events
      where barcode=card_code or related_barcode=card_code or (action='stock_batch' and request->'barcodes' ? card_code) order by created_at desc, request_id
      limit (case when actor_role='owner' then null else 100 end)) e
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

  if action_name not in ('stock','stock_batch','claim','set_service','quote') then
    -- Lock both cards in the same order for every operation involving two cards.
    perform barcode from gift_private.cards where barcode=card_code
      or (action_name in ('exchange','transfer') and barcode=replacement) order by barcode for update;
    select * into card from gift_private.cards where barcode=card_code;
    if not found then raise exception 'Card not found'; end if;
  end if;

  before_balance := coalesce(card.balance,0);
  if action_name in ('sale','quote','redeem','exchange') and chosen_code is not null then
    if action_name <> 'sale' and card.kind='service' and card.service_code=chosen_code then
      service.code := card.service_code;
      service.name := card.service_name;
      service.price := card.service_value;
      service.duration := card.service_duration;
    else
      select * into service from gift_private.crm_service_catalog where code=chosen_code and active;
      if not found then raise exception 'Select a currently available gift card service'; end if;
    end if;
  end if;

  case action_name
  when 'set_service' then
    raise exception 'Manage service prices in CRM Services';
  when 'correct_card' then
    if card.status='pending' then raise exception 'Review this old card through Approve Old Cards'; end if;
    if reason is null or length(reason)>1000 or not (args ? 'registration_note')
       or length(coalesce(args->>'registration_note',''))>1000 then
      raise exception 'Enter a correction reason and a note of up to 1000 characters';
    end if;
    update gift_private.cards set registration_note=nullif(btrim(args->>'registration_note'),'') where barcode=card_code;
    result := jsonb_build_object('previous_note',card.registration_note,
      'registration_note',nullif(btrim(args->>'registration_note'),''),'reason',reason);
  when 'cancel_card' then
    if reason is null or length(reason)>1000 then raise exception 'Enter a cancellation reason'; end if;
    if card.status<>'stock' or exists (
      select 1 from gift_private.events where (barcode=card_code or related_barcode=card_code)
        and action in ('sale','approve','redeem','exchange','transfer','adjust')
    ) then raise exception 'Only cards without transactions can be cancelled. Review Card History for a correction or refund'; end if;
    update gift_private.cards set status='cancelled',balance=0 where barcode=card_code;
    result := jsonb_build_object('status','cancelled','before',before_balance,'after',0,'reason',reason);
  when 'stock' then
    if length(reason)>1000 then raise exception 'Reason must be at most 1000 characters'; end if;
    insert into gift_private.cards(barcode,status) values (card_code,'stock');
    result := jsonb_build_object('status','stock','reason',coalesce(reason,'Registered as unsold stock'));
  when 'stock_batch' then
    if length(reason)>1000 then raise exception 'Reason must be at most 1000 characters'; end if;
    if jsonb_typeof(args->'barcodes') is distinct from 'array' then
      raise exception 'Enter one barcode per line';
    end if;
    if jsonb_array_length(args->'barcodes') not between 1 and 200 or exists (
      select 1 from jsonb_array_elements_text(args->'barcodes') as b(code)
      where code is null or code !~ '^[A-Za-z0-9._/-]{1,100}$'
    ) then raise exception 'Enter 1 to 200 valid barcodes'; end if;
    if exists (
      select 1 from jsonb_array_elements_text(args->'barcodes') as b(code)
      group by code having count(*)>1
    ) then raise exception 'A barcode appears more than once'; end if;
    insert into gift_private.cards(barcode,status)
      select code,'stock' from jsonb_array_elements_text(args->'barcodes') as b(code) order by code
      on conflict (barcode) do nothing;
    get diagnostics inserted_count = row_count;
    if inserted_count <> jsonb_array_length(args->'barcodes') then
      raise exception 'A barcode is already registered. No stock was added';
    end if;
    result := jsonb_build_object('status','stock','stock_count',inserted_count,
      'reason',coalesce(reason,'Registered as unsold stock'));
  when 'claim' then
    old_expires := nullif(args->>'old_expires_on','')::date;
    if amount is null or amount not between 1 and 100000000 or old_expires is null or not isfinite(old_expires) then
      raise exception 'Enter the claimed value and old card expiry date';
    end if;
    insert into gift_private.cards(barcode,status,kind) values(card_code,'pending','legacy');
    result := jsonb_build_object('status','pending','claimed',amount,'old_expires_on',old_expires);
  when 'approve', 'reject' then
    if length(coalesce(args->>'review_notes',''))>1000 then raise exception 'Review notes must be at most 1000 characters'; end if;
    if card.status<>'pending' or reason is null or length(reason)>1000 then
      raise exception 'A pending claim and review reason are required';
    end if;
    if action_name='approve' then
      if args->>'physical_card_verified' is distinct from 'true' then raise exception 'Verify the physical old card before approval'; end if;
      if amount is null or amount not between 1 and 100000000 or expires is null or expires<business_day then
        raise exception 'Enter the approved balance and a valid expiry';
      end if;
      update gift_private.cards set status='active',balance=amount,expires_on=expires where barcode=card_code;
      result := jsonb_build_object('status','active','before',0,'after',amount,'expires_on',expires,'reason',reason,'physical_card_verified',true);
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
    if service.code is not null then
      -- Keep the existing referential link. This legacy row is no longer a price source.
      insert into gift_private.services(code,name,price,active)
      values (service.code,service.name,service.price,service.active)
      on conflict (code) do nothing;
    end if;
    update gift_private.cards set status='active',kind=case when service.code is null then 'dollar' else 'service' end,
      balance=amount,expires_on=expires,service_code=service.code,service_name=service.name,service_value=service.price,service_duration=service.duration
      where barcode=card_code;
    result := jsonb_build_object('before',0,'after',amount,'cash_sale',amount,'payment',payment,'expires_on',expires,
      'service_name',service.name,'service_value',service.price,'service_duration',service.duration);
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
    result := jsonb_build_object('before',before_balance,'after',0,'transferred',before_balance,'replacement',replacement,'old_card_collected',true,'expires_on',card.expires_on);
  when 'quote', 'redeem', 'exchange' then
    if card.status is distinct from 'active' or card.expires_on<business_day or service.code is null then
      raise exception 'An active unexpired card and an available service are required';
    end if;
    price := case when card.kind='service' and card.service_code=service.code then card.service_value else service.price end;
    redeemed := least(before_balance,price);
    if args ? 'redeem_amount' then
      redeem_amount := (args->>'redeem_amount')::bigint;
      if card.kind <> 'dollar' or redeem_amount is null or redeem_amount not between 1 and redeemed then
        raise exception 'Redeem amount must be positive and no more than the balance or service price';
      end if;
      redeemed := redeem_amount;
    end if;
    topup := price-redeemed;
    after_balance := case when card.kind='service' then 0 else before_balance-redeemed end;
    result := jsonb_build_object('before',before_balance,'after',after_balance,'service_price',price,
      'redeemed',redeemed,'topup',topup,'service_name',case when card.kind='service' and card.service_code=service.code then card.service_name else service.name end,'service_code',service.code,
      'service_value_released',before_balance-redeemed-after_balance);
    if service.duration is not null then result := result || jsonb_build_object('service_duration',service.duration); end if;
    if action_name='quote' then return result; end if;
    if args->'quote' is distinct from result
       and args->'quote' is distinct from (result - 'service_duration') then raise exception 'Price or balance changed. Refresh the quote'; end if;
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
      'replacement',case when action_name='exchange' then replacement end,'old_card_collected',action_name='exchange','payment',case when topup>0 then payment end);
  else raise exception 'Unknown Gift Card operation';
  end case;

  if action_name in ('approve','reject') then
    result := result || jsonb_build_object('review_notes',nullif(btrim(args->>'review_notes'),''));
  end if;
  result := result || jsonb_build_object('actor_name',actor_name,'barcode',card_code);
  insert into gift_private.events(request_id,actor,action,barcode,related_barcode,request,result)
    values(operation_id,actor_id,action_name,card_code,case when action_name in ('exchange','transfer') then replacement end,args,result);
  return result;
end;
$$;

commit;
