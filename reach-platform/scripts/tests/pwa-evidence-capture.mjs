/**
 * Exercises the real PWA evidence path in js/evidence.js: content-addressed upload under the
 * caller's own uid prefix, registration against an incident, offline hold, and the rebinding of a
 * capture taken before the incident existed.
 *
 * evidence.js runs in a browser, so this provides indexedDB, localStorage, crypto.subtle and
 * navigator, plus a fetch stub at the network boundary (Storage and the API are the only places we
 * do not want to hit for real).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  const open = (name, version) => {
    const r = {};
    queueMicrotask(() => {
      if (!databases.has(name)) databases.set(name, { stores: new Map() });
      const db = { name, objectStoreNames: { contains: (n) => databases.get(name).stores.has(n) } };
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
        queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
        return tx;
      };
      r.result = db;
      r.onsuccess?.();
    });
    void version;
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
Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });

// Node's global webcrypto already provides subtle and randomUUID, which the module relies on.

// --- fetch stub at the network boundary --------------------------------------------------
const uploads = [];
const attaches = [];
let uploadStatus = 200;
let attachStatus = 201;
globalThis.fetch = async (url, opts = {}) => {
  const target = String(url);
  if (target.includes('/storage/v1/object/')) {
    if (uploadStatus !== 200) return { ok: false, status: uploadStatus, json: async () => ({ message: 'denied' }) };
    uploads.push({ path: target.split('/storage/v1/object/incident-evidence/')[1], contentType: opts.headers['Content-Type'], bytes: opts.body?.size });
    return { ok: true, status: 200, json: async () => ({ Key: 'incident-evidence/x' }) };
  }
  if (target.endsWith('/evidence')) {
    if (attachStatus >= 400) return { ok: false, status: attachStatus, json: async () => ({ error: 'Not permitted' }) };
    const body = JSON.parse(opts.body);
    attaches.push(body);
    return { ok: true, status: 201, json: async () => ({ data: { id: 'ev-1', ...body } }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const evidence = await import(pathToFileURL(path.join(PWA, 'evidence.js')).href);
const { sha256Hex, evidenceKindForMime } = await import(pathToFileURL(path.join(PWA, 'utils.js')).href);

let pass = 0, fail = 0;
const ck = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  [PASS] ${name}${detail ? '  — ' + detail : ''}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); } };

const UID = 'aaaaaaaa-0000-0000-0000-000000000001';
const rows = () => idb.dump('reach-offline', 'evidence-queue');
const setSession = (user) => ls.set('reach_pwa_session', JSON.stringify({ access_token: 't', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: user } }));
const blob = (text, type) => new Blob([text], { type });

console.log('\n=== PWA evidence capture ===');
{
  // 1. the object path is content-addressed and inside the caller's own uid prefix
  const digest = await sha256Hex(blob('scene', 'image/jpeg'));
  ck('sha256 is 64 hex chars', /^[0-9a-f]{64}$/.test(digest), digest.slice(0, 16) + '…');
  ck('the same bytes hash the same', (await sha256Hex(blob('scene', 'image/jpeg'))) === digest);
  ck('different bytes hash differently', (await sha256Hex(blob('other', 'image/jpeg'))) !== digest);
}
{
  // 2. attaching while signed in uploads then registers, with no client confidence
  nav.onLine = true;
  setSession(UID);
  idb.clear('reach-offline', 'evidence-queue');
  const result = await evidence.attachEvidenceNow('inc-1', 'image', blob('scene', 'image/jpeg'), 'image/jpeg', { name: 'scene.jpg' });
  ck('attach reports attached', result.status === 'attached', `status=${result.status}`);
  ck('upload path is under the caller uid', uploads[0]?.path.startsWith(`${UID}/`), uploads[0]?.path);
  ck('upload path is the sha256 address', uploads[0]?.path.split('/')[1].startsWith((await sha256Hex(blob('scene', 'image/jpeg'))).slice(0, 64)));
  ck('registration carries the same path and hash', attaches[0]?.storage_path === uploads[0]?.path && attaches[0]?.content_hash?.length === 64);
  ck('registration sends no confidence', !('confidence' in (attaches[0] || {})));
  ck('nothing is left queued after a successful attach', rows().length === 0);
}
{
  // 3. a failed upload holds the capture on the device rather than losing it
  uploadStatus = 403;
  const result = await evidence.attachEvidenceNow('inc-1', 'image', blob('scene2', 'image/jpeg'), 'image/jpeg');
  ck('a rejected upload is queued, not lost', result.status === 'queued' && rows().length === 1, `status=${result.status} rows=${rows().length}`);
  ck('the queued row keeps the blob for retry', rows()[0]?.blob?.size > 0);
  uploadStatus = 200;
}
{
  // 4. a capture with no incident yet is held until the report is sent
  idb.clear('reach-offline', 'evidence-queue');
  await evidence.queueEvidenceCapture({ incidentId: null, incidentKey: null, kind: 'audio', blob: blob('noise', 'audio/webm'), mime: 'audio/webm' });
  const skipped = await evidence.flushEvidenceQueue((row) => row.incidentId || null);
  ck('an unbound capture is not flushed', skipped.sent === 0 && rows().length === 1, `sent=${skipped.sent}`);

  // 5. binding it to the incident lets the flush send it
  const bound = await evidence.bindUnboundEvidence({ incidentId: 'inc-9' });
  ck('binding claims the unbound capture', bound === 1 && rows()[0]?.incidentId === 'inc-9');
  const flushed = await evidence.flushEvidenceQueue((row) => row.incidentId || null);
  ck('a bound capture flushes', flushed.sent === 1 && rows().length === 0, `sent=${flushed.sent} rows=${rows().length}`);
}
{
  // 6. a capture queued against a report key is rebound once the incident exists
  idb.clear('reach-offline', 'evidence-queue');
  await evidence.queueEvidenceCapture({ incidentId: null, incidentKey: 'pwa-key-1', kind: 'image', blob: blob('later', 'image/jpeg'), mime: 'image/jpeg' });
  const beforeRebind = await evidence.flushEvidenceQueue((row) => row.incidentId || null);
  ck('a report-keyed capture waits for the real incident', beforeRebind.sent === 0 && rows().length === 1);
  await evidence.bindUnboundEvidence({ incidentId: 'inc-real' });
  ck('rebinding does not touch an already-keyed row', rows()[0]?.incidentKey === 'pwa-key-1');
}
{
  // 7. a permanent rejection is recorded once, not retried forever
  idb.clear('reach-offline', 'evidence-queue');
  attachStatus = 403;
  await evidence.queueEvidenceCapture({ incidentId: 'inc-1', incidentKey: null, kind: 'image', blob: blob('x', 'image/jpeg'), mime: 'image/jpeg' });
  await evidence.flushEvidenceQueue((row) => row.incidentId || null);
  ck('a 4xx marks the capture rejected', rows()[0]?.state === 'rejected', `state=${rows()[0]?.state}`);
  const attemptsAtReject = rows()[0]?.attempts;
  const attachCallsAtReject = attaches.length;
  await evidence.flushEvidenceQueue((row) => row.incidentId || null);
  ck('a rejected capture is not retried on the next flush', attaches.length === attachCallsAtReject && rows()[0]?.attempts === attemptsAtReject, `attempts=${rows()[0]?.attempts}`);
  ck('a rejected capture is kept on disk, not silently dropped', rows().length === 1);
  attachStatus = 201;
}
{
  // 8. MIME → kind mapping matches what the server accepts
  ck('image/* maps to image', evidenceKindForMime('image/png') === 'image');
  ck('audio/* maps to audio', evidenceKindForMime('audio/webm') === 'audio');
  ck('video/* maps to video', evidenceKindForMime('video/mp4') === 'video');
  ck('an unrelated type is rejected', evidenceKindForMime('application/pdf') === null);
}

{
  // 9. Both modules open the same IndexedDB at the same version. A mismatch throws VersionError in
  //    the browser, which would silently stop the evidence queue from working.
  const versionOf = (file) => Number((readFileSync(path.join(PWA, file), 'utf8').match(/const DB_VERSION = (\d+)/) || [])[1]);
  ck('backend.js and evidence.js agree on the database version', versionOf('backend.js') === versionOf('evidence.js') && versionOf('backend.js') > 0, `backend=${versionOf('backend.js')} evidence=${versionOf('evidence.js')}`);
  const backendSrc = readFileSync(path.join(PWA, 'backend.js'), 'utf8');
  ck('backend.js opens the database at DB_VERSION', backendSrc.includes('indexedDB.open(DB_NAME,DB_VERSION)'));
  ck('evidence.js opens the database at DB_VERSION', readFileSync(path.join(PWA, 'evidence.js'), 'utf8').includes('indexedDB.open(DB_NAME, DB_VERSION)'));
}

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0, `${fail} evidence capture assertion(s) failed`);