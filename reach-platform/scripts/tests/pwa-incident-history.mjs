/**
 * Exercises the real PWA incident-history path in js/backend.js.
 *
 * `/incidents` is RLS-scoped, so the list can legitimately contain rows the citizen cannot see the
 * provenance of. The screen must show only this user's own reports, and must still show the last
 * known history when there is no connection. This drives the real module with stubbed
 * window/localStorage/navigator, not a copy of the logic.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PWA = path.join(HERE, '..', '..', '..', 'reach-citizen-pwa', 'js');

// --- minimal browser surface backend.js touches at import / call time ---
const storage = new Map();
globalThis.window = { REACH_CONFIG: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon' } };
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true, writable: true });
globalThis.indexedDB = { open: () => ({}) };

const mod = await import(pathToFileURL(path.join(PWA, 'backend.js')).href);
const { filterOwnIncidents, getIncidentHistory } = mod;

let pass = 0, fail = 0;
const ck = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  [PASS] ${name}${detail ? '  — ' + detail : ''}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); } };

const USER = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER = 'bbbbbbbb-5555-6666-7777-888888888888';

console.log('\n=== PWA incident history ===');
{
  // 1. A signed-in citizen sees only their own reports.
  storage.set('reach_pwa_session', JSON.stringify({ access_token: 't', user: { id: USER } }));
  const rows = [
    { id: 'i1', reporter_id: USER, code: 'REACH-1', status: 'resolved' },
    { id: 'i2', reporter_id: OTHER, code: 'REACH-2', status: 'open' },
    { id: 'i3', reporter_id: USER, code: 'REACH-3', status: 'responding' },
  ];
  const mine = filterOwnIncidents(rows);
  ck('own reports kept', mine.length === 2 && mine.every((r) => r.reporter_id === USER));
  ck("another citizen's report hidden", !mine.some((r) => r.id === 'i2'));
}
{
  // 2. Offline with a warm cache: history is served from localStorage, not fabricated.
  storage.set('reach_pwa_session', JSON.stringify({ access_token: 't', user: { id: USER } }));
  storage.set('reach_incident_history', JSON.stringify([{ id: 'i1', reporter_id: USER, code: 'REACH-1' }]));
  const rows = await getIncidentHistory();
  ck('offline history falls back to cache', rows.length === 1 && rows[0].id === 'i1');
}
{
  // 3. No session and no cache: empty, never invented.
  storage.delete('reach_pwa_session');
  storage.delete('reach_incident_history');
  const rows = await getIncidentHistory();
  ck('no session yields empty history', Array.isArray(rows) && rows.length === 0);
}
{
  // 4. A row with no reporter_id (older shape) is not silently dropped.
  storage.set('reach_pwa_session', JSON.stringify({ access_token: 't', user: { id: USER } }));
  const mine = filterOwnIncidents([{ id: 'legacy', code: 'REACH-0' }]);
  ck('legacy row without reporter_id kept', mine.length === 1 && mine[0].id === 'legacy');
}

console.log(`\nTOTAL: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
