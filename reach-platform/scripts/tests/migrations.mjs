#!/usr/bin/env node
// Executes every Supabase migration against a throwaway Postgres+PostGIS database,
// one transaction per file -- mirroring how Supabase applies migrations. Static text
// checks in validate.mjs cannot catch SQL that fails to parse or run; this does.
//
// Requires a Postgres server reachable via REACH_TEST_DATABASE_URL or PGHOST/PGPORT/
// PGUSER/PGPASSWORD, plus the `psql` client. If PostGIS is unavailable the script
// skips (exit 0) with a notice, so environments without the extension are not blocked.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'supabase', 'migrations');
const bootstrap = join(here, 'supabase-bootstrap.sql');
const dbName = 'reach_migration_validation';

const baseArgs = [];
if (process.env.REACH_TEST_DATABASE_URL) {
  baseArgs.push(process.env.REACH_TEST_DATABASE_URL);
} else {
  baseArgs.push('-h', process.env.PGHOST || '127.0.0.1');
  baseArgs.push('-p', process.env.PGPORT || '5432');
  baseArgs.push('-U', process.env.PGUSER || 'postgres');
  if (process.env.PGPASSWORD) baseArgs.push('-w');
}
const env = { ...process.env };
const psql = (args, opts = {}) =>
  spawnSync('psql', [...baseArgs, ...args], { encoding: 'utf8', env, ...opts });

if (!spawnSync('psql', ['--version'], { encoding: 'utf8' }).stdout) {
  console.log('SKIP - migration execution: psql client not installed.');
  process.exit(0);
}

const server = psql(['-d', 'postgres', '-tAc', 'select 1']);
if (server.status !== 0) {
  console.log('SKIP - migration execution: no Postgres server reachable.');
  console.log(`       ${(server.stderr || server.error?.message || '').trim().split('\n')[0]}`);
  process.exit(0);
}

const hasPostgis = psql(['-d', 'postgres', '-tAc', "select 1 from pg_available_extensions where name='postgis'"]).stdout.trim();
if (hasPostgis !== '1') {
  console.log('SKIP - migration execution: PostGIS extension is not available on the server.');
  process.exit(0);
}

// Fresh database for a deterministic run.
psql(['-d', 'postgres', '-c', `drop database if exists ${dbName}`]);
const created = psql(['-d', 'postgres', '-c', `create database ${dbName}`]);
if (created.status !== 0) {
  console.error('FAIL - migration execution: could not create test database.');
  console.error(created.stderr.trim());
  process.exit(1);
}

const run = (file) =>
  psql(['-d', dbName, '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', file]);

const boot = run(bootstrap);
if (boot.status !== 0) {
  console.error('FAIL - migration execution: Supabase bootstrap fixture failed.');
  console.error(boot.stderr.trim());
  process.exit(1);
}

const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
const failures = [];
for (const file of files) {
  const res = run(join(migrationsDir, file));
  if (res.status !== 0) {
    const err = (res.stderr || '').split('\n').find((l) => /ERROR/i.test(l)) || res.stderr.trim();
    failures.push(`${file}: ${err.trim()}`);
  }
}

if (failures.length) {
  console.error(`FAIL - migration execution: ${failures.length} of ${files.length} migration(s) did not apply.`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

// The hardening migrations must leave privileged SECURITY DEFINER RPCs unreachable by
// unauthenticated clients. Granting execute to `authenticated` is intended (the app calls
// these as a signed-in user); what must never remain is PUBLIC (`=`) or `anon` access.
const privileged = ['create_staff_invite', 'redeem_staff_invite', 'create_incident_for_current_user',
  'transition_incident', 'assign_incident', 'ingest_relay_packet', 'promote_current_user_to_operator',
  'ingest_incident_evidence_service', 'store_ai_assessment_for_incident'];
const privCheck = psql(['-d', dbName, '-tAc',
  `select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.prosecdef and p.proname = any(array[${privileged.map((p) => `'${p}'`).join(',')}])
   and (p.proacl is null or exists (select 1 from unnest(p.proacl) a where a::text ~ '^(anon|public)?='))`]);
const exposed = privCheck.stdout.trim().split('\n').filter(Boolean);
if (exposed.length) {
  console.error(`FAIL - privileged RPCs remain callable by anon/PUBLIC: ${exposed.join(', ')}`);
  process.exit(1);
}

// The legacy relay ingest RPC (0002/0003) writes relay_packets without verifying the device
// registration, the packet fingerprint or any signature — those checks live only in the Edge
// Function and ingest_relay_packet_service(). If `authenticated` can still execute it, a
// signed-in client can forge relay packets straight through PostgREST, bypassing verification.
const legacyRelay = psql(['-d', dbName, '-tAc',
  `select coalesce(array_to_string(p.proacl, ','), '') from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='ingest_relay_packet'`]);
const acl = legacyRelay.stdout.trim();
if (!acl) {
  console.error('FAIL - ingest_relay_packet not found; expected it to exist but be locked down.');
  process.exit(1);
}
if (/(^|,)(=?authenticated|anon|public)=/.test(acl) || /(^|,)=/.test(acl)) {
  console.error(`FAIL - legacy ingest_relay_packet is still client-callable (acl: ${acl})`);
  process.exit(1);
}
if (!/service_role=/.test(acl)) {
  console.error(`FAIL - legacy ingest_relay_packet is not restricted to service_role (acl: ${acl})`);
  process.exit(1);
}

const tableCount = psql(['-d', dbName, '-tAc',
  `select count(*) from pg_tables where schemaname='public'`]).stdout.trim();
// Extension-owned tables (e.g. PostGIS spatial_ref_sys) are not part of the REACH schema.
const rlsOff = psql(['-d', dbName, '-tAc',
  `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='r' and not c.relrowsecurity
   and not exists (select 1 from pg_depend d where d.objid=c.oid and d.deptype='e')`]).stdout.trim();

console.log(`PASS - migration execution: ${files.length} migrations applied transactionally (${tableCount} tables).`);
if (rlsOff) {
  console.error(`FAIL - row level security disabled on: ${rlsOff.split('\n').join(', ')}`);
  process.exit(1);
}
console.log('PASS - row level security enabled on every public table; privileged RPCs are not anon-callable.');

// Tenant-isolation suite (tests/rls_tenant_isolation.sql). It asserts, as the `authenticated`
// role, that RLS actually isolates institutions and that the privilege/audit protections hold.
// Running it here means a policy regression fails CI alongside the migration that caused it.
const rlsSuite = join(here, '..', '..', '..', 'tests', 'rls_tenant_isolation.sql');
const rls = psql(['-d', dbName, '-v', 'ON_ERROR_STOP=1', '-f', rlsSuite]);
if (rls.status !== 0) {
  const err = (rls.stderr || '').split('\n').find((l) => /ERROR/i.test(l)) || rls.stderr.trim();
  console.error('FAIL - tenant isolation suite failed.');
  console.error(`  ${err.trim()}`);
  process.exit(1);
}
const passed = (rls.stdout.match(/^PASS \d+/gm) || []).length;
console.log(`PASS - tenant isolation suite: ${passed} assertions held (role escalation, cross-institution reads/writes, audit immutability, anon access).`);

// BMONI webhook end-to-end (tests/bmoni_webhook_flow.sql). Exercises the real
// process_bmoni_webhook_event RPC the Edge Function calls, against the migrated schema, so a
// change to either side that breaks the sandbox -> payment/subscription path fails here.
const bmoniSuite = join(here, '..', '..', '..', 'tests', 'bmoni_webhook_flow.sql');
const bmoni = psql(['-d', dbName, '-v', 'ON_ERROR_STOP=1', '-f', bmoniSuite]);
if (bmoni.status !== 0) {
  const err = (bmoni.stderr || '').split('\n').find((l) => /ERROR/i.test(l)) || bmoni.stderr.trim();
  console.error('FAIL - BMONI webhook flow suite failed.');
  console.error(`  ${err.trim()}`);
  process.exit(1);
}
const bmoniPassed = (bmoni.stdout.match(/^PASS \d+/gm) || []).length;
console.log(`PASS - BMONI webhook flow: ${bmoniPassed} assertions held (success -> paid/active, duplicate ignored, reversal -> cancelled/past_due, unknown proposal rejected).`);

// RPC variable-shadowing suite (tests/rpc_variable_shadowing.sql). A PL/pgSQL variable named
// after a reserved keyword (current_role) silently never binds, so a guard like
// `current_role <> 'citizen'` compares the database role instead and always fires. That bug
// made institution signup 500 and broke staff-invite redemption. This exercises both RPCs.
const shadowSuite = join(here, '..', '..', '..', 'tests', 'rpc_variable_shadowing.sql');
const shadow = psql(['-d', dbName, '-v', 'ON_ERROR_STOP=1', '-f', shadowSuite]);
if (shadow.status !== 0) {
  const err = (shadow.stderr || '').split('\n').find((l) => /ERROR/i.test(l)) || shadow.stderr.trim();
  console.error('FAIL - RPC variable-shadowing suite failed.');
  console.error(`  ${err.trim()}`);
  process.exit(1);
}
const shadowPassed = (shadow.stdout.match(/^PASS \d+/gm) || []).length;
console.log(`PASS - RPC variable-shadowing suite: ${shadowPassed} assertions held (citizen creates institution, invite redemption, single-use invites).`);

// Citizen institution-join suite (tests/citizen_institution_join.sql). Migration 0022 lets a
// citizen join an existing estate with a join code so their incidents carry the estate's
// institution_id (previously they were NULL and invisible to the desk). This exercises the
// RPC end to end and pins the abuse cases: single-use, no tenant hop, no role escalation,
// no cross-flavour redemption, tenant-scoped listing/revoke.
const joinSuite = join(here, '..', '..', '..', 'tests', 'citizen_institution_join.sql');
const joinRun = psql(['-d', dbName, '-v', 'ON_ERROR_STOP=1', '-f', joinSuite]);
if (joinRun.status !== 0) {
  const err = (joinRun.stderr || '').split('\n').find((l) => /ERROR/i.test(l)) || joinRun.stderr.trim();
  console.error('FAIL - citizen institution-join suite failed.');
  console.error(`  ${err.trim()}`);
  process.exit(1);
}
const joinPassed = (joinRun.stdout.match(/^PASS \d+/gm) || []).length;
console.log(`PASS - citizen institution-join suite: ${joinPassed} assertions held (join code links a citizen, single-use, no tenant hop, no role escalation).`);
