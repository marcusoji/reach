import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url).pathname;
const pwa = join(root, '..', 'reach-citizen-pwa');
const required = [
  'supabase/migrations/0001_reach_mvp.sql',
  'supabase/migrations/0002_security_and_workflows.sql',
  'supabase/migrations/0005_bmoni_institution_billing.sql',
  'supabase/migrations/0006_production_hardening.sql',
  'supabase/migrations/0007_relay_bmoni_atomic_hardening.sql',
  'supabase/functions/api/index.ts',
  'src/lib/reachApi.ts',
  'src/context/AuthContext.tsx',
  '../reach-citizen-pwa/js/backend.js',
  '../reach-citizen-pwa/js/app.js',
  '../reach-citizen-pwa/js/state.js',
  '../reach-citizen-pwa/js/navigation.js',
];
for (const file of required) {
  if (!statSync(join(root, file), { throwIfNoEntry:false })) throw new Error(`Missing required file: ${file}`);
}
const migration = readFileSync(join(root,'supabase/migrations/0002_security_and_workflows.sql'),'utf8');
const hardening = readFileSync(join(root,'supabase/migrations/0006_production_hardening.sql'),'utf8');
const hardening7 = readFileSync(join(root,'supabase/migrations/0007_relay_bmoni_atomic_hardening.sql'),'utf8');
const bmoniApi = readFileSync(join(root,'supabase/functions/api/bmoni.ts'),'utf8');
const api = readFileSync(join(root,'supabase/functions/api/index.ts'),'utf8');
const env = readFileSync(join(root,'.env.example'),'utf8');
const requiredSql = [
  'handle_new_user', 'create_incident_for_current_user', 'transition_incident', 'assign_incident',
  'ingest_relay_packet', 'redeem_staff_invite', 'promote_current_user_to_operator',
  'check_reach_rate_limit', 'supabase_realtime', 'queue_incident_notifications'
];
for (const token of requiredSql) if (!migration.includes(token)) throw new Error(`Migration missing security/workflow feature: ${token}`);
const jsFiles = readdirSync(join(pwa,'js')).filter(f=>f.endsWith('.js'));
for (const file of jsFiles) execFileSync(process.execPath,['--check',join(pwa,'js',file)],{stdio:'pipe'});
const pwaHtml = readFileSync(join(pwa,'index.html'),'utf8');
if (/value="(?:Amaka Okafor|amaka@example.com|reachdemo123)"/i.test(pwaHtml)) throw new Error('PWA contains demo credentials as form values');
if (!readFileSync(join(pwa,'js','backend.js'),'utf8').includes('indexedDB')) throw new Error('Offline queue implementation missing');
if (!hardening.includes('revoke all on function public.promote_current_user_to_operator() from authenticated')) throw new Error('Operator privilege RPC is still browser-callable');
if (!hardening.includes('ingest_relay_packet_service')) throw new Error('Trusted relay ingestion function missing');
if (!api.includes('const serviceRoleKey =')) throw new Error('Privileged service path must fail closed');
if (!api.includes("requireService().rpc('ingest_relay_packet_service'")) throw new Error('Relay ingestion is not using trusted service path');
if (!hardening7.includes('provisional incident') || !hardening7.includes('process_bmoni_webhook_event')) throw new Error('0007 production hardening controls missing');
if (!api.includes('x-idempotency-key is required for payment operations')) throw new Error('Financial idempotency requirement missing');
if (!env.includes('VITE_REACH_DEMO_MODE=false')) throw new Error('Explicit demo-mode gate missing');
if (!bmoniApi.includes('AbortController')) throw new Error('BMONI timeout protection missing');
if (!api.includes('const txMatch = path.match')) throw new Error('BMONI payment status route missing');

// Static checks above cannot catch SQL that fails to parse or run. Execute the migrations
// against a throwaway Postgres+PostGIS when one is reachable (see scripts/tests/migrations.mjs).
const migrations = join(dirname(fileURLToPath(import.meta.url)), 'tests', 'migrations.mjs');
const migrationRun = execFileSync(process.execPath, [migrations], { stdio: 'pipe', encoding: 'utf8' });
process.stdout.write(migrationRun);

console.log(`REACH validation passed: ${jsFiles.length} PWA JavaScript files syntax-checked and production hardening controls found.`);
