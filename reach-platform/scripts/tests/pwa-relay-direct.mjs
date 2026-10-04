/**
 * Exercises the browser → nearby relay node path in js/relay/direct.js.
 *
 * A plain browser (and a PWABuilder/TWA shell) has no native relay node, so the only way it can hand
 * an offline alert to the relay network is a Web Bluetooth write to a nearby Android node's GATT
 * service plus a verified ACK. This drives the real module against a fake GATT server so the packet
 * framing, the ACK correlation and the honest reporting are all tested rather than assumed.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PWA = path.join(HERE, '..', '..', '..', 'reach-citizen-pwa', 'js');

// --- Minimal browser surface the modules touch at import time -------------------------------
globalThis.window = {};
globalThis.localStorage = {
  _data: {},
  getItem(k) { return this._data[k] ?? null; },
  setItem(k, v) { this._data[k] = String(v); },
  removeItem(k) { delete this._data[k]; },
};
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });

// Real WebCrypto is used deliberately: buildRelayPacket signs the canonical payload, so the probe
// exercises the actual signing path. IndexedDB backs the relay identity.
const stores = new Map();
globalThis.indexedDB = {
  open() {
    const req = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    queueMicrotask(() => {
      const store = {
        get: (k) => { const r = { result: stores.get(k), onsuccess: null, onerror: null }; queueMicrotask(() => r.onsuccess && r.onsuccess()); return r; },
        put: (v, k) => { stores.set(k, v); return {}; },
      };
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => {},
        transaction() { const tx = { oncomplete: null, onerror: null, error: null, objectStore: () => store }; queueMicrotask(() => tx.oncomplete && tx.oncomplete()); return tx; },
      };
      req.result = db;
      req.onsuccess && req.onsuccess();
    });
    return req;
  },
};

const direct = await import(pathToFileURL(path.join(PWA, 'relay', 'direct.js')).href);
const protocol = await import(pathToFileURL(path.join(PWA, 'relay', 'protocol.js')).href);
const { directRelayAvailable, connectDirectRelay, disconnectDirectRelay, sendPacketViaDirectRelay, probeDirectRelay } = direct;
const { awaitAck, RELAY_SERVICE_UUID, RELAY_DATA_UUID, RELAY_ACK_UUID, RELAY_LIMITS } = protocol;

let pass = 0, fail = 0;
const ck = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  [PASS] ${name}${detail ? '  — ' + detail : ''}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); } };

class FakeChar {
  constructor() { this.listeners = []; this.writes = []; this.notifying = false; this.onWrite = null; }
  async writeValueWithResponse(frame) { this.writes.push(new Uint8Array(frame)); if (this.onWrite) this.onWrite(frame); }
  async startNotifications() { this.notifying = true; }
  addEventListener(type, fn) { if (type === 'characteristicvaluechanged') this.listeners.push(fn); }
  removeEventListener(type, fn) { this.listeners = this.listeners.filter((f) => f !== fn); }
  emit(obj) { const buf = new TextEncoder().encode(JSON.stringify(obj)); const value = new DataView(buf.buffer.slice(0)); for (const fn of this.listeners) fn({ target: { value } }); }
}

function fakeDevice({ ack } = {}) {
  const dataChar = new FakeChar();
  const ackChar = new FakeChar();
  let requestedFilters = null;
  dataChar.onWrite = (frame) => {
    const total = frame[5];
    if (dataChar.writes.length < total) return; // wait for every fragment of the transfer
    const HEADER = 6;
    const packet = JSON.parse(new TextDecoder().decode(dataChar.writes.map((f) => f.slice(HEADER)).reduce((a, b) => new Uint8Array([...a, ...b]), new Uint8Array())));
    const reply = ack === undefined
      ? { type: 'ACK', v: 2, k: packet.k, x: packet.x, accepted: true, receiver_device_id: 'node-1' }
      : ack(packet);
    if (reply) queueMicrotask(() => ackChar.emit(reply));
  };
  const service = {
    getCharacteristic: async (uuid) => {
      if (uuid === RELAY_DATA_UUID) return dataChar;
      if (uuid === RELAY_ACK_UUID) return ackChar;
      throw new Error('unknown characteristic');
    },
  };
  const server = { getPrimaryService: async () => service, disconnect() {} };
  const device = { name: 'Test Relay', gatt: { connect: async () => server } };
  const requestDevice = async (opts) => { requestedFilters = opts; return device; };
  return { device, dataChar, ackChar, requestDevice, filters: () => requestedFilters };
}

const setBluetooth = (requestDevice) => Object.defineProperty(globalThis, 'navigator', { value: { bluetooth: requestDevice ? { requestDevice } : {} }, configurable: true, writable: true });
const reset = () => { globalThis.window.REACH_NATIVE_RELAY = undefined; disconnectDirectRelay(); setBluetooth(null); };

const smallPacket = () => ({ v: 2, k: 'pwa-direct-0001', x: 'a'.repeat(64), e: Date.now() + 60000, h: 0, m: 6, minimal_payload: { category: 'fire', priority: 'high' } });

console.log('\n=== PWA direct relay (Web Bluetooth → nearby node) ===');
{
  // 1. No Web Bluetooth: the path is unavailable and pairing fails honestly.
  reset();
  ck('no Web Bluetooth means no direct path', directRelayAvailable() === false);
  let threw = false;
  try { await connectDirectRelay(); } catch { threw = true; }
  ck('pairing without Web Bluetooth throws', threw);
}
{
  // 2. Pairing uses the shared service UUID and keeps the connection.
  reset();
  const fake = fakeDevice();
  setBluetooth(fake.requestDevice);
  ck('Web Bluetooth advertises the direct path', directRelayAvailable() === true);
  const connection = await connectDirectRelay();
  ck('pairing returns the relay device', connection?.device?.name === 'Test Relay');
  ck('pairing filters on the shared relay service UUID', fake.filters()?.filters?.[0]?.services?.[0] === RELAY_SERVICE_UUID);
  ck('pairing asks for the ACK characteristic', fake.filters()?.optionalServices?.includes(RELAY_SERVICE_UUID));
  const again = await connectDirectRelay();
  ck('pairing is reused, not repeated', again === connection);
}
{
  // 3. A verified ACK means the packet was carried.
  reset();
  const fake = fakeDevice();
  setBluetooth(fake.requestDevice);
  const packet = smallPacket();
  const result = await sendPacketViaDirectRelay(packet);
  ck('verified ACK reports carried', result.ok === true && result.device === 'Test Relay');
  ck('ACK notifications are subscribed before writing', fake.ackChar.notifying === true);
  const frames = fake.dataChar.writes;
  const HEADER = 6;
  const reassembled = new Uint8Array(frames.reduce((n, f) => n + f.length - HEADER, 0));
  let off = 0;
  for (const f of frames) { reassembled.set(f.slice(HEADER), off); off += f.length - HEADER; }
  ck('written frames carry the 4-byte transfer id header', frames.every((f) => f.length > HEADER));
  ck('frames share one transfer id', new Set(frames.map((f) => [...f.slice(0, 4)].join(','))).size === 1);
  ck('reassembled payload is the signed packet', new TextDecoder().decode(reassembled) === JSON.stringify(packet));
  ck('each fragment respects the 180-byte chunk limit', frames.every((f) => f.length - HEADER <= RELAY_LIMITS.bleChunkBytes));
}
{
  // 4. A rejecting ACK is not a delivery.
  reset();
  const fake = fakeDevice({ ack: (p) => ({ type: 'ACK', v: 2, k: p.k, x: p.x, accepted: false, reason: 'Packet expired', receiver_device_id: 'node-1' }) });
  setBluetooth(fake.requestDevice);
  const result = await sendPacketViaDirectRelay(smallPacket());
  ck('rejected ACK reports not carried', result.ok === false);
  ck('rejection reason is surfaced', result.reason === 'Packet expired');
}
{
  // 5. An ACK naming a different packet must not be counted (identity collision defence).
  const ackChar = new FakeChar();
  const p = smallPacket();
  const wait = awaitAck(ackChar, { packetKey: p.k, packetHash: p.x, timeoutMs: 40 });
  ackChar.emit({ type: 'ACK', v: 2, k: 'someone-elses-key', x: p.x, accepted: true });
  ackChar.emit({ type: 'NOT_AN_ACK' });
  const result = await wait;
  ck('mismatched ACK is ignored', result.ok === false && result.reason === 'timeout');
}
{
  // 6. A characteristic that cannot notify cannot prove delivery.
  const bare = { addEventListener: undefined, removeEventListener: undefined };
  const result = await awaitAck(bare, { packetKey: 'k', packetHash: 'x', timeoutMs: 40 });
  ck('no ACK channel reports ack_unavailable', result.reason === 'ack_unavailable');
}
{
  // 7. The probe is a real end-to-end test, not a capability guess.
  reset();
  const fake = fakeDevice();
  setBluetooth(fake.requestDevice);
  const result = await probeDirectRelay();
  ck('probe reports carried on ACK', result.ok === true && /Test Relay/.test(result.detail));
}
{
  // 8. A cancelled chooser is reported plainly.
  reset();
  setBluetooth(async () => { throw new Error('User cancelled the requestDevice() chooser.'); });
  const result = await probeDirectRelay();
  ck('cancelled probe is not a success', result.ok === false);
  ck('cancelled probe is worded plainly', /no relay device was selected/i.test(result.detail));
}
{
  // 9. Web Bluetooth present but blocked: point at the relay app, do not claim success.
  reset();
  setBluetooth(async () => { const e = new Error('Bluetooth adapter not available.'); e.name = 'SecurityError'; throw e; });
  const result = await probeDirectRelay();
  ck('blocked probe is not a success', result.ok === false);
  ck('blocked probe suggests turning Bluetooth on', /turn it on to relay/i.test(result.detail));
}
{
  // 10. A native bridge always wins: direct sends defer to it.
  reset();
  globalThis.window.REACH_NATIVE_RELAY = { sendPacket: () => '{}' };
  setBluetooth(fakeDevice().requestDevice);
  const result = await sendPacketViaDirectRelay(smallPacket());
  ck('native bridge defers the direct path', result.ok === false && result.reason === 'native_bridge');
  globalThis.window.REACH_NATIVE_RELAY = undefined;
}

console.log(`\nTOTAL: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
