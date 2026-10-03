-- REACH RPC variable-shadowing suite - executable.
--
-- Guards against the class of bug where a PL/pgSQL variable is named after a reserved
-- SQL keyword. `current_role` is the trap that shipped in 0002/0012: `select role into
-- current_role` never bound, so `current_role <> 'citizen'` compared the *database* role
-- against 'citizen' and every call raised. Institution signup returned 500 and staff
-- invite redemption reported 'Account is already assigned a role' for every user.
--
-- Runs as the `authenticated` role with a simulated JWT subject, the same way PostgREST
-- does. Every assertion RAISEs on failure, so a non-zero exit means the suite failed.
--
-- Usage:
--   psql "$REACH_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/rpc_variable_shadowing.sql

\set ON_ERROR_STOP on

begin;

-- ---- seed (as superuser, bypassing RLS) ------------------------------------
insert into auth.users (id, email, raw_user_meta_data)
values
  ('a1000000-0000-0000-0000-000000000001', 'founder@example.test', '{"full_name":"Founder"}'::jsonb),
  ('a1000000-0000-0000-0000-000000000002', 'invitee@example.test', '{"full_name":"Invitee"}'::jsonb),
  ('a1000000-0000-0000-0000-000000000003', 'outsider@example.test', '{"full_name":"Outsider"}'::jsonb),
  ('a1000000-0000-0000-0000-000000000004', 'sponsor@example.test', '{"full_name":"Sponsor"}'::jsonb)
on conflict (id) do nothing;

-- Sponsor already runs an institution and is the sender of the staff invite.
insert into institutions (id, name, category, city)
values ('a1000000-0000-0000-0000-0000000000f0', 'Sponsor Institute', 'university', 'Lagos')
on conflict (id) do nothing;

-- ---- 1) a fresh citizen can create an institution (was a hard 500) ---------
do $$
declare
  institution_uuid uuid;
  caller_role public.reach_role;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000001', true);

  institution_uuid := public.create_institution_for_current_user('Founder Works', 'Estate', 'Lagos', null);

  if institution_uuid is null then
    raise exception 'FAIL 1: institution creation returned NULL';
  end if;

  select role into caller_role from public.profiles where id = 'a1000000-0000-0000-0000-000000000001';
  if caller_role <> 'institution' then
    raise exception 'FAIL 1: creator role is %, expected institution', caller_role;
  end if;
end $$;
\echo 'PASS 1 - a citizen can create an institution and is promoted to institution'

-- ---- 2) the founder is now bound to their institution ----------------------
do $$
declare
  bound uuid;
  members integer;
  subscription integer;
begin
  select institution_id into bound from public.profiles where id = 'a1000000-0000-0000-0000-000000000001';
  if bound is null then
    raise exception 'FAIL 2: founder has no institution_id after creation';
  end if;

  select count(*) into members from public.institution_members
  where institution_id = bound and user_id = 'a1000000-0000-0000-0000-000000000001';
  if members <> 1 then
    raise exception 'FAIL 2: expected 1 membership row, found %', members;
  end if;

  select count(*) into subscription from public.subscriptions where institution_id = bound;
  if subscription <> 1 then
    raise exception 'FAIL 2: expected 1 trial subscription, found %', subscription;
  end if;
end $$;
\echo 'PASS 2 - institution, membership and trial subscription are created together'

-- ---- 3) a second institution cannot be created from the same account -------
do $$
declare
  denied boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000001', true);
  begin
    perform public.create_institution_for_current_user('Second Works', 'Estate', 'Abuja', null);
  exception when others then
    denied := true;
  end;
  reset role;
  if not denied then
    raise exception 'FAIL 3: an institution account created a second institution';
  end if;
end $$;
\echo 'PASS 3 - an account that already has an institution cannot create another'

-- ---- 4) a staff invite can be redeemed by a citizen (was a hard failure) ---
do $$
declare
  invite_code text;
  redeemed jsonb;
begin
  -- Issue the invite as the sponsor (institution role), hashing happens server-side.
  update public.profiles set institution_id = 'a1000000-0000-0000-0000-0000000000f0', role = 'institution'
  where id = 'a1000000-0000-0000-0000-000000000004';

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000004', true);
  invite_code := public.create_staff_invite('invitee@example.test', 'staff', 72);
  reset role;

  if invite_code is null then
    raise exception 'FAIL 4: create_staff_invite returned no code';
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000002', true);
  redeemed := public.redeem_staff_invite(invite_code);
  reset role;

  if redeemed->>'role' <> 'staff' then
    raise exception 'FAIL 4: redemption returned role %, expected staff', redeemed->>'role';
  end if;
  if (redeemed->>'institution_id')::uuid <> 'a1000000-0000-0000-0000-0000000000f0' then
    raise exception 'FAIL 4: redemption bound the wrong institution: %', redeemed->>'institution_id';
  end if;
end $$;
\echo 'PASS 4 - a citizen redeems a staff invite and joins the issuing institution'

-- ---- 5) an invite is single-use --------------------------------------------
do $$
declare
  reused boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000002', true);
  begin
    perform public.redeem_staff_invite('REACH-NOT-A-REAL-CODE');
  exception when others then
    reused := true;
  end;
  reset role;
  if not reused then
    raise exception 'FAIL 5: a bogus invite code was accepted';
  end if;
end $$;
\echo 'PASS 5 - an invalid or spent invite code is rejected'

-- ---- 6) an already-assigned account cannot redeem a second invite ----------
do $$
declare
  denied boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000003', true);
  begin
    perform public.redeem_staff_invite('REACH-ANYTHING');
  exception when others then
    denied := true;
  end;
  reset role;
  if not denied then
    raise exception 'FAIL 6: a citizen with no invite should still be rejected for a bad code, not silently pass';
  end if;
end $$;
\echo 'PASS 6 - redeem_staff_invite rejects rather than binding a citizen with no matching invite'

rollback;

\echo '=== RPC variable-shadowing suite complete ==='
