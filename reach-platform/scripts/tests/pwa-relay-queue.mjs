/**
 * Exercises the real PWA relay queue in js/backend.js: queueing while offline, flushing on
 * reconnect, TTL expiry, exponential backoff and dead-lettering.
 *
 * backend.js runs in a browser, so this provides the smallest environment it needs —
 * indexedDB, localStorage, window.REACH_CONFIG and navigator — plus a fetch stub at the
 * network boundary (the only place we do not want to hit a real gateway).
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
  const request = () => {
    const r = {};
    queueMicrotask(() => { try { r.result = r._fn(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); } });
    return r;
  };
  const open = (name) => {
    const r = {};
    queueMicrotask(() => {
      const db = { name, objectStoreNames: { contains: (n) => storeMap(name, n) && databases.get(name).stores.has(n) } };
      // A fresh open should not pre-create stores; onupgradeneeded does that.
      if (!databases.has(name)) databases.set(name, { stores: new Map() });
      db.createObjectStore = (n) => storeMap(name, n);
      db.transaction = (storeName, mode = 'readonly') => {
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
        // Fire completion only after the synchronous onsuccess handlers (which may enqueue
        // further work) have run.
        queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
        return tx;
      };
      r.result = db;
      r.onsuccess?.();
    });
    return r;
  };
  return { open, dump: (dbName, storeName) => [...storeMap(dbName, storeName).values()], clear: (dbName, storeName) => storeMap(dbName, storeName).clear() };
}

const idb = makeIndexedDB();
globalThis.indexedDB = idb;

// --- localStorage / window / navigator ---------------------------------------------------
const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
};
globalThis.window = { REACH_CONFIG: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon' }, addEventListener: () => {}, setInterval: () => 0 };
const nav = { onLine: true };
// Node exposes a read-only global `navigator`; override it with a writable stub.
Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });

// --- fetch stub at the network boundary --------------------------------------------------
let fetchMode = 'ok';
const sentBodies = [];
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('/relay/packets')) {
    if (fetchMode === 'fail') return { ok: false, status: 503, json: async () => ({ error: 'gateway unavailable' }) };
    sentBodies.push(JSON.parse(opts.body));
    return { ok: true, status: 201, json: async () => ({ data: { packet_key: 'x' } }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const backend = await import(pathToFileURL(path.join(PWA, 'backend.js')).href);
const { appState } = await import(pathToFileURL(path.join(PWA, 'state.js')).href);

let pass = 0, fail = 0;
const ck = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  [PASS] ${name}${detail ? '  — ' + detail : ''}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); } };

const RELAY_STORE = 'relay-queue';
const rows = () => idb.dump('reach-offline', RELAY_STORE);
const setSession = (token) => ls.set('reach_pwa_session', JSON.stringify({ access_token: token, refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600 }));

const offline = async () => {
  nav.onLine = false;
  appState.relayEnabled = true;
  Object.assign(appState.emergency, { category: 'fire', categoryLabel: 'Fire', priority: 'high', title: 'Fire', description: 'Smoke', locationLabel: 'Zone A', locationType: 'manual', locationAccuracyM: 20, latitude: 6.2, longitude: 6.7 });
  return backend.sendOrQueueEmergency();
};

console.log('\n=== PWA relay queue ===');
{
  // 1. offline send queues a signed relay packet
  const res = await offline();
  ck('offline emergency queues a relay packet', res.status === 'relay-queued' && rows().length === 1, `status=${res.status} rows=${rows().length}`);
  ck('queued row carries a signed packet with a fingerprint', Boolean(rows()[0]?.packet?.x) && Boolean(rows()[0]?.packet?.source_signature));
  ck('queued row starts at attempt 0', Number(rows()[0]?.attempts || 0) === 0);
}
{
  // 2. flush while offline is a no-op
  const r = await backend.flushRelayQueue();
  ck('flush is skipped while offline', r.sent === 0 && rows().length === 1);
}
{
  // 3. flush while online sends and clears the row
  nav.onLine = true; setSession('token'); fetchMode = 'ok'; sentBodies.length = 0;
  const r = await backend.flushRelayQueue();
  ck('flush sends the queued packet', r.sent === 1 && rows().length === 0, `sent=${r.sent} rows=${rows().length}`);
  ck('the sent body is a mapped relay packet', sentBodies.length === 1 && Boolean(sentBodies[0].packet_key) && Boolean(sentBodies[0].packet_hash) && sentBodies[0].transport === 'pwa');
}
{
  // 4. a packet past its own TTL is discarded, not retried
  await offline();
  const row = rows()[0];
  row.packet.e = Date.now() - 1000;
  nav.onLine = true; setSession('token');
  const r = await backend.flushRelayQueue();
  ck('expired packet is dropped and counted', r.expired === 1 && rows().length === 0, `expired=${r.expired} rows=${rows().length}`);
}
{
  // 5. a failing send backs off and keeps the packet
  await offline();
  nav.onLine = true; setSession('token');
  fetchMode = 'fail';
  const r = await backend.flushRelayQueue();
  const row = rows()[0];
  ck('failed send is retained with an incremented attempt', r.sent === 0 && rows().length === 1 && Number(row.attempts) === 1, `attempts=${row?.attempts}`);
  ck('failed send records a backoff window', Number(row.nextAttemptAt) > Date.now());
  ck('failed send records the error', /gateway unavailable/.test(row.lastError || ''), row.lastError);
  // a second immediate flush must respect the backoff window
  const r2 = await backend.flushRelayQueue();
  ck('backoff suppresses the immediate retry', r2.sent === 0 && Number(rows()[0].attempts) === 1, `attempts=${rows()[0].attempts}`);
}
{
  // 6. exhausting attempts dead-letters instead of retrying forever
  idb.clear('reach-offline', RELAY_STORE);
  await offline();
  const row = rows()[0];
  row.attempts = 7; row.nextAttemptAt = 0;
  nav.onLine = true; setSession('token');
  fetchMode = 'fail';
  const r = await backend.flushRelayQueue();
  const dead = rows().filter((i) => i.state === 'dead_letter');
  ck('final failure dead-letters the packet', dead.length === 1 && Number(dead[0].attempts) === 8, `dead=${dead.length}`);
  ck('dead letters are reported', r.dead === 1);
  ck('dead letters are excluded from the remaining count', r.remaining === 0, `remaining=${r.remaining}`);
  const listed = await backend.listRelayDeadLetter();
  ck('listRelayDeadLetter surfaces the dead letter', listed.length === 1 && listed[0].id === dead[0].id);
}
{
  // 7. a dead letter is never re-sent even after the gateway recovers
  fetchMode = 'ok'; sentBodies.length = 0;
  const r = await backend.flushRelayQueue();
  ck('dead letters are not retried after recovery', r.sent === 0 && sentBodies.length === 0, `sent=${r.sent}`);
}
{
  // 8. offline with a native relay node: the packet is handed to the node and leaves the queue
  idb.clear('reach-offline', RELAY_STORE);
  await offline(); // queues the signed packet locally first (no bridge yet)
  const bridgeCalls = [];
  globalThis.window.REACH_NATIVE_RELAY = { sendPacket: (json) => { bridgeCalls.push(JSON.parse(json)); return JSON.stringify({ accepted: true }); } };
  const r = await backend.flushRelayQueue();
  ck('offline flush hands the packet to the native relay node', r.relayed === 1 && rows().length === 0, `relayed=${r.relayed} rows=${rows().length}`);
  ck('the native node received the signed packet', bridgeCalls.length === 1 && Boolean(bridgeCalls[0].k) && Boolean(bridgeCalls[0].source_signature));
  delete globalThis.window.REACH_NATIVE_RELAY;
}
{
  // 9. offline with no native node: the packet stays queued for a later gateway upload
  idb.clear('reach-offline', RELAY_STORE);
  await offline();
  const r = await backend.flushRelayQueue();
  ck('offline without a native node keeps the packet queued', r.relayed === 0 && rows().length === 1, `relayed=${r.relayed} rows=${rows().length}`);
}

console.log(`\nTOTAL: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
