/**
 * Exercises the relay packet export in reach-citizen-pwa/js/backend.js.
 *
 * A phone with no relay node and no internet can save its signed packets as a JSON file and hand
 * them to a REACH relay node over Bluetooth/Wi-Fi file transfer. These tests pin that the export
 * contains only live, unexpired packets, in a documented envelope, and that it never ships a
 * dead-lettered or expired packet the gateway would reject.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PWA = path.join(HERE, '..', '..', '..', 'reach-citizen-pwa', 'js');

// --- minimal in-memory IndexedDB (same shape the relay-queue test uses) ------------------
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
      const db = { name, objectStoreNames: { contains: (n) => storeMap(name, n) && databases.get(name).stores.has(n) } };
      if (!databases.has(name)) databases.set(name, { stores: new Map() });
      db.createObjectStore = (n) => storeMap(name, n);
      db.transaction = (storeName) => {
        const map = storeMap(name, storeName);
        const tx = {};
        const store = {
          getAll: () => { const q = {}; queueMicrotask(() => { q.result = [...map.values()]; q.onsuccess?.(); }); return q; },
          get: (k) => { const q = {}; queueMicrotask(() => { q.result = map.get(k); q.onsuccess?.(); }); return q; },
          put: (v, k) => { const q = {}; map.set(k !== undefined ? k : v.id, v); queueMicrotask(() => { q.result = k; q.onsuccess?.(); }); return q; },
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
  return { open, dump: (dbName, storeName) => [...storeMap(dbName, storeName).values()], clear: (dbName, storeName) => storeMap(dbName, storeName).clear() };
}

const idb = makeIndexedDB();
globalThis.indexedDB = idb;
const ls = new Map();
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
globalThis.window = { REACH_CONFIG: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon' }, addEventListener: () => {}, setInterval: () => 0 };
const nav = { onLine: true };
Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'offline' }) });

const backend = await import(pathToFileURL(path.join(PWA, 'backend.js')).href);
const { appState } = await import(pathToFileURL(path.join(PWA, 'state.js')).href);

let pass = 0, fail = 0;
const ck = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  [PASS] ${name}${detail ? '  — ' + detail : ''}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); } };
const rows = () => idb.dump('reach-offline', 'relay-queue');
const RELAY_STORE = 'relay-queue';

async function queueOne() {
  nav.onLine = false;
  appState.relayEnabled = true;
  Object.assign(appState.emergency, { category: 'fire', categoryLabel: 'Fire', priority: 'high', title: 'Fire', description: 'Smoke', locationLabel: 'Zone A', locationType: 'manual', locationAccuracyM: 20, latitude: 6.2, longitude: 6.7 });
  await backend.sendOrQueueEmergency();
}

console.log('\n=== PWA relay packet export ===');
{
  await queueOne();
  const out = await backend.exportRelayPackets();
  ck('export declares its format and version', out.format === 'reach-relay-packets' && out.version === 1);
  ck('export carries an ISO timestamp', !Number.isNaN(Date.parse(out.exported_at)));
  ck('export includes the queued signed packet', out.packets.length === 1 && Boolean(out.packets[0].x) && Boolean(out.packets[0].source_signature));
  ck('export round-trips through JSON', JSON.parse(JSON.stringify(out)).packets.length === 1);
}
{
  // An expired packet must be excluded — the gateway would reject it anyway.
  rows()[0].packet.e = Date.now() - 1000;
  const out = await backend.exportRelayPackets();
  ck('expired packets are excluded from the export', out.packets.length === 0, `packets=${out.packets.length}`);
}
{
  // A dead-lettered packet must be excluded too.
  idb.clear('reach-offline', RELAY_STORE);
  await queueOne();
  rows()[0].state = 'dead_letter';
  const out = await backend.exportRelayPackets();
  ck('dead-lettered packets are excluded from the export', out.packets.length === 0, `packets=${out.packets.length}`);
}
{
  // Ordering: oldest first, so a relay node uploads in the order they were created.
  idb.clear('reach-offline', RELAY_STORE);
  await queueOne();
  const first = rows()[0];
  first.createdAt = 1000;
  await queueOne();
  const second = rows().find((r) => r !== first);
  second.createdAt = 2000;
  const out = await backend.exportRelayPackets();
  ck('export orders packets oldest first', out.packets.length === 2 && out.packets[0].k === first.packet.k, out.packets.map((p) => p.k).join(','));
}
{
  // Round trip: the receiving device imports the file and can then flush it as its own queue.
  idb.clear('reach-offline', RELAY_STORE);
  await queueOne();
  const file = await backend.exportRelayPackets();
  const sourceKey = file.packets[0].k;
  // A fresh receiving device has an empty queue.
  idb.clear('reach-offline', RELAY_STORE);
  const imported = await backend.importRelayPackets(JSON.parse(JSON.stringify(file)));
  ck('import accepts a signed packet file', imported.accepted === 1 && imported.rejected === 0 && imported.skipped === 0, JSON.stringify(imported));
  ck('imported packet is queued under its own key', rows().length === 1 && rows()[0].id === sourceKey && rows()[0].state === 'queued');
  // Re-importing the same file is a no-op (idempotent), so a retried transfer cannot double-send.
  const again = await backend.importRelayPackets(file);
  ck('re-importing the same packet is skipped', again.accepted === 0 && again.skipped === 1 && rows().length === 1, JSON.stringify(again));
}
{
  // Malformed input is rejected, not queued.
  idb.clear('reach-offline', RELAY_STORE);
  const bad = await backend.importRelayPackets({ packets: [{ k: 'x' }, null, 'nope'] });
  ck('malformed packets are rejected', bad.accepted === 0 && bad.rejected === 3 && rows().length === 0, JSON.stringify(bad));
  let threw = false;
  try { await backend.importRelayPackets({ not: 'a file' }); } catch { threw = true; }
  ck('a non-packet document throws', threw);
}
{
  // An expired packet in a transferred file is skipped, not queued for a doomed upload.
  idb.clear('reach-offline', RELAY_STORE);
  await queueOne();
  const file = await backend.exportRelayPackets();
  idb.clear('reach-offline', RELAY_STORE);
  file.packets[0].e = Date.now() - 1000;
  const out = await backend.importRelayPackets(file);
  ck('expired packets are skipped on import', out.accepted === 0 && out.skipped === 1 && rows().length === 0, JSON.stringify(out));
}
  {
    // Inside the relay-node app the node owns the durable queue (it holds packets received over the
    // radio too), so the export must prefer the native queue and the import must be handed to it.
    idb.clear('reach-offline', RELAY_STORE);
    globalThis.window.REACH_NATIVE_RELAY = {
      exportRelayFile: () => JSON.stringify({ format: 'reach-relay-packets', version: 1, exported_at: new Date().toISOString(), packets: [{ k: 'native-1', x: 'a'.repeat(64) }] }),
      importRelayFile: (text) => {
        const doc = JSON.parse(text);
        return JSON.stringify({ accepted: doc.packets.length, skipped: 0, rejected: 0 });
      },
    };
    const exported = await backend.exportRelayPackets();
    ck('export prefers the native relay queue', exported.packets.length === 1 && exported.packets[0].k === 'native-1');
    const imported = await backend.importRelayPackets({ packets: [{ k: 'incoming-1' }, { k: 'incoming-2' }] });
    ck('import is handed to the native node', imported.accepted === 2 && rows().length === 0, JSON.stringify(imported));
    // A native node with an empty queue must fall back to the local IndexedDB rows.
    globalThis.window.REACH_NATIVE_RELAY = { exportRelayFile: () => null };
    await queueOne();
    const fallback = await backend.exportRelayPackets();
    ck('empty native queue falls back to the local export', fallback.packets.length === 1, `packets=${fallback.packets.length}`);
    globalThis.window.REACH_NATIVE_RELAY = undefined;
  }


console.log(`\nTOTAL: ${pass}/${pass + fail} passed`);
assert.equal(fail, 0, `${fail} relay export assertion(s) failed`);
