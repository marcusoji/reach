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
  ('cccccccc-0000-0000-0000-000000000001', 'operator@example.test'),
  ('dddddddd-0000-0000-0000-000000000001', 'drifting.staff@example.test'),
  ('eeeeeeee-0000-0000-0000-000000000001', 'drifting.desk@example.test')
on conflict (id) do nothing;

-- auth.users inserts fire handle_new_user, which already creates a minimal
-- ('citizen', NULL institution) profile. A plain `on conflict do nothing` would
-- therefore be a no-op and every role/institution below would be discarded,
-- leaving the suite to run as citizens with no institution. Upsert instead.
insert into profiles (id, full_name, role, institution_id)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Citizen A',  'citizen',       '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Staff A',    'staff',         '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'Desk A',     'security-desk', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Citizen B',  'citizen',       '22222222-2222-2222-2222-222222222222'),
  ('cccccccc-0000-0000-0000-000000000001', 'Operator',   'operator',      null),
  -- Anomalous accounts with no institution. These exercise the NULL-comparison
  -- guards in the authorization RPCs (migration 0012).
  ('dddddddd-0000-0000-0000-000000000001', 'Drifting Staff', 'staff',         null),
  ('eeeeeeee-0000-0000-0000-000000000001', 'Drifting Desk',  'security-desk', null)
on conflict (id) do update set
  full_name = excluded.full_name, role = excluded.role, institution_id = excluded.institution_id;

insert into incidents (id, institution_id, reporter_id, category, status, title)
values
  ('a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-0000-0000-0000-000000000001', 'fire', 'reported', 'A fire'),
  ('b0000000-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222',
   'bbbbbbbb-0000-0000-0000-000000000001', 'medical', 'reported', 'B medical'),
  ('a0000000-0000-0000-0000-00000000000c', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-0000-0000-0000-000000000001', 'security', 'verified', 'A verified incident')
on conflict (id) do nothing;

insert into responders (id, user_id, institution_id, responder_type, duty_status)
values
  ('ffffffff-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111', 'staff', 'on_duty')
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

-- 8) A staff account whose institution_id is NULL must NOT be able to act on an
--    institution's incident. The old guard `i.institution_id <> current_institution_id()`
--    is NULL when the caller has no institution, so the check silently passed. 0012
--    makes it `is distinct from`, which is true here.
do $$
declare before_status public.incident_status; after_status public.incident_status; denied boolean := false;
begin
  select status into before_status from incidents where id = 'a0000000-0000-0000-0000-00000000000a';
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-000000000001', true);
  begin
    perform transition_incident('a0000000-0000-0000-0000-00000000000a', 'received');
  exception when others then denied := true;
  end;
  reset role;
  select status into after_status from incidents where id = 'a0000000-0000-0000-0000-00000000000a';
  if not denied then
    raise exception 'FAIL 8: NULL-institution staff transitioned an incident (% -> %)', before_status, after_status;
  end if;
end $$;
\echo 'PASS 8 - NULL-institution staff cannot transition another institution''s incident'

-- 9) Same NULL-comparison shape in assign_incident: a security-desk account with no
--    institution must not be able to assign a responder to an institution's incident.
do $$
declare n int; denied boolean := false;
begin
  select count(*) into n from incident_assignments where incident_id = 'a0000000-0000-0000-0000-00000000000c';
  if n <> 0 then raise exception 'FAIL 9: fixture incident already has an assignment'; end if;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'eeeeeeee-0000-0000-0000-000000000001', true);
  begin
    perform assign_incident('a0000000-0000-0000-0000-00000000000c', 'ffffffff-0000-0000-0000-000000000001');
  exception when others then denied := true;
  end;
  reset role;
  select count(*) into n from incident_assignments where incident_id = 'a0000000-0000-0000-0000-00000000000c';
  if not denied or n <> 0 then
    raise exception 'FAIL 9: NULL-institution desk assigned a responder (denied=%, rows=%)', denied, n;
  end if;
end $$;
\echo 'PASS 9 - NULL-institution desk cannot assign a responder cross-tenant'

-- 10) The evidence-ingest RPC is restricted to service_role. It deletes and replaces an
--     incident's evidence, and its `corroboration` kind is weighted 0.8 in the fusion, so a
--     client-callable version would let any signed-in user manufacture the corroboration that
--     pushes an assessment over the confidence threshold.
do $$
declare exposed boolean;
begin
  select exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'ingest_incident_evidence_service'
       and (p.proacl is null or exists (
              select 1 from unnest(p.proacl) a where a::text ~ '^(anon|authenticated|public)?='
            ))
  ) into exposed;
  if exposed then
    raise exception 'FAIL 10: ingest_incident_evidence_service is callable by anon/authenticated/PUBLIC';
  end if;
end $$;
\echo 'PASS 10 - evidence ingest RPC restricted to service_role'

-- 11) Direct evidence inserts stay impossible for clients, so the RPC above is the only path.
do $$
declare inserted boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', true);
  begin
    insert into incident_evidence (incident_id, evidence_type, confidence)
    values ((select id from incidents where institution_id = '11111111-1111-1111-1111-111111111111' limit 1),
            'corroboration', 90);
    inserted := true;
  exception
    when others then inserted := false;
  end;
  reset role;
  if inserted then
    raise exception 'FAIL 11: a client inserted evidence directly';
  end if;
end $$;
\echo 'PASS 11 - clients cannot insert evidence directly'

-- 12) Provider telemetry is not client-writable: a forged 'ok' would hide a dead provider.
do $$
declare inserted boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-000000000001', true);
  begin
    insert into ai_provider_events (outcome, failure_kind) values ('ok', null);
    inserted := true;
  exception
    when others then inserted := false;
  end;
  reset role;
  if inserted then
    raise exception 'FAIL 12: a client wrote provider telemetry';
  end if;
end $$;
\echo 'PASS 12 - provider telemetry is not client-writable'

\echo '=== RLS isolation suite complete ==='
