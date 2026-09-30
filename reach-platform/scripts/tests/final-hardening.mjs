import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const auth = read('src/context/AuthContext.tsx');
const api = read('supabase/functions/api/index.ts');
const bmoni = read('supabase/functions/api/bmoni.ts');
const migration = read('supabase/migrations/0008_final_hardening.sql');

const checks = [
  ['backend signup does not require demo mode', auth.includes("if (isBackendConfigured) {\n        const session") && auth.indexOf("if (isBackendConfigured) {") < auth.indexOf("if (!isDemoMode) throw new Error('REACH backend is not configured');")],
  ['AI authorization precedes model call', api.indexOf("const { data: incidentForAi") < api.indexOf('const modelResult = await modelAssist')],
  ['BMONI has no implicit dev endpoint', bmoni.includes("Deno.env.get('BMONI_BASE_URL') || ''") && !bmoni.includes("|| 'https://embedded-dev.bmoni.com'")],
  ['service-role fallback is absent', api.includes('const serviceSupabase = serviceRoleKey ?') && !api.includes('SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY')],
  ['relay UUID cast is guarded', migration.includes("raw_incident_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5]")],
  ['relay device takeover is blocked', migration.includes('Device identity is already registered to another account')],
  ['relay TTL is server capped', migration.includes("expires > now() + interval '30 minutes'")],
  ['BMONI late failures cannot downgrade successful', migration.includes("current_tx_status in ('successful','reversed')")],
  ['single active institutional payment enforced', migration.includes('bmoni_one_active_subscription_payment')],
  ['system health performs database probes', api.includes("supabase.from('profiles').select('id', { head: true, count: 'exact' })")],
];

for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
