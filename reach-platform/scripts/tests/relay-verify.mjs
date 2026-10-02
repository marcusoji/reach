/**
 * Deep verification of the REACH relay protocol.
 *
 * Unlike the earlier harness this imports the REAL server verification module
 * (relay_verify.ts, the same one index.ts calls) rather than a copy, so a divergence
 * between test and production code cannot hide. The PWA side is the real protocol.js.
 *
 * The only synthetic pieces are: an indexedDB shim (protocol.js persists its identity
 * there) and a fake GATT characteristic for the BLE framing checks.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.join(HERE, '..', '..', 'supabase', 'functions', 'api');
const PWA = path.join(HERE, '..', '..', '..', 'reach-citizen-pwa', 'js', 'relay');

// --- transpile the TypeScript modules under test (CI runs Node 20, no type stripping) ---
const outDir = mkdtempSync(path.join(tmpdir(), 'reach-relay-'));
const transpile = (file) => {
  const js = ts.transpileModule(readFileSync(path.join(API, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/\.ts(['"])/g, '.mjs$1');
  const out = path.join(outDir, file.replace(/\.ts$/, '.mjs'));
  writeFileSync(out, js);
  return pathToFileURL(out).href;
};
const relayProtocolHref = transpile('relay_protocol.ts');
const relayVerifyHref = transpile('relay_verify.ts');
const { canonicalSourceSigned, canonicalRelaySigned, relayFingerprint, SOURCE_SIGNED_KEYS, RELAY_SIGNED_KEYS } = await import(relayProtocolHref);
const { verifyRelayBody } = await import(relayVerifyHref);

// --- indexedDB shim so the real PWA protocol.js can persist its identity ---
function makeIndexedDB() {
  const data = new Map();
  const req = (fn) => { const r = {}; queueMicrotask(() => { try { r.result = fn(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); } }); return r; };
  const store = { get: (k) => req(() => data.get(k)), put: (v, k) => req(() => data.set(k, v)) };
  const db = { transaction: () => { const tx = {}; tx.objectStore = () => store; queueMicrotask(() => tx.oncomplete?.()); return tx; } };
  return { open: () => { const r = {}; queueMicrotask(() => { r.result = db; r.onsuccess?.(); }); return r; } };
}
globalThis.indexedDB = makeIndexedDB();
const { buildRelayPacket, toServerPacket, RELAY_LIMITS, sendBluetoothPacket } = await import(pathToFileURL(path.join(PWA, 'protocol.js')).href);

// --- harness ---
let pass = 0, fail = 0;
const results = [];
const S = (t) => console.log(`\n=== ${t} ===`);
function ck(name, ok, detail = '') { results.push({ name, ok }); if (ok) { pass++; console.log(`  [PASS] ${name}${detail ? '  — ' + detail : ''}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); } }

// --- helpers ---
const enc = (s) => new TextEncoder().encode(s);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const p1363ToDer = (raw) => {
  const r = raw.slice(0, 32), s = raw.slice(32);
  const trim = (x) => { let i = 0; while (i < x.length - 1 && x[i] === 0) i++; let y = x.slice(i); if (y[0] & 0x80) y = new Uint8Array([0, ...y]); return y; };
  const rr = trim(r), ss = trim(s);
  const body = new Uint8Array(2 + rr.length + 2 + ss.length); let i = 0;
  body[i++] = 2; body[i++] = rr.length; body.set(rr, i); i += rr.length;
  body[i++] = 2; body[i++] = ss.length; body.set(ss, i);
  const head = body.length < 128 ? new Uint8Array([0x30, body.length]) : new Uint8Array([0x30, 0x81, body.length]);
  const out = new Uint8Array(head.length + body.length); out.set(head); out.set(body, head.length); return out;
};
const dedupCalls = [];
const deps = (institutionId = null) => ({ actorInstitutionId: institutionId, dedup: { record: async (k, h, inst) => { dedupCalls.push({ k, h, inst }); } } });

const build = (overrides = {}) => buildRelayPacket({
  packetKey: 'pwa-12345678-abcd', incidentId: null, category: 'fire', priority: 'critical',
  title: 'Fire', description: 'Smoke seen', locationLabel: 'Zone A', locationSource: 'manual',
  locationAccuracyM: 25, latitude: 6.2, longitude: 6.7, ...overrides,
});

// =====================================================================
S('A. Canonical form parity (PWA protocol.js vs server relay_protocol.ts)');
{
  const { packet } = await build();
  const body = toServerPacket(packet);
  const serverFields = { v: body.v ?? 2, k: body.packet_key, e: Date.parse(body.ttl_expires_at), m: body.max_hops, incident_id: body.incident_id, source_device_id: body.source_device_id, minimal_payload: body.minimal_payload ?? {} };
  ck('server canonical source == PWA signed payload', canonicalSourceSigned(serverFields) === packet.source_signed_payload);
  ck('server fingerprint == PWA x', (await relayFingerprint(packet.source_signed_payload)) === packet.x);
  ck('signed payload omits x (no self-reference)', !packet.source_signed_payload.includes('&x='));
  // key order is the cross-language contract (Kotlin mirrors it)
  ck('source key order is v,k,e,m,incident_id,source_device_id,minimal_payload',
    packet.source_signed_payload.startsWith('v=2&k=pwa-12345678-abcd&e=') && packet.source_signed_payload.includes('&m=6&incident_id=null&source_device_id=') && packet.source_signed_payload.includes('&minimal_payload='));
  // object values must serialise identically on both sides
  const nested = { a: 1, b: { c: [1, 2] } };
  ck('nested object values canonicalise identically', canonicalSourceSigned({ minimal_payload: nested }) === 'v=undefined&k=undefined&e=undefined&m=undefined&incident_id=undefined&source_device_id=undefined&minimal_payload=' + JSON.stringify(nested));
  ck('null/undefined render as "undefined" on the server', canonicalSourceSigned({ k: undefined }).includes('k=undefined'));
}

// =====================================================================
S('B. Sign → server verify round trip (real verifyRelayBody)');
{
  dedupCalls.length = 0;
  const { packet } = await build();
  const v = await verifyRelayBody(toServerPacket(packet), deps('inst-1'));
  ck('a freshly built packet is accepted', v.ok === true, v.ok ? '' : `rejected: ${v.error}`);
  ck('accepted packet carries normalised fields', v.ok && v.packet.packet_key === packet.k && v.packet.packet_hash === packet.x && v.packet.transport === 'pwa');
  ck('dedup recorded exactly once with key+hash', dedupCalls.length === 1 && dedupCalls[0].k === packet.k && dedupCalls[0].h === packet.x, `calls=${dedupCalls.length}`);
  ck('dedup received the actor institution', dedupCalls[0]?.inst === 'inst-1');
  ck('transport defaults to native when absent', (await verifyRelayBody({ ...toServerPacket(packet), transport: undefined }, deps())).packet?.transport === 'native');
}

// =====================================================================
S('C. Tamper rejection');
{
  const { packet } = await build();
  const base = toServerPacket(packet);
  const cases = [
    ['payload edited after signing', { ...base, minimal_payload: { ...base.minimal_payload, title: 'Not a fire' } }, 403],
    ['priority edited after signing', { ...base, minimal_payload: { ...base.minimal_payload, priority: 'low' } }, 403],
    ['packet_hash replaced', { ...base, packet_hash: 'f'.repeat(64) }, 403],
    ['signature replaced', { ...base, source_signature: b64(new Uint8Array(70)) }, 403],
    ['public key swapped', { ...base, source_public_key: base.source_public_key.slice(0, -4) + 'AAAA' }, 403],
    ['ttl edited after signing', { ...base, ttl_expires_at: new Date(Date.parse(base.ttl_expires_at) + 60000).toISOString() }, 403],
    ['incident_id edited after signing', { ...base, incident_id: '00000000-0000-4000-8000-000000000000' }, 403],
    ['source_device_id edited after signing', { ...base, source_device_id: 'attacker-device-id' }, 403],
  ];
  for (const [name, body, status] of cases) {
    const v = await verifyRelayBody(body, deps());
    ck(name, v.ok === false && v.status === status, v.ok ? 'ACCEPTED (bad)' : `status=${v.status}`);
  }
  // signature bytes that are valid base64 but not DER must be a clean 403, not a 500
  const malformed = await verifyRelayBody({ ...base, source_signature: b64(enc('not-a-der-signature')) }, deps());
  ck('malformed DER signature is a clean 403', malformed.ok === false && malformed.status === 403);
  const emptyKey = await verifyRelayBody({ ...base, source_public_key: b64(enc('not-a-key')) }, deps());
  ck('malformed public key is a clean 403', emptyKey.ok === false && emptyKey.status === 403);
}

// =====================================================================
S('D. Hop, TTL, size and shape boundaries');
{
  const { packet } = await build();
  const base = toServerPacket(packet);
  // Valid hop combinations: a direct gateway upload is always h=0 (see the hop-spoof rule below);
  // a forwarded packet needs a relay envelope, which section E covers.
  for (const [name, h, m] of [['h=0 of m=1 accepted', 0, 1], ['h=0 of m=6 accepted', 0, 6]]) {
    const { packet: p } = await buildRelayPacket({ packetKey: `pwa-hop-${h}-${m}-0000`, incidentId: null, category: 'fire', priority: 'high', title: 't', description: 'd', locationLabel: 'L', locationSource: 'manual', hopCount: h, maxHops: m });
    const v = await verifyRelayBody(toServerPacket(p), deps());
    ck(name, v.ok === true, v.ok ? '' : `rejected: ${v.error}`);
  }
  // Invalid hop values are rejected before signature verification, so send them raw.
  for (const [name, h, m] of [
    ['h=m rejected (hop exhausted)', 6, 6],
    ['h>m rejected', 7, 6],
    ['m=7 rejected (above ceiling)', 0, 7],
    ['m=0 rejected', 0, 0],
    ['negative hop rejected', -1, 6],
    ['non-integer hop rejected', 1.5, 6],
    ['non-integer max rejected', 0, 1.5],
  ]) {
    const v = await verifyRelayBody({ ...base, hop_count: h, max_hops: m }, deps());
    ck(name, v.ok === false && v.status === 422, `status=${v.status}${v.ok ? ' ACCEPTED (bad)' : ''}`);
  }
  // The source signature does not cover `h`, so an unsigned hop claim must be refused.
  const spoofedHop = await verifyRelayBody({ ...base, hop_count: 3 }, deps());
  ck('non-zero hop without a relay envelope is refused', spoofedHop.ok === false && spoofedHop.status === 422, `status=${spoofedHop.status}${spoofedHop.ok ? ' ACCEPTED (bad)' : ''}`);

  const missing = [
    ['missing packet_key', { ...base, packet_key: undefined }, 422],
    ['missing packet_hash', { ...base, packet_hash: undefined }, 422],
    ['missing source_device_id', { ...base, source_device_id: undefined }, 422],
    ['missing source_public_key', { ...base, source_public_key: undefined }, 422],
    ['missing source_signature', { ...base, source_signature: undefined }, 422],
    ['missing source_signed_payload', { ...base, source_signed_payload: undefined }, 422],
  ];
  for (const [name, body, status] of missing) {
    const v = await verifyRelayBody(body, deps());
    ck(name, v.ok === false && v.status === status, v.ok ? 'ACCEPTED (bad)' : `status=${v.status}`);
  }
  // buildRelayPacket enforces size and hop at construction time
  const big = await build({ description: 'x'.repeat(5000) }).then(() => 'built').catch(() => 'threw');
  ck('oversized packet is rejected at build time', big === 'threw');
  const badHop = await build({ hopCount: 6, maxHops: 6 }).then(() => null).catch(() => 'threw');
  ck('builder rejects hopCount >= maxHops', badHop === 'threw');
}

// =====================================================================
S('E. Relay envelope (multi-hop forwarding node)');
{
  // A forwarding node adds relay_device_id + its own signature over the relay canonical form.
  const relayKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const relayPubB64 = b64(new Uint8Array(await crypto.subtle.exportKey('spki', relayKeys.publicKey)));
  const relayDeviceId = 'relay-node-0001';
  const withRelay = async (hops = 0, mutate = (x) => x) => {
    const { packet } = await build({ hopCount: hops, maxHops: 6 });
    const body = toServerPacket(packet);
    body.hop_count = hops;
    const fields = { v: body.v ?? 2, k: body.packet_key, e: Date.parse(body.ttl_expires_at), h: hops, m: body.max_hops, incident_id: body.incident_id, source_device_id: body.source_device_id, x: body.packet_hash, relay_device_id: relayDeviceId, minimal_payload: body.minimal_payload };
    const signed = canonicalRelaySigned(mutate(fields));
    const raw = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, relayKeys.privateKey, enc(signed));
    return { ...body, relay_device_id: relayDeviceId, relay_public_key: relayPubB64, relay_signed_payload: signed, relay_signature: b64(p1363ToDer(new Uint8Array(raw))) };
  };
  const good = await withRelay();
  const v = await verifyRelayBody(good, deps());
  ck('relay-signed envelope accepted', v.ok === true, v.ok ? '' : `rejected: ${v.error}`);
  // A forwarded packet carries h>0; the relay envelope is what vouches for it.
  const forwarded = await withRelay(1);
  const vf = await verifyRelayBody(forwarded, deps());
  ck('forwarded packet (h=1) with a relay envelope is accepted', vf.ok === true, vf.ok ? '' : `rejected: ${vf.error}`);
  ck('relay key order is v,k,e,h,m,incident_id,source_device_id,x,relay_device_id,minimal_payload',
    good.relay_signed_payload.startsWith('v=2&k=') && good.relay_signed_payload.includes('&x=') && good.relay_signed_payload.includes('&relay_device_id=relay-node-0001&minimal_payload='));
  // tampering the relay layer
  const badSig = await withRelay();
  const v2 = await verifyRelayBody({ ...badSig, relay_signature: b64(new Uint8Array(70)) }, deps());
  ck('relay signature tamper rejected', v2.ok === false && v2.status === 403);
  const badDevice = await withRelay();
  const v3 = await verifyRelayBody({ ...badDevice, relay_device_id: 'other-node' }, deps());
  ck('relay_device_id swap rejected (payload mismatch)', v3.ok === false && v3.status === 403);
  const badX = await withRelay();
  const v4 = await verifyRelayBody({ ...badX, packet_hash: 'a'.repeat(64) }, deps());
  ck('relay x swap rejected', v4.ok === false);
  // incomplete envelope
  const inc = await verifyRelayBody({ ...toServerPacket((await build()).packet), relay_device_id: 'relay-node-0001' }, deps());
  ck('relay_device_id without key/sig is 422', inc.ok === false && inc.status === 422);
  // source signature must still verify even with a valid relay layer
  const bothTampered = { ...good, source_signature: b64(new Uint8Array(70)) };
  const v5 = await verifyRelayBody(bothTampered, deps());
  ck('source signature still enforced on relayed packets', v5.ok === false && v5.status === 403);
}

// =====================================================================
S('F. Fuzz: random mutations of signed fields are never accepted');
{
  const { packet } = await build();
  const base = toServerPacket(packet);
  // Only fields covered by the source-signed payload. `transport` is not signed, and a deleted
  // `incident_id` normalises back to `null` in the canonical form, so neither is a real tamper.
  const fields = ['packet_key', 'packet_hash', 'source_device_id', 'source_public_key', 'source_signature', 'source_signed_payload', 'ttl_expires_at'];
  let accepted = 0, mutated = 0;
  const rnd = (() => { let s = 12345; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  for (let i = 0; i < 600; i++) {
    const body = { ...base, minimal_payload: { ...base.minimal_payload } };
    const f = fields[Math.floor(rnd() * fields.length)];
    const mode = rnd();
    if (mode < 0.5) body[f] = typeof base[f] === 'number' ? base[f] + 1 + Math.floor(rnd() * 5) : String(base[f] ?? '') + 'X';
    else if (mode < 0.75) delete body[f];
    else body.minimal_payload.title = String(body.minimal_payload.title) + 'X';
    mutated++;
    const v = await verifyRelayBody(body, deps());
    if (v.ok) accepted++;
  }
  ck('no mutated packet is accepted', accepted === 0, `${accepted}/${mutated} accepted`);
}

// =====================================================================
S('G. Dedup contract');
{
  dedupCalls.length = 0;
  const { packet } = await build();
  await verifyRelayBody(toServerPacket(packet), deps('inst-A'));
  const { packet: p2 } = await build({ packetKey: 'pwa-second-0000' });
  await verifyRelayBody(toServerPacket(p2), deps('inst-B'));
  ck('dedup called once per accepted packet', dedupCalls.length === 2, `calls=${dedupCalls.length}`);
  ck('dedup keys are unique per packet', new Set(dedupCalls.map((c) => c.k)).size === 2);
  // a rejected packet must not reach dedup
  dedupCalls.length = 0;
  await verifyRelayBody({ ...toServerPacket(packet), packet_hash: 'b'.repeat(64) }, deps());
  ck('rejected packets do not touch dedup', dedupCalls.length === 0, `calls=${dedupCalls.length}`);
}

// =====================================================================
S('H. BLE framing (PWA sender, fake GATT characteristic)');
{
  const written = [];
  const connection = { characteristic: { writeValueWithResponse: async (frame) => { written.push(new Uint8Array(frame)); } } };
  const { packet } = await build();
  await sendBluetoothPacket(connection, packet);
  const HEADER = 6;
  const reassembled = new Uint8Array(written.reduce((n, f) => n + f.length - HEADER, 0));
  let off = 0;
  const totals = new Set();
  for (const f of written) {
    const total = f[5];
    totals.add(total);
    reassembled.set(f.slice(HEADER), off); off += f.length - HEADER;
  }
  const json = new TextDecoder().decode(reassembled);
  const transferIds = new Set(written.map((f) => [...f.slice(0, 4)].join(',')));
  ck('BLE frames carry a 4-byte transfer id + seq + total header', written.every((f) => f.length > HEADER));
  ck('every fragment shares one transfer id', transferIds.size === 1, `ids=${transferIds.size}`);
  ck('all frames agree on the fragment total', totals.size === 1, `totals=${[...totals]}`);
  ck('fragment count matches the frame total', [...totals][0] === written.length, `total=${[...totals][0]} frames=${written.length}`);
  ck('reassembled payload is byte-identical to the packet', json === JSON.stringify(packet));
  ck('each fragment body respects the 180-byte chunk limit', written.every((f) => f.length - HEADER <= RELAY_LIMITS.bleChunkBytes));
  // frames are emitted in order
  const seqs = written.map((f) => f[4]);
  ck('fragments are emitted in sequence order', seqs.every((s, i) => s === i), `seqs=${seqs.slice(0, 6)}...`);
}

// =====================================================================
S('I. Production wiring guards');
{
  const indexTs = readFileSync(path.join(API, 'index.ts'), 'utf8');
  ck('index.ts uses the extracted verifier', indexTs.includes('verifyRelayBody('));
  ck('index.ts no longer inlines a second verifyEcdsa', !indexTs.includes('const verifyEcdsa'));
  ck('index.ts still calls the trusted service RPC', indexTs.includes("rpc('ingest_relay_packet_service'"));
  const verifyTs = readFileSync(path.join(API, 'relay_verify.ts'), 'utf8');
  ck('verifier binds the fingerprint to the signed payload', verifyTs.includes('relayFingerprint(sourceSignedPayload)'));
}

// =====================================================================
S('J. Cross-language canonical key order (Kotlin relay node)');
{
  // The Kotlin node mirrors this canonicalisation in DeviceIdentity.kt. The key order is the
  // contract; if it drifts, every signature the node produces is rejected. Assert the exact
  // quoted key lists rather than a loose presence check.
  const identityKt = readFileSync(path.join(HERE, '..', '..', '..', 'relay-node-android', 'app', 'src', 'main', 'java', 'com', 'reach', 'relay', 'DeviceIdentity.kt'), 'utf8');
  const kotlinList = (fn) => {
    const m = identityKt.match(new RegExp(`fun ${fn}\\(packet:org\\.json\\.JSONObject\\):String = listOf\\(([\\s\\S]*?)\\)\\.joinToString`));
    return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : null;
  };
  const source = kotlinList('canonicalSource');
  const relay = kotlinList('canonicalRelay');
  ck('DeviceIdentity.canonicalSource found', Array.isArray(source));
  ck('DeviceIdentity.canonicalRelay found', Array.isArray(relay));
  ck('Kotlin source key order matches the shared contract',
    JSON.stringify(source) === JSON.stringify(['v', 'k', 'e', 'm', 'incident_id', 'source_device_id', 'minimal_payload']),
    JSON.stringify(source));
  ck('Kotlin relay key order matches the shared contract',
    JSON.stringify(relay) === JSON.stringify(['v', 'k', 'e', 'h', 'm', 'incident_id', 'source_device_id', 'x', 'relay_device_id', 'minimal_payload']),
    JSON.stringify(relay));
  ck('Kotlin source canonical omits x', !source.includes('x'));
  // The TS/PWA lists must agree with each other and with Kotlin.
  ck('TS source key order matches Kotlin', JSON.stringify([...SOURCE_SIGNED_KEYS]) === JSON.stringify(source));
  ck('TS relay key order matches Kotlin', JSON.stringify([...RELAY_SIGNED_KEYS]) === JSON.stringify(relay));
}

// =====================================================================
console.log('\n' + '='.repeat(64));
console.log(`TOTAL: ${pass}/${pass + fail} passed`);
console.log('='.repeat(64));
process.exit(fail ? 1 : 0);
