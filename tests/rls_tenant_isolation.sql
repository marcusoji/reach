-- REACH RLS / tenant-isolation suite - executable.
--
-- Seeds two institutions with a citizen/staff/desk/operator in each, then asserts
-- that RLS actually isolates tenants. Runs as the `authenticated` role with a
-- simulated JWT subject (request.jwt.claim.sub), the same way PostgREST does.
--
-- Usage:
--   psql "$REACH_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/rls_tenant_isolation.sql
--
-- Every assertion RAISEs on failure, so a non-zero exit means the suite failed.

\set ON_ERROR_STOP on

begin;

-- ---- seed (as superuser, bypassing RLS) ------------------------------------
insert into institutions (id, name, category, city)
values
  ('11111111-1111-1111-1111-111111111111', 'Institution A', 'university', 'Lagos'),
  ('22222222-2222-2222-2222-222222222222', 'Institution B', 'university', 'Abuja')
on conflict (id) do nothing;

insert into auth.users (id, email)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'citizen.a@example.test'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'staff.a@example.test'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'desk.a@example.test'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'citizen.b@example.test'),
  ('cccccccc-0000-0000-0000-000000000001', 'operator@example.test')
on conflict (id) do nothing;

insert into profiles (id, full_name, role, institution_id)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Citizen A',  'citizen',       '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Staff A',    'staff',         '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Desk A',     'security-desk', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Citizen B',  'citizen',       '22222222-2222-2222-2222-222222222222'),
  ('cccccccc-0000-0000-0000-000000000001', 'Operator',   'operator',      null)
on conflict (id) do nothing;

insert into incidents (id, institution_id, reporter_id, category, status, title)
values
  ('a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-0000-0000-0000-000000000001', 'fire', 'reported', 'A fire'),
  ('b0000000-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222',
   'bbbbbbbb-0000-0000-0000-000000000001', 'medical', 'reported', 'B medical')
on conflict (id) do nothing;

commit;

-- Supabase grants table DML to anon/authenticated by default and lets RLS do the
-- filtering. Reproduce that here so a "permission denied" never masks an RLS gap:
-- the assertions below must fail on policy, not on a missing grant.
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;

-- ---- assertions -----------------------------------------------------------
\echo '=== REACH RLS isolation suite ==='

-- 1) A citizen must not be able to promote themselves to operator.
do $$
declare r public.reach_role;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', true);
  -- protect_profile_privileges reverts role/institution/zone silently rather
  -- than raising, so the security property is the post-condition: the row is
  -- still a citizen afterwards.
  update profiles set role = 'operator'
   where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  select role into r from profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  reset role;
  if r <> 'citizen' then
    raise exception 'FAIL 1: citizen escalated own role to %', r;
  end if;
end $$;
\echo 'PASS 1 - citizen cannot escalate own role'

-- 2) Citizen A cannot read institution B incidents.
do $$
declare n int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', true);
  select count(*) into n from incidents where institution_id = '22222222-2222-2222-2222-222222222222';
  reset role;
  if n <> 0 then
    raise exception 'FAIL 2: citizen A read % incident(s) belonging to institution B', n;
  end if;
end $$;
\echo 'PASS 2 - cross-institution incident read returns 0 rows'

-- 3) Citizen A CAN read their own institution incident (isolation, not blanket deny).
do $$
declare n int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', true);
  select count(*) into n from incidents where institution_id = '11111111-1111-1111-1111-111111111111';
  reset role;
  if n < 1 then
    raise exception 'FAIL 3: citizen A cannot read their own institution incident (n=%)', n;
  end if;
end $$;
\echo 'PASS 3 - same-institution incident read works'

-- 4) Audit log is not writable by an authenticated client.
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000003', true);
  begin
    insert into audit_logs (id, actor_id, action, resource_type, resource_id, metadata)
    values (gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000003', 'tamper', 'incident', gen_random_uuid(), '{}'::jsonb);
    reset role;
    raise exception 'FAIL 4: authenticated client inserted an audit_logs row';
  exception
    when insufficient_privilege then
      reset role;
      null; -- expected
  end;
end $$;
\echo 'PASS 4 - audit_logs not insertable by client'

-- 5) Unauthenticated (anon) callers see no incidents.
do $$
declare n int;
begin
  set local role anon;
  perform set_config('request.jwt.claim.sub', '', true);
  select count(*) into n from incidents;
  reset role;
  if n <> 0 then
    raise exception 'FAIL 5: anon read % incident(s)', n;
  end if;
end $$;
\echo 'PASS 5 - anon reads 0 incidents'

-- 6) Privileged relay-ingest RPC is not callable by anon/PUBLIC.
do $$
declare exposed boolean;
begin
  select (p.proacl is null or exists (
            select 1 from unnest(p.proacl) a where a::text ~ '^(anon|public)?='
          )) into exposed
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ingest_relay_packet';
  if exposed then
    raise exception 'FAIL 6: ingest_relay_packet is callable by anon/PUBLIC';
  end if;
end $$;
\echo 'PASS 6 - ingest_relay_packet not anon-callable'

-- 7) A citizen cannot forge an incident for another institution: the institution
--    is derived server-side from the authenticated profile, never the payload.
do $$
declare created_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', true);
  begin
    select (create_incident_for_current_user(
              '{"category":"fire","title":"forged","institution_id":"22222222-2222-2222-2222-222222222222"}'::jsonb,
              null)).id into created_id;
  exception
    when others then created_id := null;
  end;
  reset role;
  if created_id is not null then
    if (select institution_id from incidents where id = created_id)
         = '22222222-2222-2222-2222-222222222222' then
      raise exception 'FAIL 7: citizen A created an incident for institution B';
    end if;
  end if;
end $$;
\echo 'PASS 7 - citizen cannot create cross-institution incident'

\echo '=== RLS isolation suite complete ==='
