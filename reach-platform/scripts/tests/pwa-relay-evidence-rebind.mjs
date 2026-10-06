/**
 * Closes the "relay-path evidence never rebinds" gap.
 *
 * A photo captured on the review screen is held in IndexedDB and bound to the report's
 * idempotency key, because the incident does not exist yet on a relay-delivered report. This
 * exercises the two ways it is repointed onto the real incident:
 *
 *  - the sender uploads the queued relay packet itself and reads the created incident id out of
 *    the ingest response (or the packet lookup), then rebinds before flushing the capture; and
 *  - the packet was delivered by another node/alert file, so a later sync reconciles the still
 *    report-keyed capture by asking the gateway which relay packets have become incidents.
 *
 * backend.js and evidence.js run in a browser, so this provides the smallest environment they
 * need plus a fetch stub at the network boundary.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PWA = path.join(HERE, '..', '..', '..', 'reach-citizen-pwa', 'js');

// --- minimal in-memory IndexedDB ---------------------------------------------------------
const microtask = () => new Promise((r) => queueMicrotask(r));
function makeIndexedDB() {
  const databases = new Map();
  const storeMap = (dbName, storeName) => {
    if (!databases.has(dbName)) databases.set(dbName, { stores: new Map() });
    const db = databases.get(dbName);
    if (!db.stores.has(storeName)) db.stores.set(storeName, new Map());
    return db.stores.get(storeName);
  };
  const open = (name) => {
    const r = {};
    queueMicrotask(() => {
      if (!databases.has(name)) databases.set(name, { stores: new Map() });
      const db = { name, objectStoreNames: { contains: (n) => databases.get(name).stores.has(n) } };
      db.createObjectStore = (n) => storeMap(name, n);
      db.transaction = (storeName) => {
        const map = storeMap(name, storeName);
        const tx = {};
        const store = {
          getAll: () => { const q = {}; queueMicrotask(() => { q.result = [...map.values()]; q.onsuccess?.(); }); return q; },
          get: (k) => { const q = {}; queueMicrotask(() => { q.result = map.get(k); q.onsuccess?.(); }); return q; },
          put: (v, k) => { const q = {}; const key = k !== undefined ? k : v.id; map.set(key, v); queueMicrotask(() => { q.result = key; q.onsuccess?.(); }); return q; },
          delete: (k) => { const q = {}; map.delete(k); queueMicrotask(() => { q.result = undefined; q.onsuccess?.(); }); return q; },
        };
        tx.objectStore = () => store;
        tx.abort = () => {};
        queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
        return tx;
      };
      r.result = db;
      r.onsuccess?.();
    });
    return r;
  };
  return { open, dump: (d, s) => [...storeMap(d, s).values()], clear: (d, s) => storeMap(d, s).clear() };
}

const idb = makeIndexedDB();
globalThis.indexedDB = idb;

const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
};
globalThis.window = { REACH_CONFIG: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon' }, addEventListener: () => {}, setInterval: () => 0 };
const nav = { onLine: true };
Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });

// --- fetch stub --------------------------------------------------------------------------
const uploads = [];
const attaches = [];
const relayPosts = [];
// packet key -> incident id the gateway "reconstructed"; absent means "not ingested yet".
const gatewayIncidents = new Map();
let lookupStatus = 404; // before ingest, the packet lookup 404s like a foreign key under RLS
globalThis.fetch = async (url, opts = {}) => {
  const target = String(url);
  if (target.includes('/storage/v1/object/')) {
    uploads.push({ path: target.split('/storage/v1/object/incident-evidence/')[1] });
    return { ok: true, status: 200, json: async () => ({ Key: 'incident-evidence/x' }) };
  }
  if (target.endsWith('/evidence')) {
    const body = JSON.parse(opts.body);
    attaches.push(body);
    return { ok: true, status: 201, json: async () => ({ data: { id: 'ev-1', ...body } }) };
  }
  if (target.includes('/relay/packets/')) {
    const key = decodeURIComponent(target.split('/relay/packets/')[1]);
    if (lookupStatus >= 400 || !gatewayIncidents.has(key)) return { ok: false, status: lookupStatus, json: async () => ({ error: 'Packet not found' }) };
    return { ok: true, status: 200, json: async () => ({ data: { packet_key: key, incident_id: gatewayIncidents.get(key) } }) };
  }
  if (target.includes('/relay/packets')) {
    const body = JSON.parse(opts.body);
    relayPosts.push(body);
    const incidentId = gatewayIncidents.get(body.packet_key) || `inc-${body.packet_key}`;
    gatewayIncidents.set(body.packet_key, incidentId);
    return { ok: true, status: 201, json: async () => ({ data: { packet_key: body.packet_key, incident_id: incidentId } }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const backend = await import(pathToFileURL(path.join(PWA, 'backend.js')).href);
const evidence = await import(pathToFileURL(path.join(PWA, 'evidence.js')).href);
const { appState } = await import(pathToFileURL(path.join(PWA, 'state.js')).href);

let pass = 0, fail = 0;
const ck = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  [PASS] ${name}${detail ? '  — ' + detail : ''}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); } };

const EVIDENCE = 'evidence-queue';
const RELAY = 'relay-queue';
const evRows = () => idb.dump('reach-offline', EVIDENCE);
const relayRows = () => idb.dump('reach-offline', RELAY);
const setSession = () => ls.set('reach_pwa_session', JSON.stringify({ access_token: 't', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'aaaaaaaa-0000-0000-0000-000000000001' } }));
const blob = (t, type) => new Blob([t], { type });

async function offlineReportWithCapture() {
  nav.onLine = false;
  appState.relayEnabled = true;
  Object.assign(appState.emergency, { category: 'fire', categoryLabel: 'Fire', priority: 'high', title: 'Fire', description: 'Smoke', locationLabel: 'Zone A', locationType: 'manual', locationAccuracyM: 20, latitude: 6.2, longitude: 6.7 });
  // A photo captured before send: held unbound until the report is queued.
  await evidence.queueEvidenceCapture({ incidentId: null, incidentKey: null, kind: 'image', blob: blob('scene', 'image/jpeg'), mime: 'image/jpeg' });
  const res = await backend.sendOrQueueEmergency();
  const key = relayRows()[0]?.packet?.k;
  return { res, key };
}

console.log('\n=== PWA relay-path evidence rebind ===');
{
  // 1. The sender's own upload rebinds the capture onto the incident the gateway created.
  const { res, key } = await offlineReportWithCapture();
  ck('offline report queues a relay packet', res.status === 'relay-queued' && Boolean(key));
  ck('the pre-send capture is bound to the report key', evRows().length === 1 && evRows()[0].incidentKey === key && !evRows()[0].incidentId);

  nav.onLine = true; setSession();
  const flush = await backend.flushRelayQueue();
  ck('the queued packet is uploaded', flush.sent === 1 && relayRows().length === 0);
  const rebound = evRows()[0];
  ck('the capture is repointed onto the real incident', rebound?.incidentId && rebound.incidentId !== key && !rebound.incidentKey, `incidentId=${rebound?.incidentId}`);

  await evidence.flushEvidenceQueue((row) => row.incidentId || null);
  ck('the rebound capture uploads to Storage', uploads.length === 1 && uploads[0].path.startsWith('aaaaaaaa-0000-0000-0000-000000000001/'));
  ck('the capture registers against the real incident, not the report key', attaches.length === 1 && attaches[0].incident_id === rebound.incidentId);
  ck('all evidence rows are attached', evRows().length === 0);
}
{
  // 2. The packet was delivered by another device; a later sync reconciles the capture.
  idb.clear('reach-offline', EVIDENCE); idb.clear('reach-offline', RELAY);
  uploads.length = 0; attaches.length = 0; relayPosts.length = 0; gatewayIncidents.clear();
  const { res, key } = await offlineReportWithCapture();
  ck('second report queues a relay packet', res.status === 'relay-queued' && Boolean(key));

  // The packet reaches a relay node that uploads it, so the gateway knows the incident — but this
  // device never posted it (its own queue row is still pending).
  gatewayIncidents.set(key, 'inc-from-other-node');
  nav.onLine = true; setSession();
  lookupStatus = 200;
  const rec = await backend.reconcileRelayEvidence();
  ck('reconcile finds the report-keyed capture', rec.checked === 1, `checked=${rec.checked}`);
  ck('reconcile rebinds it without this device uploading the packet', evRows()[0]?.incidentId === 'inc-from-other-node' && relayRows().length === 1);

  await evidence.flushEvidenceQueue((row) => row.incidentId || null);
  ck('the reconciled capture registers against the incident', attaches.length === 1 && attaches[0].incident_id === 'inc-from-other-node');
}
{
  // 3. A packet the gateway has not ingested yet leaves the capture queued — no fabrication.
  idb.clear('reach-offline', EVIDENCE); idb.clear('reach-offline', RELAY);
  uploads.length = 0; attaches.length = 0; relayPosts.length = 0; gatewayIncidents.clear();
  await offlineReportWithCapture();
  nav.onLine = true; setSession();
  lookupStatus = 404;
  const rec = await backend.reconcileRelayEvidence();
  ck('an unknown packet rebinds nothing', rec.rebound === 0 && evRows()[0]?.incidentId === null && evRows()[0]?.incidentKey);
}
{
  // 4. A capture whose relay packet TTL has passed is no longer polled: the packet can never be
  //    ingested, so the capture stays queued without a lookup.
  const row = evRows()[0];
  row.createdAt = Date.now() - 31 * 60 * 1000;
  lookupStatus = 200;
  const rec = await backend.reconcileRelayEvidence();
  ck('an expired report-keyed capture is not reconciled', rec.checked === 0 && rec.rebound === 0, `checked=${rec.checked}`);
}

console.log(`\nTOTAL: ${pass}/${pass + fail} passed`);
assert.equal(fail, 0, `${fail} relay-evidence rebind assertion(s) failed`);
