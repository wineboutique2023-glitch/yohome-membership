begin;
-- The receipt function records delivery only after the email provider accepts it.
create function crm_private.crm_dispatch(action_name text, args jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  if crm_private.app_role() is null then raise exception 'CRM access is required'; end if;
  if action_name = 'mark_receipt' then raise exception 'Receipt status is server-managed'; end if;
  return crm_private.crm(action_name,args);
end;
$$;
revoke all on function crm_private.crm_dispatch(text,jsonb) from public, anon, authenticated;
grant execute on function crm_private.crm_dispatch(text,jsonb) to authenticated;
revoke execute on function crm_private.crm(text,jsonb) from public, anon, authenticated;
create or replace function public.membership_crm(action_name text, args jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$ select crm_private.crm_dispatch(action_name,args) $$;

-- Owner table permissions still permit ordinary member edits. Only the backend may mark delivery.
create function crm_private.protect_member_receipt()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if current_user in ('authenticated','anon') and
     ((tg_op = 'INSERT' and (new.receipt_sent is true or new.receipt_sent_at is not null))
      or (tg_op = 'UPDATE' and (new.receipt_sent is distinct from old.receipt_sent
        or new.receipt_sent_at is distinct from old.receipt_sent_at))) then
    raise exception 'Receipt status is server-managed';
  end if;
  return new;
end;
$$;
create trigger crm_member_receipt_guard
before insert or update of receipt_sent, receipt_sent_at on public.members
for each row execute function crm_private.protect_member_receipt();
commit;
