-- REACH — clear all data (destructive)
--
-- Deletes every REACH data record from every data table while leaving the schema,
-- migrations, RLS policies, functions and the two canonical `ai_model_registry` rows
-- (migration 0004) untouched. After this the database is empty: no institutions, no
-- users, no incidents.
--
-- Run it in the Supabase SQL editor (Dashboard → SQL editor → paste → Run) or with psql
-- against the project database. It runs as the connection owner and bypasses RLS on
-- purpose; it is a maintenance script, never something the app calls.
--
--   * This is destructive and irreversible. Take a backup first.
--   * It is safe to re-run (deletes are idempotent).
--
-- To load demo/test data afterwards, run scripts/seed-demo-data.sql.

set search_path = public, extensions;
-- The profiles guard trigger reverts role/institution changes unless this is on.
select set_config('reach.allow_privilege_change', 'on', false);

begin;

do $$
begin
  if to_regclass('auth.users') is null then
    raise exception 'auth.users not found — run this against a Supabase project database';
  end if;
end $$;

-- FK-safe order: children before parents. `delete from auth.users` cascades the
-- public.profiles rows via the profiles.id → auth.users.id foreign key.
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
-- Keep the two canonical rows from migration 0004; remove any demo rows.
delete from public.ai_model_registry where metadata->>'demo' = 'true';
delete from public.profiles;
delete from public.zones;
delete from public.institutions;
delete from auth.users;

commit;

-- Summary: every data table should report 0 rows (ai_model_registry may keep 2).
select c.relname as table_name,
       (xpath('/row/c/text()', query_to_xml(
         format('select count(*) as c from public.%I', c.relname), false, true, '')))[1]::text::int as rows
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;
