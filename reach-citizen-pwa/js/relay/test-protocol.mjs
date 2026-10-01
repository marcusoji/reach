import assert from 'node:assert/strict';
import { buildRelayPacket, validateRelayPacket, toServerPacket, RELAY_LIMITS } from './protocol.js';

// protocol.js persists its identity in IndexedDB, which Node does not provide.
function makeIndexedDB() {
  const data = new Map();
  const req = (fn) => { const r = {}; queueMicrotask(() => { try { r.result = fn(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); } }); return r; };
  const store = { get: (k) => req(() => data.get(k)), put: (v, k) => req(() => data.set(k, v)) };
  const db = { transaction: () => { const tx = {}; tx.objectStore = () => store; queueMicrotask(() => tx.oncomplete?.()); return tx; } };
  return { open: () => { const r = {}; queueMicrotask(() => { r.result = db; r.onsuccess?.(); }); return r; } };
}
globalThis.indexedDB = makeIndexedDB();

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const derToP1363 = (der) => {
  if (der[0] !== 0x30) throw new Error('bad DER');
  let i = 2; if (der[i] === 0x81) i += 1;
  if (der[i++] !== 0x02) throw new Error('bad R');
  const rLen = der[i++]; const r = der.slice(i, i + rLen); i += rLen;
  if (der[i++] !== 0x02) throw new Error('bad S');
  const sLen = der[i++]; const s = der.slice(i, i + sLen);
  const out = new Uint8Array(64);
  out.set(r.slice(Math.max(0, r.length - 32)), 32 - Math.min(32, r.length));
  out.set(s.slice(Math.max(0, s.length - 32)), 64 - Math.min(32, s.length));
  return out;
};

const built = await buildRelayPacket({ packetKey: 'test-12345678', incidentId: 'test-incident', category: 'fire', priority: 'critical', title: 'Fire', description: 'Smoke seen', locationLabel: 'Zone A', locationSource: 'manual', locationAccuracyM: 25, latitude: 6.2, longitude: 6.7 });

// basic validity and size
assert.equal(validateRelayPacket(built.packet).ok, true, 'fresh packet validates');
assert.ok(built.bytes < RELAY_LIMITS.maxBytes, 'packet within size limit');

// the signed payload must NOT contain x, or the fingerprint is self-referential
assert.ok(!built.packet.source_signed_payload.includes('&x='), 'signed payload omits x');
assert.equal(await sha256(built.packet.source_signed_payload), built.packet.x, 'x is sha256(signed payload)');

// the signature must verify over the signed payload with the advertised key
{
  const key = await crypto.subtle.importKey('spki', Uint8Array.from(atob(built.packet.source_public_key), (c) => c.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const der = Uint8Array.from(atob(built.packet.source_signature), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToP1363(der), new TextEncoder().encode(built.packet.source_signed_payload));
  assert.equal(ok, true, 'source signature verifies');
}

// payload fields carried through with snake_case keys (server contract)
assert.equal(built.packet.minimal_payload.title, 'Fire', 'title carried');
assert.equal(built.packet.minimal_payload.location_label, 'Zone A', 'location_label carried');
assert.equal(built.packet.minimal_payload.location_source, 'manual', 'location_source carried');
assert.equal(built.packet.minimal_payload.location_accuracy_m, 25, 'location_accuracy_m carried');
assert.equal(built.packet.minimal_payload.latitude, 6.2, 'latitude carried');
assert.equal(built.packet.minimal_payload.longitude, 6.7, 'longitude carried');

// tampering and limits
assert.equal(validateRelayPacket({ ...built.packet, e: Date.now() - 1 }).ok, false, 'expired rejected');
assert.equal(validateRelayPacket({ ...built.packet, h: built.packet.m }).ok, false, 'hop limit rejected');
assert.equal(validateRelayPacket({ ...built.packet, m: RELAY_LIMITS.maxHops + 1 }).ok, false, 'excess max hops rejected');

// server body mapping
const body = toServerPacket(built.packet);
assert.equal(body.packet_hash, built.packet.x);
assert.equal(body.source_signed_payload, built.packet.source_signed_payload);
assert.equal(body.transport, 'pwa');
assert.equal(new Date(body.ttl_expires_at).getTime(), built.packet.e);

// every build must succeed (regression: subtle.sign returns an ArrayBuffer)
for (let i = 0; i < 10; i++) {
  const p = await buildRelayPacket({ packetKey: `pwa-${i}`, incidentId: null, category: 'medical', priority: 'high', locationLabel: 'X', locationSource: 'gps', latitude: 1, longitude: 2 });
  assert.ok(p.packet.source_signature.length > 0, `packet ${i} built`);
}

console.log('relay protocol tests: PASS');
