-- REACH 0020: make pgcrypto reachable from the invite RPCs on Supabase.
--
-- 0001 runs `create extension if not exists pgcrypto;`. On a plain Postgres that lands in
-- public, but Supabase pre-installs pgcrypto into the dedicated `extensions` schema, so the
-- `if not exists` is a no-op there and `digest()` lives at extensions.digest.
--
-- create_staff_invite and redeem_staff_invite pin `set search_path=public`, which therefore
-- does *not* include extensions. Resolving `digest(...)` then fails with
--
--   42883: function digest(text, unknown) does not exist
--
-- so creating a staff invite returned 500 and redeeming any invite raised. (The local
-- validation fixture used to install pgcrypto in public, which is why this only surfaced
-- against the real project; the fixture now mirrors Supabase's extensions schema.)
--
-- Adding `extensions` to these two functions' search_path is the minimal fix; a broader
-- sweep for extension functions reached from a pinned path is tracked separately.

create or replace function public.create_staff_invite(
  p_email text,
  p_role public.reach_role,
  p_expires_hours integer default 72
)
returns text language plpgsql security definer set search_path=public, extensions as $$
declare
  p_role_allowed boolean;
  inst uuid;
  raw_code text;
  hashed text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if public.current_reach_role() not in ('institution','operator','super-admin') then raise exception 'Not permitted'; end if;
  inst := public.current_institution_id();
  if inst is null and public.current_reach_role()='institution' then raise exception 'Institution account is not configured'; end if;
  if p_role not in ('staff','security-desk') then raise exception 'Invalid invite role'; end if;
  if length(trim(coalesce(p_email,''))) < 3 then raise exception 'Email is required'; end if;
  if p_expires_hours < 1 or p_expires_hours > 168 then raise exception 'Invalid expiry'; end if;
  if public.current_reach_role() in ('operator','super-admin') and inst is null then
    raise exception 'Operator must specify institution through an administrative workflow';
  end if;

  raw_code := 'REACH-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));
  hashed := encode(digest(raw_code,'sha256'),'hex');
  insert into public.institution_invites(institution_id,email,role,code_hash,expires_at,created_by)
  values(inst,lower(trim(p_email)),p_role,hashed,now() + make_interval(hours=>p_expires_hours),auth.uid());
  return raw_code;
end $$;
revoke all on function public.create_staff_invite(text,public.reach_role,integer) from public;
grant execute on function public.create_staff_invite(text,public.reach_role,integer) to authenticated;

create or replace function public.redeem_staff_invite(p_code text)
returns jsonb language plpgsql security definer set search_path=public, extensions as $$
declare
  inv public.institution_invites%rowtype;
  caller_role public.reach_role;
  result jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select role into caller_role from public.profiles where id=auth.uid() for update;
  if caller_role is distinct from 'citizen' then raise exception 'Account is already assigned a role'; end if;
  select * into inv from public.institution_invites
  where code_hash=encode(digest(trim(p_code),'sha256'),'hex')
    and used_at is null and expires_at > now()
    and lower(email)=lower(coalesce((select email from auth.users where id=auth.uid()),''))
  for update;
  if not found then raise exception 'Invalid, expired, used, or email-mismatched invite'; end if;

  perform set_config('reach.allow_privilege_change','on',true);
  update public.profiles set role=inv.role,institution_id=inv.institution_id where id=auth.uid();
  insert into public.institution_members(institution_id,user_id,membership_role)
  values(inv.institution_id,auth.uid(),inv.role)
  on conflict(institution_id,user_id) do update set membership_role=excluded.membership_role,status='active';
  update public.institution_invites set used_at=now() where id=inv.id;
  insert into public.audit_logs(actor_id,institution_id,action,resource_type,resource_id)
  values(auth.uid(),inv.institution_id,'membership.invite_redeemed','institution_member',auth.uid());

  select jsonb_build_object('role',role,'institution_id',institution_id) into result from public.profiles where id=auth.uid();
  return result;
end $$;
revoke all on function public.redeem_staff_invite(text) from public;
grant execute on function public.redeem_staff_invite(text) to authenticated;
