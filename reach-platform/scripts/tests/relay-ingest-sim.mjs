#!/usr/bin/env node
/**
 * Relay ingest + gateway dedup simulation against a real Postgres+PostGIS.
 *
 * Exercises two concurrency contracts the relay design depends on:
 *   1. ingest_relay_packet_service() must be idempotent under concurrent duplicate
 *      deliveries (same packet_key arriving over BLE + Wi-Fi + PWA at once) — one
 *      incident, one relay_packets row, no lost updates.
 *   2. The gateway dedup path in index.ts (SELECT then INSERT/UPDATE) must not lose
 *      deliveries or throw when several transports record the same packet at once.
 *
 * Requires Postgres reachable via PGHOST/PGPORT/PGUSER/PGPASSWORD (or
 * REACH_TEST_DATABASE_URL). Skips cleanly when unavailable.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'supabase', 'migrations');
const bootstrap = join(here, 'supabase-bootstrap.sql');
const dbName = 'reach_relay_sim';

if (!spawnSync('psql', ['--version'], { encoding: 'utf8' }).stdout) {
  console.log('SKIP - relay ingest simulation: psql client not installed.');
  process.exit(0);
}
const base = process.env.REACH_TEST_DATABASE_URL ? [process.env.REACH_TEST_DATABASE_URL] : ['-h', process.env.PGHOST || '127.0.0.1', '-p', process.env.PGPORT || '5432', '-U', process.env.PGUSER || 'postgres'];
const env = { ...process.env };
const psql = (args, opts = {}) => spawnSync('psql', [...base, ...args], { encoding: 'utf8', env, ...opts });

if (psql(['-d', 'postgres', '-tAc', 'select 1']).status !== 0) {
  console.log('SKIP - relay ingest simulation: no Postgres server reachable.');
  process.exit(0);
}
psql(['-d', 'postgres', '-c', `drop database if exists ${dbName}`]);
if (psql(['-d', 'postgres', '-c', `create database ${dbName}`]).status !== 0) {
  console.error('FAIL - could not create simulation database.');
  process.exit(1);
}
// Mirror Supabase's default search_path so schema-less extension references (PostGIS geography,
// pgcrypto) resolve the way they do in production.
psql(['-d', 'postgres', '-c', `alter database ${dbName} set search_path = "$user", public, extensions`]);
const run = (file) => psql(['-d', dbName, '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', file]);
if (run(bootstrap).status !== 0) { console.error('FAIL - bootstrap'); process.exit(1); }
for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
  const r = run(join(migrationsDir, f));
  if (r.status !== 0) { console.error(`FAIL - ${f}: ${(r.stderr || '').split('\n').find((l) => /ERROR/i.test(l))}`); process.exit(1); }
}

let pass = 0, fail = 0;
const ck = (name, ok, detail) => { console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`); ok ? pass++ : fail++; };
const q = (sql) => psql(['-d', dbName, '-tAc', sql]).stdout.trim();

// ---------------------------------------------------------------- seed
const inst = randomUUID();
const userSource = randomUUID();
const userActor = randomUUID();
const pk = 'pk-' + 'A'.repeat(60);
q(`insert into auth.users(id,email) values ('${userSource}','s@x'),('${userActor}','a@x');`);
q(`insert into public.institutions(id,name) values ('${inst}','Sim Inst');`);
q(`insert into public.profiles(id,role,institution_id) values ('${userSource}','citizen','${inst}'),('${userActor}','citizen','${inst}');`);
q(`insert into public.device_registrations(user_id,device_id,public_key,status) values ('${userSource}','device-source-0001','${pk}','active');`);

const packetKey = 'pkt-' + randomUUID();
const packetHash = 'h'.repeat(64);
const expires = new Date(Date.now() + 20 * 60 * 1000).toISOString();
const packet = {
  v: 2, packet_key: packetKey, packet_hash: packetHash, source_device_id: 'device-source-0001',
  source_public_key: pk, hop_count: 1, max_hops: 6, ttl_expires_at: expires,
  source_signature: 'sig', source_signed_payload: 'payload', transport: 'ble',
  minimal_payload: { category: 'fire', priority: 'high', title: 'Sim fire', description: 'sim', location_source: 'gps', latitude: 6.5, longitude: 3.3, location_accuracy_m: 12, created_at: Date.now() },
};
const packetJson = JSON.stringify(packet).replace(/'/g, "''");

console.log('\n=== A. Concurrent duplicate delivery through ingest_relay_packet_service (multi-path) ===');
{
  const N = 16;
  const results = await Promise.all(Array.from({ length: N }, () =>
    new Promise((resolve) => {
      const r = psql(['-d', dbName, '-tAc', `select id from public.ingest_relay_packet_service('${packetJson}'::jsonb,'${userActor}'::uuid)`]);
      resolve({ status: r.status, out: r.stdout.trim(), err: r.stderr });
    })));
  const errors = results.filter((r) => r.status !== 0);
  ck(`all ${N} concurrent deliveries succeed`, errors.length === 0, errors.length ? errors[0].err.split('\n').find((l) => /ERROR/i.test(l)) : '');
  const ids = new Set(results.map((r) => r.out));
  ck('all deliveries resolve to the same relay_packets row', ids.size === 1, `distinct ids=${ids.size}`);
  const packets = q(`select count(*) from public.relay_packets where packet_key='${packetKey}'`);
  ck('exactly one relay_packets row exists', packets === '1', `count=${packets}`);
  const incidents = q(`select count(*) from public.incidents where idempotency_key='${packetKey}'`);
  ck('exactly one incident was reconstructed', incidents === '1', `count=${incidents}`);
}

console.log('\n=== B. Atomic gateway dedup RPC under concurrent multi-path arrival ===');
{
  const N = 16;
  const results = await Promise.all(Array.from({ length: N }, () =>
    new Promise((resolve) => {
      const r = psql(['-d', dbName, '-tAc', `select public.record_relay_ingest_dedup('${packetKey}','${packetHash}','${inst}')`]);
      resolve({ status: r.status, err: r.stderr });
    })));
  const failed = results.filter((r) => r.status !== 0);
  ck(`all ${N} concurrent dedup records succeed`, failed.length === 0,
    failed.length ? failed[0].err.split('\n').find((l) => /ERROR/i.test(l)) : '');
  const count = q(`select count(*) from public.relay_ingest_dedup where packet_key='${packetKey}' and packet_hash='${packetHash}'`);
  ck('exactly one dedup row exists', count === '1', `count=${count}`);
  const received = q(`select receive_count from public.relay_ingest_dedup where packet_key='${packetKey}' and packet_hash='${packetHash}'`);
  ck(`receive_count accounts for every arrival (expected ${N})`, received === String(N), `receive_count=${received}`);
}

console.log('\n=== C. Regression guard: the handler no longer reads-then-writes dedup ===');
{
  // The old pattern (SELECT receive_count, then INSERT/UPDATE) lost updates and raised
  // duplicate-key errors under concurrency. Fail if it ever comes back.
  const indexTs = readFileSync(join(here, '..', '..', 'supabase', 'functions', 'api', 'index.ts'), 'utf8');
  ck('handler calls the atomic dedup RPC', indexTs.includes("rpc('record_relay_ingest_dedup'"));
  ck('handler no longer selects receive_count directly', !/from\('relay_ingest_dedup'\)[\s\S]{0,120}select\('receive_count'\)/.test(indexTs));
}

console.log('\n=== D. Cross-institution packet-key reuse (multi-tenant isolation) ===');
{
  // A packet_key is client-supplied and globally unique. If institution B replays a packet_key
  // that institution A already ingested, the old existing-row short-circuit returned A's
  // relay_packets row to B (cross-tenant disclosure) and silently dropped B's own incident.
  // The fixed function scopes idempotency to the source device and rejects a foreign key.
  const instB = randomUUID();
  const userB = randomUUID();
  const actorB = randomUUID();
  const pkB = 'pk-' + 'B'.repeat(60);
  q(`insert into auth.users(id,email) values ('${userB}','b@x'),('${actorB}','ba@x');`);
  q(`insert into public.institutions(id,name) values ('${instB}','Sim Inst B');`);
  q(`insert into public.profiles(id,role,institution_id) values ('${userB}','citizen','${instB}'),('${actorB}','citizen','${instB}');`);
  q(`insert into public.device_registrations(user_id,device_id,public_key,status) values ('${userB}','device-source-B-01','${pkB}','active');`);
  const pB = { ...packet, source_device_id: 'device-source-B-01', source_public_key: pkB, minimal_payload: { category: 'medical', priority: 'critical', title: 'B medical', description: 'b' } };
  const pBjson = JSON.stringify(pB).replace(/'/g, "''");
  const before = q(`select count(*) from public.incidents where institution_id='${instB}'`);
  const r = psql(['-d', dbName, '-tAc', `select source_device_id from public.ingest_relay_packet_service('${pBjson}'::jsonb,'${actorB}'::uuid)`]);
  const returnedSource = r.stdout.trim();
  const after = q(`select count(*) from public.incidents where institution_id='${instB}'`);
  ck('institution B is not handed institution A\'s packet row',
    r.status !== 0 && returnedSource !== 'device-source-0001', `status=${r.status} returned source_device_id=${returnedSource}`);
  ck('the foreign packet key is rejected explicitly',
    /Relay packet key already used by another source device/i.test(r.stderr), r.stderr.split('\n').find((l) => /ERROR/i.test(l)) || '');
  ck('institution B creates no incident from a foreign packet key', after === before, `incidents before=${before} after=${after}`);
}

console.log('\n=== E. Relay node identity must be registered before its envelope is accepted ===');
{
  // The native relay node signs every forwarded packet with its own identity as the relay hop.
  // ingest_relay_packet_service() rejects a relay whose (relay_device_id, relay_public_key) is not
  // an active device_registrations row. This pins the exact contract the Android node's
  // /devices/register call satisfies: without it every forwarded packet is refused while the
  // radios and ACKs look healthy.
  const userRelay = randomUUID();
  const pkRelay = 'pk-' + 'R'.repeat(60);
  q(`insert into auth.users(id,email) values ('${userRelay}','r@x');`);
  q(`insert into public.profiles(id,role,institution_id) values ('${userRelay}','citizen','${inst}');`);
  const relayed = { ...packet, relay_device_id: 'device-relay-0001', relay_public_key: pkRelay };
  const relayedJson = JSON.stringify(relayed).replace(/'/g, "''");

  const before = psql(['-d', dbName, '-tAc', `select public.ingest_relay_packet_service('${relayedJson}'::jsonb,'${userActor}'::uuid)`]);
  ck('an unregistered relay identity is refused',
    /Unregistered or revoked relay device/i.test(before.stderr),
    before.stderr.split('\n').find((l) => /ERROR/i.test(l)) || '');

  const reg = psql(['-d', dbName, '-tAc',
    `do $$ begin perform set_config('request.jwt.claim.sub','${userRelay}',false); perform public.register_my_relay_device('device-relay-0001','${pkRelay}','android','{}'::jsonb); end $$;`]);
  ck('register_my_relay_device records the node as active', reg.status === 0 && q(`select status from public.device_registrations where device_id='device-relay-0001'`) === 'active',
    reg.stderr.split('\n').find((l) => /ERROR/i.test(l)) || '');

  const after = psql(['-d', dbName, '-tAc', `select public.ingest_relay_packet_service('${relayedJson}'::jsonb,'${userActor}'::uuid)`]);
  ck('the same relay envelope is accepted once registered', after.status === 0,
    after.stderr.split('\n').find((l) => /ERROR/i.test(l)) || '');
}

console.log('\n' + '='.repeat(64));
console.log(`TOTAL: ${pass}/${pass + fail} passed`);
console.log('='.repeat(64));
process.exit(fail ? 1 : 0);
