/**
 * Exercises the real PWA location state (js/state.js) and how it maps into the outgoing incident
 * payload (js/backend.js buildIncidentPayload).
 *
 * The invariant that matters in the field: coordinates belong to a GPS fix and nothing else. If a
 * citizen taps the GPS row, then changes their mind and picks their registered zone, the report must
 * not ship a "registered" label alongside the abandoned GPS point — a responder would be sent to the
 * wrong place. This checks the state transitions and the payload that reaches the gateway.
 *
 * backend.js runs in a browser, so this provides the smallest environment it needs.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PWA = path.join(HERE, '..', '..', '..', 'reach-citizen-pwa', 'js');

// --- minimal in-memory IndexedDB (backend.js opens it at import) --------------------------
const storeMap = new Map();
const makeStore = (name) => { if (!storeMap.has(name)) storeMap.set(name, new Map()); return storeMap.get(name); };
globalThis.indexedDB = {
  open: () => {
    const r = {};
    queueMicrotask(() => {
      const db = { objectStoreNames: { contains: (n) => storeMap.has(n) }, createObjectStore: (n) => makeStore(n) };
      db.transaction = (n) => {
        const map = makeStore(n);
        const tx = {};
        tx.objectStore = () => ({
          getAll: () => { const q = {}; queueMicrotask(() => { q.result = [...map.values()]; q.onsuccess?.(); }); return q; },
          get: (k) => { const q = {}; queueMicrotask(() => { q.result = map.get(k); q.onsuccess?.(); }); return q; },
          put: (v, k) => { const q = {}; map.set(k ?? v.id, v); queueMicrotask(() => { q.result = k; q.onsuccess?.(); }); return q; },
          delete: (k) => { const q = {}; map.delete(k); queueMicrotask(() => { q.onsuccess?.(); }); return q; },
        });
        tx.abort = () => {};
        queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
        return tx;
      };
      r.result = db;
      r.onsuccess?.();
    });
    return r;
  },
};

// --- localStorage / window / navigator ---------------------------------------------------
const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
};
globalThis.window = { REACH_CONFIG: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon' }, addEventListener: () => {}, setInterval: () => 0 };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

const { appState, setGpsCoordinates, setSelectedLocation } = await import(pathToFileURL(path.join(PWA, 'state.js')).href);
const { buildIncidentPayload } = await import(pathToFileURL(path.join(PWA, 'backend.js')).href);

let pass = 0, fail = 0;
const ck = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  [PASS] ${name}${detail ? '  — ' + detail : ''}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); } };

console.log('\n=== PWA location ===');
{
  // 1. A GPS fix records coordinates, source and accuracy.
  setGpsCoordinates(6.5244, 3.3792, 12);
  const e = appState.emergency;
  ck('gps fix records coordinates', e.latitude === 6.5244 && e.longitude === 3.3792 && e.locationAccuracyM === 12);
  ck('gps fix sets the source to gps', e.locationType === 'gps');
  ck('gps fix labels itself with accuracy', /gps/i.test(e.locationLabel) && /12/.test(e.locationLabel), e.locationLabel);
}
{
  // 2. Switching to a registered zone must drop the abandoned fix.
  setSelectedLocation('registered', 'Zone B — Hostel Block 4');
  const e = appState.emergency;
  ck('selecting a zone clears latitude', e.latitude === null);
  ck('selecting a zone clears longitude', e.longitude === null);
  ck('selecting a zone clears accuracy', e.locationAccuracyM === null);
  ck('selecting a zone keeps the real zone label', e.locationLabel === 'Zone B — Hostel Block 4', e.locationLabel);
}
{
  // 3. The outgoing payload reflects the chosen zone, with no stale coordinates.
  const payload = buildIncidentPayload();
  ck('payload reports the registered source', payload.location_source === 'registered', payload.location_source);
  ck('payload carries no abandoned coordinates', payload.latitude === null && payload.longitude === null);
  ck('payload carries the zone label', payload.location_label === 'Zone B — Hostel Block 4', payload.location_label);
}
{
  // 4. Choosing GPS again ships the coordinates and the gps source.
  setSelectedLocation('gps', 'Current GPS location');
  setGpsCoordinates(6.5244, 3.3792, 8);
  const payload = buildIncidentPayload();
  ck('payload reports the gps source', payload.location_source === 'gps');
  ck('payload ships the fix', payload.latitude === 6.5244 && payload.longitude === 3.3792);
  ck('payload ships the accuracy', payload.location_accuracy_m === 8);
}
{
  // 5. A manual zone is labelled as such and carries no coordinates.
  setSelectedLocation('manual', 'Manual zone');
  const payload = buildIncidentPayload();
  ck('manual zone maps to the manual source', payload.location_source === 'manual');
  ck('manual zone ships no coordinates', payload.latitude === null && payload.longitude === null);
}
{
  // 6. A non-finite fix is never stored as a coordinate.
  setGpsCoordinates(NaN, undefined, 'x');
  const e = appState.emergency;
  ck('a non-finite fix is rejected', e.latitude === null && e.longitude === null && e.locationAccuracyM === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0, `${fail} location assertion(s) failed`);
