-- REACH — reset + demo seed (two institutions, one of every stakeholder)
--
-- Clears every REACH data record and inserts a coherent demo dataset: two institutions
-- and one account for every stakeholder role, plus representative rows in every other
-- table so each screen has something to show during the hackathon demo.
--
-- Run it in the Supabase SQL editor (Dashboard → SQL editor → paste → Run), or with psql
-- against the project database. It runs as the connection owner and bypasses RLS on
-- purpose; it is a maintenance/demo script, never something the app calls.
--
--   * The reset is destructive. Take a backup first if any row matters.
--   * Every seeded sign-in uses the password  ReachDemo!2026
--   * Re-running is safe: it clears and re-seeds to the same known state.
--
-- Demo sign-ins (all password ReachDemo!2026):
--   admin@greenfield.reach.dev       institution   (Greenfield Estate — active subscription)
--   staff@greenfield.reach.dev       staff
--   desk@greenfield.reach.dev        security-desk
--   citizen@greenfield.reach.dev     citizen
--   ops@reach.dev                    operator
--   superadmin@reach.dev             super-admin
--   admin@northgate.reach.dev        institution   (Northgate University — trial, not BMONI-configured)
--   staff@northgate.reach.dev        staff
--   desk@northgate.reach.dev         security-desk
--   citizen@northgate.reach.dev      citizen
--
-- BMONI sandbox walkthrough: sign in as admin@northgate.reach.dev (trial, no account
-- yet) and run Configure BMONI → Create payer → Create wallet → KYC → Start Nigeria →
-- Load NGN virtual account → Pay. Northgate's subscription flips to active when BMONI
-- sends the payment webhook. Greenfield is the already-configured reference tenant.

set search_path = public, extensions;
-- The profiles guard trigger reverts role/institution changes unless this is on. SQL-editor
-- sessions carry an auth.uid(), so set it session-wide before touching profiles.
select set_config('reach.allow_privilege_change', 'on', false);

-- One transaction: a failure anywhere rolls the whole reset back instead of leaving the
-- database half-wiped.
begin;

do $$
begin
  if to_regclass('auth.users') is null then
    raise exception 'auth.users not found — run this against a Supabase project database';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. RESET — delete every data record (FK-safe order). Schema is left intact.
-- ---------------------------------------------------------------------------
drop table if exists public._seed_users;
delete from public.incident_evidence;
delete from public.ai_evaluations;
delete from public.ai_assessments;
delete from public.incident_assignments;
delete from public.incident_events;
delete from public.relay_packets;
delete from public.ai_provider_events;
delete from public.notifications;
delete from public.notification_deliveries;
delete from public.incidents;
delete from public.emergency_contacts;
delete from public.device_registrations;
delete from public.responders;
delete from public.institution_invites;
delete from public.institution_members;
delete from public.onboarding_sessions;
delete from public.operator_invitations;
delete from public.bmoni_transactions;
delete from public.bmoni_webhook_events;
delete from public.bmoni_institution_accounts;
delete from public.payments;
delete from public.subscriptions;
delete from public.broadcasts;
delete from public.audit_logs;
delete from public.rate_limit_buckets;
delete from public.relay_ingest_dedup;
-- ai_model_registry ships two canonical rows from migration 0004; clear only demo rows.
delete from public.ai_model_registry where metadata->>'demo' = 'true';
delete from public.profiles;
delete from public.zones;
delete from public.institutions;
delete from auth.users;

-- ---------------------------------------------------------------------------
-- 2. INSTITUTIONS + ZONES
-- ---------------------------------------------------------------------------
-- Greenfield is the reference tenant (active subscription). Northgate starts on a
-- trial with no BMONI account, so it is the one to configure live in the sandbox.
insert into public.institutions(id, name, category, city, address, timezone, settings) values
  ('11111111-1111-1111-1111-111111111111', 'Greenfield Estate', 'estate', 'Abraka', '12 Greenfield Way, Abraka', 'Africa/Lagos', '{"demo": true}'::jsonb),
  ('22222222-2222-2222-2222-222222222222', 'Northgate University', 'campus', 'Lagos', '1 Northgate Ave, Lagos', 'Africa/Lagos', '{"demo": true}'::jsonb);

insert into public.zones(id, institution_id, name, landmark, centroid) values
  ('11111111-1111-1111-1111-0000000000a1', '11111111-1111-1111-1111-111111111111', 'Block A', 'Central lawn', ST_SetSRID(ST_MakePoint(6.2035, 5.7891), 4326)::geography),
  ('11111111-1111-1111-1111-0000000000a2', '11111111-1111-1111-1111-111111111111', 'Block B', 'Parking bay', ST_SetSRID(ST_MakePoint(6.2042, 5.7899), 4326)::geography),
  ('22222222-2222-2222-2222-0000000000b1', '22222222-2222-2222-2222-222222222222', 'Hostel Block B', 'Main hostel', ST_SetSRID(ST_MakePoint(6.5244, 3.3792), 4326)::geography),
  ('22222222-2222-2222-2222-0000000000b2', '22222222-2222-2222-2222-222222222222', 'Faculty of Science', 'Science quad', ST_SetSRID(ST_MakePoint(6.5251, 3.3805), 4326)::geography);

-- ---------------------------------------------------------------------------
-- 3. USERS (auth.users → trigger creates profiles → we set the real role)
-- ---------------------------------------------------------------------------
drop table if exists public._seed_users;
create table public._seed_users(
  id uuid primary key, email text, full_name text, phone text,
  role public.reach_role, institution_id uuid, zone_id uuid
);

insert into _seed_users(id, email, full_name, phone, role, institution_id, zone_id) values
  -- Greenfield Estate (reference tenant, active subscription)
  ('aaaaaaaa-0000-0000-0000-000000000001', 'admin@greenfield.reach.dev',   'Greenfield Admin',   '+2348010000001', 'institution',   '11111111-1111-1111-1111-111111111111', null),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'staff@greenfield.reach.dev',   'Tunde Bello',        '+2348010000002', 'staff',         '11111111-1111-1111-1111-111111111111', null),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'desk@greenfield.reach.dev',    'Amadi Okonkwo',      '+2348010000003', 'security-desk', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-0000000000a1'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'citizen@greenfield.reach.dev', 'Chioma Eze',         '+2348010000004', 'citizen',       '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-0000000000a1'),
  -- Platform roles (no institution)
  ('aaaaaaaa-0000-0000-0000-000000000005', 'ops@reach.dev',                'Ops Ada',            '+2348010000005', 'operator',      null,                                   null),
  ('aaaaaaaa-0000-0000-0000-000000000006', 'superadmin@reach.dev',         'REACH Super Admin',  '+2348010000006', 'super-admin',   null,                                   null),
  -- Northgate University (trial, not BMONI-configured yet)
  ('aaaaaaaa-0000-0000-0000-000000000007', 'admin@northgate.reach.dev',    'Northgate Admin',    '+2348010000007', 'institution',   '22222222-2222-2222-2222-222222222222', null),
  ('aaaaaaaa-0000-0000-0000-000000000008', 'citizen@northgate.reach.dev',  'Bola Ade',           '+2348010000008', 'citizen',       '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-0000000000b1'),
  ('aaaaaaaa-0000-0000-0000-000000000018', 'staff@northgate.reach.dev',    'Grace Umeh',         '+2348010000018', 'staff',         '22222222-2222-2222-2222-222222222222', null),
  ('aaaaaaaa-0000-0000-0000-00000000001a', 'desk@northgate.reach.dev',     'Ngozi Ibe',          '+2348010000020', 'security-desk', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-0000000000b1');

insert into auth.users(
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select
  u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  u.email, crypt('ReachDemo!2026', gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', u.full_name, 'phone', u.phone),
  now(), now()
from _seed_users u;

update public.profiles p
set full_name = u.full_name, phone = u.phone, role = u.role,
    institution_id = u.institution_id, zone_id = u.zone_id, relay_enabled = true
from _seed_users u
where p.id = u.id;

-- GoTrue scans several auth.users text columns into plain strings, so they must be ''
-- rather than NULL or every password login fails with "Database error querying schema".
-- The columns vary by GoTrue version, so set whichever exist.
do $$
declare col text;
begin
  foreach col in array array[
    'confirmation_token','recovery_token','email_change_token_new','email_change',
    'email_change_token_current','phone_change','phone_change_token','reauthentication_token'
  ] loop
    if exists (select 1 from information_schema.columns
               where table_schema='auth' and table_name='users' and column_name=col) then
      execute format('update auth.users set %I = '''' where %I is null', col, col);
    end if;
  end loop;
  if exists (select 1 from information_schema.columns
             where table_schema='auth' and table_name='users' and column_name='is_sso_user') then
    update auth.users set is_sso_user = false where is_sso_user is null;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='auth' and table_name='users' and column_name='is_anonymous') then
    update auth.users set is_anonymous = false where is_anonymous is null;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='auth' and table_name='users' and column_name='email_change_confirm_status') then
    update auth.users set email_change_confirm_status = 0 where email_change_confirm_status is null;
  end if;
end $$;

-- Identity rows let the dashboard show the user; password login works without them, so
-- this is best-effort and must not abort the seed on a schema variant.
do $$
declare u record;
begin
  for u in select id, email from _seed_users loop
    begin
      insert into auth.identities(id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
      values (u.id, u.id, jsonb_build_object('sub', u.id::text, 'email', u.email), 'email', u.id::text, now(), now(), now());
    exception when others then
      raise notice 'identity row skipped for %: %', u.email, sqlerrm;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. MEMBERSHIP
-- ---------------------------------------------------------------------------
insert into public.institution_members(institution_id, user_id, membership_role, status) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'institution',   'active'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002', 'staff',         'active'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000003', 'security-desk', 'active'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000004', 'citizen',       'active'),
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000007', 'institution',   'active'),
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000018', 'staff',         'active'),
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-00000000001a', 'security-desk', 'active'),
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000008', 'citizen',       'active');

-- ---------------------------------------------------------------------------
-- 5. RESPONDERS
-- ---------------------------------------------------------------------------
insert into public.responders(id, user_id, institution_id, responder_type, duty_status, current_location, last_seen_at) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'staff',         'on_duty',  ST_SetSRID(ST_MakePoint(6.2040, 5.7895), 4326)::geography, now()),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'security-desk', 'off_duty', null, now()),
  ('bbbbbbbb-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000018', '22222222-2222-2222-2222-222222222222', 'staff',         'on_duty',  ST_SetSRID(ST_MakePoint(6.5246, 3.3795), 4326)::geography, now()),
  ('bbbbbbbb-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-00000000001a', '22222222-2222-2222-2222-222222222222', 'security-desk', 'off_duty', null, now());

-- ---------------------------------------------------------------------------
-- 6. EMERGENCY CONTACTS + DEVICES
-- ---------------------------------------------------------------------------
insert into public.emergency_contacts(id, user_id, name, phone, relationship, notify_on_incident) values
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000004', 'Ngozi Eze',   '+2348090000001', 'sister',   true),
  ('cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000008', 'Femi Ade',    '+2348090000003', 'brother',  true);

insert into public.device_registrations(id, user_id, device_id, platform, relay_enabled, public_key, status, last_seen_at, metadata) values
  ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000004', 'demo-device-0001', 'android', true, 'demo-public-key-00000000000000000000000000000000000000000000000000000001', 'active', now(), '{"demo": true, "transport": "web-bluetooth"}'::jsonb),
  ('dddddddd-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000008', 'demo-device-0003', 'android', true, 'demo-public-key-00000000000000000000000000000000000000000000000000000003', 'active', now(), '{"demo": true, "transport": "web-bluetooth"}'::jsonb);

-- ---------------------------------------------------------------------------
-- 7. INCIDENTS (trigger records the creation event + queues notifications)
-- ---------------------------------------------------------------------------
-- A spread of statuses across both institutions so the desk, responder and operator
-- screens all show a realistic queue. `via_relay` incidents arrived through the
-- offline relay transport.
insert into public.incidents(
  id, code, institution_id, reporter_id, category, status, priority, title, description,
  source_channel, delivery_method, location_label, location_source, location_accuracy_m, location,
  location_context, ai_confidence, ai_fp_code, verification_state, auto_pushed, via_relay,
  idempotency_key, reported_at, acknowledged_at, resolved_at, closed_at
) values
  -- Greenfield Estate
  ('eeeeeeee-0000-0000-0000-000000000001', 'REACH-GF0001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000004',
   'medical', 'verified', 'high', 'Medical emergency at Block A', 'Resident collapsed near the central lawn.',
   'pwa', 'internet', 'Block A lawn', 'gps', 25, ST_SetSRID(ST_MakePoint(6.2036, 5.7892), 4326)::geography,
   '{"note":"demo"}'::jsonb, 78.50, 'FP-2041', 'verified', true, false,
   'demo-incident-a1', now() - interval '15 minutes', now() - interval '14 minutes', null, null),
  ('eeeeeeee-0000-0000-0000-000000000002', 'REACH-GF0002', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000004',
   'security', 'resolved', 'medium', 'Suspicious movement near Block B', 'Unidentified person loitering by the parking bay.',
   'pwa', 'internet', 'Block B parking', 'gps', 40, ST_SetSRID(ST_MakePoint(6.2042, 5.7899), 4326)::geography,
   '{}'::jsonb, 61.20, 'FP-3077', 'verified', true, false,
   'demo-incident-a2', now() - interval '2 days', now() - interval '2 days' + interval '3 minutes', now() - interval '2 days' + interval '40 minutes', now() - interval '2 days' + interval '1 hour'),
  ('eeeeeeee-0000-0000-0000-000000000003', 'REACH-GF0003', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000004',
   'accident', 'responding', 'critical', 'Road accident at the gate', 'Two vehicles collided at the estate gate; relayed from an offline device.',
   'relay', 'relay', 'Estate gate', 'gps', 30, ST_SetSRID(ST_MakePoint(6.2031, 5.7888), 4326)::geography,
   '{"transport":"relay","provisional":false}'::jsonb, 84.00, 'FP-1188', 'verified', true, true,
   'demo-incident-a3', now() - interval '35 minutes', now() - interval '33 minutes', null, null),
  ('eeeeeeee-0000-0000-0000-000000000004', 'REACH-GF0004', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000004',
   'fire', 'closed', 'low', 'Fire extinguisher discharge', 'A resident discharged a fire extinguisher in the corridor as a prank.',
   'pwa', 'internet', 'Block A corridor', 'registered', 60, ST_SetSRID(ST_MakePoint(6.2035, 5.7891), 4326)::geography,
   '{}'::jsonb, 45.00, 'FP-9001', 'rejected', false, false,
   'demo-incident-a4', now() - interval '3 days', now() - interval '3 days' + interval '2 minutes', now() - interval '3 days' + interval '20 minutes', now() - interval '3 days' + interval '30 minutes'),
  ('eeeeeeee-0000-0000-0000-000000000005', 'REACH-GF0005', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000004',
   'medical', 'reported', 'critical', 'Fainting in Block B', 'Resident fainted in the stairwell; needs urgent attention.',
   'pwa', 'internet', 'Block B stairwell', 'gps', 20, ST_SetSRID(ST_MakePoint(6.2043, 5.7900), 4326)::geography,
   '{}'::jsonb, null, null, 'unverified', false, false,
   'demo-incident-a5', now() - interval '4 minutes', null, null, null),
  -- Northgate University
  ('eeeeeeee-0000-0000-0000-000000000006', 'REACH-NG0001', '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000008',
   'fire', 'received', 'critical', 'Fire alarm at Northgate hostel', 'Smoke reported on the second floor.',
   'pwa', 'internet', 'Hostel Block B', 'network', 120, ST_SetSRID(ST_MakePoint(3.3792, 6.5244), 4326)::geography,
   '{}'::jsonb, null, null, 'unverified', false, false,
   'demo-incident-b1', now() - interval '3 minutes', null, null, null),
  ('eeeeeeee-0000-0000-0000-000000000007', 'REACH-NG0002', '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000008',
   'security', 'assigned', 'high', 'Theft reported at the science lab', 'A laptop was taken from the faculty of science lab.',
   'pwa', 'internet', 'Faculty of Science', 'gps', 35, ST_SetSRID(ST_MakePoint(3.3805, 6.5251), 4326)::geography,
   '{}'::jsonb, 70.00, 'FP-2210', 'verified', true, false,
   'demo-incident-b2', now() - interval '50 minutes', now() - interval '48 minutes', null, null),
  ('eeeeeeee-0000-0000-0000-000000000008', 'REACH-NG0003', '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000008',
   'accident', 'verifying', 'medium', 'Slip and fall near the library', 'A student slipped on a wet floor outside the library.',
   'pwa', 'internet', 'Main library steps', 'manual', null, ST_SetSRID(ST_MakePoint(3.3798, 6.5247), 4326)::geography,
   '{}'::jsonb, 58.00, 'FP-4400', 'pending', false, false,
   'demo-incident-b3', now() - interval '22 minutes', now() - interval '20 minutes', null, null),
  ('eeeeeeee-0000-0000-0000-000000000009', 'REACH-NG0004', '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000008',
   'other', 'on_scene', 'low', 'Flooded walkway', 'Heavy rain flooded the walkway between hostels.',
   'pwa', 'internet', 'Hostel walkway', 'gps', 50, ST_SetSRID(ST_MakePoint(3.3793, 6.5245), 4326)::geography,
   '{}'::jsonb, 40.00, 'FP-5500', 'verified', true, false,
   'demo-incident-b4', now() - interval '80 minutes', now() - interval '78 minutes', null, null),
  ('eeeeeeee-0000-0000-0000-00000000000a', 'REACH-NG0005', '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000008',
   'medical', 'resolved', 'high', 'Asthma attack at the hostel', 'Student had an asthma attack; inhaler administered on site.',
   'pwa', 'internet', 'Hostel Block B', 'gps', 25, ST_SetSRID(ST_MakePoint(3.3792, 6.5244), 4326)::geography,
   '{}'::jsonb, 66.00, 'FP-6600', 'verified', true, false,
   'demo-incident-b5', now() - interval '1 day', now() - interval '1 day' + interval '2 minutes', now() - interval '1 day' + interval '25 minutes', null);

-- Manual timeline entries that show desk/responder decisions. The creation event for each
-- incident is written automatically by the incident_event_trigger.
insert into public.incident_events(id, incident_id, actor_id, event_type, from_status, to_status, message, metadata) values
  ('ffffffff-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 'note', 'verified', 'verified', 'Desk confirmed the report with the caller.', '{"demo": true}'::jsonb),
  ('ffffffff-0000-0000-0000-000000000002', 'eeeeeeee-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000003', 'status_change', 'assigned', 'responding', 'Responder dispatched to the estate gate.', '{"demo": true}'::jsonb),
  ('ffffffff-0000-0000-0000-000000000003', 'eeeeeeee-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-00000000001a', 'status_change', 'verifying', 'assigned', 'Security staff assigned to the lab theft.', '{"demo": true}'::jsonb),
  ('ffffffff-0000-0000-0000-000000000004', 'eeeeeeee-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-00000000001a', 'note', 'responding', 'responding', 'First aid administered; student stable.', '{"demo": true}'::jsonb);

insert into public.incident_assignments(id, incident_id, responder_id, assigned_by, status, assigned_at, accepted_at) values
  ('12121212-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 'accepted', now() - interval '10 minutes', now() - interval '9 minutes'),
  ('12121212-0000-0000-0000-000000000003', 'eeeeeeee-0000-0000-0000-000000000007', 'bbbbbbbb-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-00000000001a', 'assigned', now() - interval '45 minutes', null),
  ('12121212-0000-0000-0000-000000000004', 'eeeeeeee-0000-0000-0000-000000000009', 'bbbbbbbb-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-00000000001a', 'on_scene', now() - interval '75 minutes', now() - interval '74 minutes');

insert into public.incident_evidence(id, incident_id, evidence_type, storage_path, content_hash, source, confidence, metadata) values
  ('13131313-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 'text', null, null, 'citizen', 55, '{"derived": true, "quality": 1, "demo": true}'::jsonb),
  ('13131313-0000-0000-0000-000000000002', 'eeeeeeee-0000-0000-0000-000000000003', 'image', 'demo/evidence/accident-gate.jpg', 'demo-hash-evidence-0002', 'relay', 72, '{"demo": true}'::jsonb),
  ('13131313-0000-0000-0000-000000000003', 'eeeeeeee-0000-0000-0000-000000000007', 'audio', 'demo/evidence/lab-theft.m4a', 'demo-hash-evidence-0003', 'citizen', 64, '{"demo": true}'::jsonb);

-- ---------------------------------------------------------------------------
-- 8. AI
-- ---------------------------------------------------------------------------
insert into public.ai_assessments(id, incident_id, model_name, category, confidence, fp_code, evidence_ids, explanation, decision) values
  ('14141414-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 'reach-deterministic-v1', 'medical', 78.50, 'FP-2041', '{}', 'Strong medical signal with corroborating location.', 'recommend'),
  ('14141414-0000-0000-0000-000000000002', 'eeeeeeee-0000-0000-0000-000000000007', 'reach-deterministic-v1', 'security', 70.00, 'FP-2210', '{}', 'Security signal with a verified zone match.', 'recommend');

insert into public.ai_evaluations(id, incident_id, assessment_id, outcome, reviewer_id, notes) values
  ('15151515-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', '14141414-0000-0000-0000-000000000001', 'confirmed', 'aaaaaaaa-0000-0000-0000-000000000003', 'Confirmed true emergency during desk review.'),
  ('15151515-0000-0000-0000-000000000002', 'eeeeeeee-0000-0000-0000-000000000007', '14141414-0000-0000-0000-000000000002', 'confirmed', 'aaaaaaaa-0000-0000-0000-00000000001a', 'Confirmed theft; CCTV corroborated the report.');

insert into public.ai_model_registry(id, model_name, provider, modality, version, status, calibration_version, latency_target_ms, metadata) values
  ('16161616-0000-0000-0000-000000000001', 'reach-deterministic-v1', 'reach', '{text,location}', '1.0.0', 'active', 'cal-1', 800, '{"demo": true}'::jsonb)
on conflict (model_name) do update set metadata = excluded.metadata;

insert into public.ai_provider_events(id, institution_id, incident_id, outcome, model, failure_kind, detail, latency_ms) values
  ('17171717-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'eeeeeeee-0000-0000-0000-000000000001', 'ok', 'reach-deterministic-v1', null, null, 42),
  ('17171717-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'eeeeeeee-0000-0000-0000-000000000007', 'ok', 'reach-deterministic-v1', null, null, 51);

-- ---------------------------------------------------------------------------
-- 9. RELAY
-- ---------------------------------------------------------------------------
insert into public.relay_packets(id, packet_key, incident_id, source_device_id, relay_device_id, gateway_id, hop_count, max_hops, status, packet_hash, minimal_payload, received_at) values
  ('18181818-0000-0000-0000-000000000001', 'demo-packet-key-0001', 'eeeeeeee-0000-0000-0000-000000000001', 'demo-device-0001', null, 'demo-gateway-01', 0, 6, 'delivered', 'demo-packet-hash-0000000000000001', '{"location_label":"Block A lawn","location_source":"gps","location_accuracy_m":25}'::jsonb, now() - interval '14 minutes'),
  ('18181818-0000-0000-0000-000000000002', 'demo-packet-key-0002', 'eeeeeeee-0000-0000-0000-000000000003', 'demo-device-0001', null, 'demo-gateway-01', 1, 6, 'delivered', 'demo-packet-hash-0000000000000002', '{"location_label":"Estate gate","location_source":"gps","location_accuracy_m":30}'::jsonb, now() - interval '34 minutes');

insert into public.relay_ingest_dedup(packet_key, packet_hash, institution_id, receive_count) values
  ('demo-packet-key-0001', 'demo-packet-hash-0000000000000001', '11111111-1111-1111-1111-111111111111', 1),
  ('demo-packet-key-0002', 'demo-packet-hash-0000000000000002', '11111111-1111-1111-1111-111111111111', 2);

-- ---------------------------------------------------------------------------
-- 10. NOTIFICATIONS
-- ---------------------------------------------------------------------------
insert into public.notifications(id, user_id, institution_id, incident_id, channel, title, body, status, recipient_phone, recipient_email, sent_at) values
  ('19191919-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'eeeeeeee-0000-0000-0000-000000000001', 'in_app', 'Emergency reported', 'Incident REACH-GF0001 is entering the response workflow.', 'sent', '+2348010000004', 'citizen@greenfield.reach.dev', now()),
  ('19191919-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'eeeeeeee-0000-0000-0000-000000000003', 'push', 'Critical incident assigned', 'REACH-GF0003 · Accident · Critical — a responder is responding.', 'sent', null, 'desk@greenfield.reach.dev', now()),
  ('19191919-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000008', '22222222-2222-2222-2222-222222222222', 'eeeeeeee-0000-0000-0000-000000000006', 'in_app', 'Emergency reported', 'Incident REACH-NG0001 is entering the response workflow.', 'queued', '+2348010000008', 'citizen@northgate.reach.dev', null);

insert into public.notification_deliveries(id, notification_id, channel, recipient, provider_message_id, status, attempt_count) values
  ('20202020-0000-0000-0000-000000000001', '19191919-0000-0000-0000-000000000001', 'in_app', 'citizen@greenfield.reach.dev', 'demo-msg-0001', 'delivered', 1),
  ('20202020-0000-0000-0000-000000000002', '19191919-0000-0000-0000-000000000002', 'push', 'desk@greenfield.reach.dev', 'demo-msg-0002', 'delivered', 1);

-- ---------------------------------------------------------------------------
-- 11. BROADCASTS
-- ---------------------------------------------------------------------------
insert into public.broadcasts(id, institution_id, created_by, title, body, priority, channels, active) values
  ('21212121-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'Scheduled drill', 'A short safety drill will run at 16:00 today.', 'medium', '{in_app}', true),
  ('21212121-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000007', 'Hostel water outage', 'Water will be off in Hostel Block B from 09:00 to 11:00 tomorrow.', 'low', '{in_app}', true);

-- ---------------------------------------------------------------------------
-- 12. BILLING (subscription, payment, BMONI)
-- ---------------------------------------------------------------------------
-- Greenfield is the already-configured, active reference tenant. Northgate is on a
-- trial with no BMONI account, payment or transaction, so it is the tenant to run the
-- sandbox Configure BMONI → Pay walkthrough against; its subscription flips to active
-- when the BMONI payment webhook arrives.
insert into public.subscriptions(id, institution_id, plan_name, status, member_limit, current_period_start, current_period_end, provider, provider_reference) values
  ('22222222-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'REACH Full', 'active', 500, current_date, current_date + interval '30 days', 'BMONI Embedded', 'demo-sub-0001'),
  ('22222222-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', 'REACH Full', 'trial',  500, current_date, current_date + interval '14 days', null, null);

insert into public.payments(id, institution_id, subscription_id, amount, currency, status, provider, provider_reference, paid_at) values
  ('23232323-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-0000000000a1', 1450000.00, 'CNGN', 'paid', 'BMONI Embedded', 'demo-payment-0001', now() - interval '2 days');

insert into public.bmoni_institution_accounts(id, institution_id, bmoni_user_id, smart_wallet_id, wallet_address, currency, onboarding_status, bvn_verified, ngn_virtual_account_ready, metadata) values
  ('24242424-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'demo-bmoni-user-0001', 'demo-smart-wallet-0001', '0xDEMO000000000000000000000000000000000001', 'CNGN', 'active', true, true, '{"payer_email":"admin@greenfield.reach.dev","demo":true}'::jsonb);

insert into public.bmoni_transactions(id, institution_id, subscription_id, payment_id, bmoni_user_id, smart_wallet_id, proposal_id, bmoni_transaction_id, idempotency_key, amount, currency, status, description, raw_response) values
  ('25252525-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-0000000000a1', '23232323-0000-0000-0000-000000000001', 'demo-bmoni-user-0001', 'demo-smart-wallet-0001', 'demo-proposal-0001', 'demo-bmoni-tx-0001', 'demo-idem-0001', 1450000.00000000, 'CNGN', 'successful', 'REACH institutional subscription', '{"demo": true}'::jsonb);

insert into public.bmoni_webhook_events(id, event_id, event_type, signature_verified, payload, processed_at) values
  ('26262626-0000-0000-0000-000000000001', 'demo-webhook-0001', 'transaction.successful', true, '{"demo": true}'::jsonb, now() - interval '2 days');

-- ---------------------------------------------------------------------------
-- 13. INVITES + ONBOARDING
-- ---------------------------------------------------------------------------
insert into public.institution_invites(id, institution_id, email, role, code_hash, expires_at, created_by) values
  ('27272727-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'newstaff@greenfield.reach.dev', 'staff', encode(digest('REACH-DEMOINVITE', 'sha256'), 'hex'), now() + interval '72 hours', 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('27272727-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'newdesk@greenfield.reach.dev', 'security-desk', encode(digest('REACH-DEMOINVITE-2', 'sha256'), 'hex'), now() + interval '72 hours', 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('27272727-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222', 'newstaff@northgate.reach.dev', 'staff', encode(digest('REACH-DEMOINVITE-NG', 'sha256'), 'hex'), now() + interval '72 hours', 'aaaaaaaa-0000-0000-0000-000000000007');

insert into public.operator_invitations(id, email, token_hash, invited_by, status, expires_at) values
  ('28282828-0000-0000-0000-000000000001', 'newops@reach.dev', encode(digest('demo-operator-invitation-token', 'sha256'), 'hex'), 'aaaaaaaa-0000-0000-0000-000000000006', 'pending', now() + interval '24 hours');

insert into public.onboarding_sessions(id, user_id, email, onboarding_type, institution_id, intended_role, payload, status, expires_at) values
  ('29292929-0000-0000-0000-000000000001', null, 'pending.institution@example.dev', 'institution', '11111111-1111-1111-1111-111111111111', 'institution', '{"demo": true}'::jsonb, 'pending', now() + interval '48 hours');

-- ---------------------------------------------------------------------------
-- 14. AUDIT + RATE LIMIT
-- ---------------------------------------------------------------------------
insert into public.audit_logs(id, actor_id, institution_id, action, resource_type, resource_id, metadata) values
  ('30303030-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'demo.seeded', 'institution', '11111111-1111-1111-1111-111111111111', '{"demo": true}'::jsonb),
  ('30303030-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000007', '22222222-2222-2222-2222-222222222222', 'demo.seeded', 'institution', '22222222-2222-2222-2222-222222222222', '{"demo": true}'::jsonb);

insert into public.rate_limit_buckets(bucket_key, window_start, request_count) values
  ('demo:bucket', now(), 1);

-- ---------------------------------------------------------------------------
-- 15. SUMMARY — one line per public table with its row count
-- ---------------------------------------------------------------------------
select t.table_name, (xpath('/row/c/text()', query_to_xml(
  format('select count(*) as c from public.%I', t.table_name), false, true, '')))[1]::text::int as rows
from information_schema.tables t
where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
  and t.table_name <> 'spatial_ref_sys' and t.table_name not like '\_%'
order by t.table_name;

drop table if exists public._seed_users;

commit;
