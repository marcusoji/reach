-- REACH 0019: repair the reserved-keyword variable collision that broke institution
-- signup and staff-invite redemption.
--
-- create_institution_for_current_user and redeem_staff_invite both declared a PL/pgSQL
-- variable named `current_role`. `current_role` is a reserved SQL keyword, so PL/pgSQL
-- never bound the variable to it: `select role into current_role ...` left the variable
-- NULL, and `current_role <> 'citizen'` resolved to the SQL keyword -- the *database*
-- role of the SECURITY DEFINER owner (postgres locally, `authenticated`/`supabase_admin`
-- on Supabase), never 'citizen'. The guard therefore raised unconditionally:
--
--   - POST /institutions returned 500 for every citizen signup
--   - redeem_staff_invite raised 'Account is already assigned a role' for every caller
--
-- Renaming the variable to caller_role restores the intended citizen-only checks. The
-- NULL-safe `is distinct from` form from 0012 is preserved so a NULL role still fails.
--
-- Reproduced on a fresh Postgres+PostGIS database and against a deployed Supabase
-- project; tests/rpc_variable_shadowing.sql guards against a regression.

create or replace function public.create_institution_for_current_user(
  p_name text,
  p_category text default 'community',
  p_city text default null,
  p_address text default null
)
returns uuid language plpgsql security definer set search_path=public as $$
declare
  institution_uuid uuid;
  existing_institution uuid;
  caller_role public.reach_role;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select role, institution_id into caller_role, existing_institution from public.profiles where id=auth.uid() for update;
  if caller_role is distinct from 'citizen' or existing_institution is not null then raise exception 'Institution account cannot be created from this account'; end if;
  if length(trim(coalesce(p_name,''))) < 2 then raise exception 'Institution name is required'; end if;

  insert into public.institutions(name,category,city,address)
  values(trim(p_name),coalesce(nullif(trim(p_category),''),'community'),nullif(trim(p_city),''),nullif(trim(p_address),''))
  returning id into institution_uuid;

  perform set_config('reach.allow_privilege_change','on',true);
  update public.profiles
  set institution_id=institution_uuid, role='institution'
  where id=auth.uid();

  insert into public.institution_members(institution_id,user_id,membership_role)
  values(institution_uuid,auth.uid(),'institution');

  insert into public.subscriptions(institution_id,plan_name,status)
  values(institution_uuid,'REACH Full','trial');

  insert into public.audit_logs(actor_id,institution_id,action,resource_type,resource_id,metadata)
  values(auth.uid(),institution_uuid,'institution.created','institution',institution_uuid,jsonb_build_object('source','self_service'));

  return institution_uuid;
end $$;
revoke all on function public.create_institution_for_current_user(text,text,text,text) from public;
grant execute on function public.create_institution_for_current_user(text,text,text,text) to authenticated;

create or replace function public.redeem_staff_invite(p_code text)
returns jsonb language plpgsql security definer set search_path=public as $$
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
