-- REACH 0022: let a citizen join an existing institution (estate/community) without an
-- institution-created staff account.
--
-- Gap this closes: 0002 gave an institution a way to invite *staff* and *security-desk*
-- (email-bound, one-time code, redeem_staff_invite assigns a role), but a plain citizen had
-- no way to attach to an institution. A citizen's incident therefore carried
-- institution_id = NULL, so the estate's desk never saw a resident's emergency. The only
-- path into an institution was to *create* one (create_institution_for_current_user), which
-- hands the caller the institution role — wrong for a resident.
--
-- This migration adds a second invite flavour:
--   * invite_type = 'member' — the existing staff/security-desk invite (email-bound, role
--     assigned on redemption). Unchanged behaviour.
--   * invite_type = 'join'   — an institution-scoped join code. A citizen redeems it with
--     join_institution_with_code(), which links the profile to the institution (role stays
--     'citizen') and records the membership. The officer shares the code out-of-band.
--
-- Security properties, all enforced server-side:
--   * The code is hashed (pgcrypto digest) and never stored in clear.
--   * Single-use and time-boxed, like a staff invite.
--   * "Join" is not "become a member of any institution": the invite row is bound to one
--     institution at creation (current_institution_id()), so a code cannot be replayed into
--     another tenant.
--   * A caller already linked to an institution cannot silently switch (institution_id is
--     not null -> reject), and a non-citizen cannot use the citizen path at all, so this is
--     not a role-escalation or tenant-hopping primitive.
--
-- Both the citizen PWA (web) and the native Android relay node load the same PWA and call
-- join_institution_with_code. Joining binds the profile, so every incident filed *after* the
-- join is stamped with the estate (create_incident_for_current_user reads profiles.institution_id),
-- and the incidents_select RLS policy matches on institution_id = current_institution_id(), so
-- the estate's desk sees those reports immediately. Incidents filed *before* the join keep
-- institution_id = NULL — this migration does not retroactively reassign them; the reporter
-- still sees them, but the desk does not. A backfill would be a separate, explicit workflow.

-- ---- 1) schema: the new invite flavour and its vocabulary --------------------------------
-- role is now allowed to be 'citizen' for a join invite. The constraint was auto-named by
-- Postgres as institution_invites_role_check; drop and recreate it idempotently.
alter table public.institution_invites
  add column if not exists invite_type text not null default 'member';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.institution_invites'::regclass
      and conname = 'institution_invites_invite_type_check'
  ) then
    alter table public.institution_invites
      add constraint institution_invites_invite_type_check check (invite_type in ('member','join'));
  end if;
end $$;

alter table public.institution_invites drop constraint if exists institution_invites_role_check;
alter table public.institution_invites
  add constraint institution_invites_role_check check (role in ('citizen','staff','security-desk'));

-- ---- 2) create an invite of either flavour ----------------------------------------------
create or replace function public.create_institution_invite(
  p_email text,
  p_role public.reach_role default 'staff',
  p_type text default 'member',
  p_expires_hours integer default 72
)
returns text language plpgsql security definer set search_path=public, extensions as $$
declare
  inst uuid;
  raw_code text;
  hashed text;
  invite_email text;
  invite_role public.reach_role;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if public.current_reach_role() not in ('institution','operator','super-admin') then raise exception 'Not permitted'; end if;
  inst := public.current_institution_id();
  if inst is null then raise exception 'Institution account is not configured'; end if;
  if p_type not in ('member','join') then raise exception 'Invalid invite type'; end if;
  if p_expires_hours < 1 or p_expires_hours > 168 then raise exception 'Invalid expiry'; end if;

  if p_type = 'join' then
    -- A join code is institution-scoped, not person-scoped: no email, and the member keeps
    -- the citizen role. Any email passed is ignored rather than stored.
    invite_role := 'citizen';
    invite_email := '';
  else
    if p_role not in ('staff','security-desk') then raise exception 'Invalid invite role'; end if;
    if length(trim(coalesce(p_email,''))) < 3 or position('@' in coalesce(p_email,'')) = 0 then
      raise exception 'Email is required';
    end if;
    invite_role := p_role;
    invite_email := lower(trim(p_email));
  end if;

  raw_code := 'REACH-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));
  hashed := encode(digest(raw_code,'sha256'),'hex');
  insert into public.institution_invites(institution_id,email,role,code_hash,expires_at,created_by,invite_type)
  values(inst, invite_email, invite_role, hashed, now() + make_interval(hours=>p_expires_hours), auth.uid(), p_type);
  return raw_code;
end $$;
revoke all on function public.create_institution_invite(text,public.reach_role,text,integer) from public;
grant execute on function public.create_institution_invite(text,public.reach_role,text,integer) to authenticated;

-- Backwards-compatible wrapper: the existing staff-invite callers and tests keep working.
create or replace function public.create_staff_invite(
  p_email text,
  p_role public.reach_role,
  p_expires_hours integer default 72
)
returns text language plpgsql security definer set search_path=public, extensions as $$
begin
  return public.create_institution_invite(p_email, p_role, 'member', p_expires_hours);
end $$;
revoke all on function public.create_staff_invite(text,public.reach_role,integer) from public;
grant execute on function public.create_staff_invite(text,public.reach_role,integer) to authenticated;

-- ---- 3) redeeming a staff/desk invite binds to the invite's institution ------------------
-- Unchanged from 0020 except it now ignores join codes explicitly rather than relying on the
-- email match to exclude them.
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
    and invite_type='member'
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

-- ---- 4) a citizen joins an institution with a join code ----------------------------------
create or replace function public.join_institution_with_code(p_code text)
returns jsonb language plpgsql security definer set search_path=public, extensions as $$
declare
  inv public.institution_invites%rowtype;
  caller_role public.reach_role;
  existing_institution uuid;
  result jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select role, institution_id into caller_role, existing_institution
    from public.profiles where id=auth.uid() for update;
  if caller_role is distinct from 'citizen' then
    raise exception 'Only a citizen account can join an institution';
  end if;
  -- Do not let a code move a user between tenants.
  if existing_institution is not null then
    raise exception 'Account is already linked to an institution';
  end if;

  select * into inv from public.institution_invites
  where code_hash=encode(digest(trim(p_code),'sha256'),'hex')
    and invite_type='join'
    and used_at is null and expires_at > now()
  for update;
  if not found then raise exception 'Invalid, expired, or used join code'; end if;

  perform set_config('reach.allow_privilege_change','on',true);
  update public.profiles set institution_id=inv.institution_id where id=auth.uid();
  insert into public.institution_members(institution_id,user_id,membership_role,status)
  values(inv.institution_id,auth.uid(),'citizen','active')
  on conflict(institution_id,user_id) do update set status='active';
  update public.institution_invites set used_at=now() where id=inv.id;
  insert into public.audit_logs(actor_id,institution_id,action,resource_type,resource_id,metadata)
  values(auth.uid(),inv.institution_id,'membership.joined','institution_member',auth.uid(),
         jsonb_build_object('via','join_code'));

  select jsonb_build_object('role',role,'institution_id',institution_id) into result
    from public.profiles where id=auth.uid();
  return result;
end $$;
revoke all on function public.join_institution_with_code(text) from public;
revoke all on function public.join_institution_with_code(text) from anon;
grant execute on function public.join_institution_with_code(text) to authenticated;

-- ---- 5) institution-side management of pending invites -----------------------------------
-- Restricted to the institution admins: a citizen member must not be able to enumerate
-- pending staff invites (which carry email addresses), so there is an explicit role guard
-- as well as the tenant match.
create or replace function public.list_institution_invites()
returns table(id uuid, email text, role public.reach_role, invite_type text,
              expires_at timestamptz, used_at timestamptz, created_at timestamptz)
language sql security definer set search_path=public as $$
  select id, email, role, invite_type, expires_at, used_at, created_at
  from public.institution_invites
  where institution_id = public.current_institution_id()
    and public.current_institution_id() is not null
    and public.current_reach_role() in ('institution','operator','super-admin')
  order by created_at desc
  limit 100;
$$;
revoke all on function public.list_institution_invites() from public;
grant execute on function public.list_institution_invites() to authenticated;

create or replace function public.revoke_institution_invite(p_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare
  affected integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  -- Only an admin of the invite's own institution can revoke it; the institution_id match
  -- is the tenant guard. Operator/super-admin are intentionally not granted a cross-tenant
  -- revoke here — that belongs to a separate administrative workflow.
  update public.institution_invites
    set used_at = now()
    where id = p_id
      and institution_id = public.current_institution_id()
      and public.current_institution_id() is not null
      and used_at is null
      and public.current_reach_role() in ('institution','operator','super-admin');
  get diagnostics affected = row_count;
  return affected > 0;
end $$;
revoke all on function public.revoke_institution_invite(uuid) from public;
grant execute on function public.revoke_institution_invite(uuid) to authenticated;
