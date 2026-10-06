/**
 * Pins the offline IndexedDB schema.
 *
 * backend.js and evidence.js previously each opened `reach-offline` directly at the same version
 * but with different store lists. Because IndexedDB only runs `onupgradeneeded` when the requested
 * version is *higher* than the stored one, whichever module opened first decided the schema:
 * `initBackendSync()` opened first (creating incident-queue/sync-meta/relay-queue), evidence.js
 * opened next at the same version, no upgrade fired, and `transaction('evidence-queue')` threw
 * "One of the specified object stores was not found" — so no photo or attachment could be saved.
 *
 * The other PWA tests use an IndexedDB stub that ignores the version, so they never caught it. This
 * one models real upgrade semantics, including the `VersionError`/`NotFoundError` cases.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PWA = path.join(HERE, '..', '..', '..', 'reach-citizen-pwa', 'js');

// --- version-aware in-memory IndexedDB ---------------------------------------------------
const microtask = () => new Promise((r) => queueMicrotask(r));
function makeIndexedDB() {
  const dbs = new Map();
  const open = (name, version) => {
    const req = {};
    queueMicrotask(() => {
      let db = dbs.get(name);
      const fresh = !db;
      if (fresh) db = { version: 0, stores: new Map() };
      const needsUpgrade = fresh || version > db.version;
      const result = {
        name,
        version: needsUpgrade ? version : db.version,
        objectStoreNames: { contains: (n) => db.stores.has(n) },
        createObjectStore: (n, opts) => { db.stores.set(n, { keyPath: opts?.keyPath, rows: new Map() }); },
        transaction: (store, mode = 'readonly') => {
          if (!db.stores.has(store)) {
            throw new DOMException(`One of the specified object stores was not found.`, 'NotFoundError');
          }
          const rows = db.stores.get(store).rows;
          const tx = {};
          tx.objectStore = () => ({
            getAll: () => { const q = {}; queueMicrotask(() => { q.result = [...rows.values()]; q.onsuccess?.(); }); return q; },
            get: (k) => { const q = {}; queueMicrotask(() => { q.result = rows.get(k); q.onsuccess?.(); }); return q; },
            put: (v, k) => { const q = {}; const key = k !== undefined ? k : v.id; rows.set(key, v); queueMicrotask(() => { q.result = key; q.onsuccess?.(); }); return q; },
            delete: (k) => { const q = {}; rows.delete(k); queueMicrotask(() => { q.result = undefined; q.onsuccess?.(); }); return q; },
          });
          tx.oncomplete = null; tx.onerror = null;
          queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
          return tx;
        },
      };
      if (version < db.version && !fresh) {
        queueMicrotask(() => { req.error = new DOMException('The requested version is lower.', 'VersionError'); req.onerror?.(); });
        return;
      }
      if (needsUpgrade) { db.version = version; req.result = result; req.onupgradeneeded?.(); }
      else req.result = result;
      dbs.set(name, db);
      req.onsuccess?.();
    });
    return req;
  };
  return { open, db: (name) => dbs.get(name), stores: (name) => [...(dbs.get(name)?.stores.keys() || [])], reset: () => dbs.clear() };
}

globalThis.DOMException = globalThis.DOMException || class extends Error {};
const idb = makeIndexedDB();
globalThis.indexedDB = idb;
const ls = new Map();
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
globalThis.window = { REACH_CONFIG: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon' }, addEventListener: () => {}, setInterval: () => 0 };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });

let pass = 0, fail = 0;
const ck = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  [PASS] ${name}${detail ? '  — ' + detail : ''}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); } };

console.log('\n=== PWA offline database schema ===');

const db = await import(pathToFileURL(path.join(PWA, 'db.js')).href);

// 1. A fresh database gets every store the app needs.
{
  const opened = await db.openReachDb();
  const stores = idb.stores('reach-offline');
  for (const name of [db.INCIDENT_STORE, db.SYNC_META_STORE, db.RELAY_STORE, db.EVIDENCE_STORE]) {
    ck(`a fresh database has ${name}`, stores.includes(name));
  }
  ck('a fresh database is opened at the current version', opened.version === db.DB_VERSION, `v${opened.version}`);
  ck('evidence-queue is transaction-safe', (() => { try { opened.transaction(db.EVIDENCE_STORE); return true; } catch { return false; } })());
}

// 2. A device left at v4 with only the three backend stores (the broken state) is healed: the
//    version bump makes the upgrade run, and the missing store is created.
{
  idb.reset();
  const v4 = idb.open('reach-offline', 4);
  const legacy = await new Promise((resolve, reject) => {
    v4.onupgradeneeded = () => { const d = v4.result; d.createObjectStore('incident-queue', { keyPath: 'id' }); d.createObjectStore('sync-meta', { keyPath: 'key' }); d.createObjectStore('relay-queue', { keyPath: 'id' }); };
    v4.onsuccess = () => resolve(v4.result); v4.onerror = () => reject(v4.error);
  });
  ck('the legacy v4 database lacks evidence-queue', !idb.stores('reach-offline').includes('evidence-queue'));
  try { legacy.transaction('evidence-queue'); ck('legacy transaction throws NotFoundError', false); }
  catch (e) { ck('legacy transaction throws NotFoundError', e.name === 'NotFoundError', e.message); }

  const healed = await db.openReachDb();
  ck('reopening heals the database to the current version', healed.version === db.DB_VERSION, `v${healed.version}`);
  ck('the healed database has evidence-queue', idb.stores('reach-offline').includes('evidence-queue'));
  ck('evidence-queue is transaction-safe after healing', (() => { try { healed.transaction(db.EVIDENCE_STORE); return true; } catch { return false; } })());
}

// 3. The real evidence path round-trips through the shared opener.
{
  const evidence = await import(pathToFileURL(path.join(PWA, 'evidence.js')).href);
  const id = await evidence.queueEvidenceCapture({ incidentId: null, incidentKey: null, kind: 'image', blob: new Blob(['scene'], { type: 'image/jpeg' }), mime: 'image/jpeg' });
  const rows = await evidence.listEvidenceQueue();
  ck('a capture can be queued and read back', rows.length === 1 && rows[0].id === id, `rows=${rows.length}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0, `${fail} database schema assertion(s) failed`);
