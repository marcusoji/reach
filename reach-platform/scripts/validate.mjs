import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
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
  'supabase/migrations/0014_ai_second_opinion.sql',
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
// The PWA is offline-first, so sw.js must precache every module the app imports. A module
// reachable only over the network makes a cold offline start fail with a module-load error.
const sw = readFileSync(join(pwa,'sw.js'),'utf8');
const walkJs = (dir) => readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walkJs(join(dir,e.name)):[join(dir,e.name)]);
const imported = new Set();
for (const file of walkJs(join(pwa,'js')).filter(f=>f.endsWith('.js'))) {
  for (const m of readFileSync(file,'utf8').matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    imported.add('./' + relative(pwa, join(dirname(file), m[1])).split(sep).join('/'));
  }
}
for (const mod of imported) if (!sw.includes(mod)) throw new Error(`Service worker does not precache imported module: ${mod}`);
if (!hardening.includes('revoke all on function public.promote_current_user_to_operator() from authenticated')) throw new Error('Operator privilege RPC is still browser-callable');
if (!hardening.includes('ingest_relay_packet_service')) throw new Error('Trusted relay ingestion function missing');
if (!api.includes('const serviceRoleKey =')) throw new Error('Privileged service path must fail closed');
if (!api.includes("requireService().rpc('ingest_relay_packet_service'")) throw new Error('Relay ingestion is not using trusted service path');
if (!hardening7.includes('provisional incident') || !hardening7.includes('process_bmoni_webhook_event')) throw new Error('0007 production hardening controls missing');
if (!api.includes('x-idempotency-key is required for payment operations')) throw new Error('Financial idempotency requirement missing');
if (!env.includes('VITE_REACH_DEMO_MODE=false')) throw new Error('Explicit demo-mode gate missing');
if (!bmoniApi.includes('AbortController')) throw new Error('BMONI timeout protection missing');
if (!api.includes('const txMatch = path.match')) throw new Error('BMONI payment status route missing');
if (!api.includes('verifyRelayBody(')) throw new Error('Relay verification must use the extracted relay_verify module');
const relayLockdown = readFileSync(join(root,'supabase/migrations/0011_relay_ingest_lockdown.sql'),'utf8');
if (!relayLockdown.includes('revoke all on function public.ingest_relay_packet(jsonb) from authenticated')) throw new Error('Legacy relay ingest RPC is still browser-callable');

// AI second-opinion auditability. The model is a second opinion and must stay auditable:
// its agreement with the engine has to be persistable and readable, or the operator view can
// only show the fused result and the model's contribution is invisible.
const aiOpinion = readFileSync(join(root,'supabase/migrations/0014_ai_second_opinion.sql'),'utf8');
if (!aiOpinion.includes('add column if not exists metadata jsonb')) throw new Error('ai_assessments metadata column missing: model agreement is not persistable');
if (!aiOpinion.includes("p_decision not in ('assist','recommend')")) throw new Error('Assessment RPC must keep rejecting autonomous decisions');
if (!aiOpinion.includes('metadata')) throw new Error('Assessment RPC does not persist metadata');
if (!api.includes("select('id,incident_id,model_name,category,confidence,fp_code,explanation,decision,metadata,created_at')")) throw new Error('GET /ai/assessments must return metadata for the second opinion');
if (!api.includes('model_agreement: finalResult.model_agreement')) throw new Error('Assessment metadata must record model_agreement');
const aiPage = readFileSync(join(root,'src/pages/operator/AiPerformancePage.tsx'),'utf8');
if (aiPage.includes("decision==='auto_push'")) throw new Error('AI performance must not report an auto-push share the engine never produces');
if (!aiPage.includes('model_agreement')) throw new Error('AI performance page must surface the second opinion');
// The assessment endpoint is useless without a caller: the operator must be able to run one.
const reachApi = readFileSync(join(root,'src/lib/reachApi.ts'),'utf8');
if (!reachApi.includes("'/ai/assess'")) throw new Error('No client path runs an AI assessment');
const allIncidents = readFileSync(join(root,'src/pages/operator/AllIncidentsPage.tsx'),'utf8');
if (!allIncidents.includes('assessIncident')) throw new Error('Incidents page does not expose the assessment trigger');

// Evidence ingestion. incident_evidence existed but was never written, so every assessment fused
// an empty set and abstained. The derivation must exist and stay off the client-callable path:
// a client-writable evidence set lets a caller manufacture `corroboration`, which is weighted 0.8.
const evidenceIngest = readFileSync(join(root,'supabase/migrations/0015_evidence_ingestion.sql'),'utf8');
if (!evidenceIngest.includes('ingest_incident_evidence_service')) throw new Error('No path ingests incident evidence: the engine always fuses an empty set');
if (!evidenceIngest.includes('to service_role')) throw new Error('Evidence ingest must be restricted to service_role');
if (!evidenceIngest.includes('from authenticated')) throw new Error('Evidence ingest must not be callable by authenticated clients');
if (!evidenceIngest.includes("'user_report'")) throw new Error('Evidence kind vocabulary must cover the engine EvidenceKind values');
if (!api.includes('deriveEvidenceFromIncident')) throw new Error('The API must derive evidence from an incident when none is supplied');
if (!api.includes("rpc('ingest_incident_evidence_service'")) throw new Error('Derived evidence must be persisted through the ingest RPC');
if (!api.includes('evidence_count: evidence.length')) throw new Error('Assessment metadata must record how much evidence was fused');

// Provider telemetry. "No second opinion" is otherwise indistinguishable from "the model was
// never called": the adapter state is in-memory and /system/health reported only env config.
const telemetry = readFileSync(join(root,'supabase/migrations/0016_ai_provider_telemetry.sql'),'utf8');
if (!telemetry.includes('ai_provider_events')) throw new Error('Provider failures are not recorded, so a dead provider is invisible');
if (!telemetry.includes('enable row level security')) throw new Error('Provider telemetry must have RLS enabled');
if (!api.includes("from('ai_provider_events')")) throw new Error('The API must record provider outcomes');
if (!api.includes("path === '/ai/provider-events'")) throw new Error('Provider telemetry must be readable by an operator');
if (!api.includes('aiLastFailureKind()')) throw new Error('The API must report why a second opinion was missing');
if (!api.includes('aiCircuitSnapshot()')) throw new Error('System health must report the real provider breaker state, not just env config');
const aiProvider = readFileSync(join(root,'supabase/functions/api/ai_provider.ts'),'utf8');
if (!aiProvider.includes('extractLeadingJson')) throw new Error('Provider JSON wrapped in agent chatter must be recoverable');
if (!aiProvider.includes('unparsable_response')) throw new Error('Provider failures must be classified for telemetry');
if (!aiPage.includes('failureExplanation')) throw new Error('AI performance page must explain why a second opinion was missing');

// Evidence capture. 0015 only derived evidence from the incident, so the strong fusion kinds
// (image/audio/sensor/motion) were unreachable. The capture path must exist and must not let a
// client award itself the strong weights or reach another user's upload.
const capture = readFileSync(join(root,'supabase/migrations/0017_evidence_capture.sql'),'utf8');
if (!capture.includes('attach_incident_evidence')) throw new Error('No path attaches captured evidence: the strong evidence kinds are unreachable');
if (!capture.includes("values ('incident-evidence'")) throw new Error('Evidence storage bucket is not declared');
if (!capture.includes('foldername(name))[1] = auth.uid()::text')) throw new Error('Evidence objects must be scoped to the uploader uid prefix');
if (!capture.includes('your own evidence prefix')) throw new Error('The RPC must re-check the storage path prefix, not trust the client');
if (!capture.includes("coalesce(metadata->>'derived'")) throw new Error('Derived ingest must not delete captured evidence');
if (!api.includes("path === '/evidence'")) throw new Error('No API route registers captured evidence');
if (!reachApi.includes('uploadIncidentEvidence')) throw new Error('No client path uploads captured evidence');
if (!allIncidents.includes('attachFile')) throw new Error('Operators cannot attach captured evidence');
// A capture-kind confidence must be server-derived: the client sends no confidence field.
if (/attach_incident_evidence[\s\S]{0,400}p_confidence/.test(capture)) throw new Error('Capture confidence must not be client-supplied');

// Static checks above cannot catch SQL that fails to parse or run. Execute the migrations
// against a throwaway Postgres+PostGIS when one is reachable (see scripts/tests/migrations.mjs).
const migrations = join(dirname(fileURLToPath(import.meta.url)), 'tests', 'migrations.mjs');
const migrationRun = execFileSync(process.execPath, [migrations], { stdio: 'pipe', encoding: 'utf8' });
process.stdout.write(migrationRun);

console.log(`REACH validation passed: ${jsFiles.length} PWA JavaScript files syntax-checked and production hardening controls found.`);
