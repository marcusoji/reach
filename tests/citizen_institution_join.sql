-- REACH citizen institution-join suite - executable.
--
-- Migration 0022 closed the gap where a citizen had no way to attach to an existing
-- institution, so a resident's incident carried institution_id = NULL and the estate's desk
-- never saw it. This suite exercises the new join-code path end to end against the migrated
-- schema: create a join code as the institution, redeem it as a citizen, confirm the incident
-- then carries the institution, and confirm the abuse cases stay closed (single use, no tenant
-- hop, no role escalation, no cross-flavour redemption, tenant-scoped listing/revoke).
--
-- Runs as the `authenticated` role with a simulated JWT subject, the way PostgREST does.
-- Every assertion RAISEs on failure, so a non-zero exit means the suite failed.
--
-- Usage:
--   psql "$REACH_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/citizen_institution_join.sql

\set ON_ERROR_STOP on

begin;

-- ---- seed (as superuser, bypassing RLS) ------------------------------------
insert into auth.users (id, email, raw_user_meta_data)
values
  ('b2000000-0000-0000-0000-000000000001', 'owner@join.test',    '{"full_name":"Owner"}'::jsonb),
  ('b2000000-0000-0000-0000-000000000002', 'resident1@join.test', '{"full_name":"Resident One"}'::jsonb),
  ('b2000000-0000-0000-0000-000000000003', 'resident2@join.test', '{"full_name":"Resident Two"}'::jsonb),
  ('b2000000-0000-0000-0000-000000000004', 'resident3@join.test', '{"full_name":"Resident Three"}'::jsonb),
  ('b2000000-0000-0000-0000-000000000005', 'dispatcher@join.test', '{"full_name":"Dispatcher"}'::jsonb),
  ('b2000000-0000-0000-0000-000000000006', 'otherowner@join.test',  '{"full_name":"Other Owner"}'::jsonb)
on conflict (id) do nothing;

insert into public.institutions (id, name, category, city)
values
  ('b2000000-0000-0000-0000-0000000000f0', 'Join Estate',  'estate', 'Lagos'),
  ('b2000000-0000-0000-0000-0000000000f1', 'Other Estate', 'estate', 'Abuja')
on conflict (id) do nothing;

-- The owner runs Join Estate; the dispatcher is the non-citizen used for the escalation check.
update public.profiles set institution_id = 'b2000000-0000-0000-0000-0000000000f0', role = 'institution'
  where id = 'b2000000-0000-0000-0000-000000000001';
update public.profiles set institution_id = 'b2000000-0000-0000-0000-0000000000f1', role = 'staff'
  where id = 'b2000000-0000-0000-0000-000000000005';
update public.profiles set institution_id = 'b2000000-0000-0000-0000-0000000000f1', role = 'institution'
  where id = 'b2000000-0000-0000-0000-000000000006';

-- ---- 1) an institution can mint an institution-scoped join code -------------
do $$
declare
  join_code text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-000000000001', true);
  join_code := public.create_institution_invite(null, 'citizen', 'join', 48);
  reset role;

  if join_code is null or join_code !~ '^REACH-' then
    raise exception 'FAIL 1: join code not issued (got %)', join_code;
  end if;
end $$;
\echo 'PASS 1 - an institution can create a join code'

-- Store a join code for later assertions.
create temporary table join_codes (label text primary key, code text);
do $$
declare
  c text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-000000000001', true);
  c := public.create_institution_invite(null, 'citizen', 'join', 48);
  reset role;
  insert into join_codes values ('r1', c);
end $$;

-- ---- 2) a citizen redeems the code and joins the estate ---------------------
do $$
declare
  code text;
  joined jsonb;
  bound uuid;
  caller_role public.reach_role;
  members integer;
begin
  select jc.code into code from join_codes jc where label = 'r1';

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-000000000002', true);
  joined := public.join_institution_with_code(code);
  reset role;

  if (joined->>'institution_id')::uuid <> 'b2000000-0000-0000-0000-0000000000f0' then
    raise exception 'FAIL 2: joined the wrong institution: %', joined->>'institution_id';
  end if;
  if joined->>'role' <> 'citizen' then
    raise exception 'FAIL 2: join changed the role to %, expected citizen', joined->>'role';
  end if;

  select institution_id, role into bound, caller_role from public.profiles
    where id = 'b2000000-0000-0000-0000-000000000002';
  if bound is distinct from 'b2000000-0000-0000-0000-0000000000f0' or caller_role <> 'citizen' then
    raise exception 'FAIL 2: profile not linked as citizen (institution=%, role=%)', bound, caller_role;
  end if;

  select count(*) into members from public.institution_members
    where institution_id = 'b2000000-0000-0000-0000-0000000000f0'
      and user_id = 'b2000000-0000-0000-0000-000000000002'
      and membership_role = 'citizen' and status = 'active';
  if members <> 1 then
    raise exception 'FAIL 2: expected one active citizen membership, found %', members;
  end if;
end $$;
\echo 'PASS 2 - a citizen joins with a code, keeps the citizen role, and is linked to the estate'

-- ---- 3) a report filed after joining carries the institution ----------------
-- This is the whole point: the estate can now see the resident's incident because
-- incidents_select matches institution_id = current_institution_id().
do $$
declare
  incident public.incidents%rowtype;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-000000000002', true);
  incident := public.create_incident_for_current_user(
    jsonb_build_object('category','fire','title','Resident report','priority','high'), 'join-test-key-0001');
  reset role;

  if incident.institution_id is distinct from 'b2000000-0000-0000-0000-0000000000f0' then
    raise exception 'FAIL 3: joined resident incident has institution %, expected Join Estate', incident.institution_id;
  end if;
end $$;
\echo 'PASS 3 - an incident filed after joining is attributed to the estate'

-- ---- 4) the join code is single-use ----------------------------------------
do $$
declare
  code text;
  reused boolean := false;
begin
  select jc.code into code from join_codes jc where label = 'r1';
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-000000000003', true);
  begin
    perform public.join_institution_with_code(code);
  exception when others then
    reused := true;
  end;
  reset role;
  if not reused then
    raise exception 'FAIL 4: a spent join code was accepted for another citizen';
  end if;
end $$;
\echo 'PASS 4 - a join code cannot be reused'

-- ---- 5) a non-citizen cannot use the citizen join path ----------------------
do $$
declare
  code text;
  denied boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-000000000001', true);
  code := public.create_institution_invite(null, 'citizen', 'join', 48);
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-000000000005', true);
  begin
    perform public.join_institution_with_code(code);
  exception when others then
    denied := true;
  end;
  reset role;
  if not denied then
    raise exception 'FAIL 5: a non-citizen redeemed a citizen join code';
  end if;
end $$;
\echo 'PASS 5 - a staff account cannot join through the citizen path'

-- ---- 6) a linked citizen cannot hop to another institution ------------------
do $$
declare
  code text;
  denied boolean := false;
begin
  -- Mint a code for the other estate as its owner.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-000000000006', true);
  code := public.create_institution_invite(null, 'citizen', 'join', 48);
  reset role;

  -- Resident one is already linked to Join Estate; the code must not move them.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-000000000002', true);
  begin
    perform public.join_institution_with_code(code);
  exception when others then
    denied := true;
  end;
  reset role;
  if not denied then
    raise exception 'FAIL 6: a linked citizen was moved to another institution';
  end if;
end $$;
\echo 'PASS 6 - a citizen already linked to an institution cannot join another'

-- ---- 7) an invalid code is rejected ----------------------------------------
do $$
declare
  denied boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-000000000003', true);
  begin
    perform public.join_institution_with_code('REACH-NOT-A-JOIN-CODE');
  exception when others then
    denied := true;
  end;
  reset role;
  if not denied then
    raise exception 'FAIL 7: a bogus join code was accepted';
  end if;
end $$;
\echo 'PASS 7 - a bogus join code is rejected'

-- ---- 8) the two invite flavours do not cross over ---------------------------
do $$
declare
  member_code text;
  join_code text;
  denied_member_as_join boolean := false;
  denied_join_as_member boolean := false;
begin
  -- A staff invite (member flavour) must not be usable as a join code.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-000000000001', true);
  member_code := public.create_staff_invite('resident3@join.test', 'staff', 48);
  join_code := public.create_institution_invite(null, 'citizen', 'join', 48);
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-000000000004', true);
  begin
    perform public.join_institution_with_code(member_code);
  exception when others then
    denied_member_as_join := true;
  end;
  begin
    perform public.redeem_staff_invite(join_code);
  exception when others then
    denied_join_as_member := true;
  end;
  reset role;

  if not denied_member_as_join then
    raise exception 'FAIL 8: a staff invite was accepted as a join code';
  end if;
  if not denied_join_as_member then
    raise exception 'FAIL 8: a join code was accepted as a staff invite';
  end if;
end $$;
\echo 'PASS 8 - staff invites and join codes are not interchangeable'

-- ---- 9) listing and revoking are tenant-scoped ------------------------------
do $$
declare
  foreign_id uuid;
  foreign_count integer;
  owned integer;
  revoked boolean;
begin
  -- Give Other Estate a pending invite to attempt to touch.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-000000000006', true);
  perform public.create_institution_invite(null, 'citizen', 'join', 48);
  reset role;

  select id into foreign_id from public.institution_invites
    where institution_id = 'b2000000-0000-0000-0000-0000000000f1' and used_at is null
    order by created_at desc limit 1;
  if foreign_id is null then
    raise exception 'FAIL 9 setup: Other Estate has no pending invite';
  end if;

  -- Join Estate's owner lists and tries to revoke the other tenant's invite.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-000000000001', true);
  select count(*) into owned from public.list_institution_invites();
  select count(*) into foreign_count from public.list_institution_invites() where id = foreign_id;
  select public.revoke_institution_invite(foreign_id) into revoked;
  reset role;

  if owned = 0 then
    raise exception 'FAIL 9: the institution saw none of its own invites';
  end if;
  if foreign_count <> 0 then
    raise exception 'FAIL 9: the institution saw an invite from another tenant';
  end if;
  if coalesce(revoked, true) then
    raise exception 'FAIL 9: cross-tenant revoke reported success';
  end if;
  if exists (select 1 from public.institution_invites where id = foreign_id and used_at is not null) then
    raise exception 'FAIL 9: the foreign invite was actually revoked';
  end if;
end $$;
\echo 'PASS 9 - invite listing and revocation are tenant-scoped'

rollback;

\echo '=== Citizen institution-join suite complete ==='
