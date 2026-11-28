begin;

-- Preserve baseline behaviour behind the approved Auth/RLS boundary. No data rewrite.
create or replace function crm_private.crm(action_name text, args jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  employee_role text := crm_private.app_role();
  reader_is_owner boolean := employee_role = 'owner' and coalesce(args->>'staff_view', 'false') <> 'true';
  member_row public.members%rowtype;
  service_row public.service_items%rowtype;
  member_key uuid := nullif(args->>'member_id','')::uuid;
  payment text := args->>'payment_method';
  therapist_name text := nullif(btrim(args->>'therapist'),'');
  business_day date := (now() at time zone 'Australia/Melbourne')::date;
  utc_day date := (now() at time zone 'UTC')::date;
  checkout_day date := nullif(args->>'checkout_date','')::date;
  renewal_date date := nullif(args->>'expiry_date','')::date;
  configured_member_price numeric;
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
        case when reader_is_owner then to_jsonb(m) else
          jsonb_build_object('id',m.id,'card_id',m.card_id,'full_name',m.full_name,'phone',m.phone,
            'email',m.email,'birthday',m.birthday,'sold_by',m.sold_by,'suburb',m.suburb,'join_date',m.join_date,
            'expiry_date',m.expiry_date,'status',m.status,'deleted',m.deleted,'created_at',m.created_at) end
        order by m.created_at desc) from public.members m where reader_is_owner or m.deleted=false),'[]'::jsonb),
      'checkouts',coalesce((select jsonb_agg(
        case when reader_is_owner then to_jsonb(c) else
          jsonb_build_object('id',c.id,'member_id',c.member_id,'customer_name',c.customer_name,
          'customer_type',c.customer_type,'service_name',c.service_name,'duration',c.duration,
          'final_price',c.final_price,'created_at',c.created_at,'therapist',c.therapist,
          'deleted',c.deleted,'gift_applied',c.gift_applied,'gift_unused_value',c.gift_unused_value,
          'price_note',case when c.price_note in ('Guest / normal price applied.','Member expired. Normal price applied.','Member price applied.','This service is not eligible for member price.','Gift card redemption') or c.payment_method='Redeem First Hour Massage' and c.price_note like 'Redeem First Hour applied:%' then c.price_note end,
          'cash_received',c.cash_received,'payment_method',c.payment_method) end
        order by c.created_at desc) from public.checkouts c where reader_is_owner or c.deleted=false),'[]'::jsonb),
      'services',coalesce((select jsonb_agg(
        case when reader_is_owner then to_jsonb(s) else jsonb_build_object('id',s.id,'name',s.name,'duration',s.duration,'price',s.price,
          'normal_price',s.normal_price,'member_price',s.member_price,'member_allowed',s.member_allowed,
          'discount_type',s.discount_type,'discount_value',s.discount_value,'active',s.active) end order by s.name)
        from public.service_items s where reader_is_owner or s.active is distinct from false),'[]'::jsonb),
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
    select coalesce(nullif((select value::numeric from public.system_settings where key='membership_fee'),0),100) into configured_fee;
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
      args->>'payment_method',args->>'notes',utc_day,configured_fee,'active',false,false)
    returning * into member_row;
    -- The receipt generator needs the submitted fields and the database-set fee.
    return to_jsonb(member_row);
  when 'renew_member' then
    -- Match the browser's setFullYear, including 29 February rolling into 1 March.
    if renewal_date is null then
      renewal_date := (date_trunc('month',utc_day::timestamp) + interval '1 year')::date + (extract(day from utc_day)::integer - 1);
    end if;
    if not exists (
      select 1 from generate_series(-1,1) as offset_day(n)
      where renewal_date=(date_trunc('month',(utc_day+n)::timestamp) + interval '1 year')::date
        + (extract(day from utc_day+n)::integer - 1)
    ) then raise exception 'Renewal must follow the one-year rule'; end if;
    update public.members set expiry_date=renewal_date,
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
        configured_member_price:=coalesce(service_row.member_price, greatest(0, case
          when service_row.discount_type='%' then normal_price*(1-coalesce(service_row.discount_value,0)/100)
          else normal_price-coalesce(service_row.discount_value,0)
        end));
        final_price:=coalesce(nullif(configured_member_price,0),normal_price);
        checkout_note:='Member price applied.';
      else
        checkout_note:='This service is not eligible for member price.';
      end if;
    end if;
    if payment='Redeem First Hour Massage' then
      if coalesce(nullif(service_row.duration,0),1)<1 then raise exception 'First Hour requires at least 60 minutes'; end if;
      final_price:=greatest(normal_price-100,0);
      checkout_note:=case when final_price=0 then 'Redeem First Hour applied: $100 value fully redeemed.'
        else 'Redeem First Hour applied: $100 value redeemed. Customer pays extra $' || to_char(final_price,'FM999999999999990.00') || '.' end;
    end if;
    if (args->>'expected_price')::numeric is distinct from final_price then raise exception 'Price changed. Refresh checkout before saving'; end if;
    insert into public.checkouts(member_id,customer_name,customer_type,service_name,duration,
      original_price,final_price,staff_pay,shop_profit,payment_method,therapist,customer_suburb,
      price_note,service_price,deleted,created_at)
    values(member_key,coalesce(member_row.full_name,'Guest'),case when member_key is null then 'guest' else 'member' end,
      service_row.name,coalesce(nullif(service_row.duration,0),1),normal_price,final_price,coalesce(service_row.staff_pay,0),
      final_price-coalesce(service_row.staff_pay,0),payment,therapist_name,coalesce(member_row.suburb,''),
      coalesce(case when employee_role='owner' then nullif(btrim(args->>'price_note'),'') end,checkout_note),
      final_price,false,coalesce((checkout_day+time '12:00') at time zone 'UTC',now()));
  else raise exception 'Unknown CRM operation';
  end case;
  return jsonb_build_object('saved',true);
end;
$$;

commit;
