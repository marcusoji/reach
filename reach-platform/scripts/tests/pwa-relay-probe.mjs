/**
 * Exercises the native relay link probe in js/backend.js.
 *
 * The probe exists because "the Bluetooth permission was granted" and "a packet can actually be
 * carried" are different questions. It must report the truth in both directions: a verified peer
 * ACK means the phone can relay, and anything else (no node, silent node, refused node) must not be
 * dressed up as success. backend.js is a heavy module, so the same stubs the other PWA tests use
 * are installed before importing it.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PWA = path.join(HERE, '..', '..', '..', 'reach-citizen-pwa', 'js');

// --- Minimal browser surface backend.js touches at import time -------------------------------
globalThis.window = {};
globalThis.localStorage = {
  _data: {},
  getItem(k) { return this._data[k] ?? null; },
  setItem(k, v) { this._data[k] = String(v); },
  removeItem(k) { delete this._data[k]; },
};
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });

// Real WebCrypto is used deliberately: buildRelayPacket generates a P-256 key, signs the canonical
// payload and SHA-256s it, so the probe is exercised against the actual signing path rather than a
// stub that could hide a malformed packet.

// IndexedDB is only opened by the relay identity path, which the probe exercises; back it with a
// tiny in-memory store so the real buildRelayPacket code runs rather than being stubbed out.
const stores = new Map();
globalThis.indexedDB = {
  open() {
    const req = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    queueMicrotask(() => {
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => {},
        transaction(name) {
          const tx = { oncomplete: null, onerror: null, error: null, objectStore: () => store };
          queueMicrotask(() => tx.oncomplete && tx.oncomplete());
          return tx;
        },
      };
      const store = {
        get: (k) => { const r = { result: stores.get(k), onsuccess: null, onerror: null }; queueMicrotask(() => r.onsuccess && r.onsuccess()); return r; },
        put: (v, k) => { stores.set(k, v); return {}; },
      };
      req.result = db;
      req.onsuccess && req.onsuccess();
    });
    return req;
  },
};

const { probeNativeRelay } = await import(pathToFileURL(path.join(PWA, 'backend.js')).href);
let pass = 0, fail = 0;
const ck = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  [PASS] ${name}${detail ? '  — ' + detail : ''}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); } };

const reset = () => { globalThis.window.REACH_NATIVE_RELAY = undefined; };

console.log('\n=== PWA relay link probe ===');
{
  // 1. No native node: honest refusal, never a fake success.
  reset();
  const result = await probeNativeRelay();
  ck('no node reports not ok', result.ok === false);
  ck('no node explains why', /no relay node/i.test(result.detail));
}
{
  // 2. A node that accepts the packet and later reports a verified peer delivery.
  reset();
  let sentPacket = null;
  globalThis.window.REACH_NATIVE_RELAY = {
    sendPacket: (p) => { sentPacket = JSON.parse(p); return JSON.stringify({ accepted: true, packet_key: sentPacket.k }); },
    packetStatus: () => JSON.stringify({ state: 'delivered' }),
  };
  const result = await probeNativeRelay();
  ck('verified delivery reports ok', result.ok === true);
  ck('probe packet is a real signed relay packet', sentPacket && sentPacket.v === 2 && typeof sentPacket.x === 'string' && sentPacket.x.length === 64);
  ck('probe is low priority, not an emergency', sentPacket.minimal_payload?.priority === 'low');
}
{
  // 3. A node that refuses the packet must not be reported as working.
  reset();
  globalThis.window.REACH_NATIVE_RELAY = { sendPacket: () => JSON.stringify({ accepted: false }) };
  const result = await probeNativeRelay();
  ck('refused probe reports not ok', result.ok === false);
  ck('refused probe suggests retrying nearby', /try again/i.test(result.detail));
}
{
  // 4. Queued but dead-lettered: the packet never left, so this is not a success.
  reset();
  globalThis.window.REACH_NATIVE_RELAY = {
    sendPacket: () => JSON.stringify({ accepted: true }),
    packetStatus: () => JSON.stringify({ state: 'dead' }),
  };
  const result = await probeNativeRelay();
  ck('dead-lettered probe reports not ok', result.ok === false);
  ck('dead-lettered probe suggests retrying', /try again/i.test(result.detail));
}
{
  // 5. An older node with no status method: enqueue is all it can prove, so no false success.
  reset();
  globalThis.window.REACH_NATIVE_RELAY = { sendPacket: () => true };
  const result = await probeNativeRelay();
  ck('node without status cannot claim delivery', result.ok === false);
  ck('node without status explains the limit', /cannot report/i.test(result.detail));
}
{
  // 6. No native node but Web Bluetooth present: probe the browser→nearby-node path instead of
  //    refusing, and still never claim success without a verified ACK.
  reset();
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, bluetooth: { requestDevice: async () => { throw new Error('User cancelled the requestDevice() chooser.'); } } }, configurable: true, writable: true });
  const result = await probeNativeRelay();
  ck('browser probe does not claim there is no node', result.ok === false && !/no relay node/i.test(result.detail));
  ck('browser probe reports the cancelled chooser', /no relay device was selected/i.test(result.detail));
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
}

console.log(`\nTOTAL: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
