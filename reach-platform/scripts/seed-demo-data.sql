-- REACH — reset + one-row-per-table demo seed
--
-- Clears every REACH data record and inserts exactly one representative row in every
-- section/table so each screen has something to show during the hackathon demo.
--
-- Run it in the Supabase SQL editor (Dashboard → SQL editor → paste → Run), or with psql
-- against the project database. It runs as the connection owner and bypasses RLS on
-- purpose; it is a maintenance/demo script, never something the app calls.
--
--   * The reset is destructive. Take a backup first if any row matters.
--   * The seeded sign-ins all use the password  ReachDemo!2026
--   * Re-running is safe: it clears and re-seeds to the same known state.
--
-- Demo sign-ins:
--   admin@greenfield.reach.dev      institution   (Greenfield Estate)
--   staff@greenfield.reach.dev      staff
--   desk@greenfield.reach.dev       security-desk
--   citizen@greenfield.reach.dev    citizen
--   ops@reach.dev                   operator
--   superadmin@reach.dev            super-admin
--   admin@northgate.reach.dev       institution   (Northgate University)
--   citizen@northgate.reach.dev     citizen

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
insert into public.institutions(id, name, category, city, address, timezone, settings) values
  ('11111111-1111-1111-1111-111111111111', 'Greenfield Estate', 'estate', 'Abraka', '12 Greenfield Way, Abraka', 'Africa/Lagos', '{"demo": true}'::jsonb),
  ('22222222-2222-2222-2222-222222222222', 'Northgate University', 'campus', 'Lagos', '1 Northgate Ave, Lagos', 'Africa/Lagos', '{"demo": true}'::jsonb);

insert into public.zones(id, institution_id, name, landmark, centroid) values
  ('11111111-1111-1111-1111-0000000000a1', '11111111-1111-1111-1111-111111111111', 'Block A', 'Central lawn', ST_SetSRID(ST_MakePoint(6.2035, 5.7891), 4326)::geography);

-- ---------------------------------------------------------------------------
-- 3. USERS (auth.users → trigger creates profiles → we set the real role)
-- ---------------------------------------------------------------------------
drop table if exists public._seed_users;
create table public._seed_users(
  id uuid primary key, email text, full_name text, phone text,
  role public.reach_role, institution_id uuid, zone_id uuid
);

insert into _seed_users(id, email, full_name, phone, role, institution_id, zone_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'admin@greenfield.reach.dev',   'Greenfield Admin',  '+2348010000001', 'institution',   '11111111-1111-1111-1111-111111111111', null),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'staff@greenfield.reach.dev',   'Tunde Bello',       '+2348010000002', 'staff',         '11111111-1111-1111-1111-111111111111', null),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'desk@greenfield.reach.dev',    'Amadi Okonkwo',     '+2348010000003', 'security-desk', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-0000000000a1'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'citizen@greenfield.reach.dev', 'Chioma Eze',        '+2348010000004', 'citizen',       '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-0000000000a1'),
  ('aaaaaaaa-0000-0000-0000-000000000005', 'ops@reach.dev',                'Ops Ada',           '+2348010000005', 'operator',      null,                                   null),
  ('aaaaaaaa-0000-0000-0000-000000000006', 'superadmin@reach.dev',         'REACH Super Admin', '+2348010000006', 'super-admin',   null,                                   null),
  ('aaaaaaaa-0000-0000-0000-000000000007', 'admin@northgate.reach.dev',    'Northgate Admin',   '+2348010000007', 'institution',   '22222222-2222-2222-2222-222222222222', null),
  ('aaaaaaaa-0000-0000-0000-000000000008', 'citizen@northgate.reach.dev',  'Bola Ade',          '+2348010000008', 'citizen',       '22222222-2222-2222-2222-222222222222', null);

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
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000008', 'citizen',       'active');

-- ---------------------------------------------------------------------------
-- 5. RESPONDERS
-- ---------------------------------------------------------------------------
insert into public.responders(id, user_id, institution_id, responder_type, duty_status, current_location, last_seen_at) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'staff',         'on_duty',  ST_SetSRID(ST_MakePoint(6.2040, 5.7895), 4326)::geography, now()),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'security-desk', 'off_duty', null, now());

-- ---------------------------------------------------------------------------
-- 6. EMERGENCY CONTACTS + DEVICES
-- ---------------------------------------------------------------------------
insert into public.emergency_contacts(id, user_id, name, phone, relationship, notify_on_incident) values
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000004', 'Ngozi Eze', '+2348090000001', 'sister', true);

insert into public.device_registrations(id, user_id, device_id, platform, relay_enabled, last_seen_at, metadata) values
  ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000004', 'demo-device-0001', 'android', true, now(), '{"demo": true}'::jsonb);

-- ---------------------------------------------------------------------------
-- 7. INCIDENTS (trigger records the creation event + queues notifications)
-- ---------------------------------------------------------------------------
insert into public.incidents(
  id, code, institution_id, reporter_id, category, status, priority, title, description,
  source_channel, delivery_method, location_label, location_source, location_accuracy_m, location,
  location_context, ai_confidence, ai_fp_code, verification_state, auto_pushed, via_relay,
  idempotency_key, reported_at
) values
  ('eeeeeeee-0000-0000-0000-000000000001', 'REACH-DEMO01', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000004',
   'medical', 'verified', 'high', 'Medical emergency at Block A', 'Resident collapsed near the central lawn.',
   'pwa', 'internet', 'Block A lawn', 'gps', 25, ST_SetSRID(ST_MakePoint(6.2036, 5.7892), 4326)::geography,
   '{"note":"demo"}'::jsonb, 78.50, 'FP-2041', 'verified', true, false,
   'demo-incident-a1', now() - interval '15 minutes'),
  ('eeeeeeee-0000-0000-0000-000000000002', 'REACH-DEMO02', '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000008',
   'fire', 'reported', 'critical', 'Fire alarm at Northgate hostel', 'Smoke reported on the second floor.',
   'pwa', 'internet', 'Hostel Block B', 'network', 120, ST_SetSRID(ST_MakePoint(3.3792, 6.5244), 4326)::geography,
   '{}'::jsonb, null, null, 'unverified', false, false,
   'demo-incident-b1', now() - interval '3 minutes');

insert into public.incident_events(id, incident_id, actor_id, event_type, from_status, to_status, message, metadata) values
  ('ffffffff-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 'note', 'verified', 'verified', 'Desk confirmed the report with the caller.', '{"demo": true}'::jsonb);

insert into public.incident_assignments(id, incident_id, responder_id, assigned_by, status, assigned_at, accepted_at) values
  ('12121212-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 'accepted', now() - interval '10 minutes', now() - interval '9 minutes');

insert into public.incident_evidence(id, incident_id, evidence_type, storage_path, content_hash, source, confidence, metadata) values
  ('13131313-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 'text', null, null, 'citizen', 55, '{"derived": true, "quality": 1, "demo": true}'::jsonb);

-- ---------------------------------------------------------------------------
-- 8. AI
-- ---------------------------------------------------------------------------
insert into public.ai_assessments(id, incident_id, model_name, category, confidence, fp_code, evidence_ids, explanation, decision) values
  ('14141414-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 'reach-deterministic-v1', 'medical', 78.50, 'FP-2041', '{}', 'Strong medical signal with corroborating location.', 'recommend');

insert into public.ai_evaluations(id, incident_id, assessment_id, outcome, reviewer_id, notes) values
  ('15151515-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', '14141414-0000-0000-0000-000000000001', 'confirmed', 'aaaaaaaa-0000-0000-0000-000000000003', 'Confirmed true emergency during desk review.');

insert into public.ai_model_registry(id, model_name, provider, modality, version, status, calibration_version, latency_target_ms, metadata) values
  ('16161616-0000-0000-0000-000000000001', 'reach-deterministic-v1', 'reach', '{text,location}', '1.0.0', 'active', 'cal-1', 800, '{"demo": true}'::jsonb)
on conflict (model_name) do update set metadata = excluded.metadata;

insert into public.ai_provider_events(id, institution_id, incident_id, outcome, model, failure_kind, detail, latency_ms) values
  ('17171717-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'eeeeeeee-0000-0000-0000-000000000001', 'ok', 'reach-deterministic-v1', null, null, 42);

-- ---------------------------------------------------------------------------
-- 9. RELAY
-- ---------------------------------------------------------------------------
insert into public.relay_packets(id, packet_key, incident_id, source_device_id, relay_device_id, gateway_id, hop_count, max_hops, status, packet_hash, minimal_payload, received_at) values
  ('18181818-0000-0000-0000-000000000001', 'demo-packet-key-0001', 'eeeeeeee-0000-0000-0000-000000000001', 'demo-device-0001', null, 'demo-gateway-01', 0, 6, 'delivered', 'demo-packet-hash-0000000000000001', '{"location_label":"Block A lawn","location_source":"gps","location_accuracy_m":25}'::jsonb, now() - interval '14 minutes');

insert into public.relay_ingest_dedup(packet_key, packet_hash, institution_id, receive_count) values
  ('demo-packet-key-0001', 'demo-packet-hash-0000000000000001', '11111111-1111-1111-1111-111111111111', 1);

-- ---------------------------------------------------------------------------
-- 10. NOTIFICATIONS
-- ---------------------------------------------------------------------------
insert into public.notifications(id, user_id, institution_id, incident_id, channel, title, body, status, recipient_phone, recipient_email, sent_at) values
  ('19191919-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'eeeeeeee-0000-0000-0000-000000000001', 'in_app', 'Emergency reported', 'Incident REACH-DEMO01 is entering the response workflow.', 'sent', '+2348010000004', 'citizen@greenfield.reach.dev', now());

insert into public.notification_deliveries(id, notification_id, channel, recipient, provider_message_id, status, attempt_count) values
  ('20202020-0000-0000-0000-000000000001', '19191919-0000-0000-0000-000000000001', 'in_app', 'citizen@greenfield.reach.dev', 'demo-msg-0001', 'delivered', 1);

-- ---------------------------------------------------------------------------
-- 11. BROADCASTS
-- ---------------------------------------------------------------------------
insert into public.broadcasts(id, institution_id, created_by, title, body, priority, channels, active) values
  ('21212121-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'Scheduled drill', 'A short safety drill will run at 16:00 today.', 'medium', '{in_app}', true);

-- ---------------------------------------------------------------------------
-- 12. BILLING (subscription, payment, BMONI)
-- ---------------------------------------------------------------------------
insert into public.subscriptions(id, institution_id, plan_name, status, member_limit, current_period_start, current_period_end, provider, provider_reference) values
  ('22222222-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111', 'REACH Full', 'active', 500, current_date, current_date + interval '30 days', 'BMONI Embedded', 'demo-sub-0001');

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
  ('27272727-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'newstaff@greenfield.reach.dev', 'staff', encode(digest('REACH-DEMOINVITE', 'sha256'), 'hex'), now() + interval '72 hours', 'aaaaaaaa-0000-0000-0000-000000000001');

insert into public.operator_invitations(id, email, token_hash, invited_by, status, expires_at) values
  ('28282828-0000-0000-0000-000000000001', 'newops@reach.dev', encode(digest('demo-operator-invitation-token', 'sha256'), 'hex'), 'aaaaaaaa-0000-0000-0000-000000000006', 'pending', now() + interval '24 hours');

insert into public.onboarding_sessions(id, user_id, email, onboarding_type, institution_id, intended_role, payload, status, expires_at) values
  ('29292929-0000-0000-0000-000000000001', null, 'pending.institution@example.dev', 'institution', '11111111-1111-1111-1111-111111111111', 'institution', '{"demo": true}'::jsonb, 'pending', now() + interval '48 hours');

-- ---------------------------------------------------------------------------
-- 14. AUDIT + RATE LIMIT
-- ---------------------------------------------------------------------------
insert into public.audit_logs(id, actor_id, institution_id, action, resource_type, resource_id, metadata) values
  ('30303030-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'demo.seeded', 'institution', '11111111-1111-1111-1111-111111111111', '{"demo": true}'::jsonb);

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
