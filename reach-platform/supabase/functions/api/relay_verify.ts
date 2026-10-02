/** Relay packet verification, extracted from the request handler in index.ts so it can be
 * exercised directly by tests instead of only through a live Edge Function request.
 *
 * Everything here is pure or takes injected dependencies; the caller supplies the actor's
 * institution id and the service client used for gateway dedup.
 */
import { canonicalSourceSigned, canonicalRelaySigned, relayFingerprint } from './relay_protocol.ts';

export type RelayBody = Record<string, unknown>;
export type RelayDeps = { actorInstitutionId: string | null; dedup: { record(packetKey: string, packetHash: string, institutionId: string | null): Promise<void> } };
export type RelayVerdict = { ok: true; packet: RelayBody } | { ok: false; error: string; status: number };

export const textValue = (value: unknown, max = 1000): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

const derToP1363 = (der: Uint8Array) => {
  if (der[0] !== 0x30) throw new Error('Invalid ECDSA signature');
  let i = 2; if (der[i] === 0x81) i += 1;
  if (der[i++] !== 0x02) throw new Error('Invalid ECDSA R');
  const rLen = der[i++]; const r = der.slice(i, i + rLen); i += rLen;
  if (der[i++] !== 0x02) throw new Error('Invalid ECDSA S');
  const sLen = der[i++]; const ss = der.slice(i, i + sLen);
  const out = new Uint8Array(64); out.set(r.slice(Math.max(0, r.length - 32)), 32 - Math.min(32, r.length)); out.set(ss.slice(Math.max(0, ss.length - 32)), 64 - Math.min(32, ss.length)); return out;
};

export const verifyEcdsa = async (publicKeyB64: string, signatureB64: string, message: string) => {
  try {
    const keyBytes = Uint8Array.from(atob(publicKeyB64), c => c.charCodeAt(0));
    const der = Uint8Array.from(atob(signatureB64), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('spki', keyBytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToP1363(der), new TextEncoder().encode(message));
  } catch {
    // Malformed key/signature bytes are a verification failure, not a server error.
    return false;
  }
};

/** Verify a /relay/packets body end to end. Rejections carry the HTTP status the handler uses. */
export async function verifyRelayBody(body: RelayBody, deps: RelayDeps): Promise<RelayVerdict> {
  const packetKey = textValue(body.packet_key, 160);
  const packetHash = textValue(body.packet_hash, 256);
  const sourceDevice = textValue(body.source_device_id, 160);
  const sourceKey = textValue(body.source_public_key, 4096);
  const sourceSignature = textValue(body.source_signature, 4096);
  const sourceSignedPayload = textValue(body.source_signed_payload, 12000);
  const relayDevice = textValue(body.relay_device_id, 160);
  const relayKey = textValue(body.relay_public_key, 4096);
  const relaySignature = textValue(body.relay_signature, 4096);
  const relaySignedPayload = textValue(body.relay_signed_payload, 12000);
  if (!packetKey || !packetHash || !sourceDevice || !sourceKey || !sourceSignature || !sourceSignedPayload) return { ok: false, error: 'Authenticated relay identity is required', status: 422 };
  const hops = Number(body.hop_count ?? 0); const maxHops = Number(body.max_hops ?? 6);
  if (!Number.isInteger(hops) || !Number.isInteger(maxHops) || hops < 0 || maxHops < 1 || maxHops > 6 || hops >= maxHops) return { ok: false, error: 'Invalid relay hop values', status: 422 };
  if (relayDevice && (!relayKey || !relaySignature || !relaySignedPayload)) return { ok: false, error: 'Relay envelope signature is incomplete', status: 422 };
  // The source-signed payload does not cover `h` (see relay_protocol.ts), so a packet uploaded
  // straight to the gateway could claim any hop count. Only a forwarding relay node increments
  // it, and that node signs `h` into the relay envelope — so a non-zero hop count without a
  // relay envelope is a claim nothing can vouch for.
  if (hops > 0 && !relayDevice) return { ok: false, error: 'Relay hop count requires a relay envelope', status: 422 };

  const sourceFields = { v: body.v ?? 2, k: packetKey, e: Date.parse(String(body.ttl_expires_at)), m: maxHops, incident_id: body.incident_id, source_device_id: sourceDevice, minimal_payload: body.minimal_payload ?? {} };
  // The signed payload omits x (see relay_protocol.ts): x is sha256 of that payload, so
  // embedding x in it would require a hash to contain its own digest.
  if (canonicalSourceSigned(sourceFields) !== sourceSignedPayload) return { ok: false, error: 'Source signed payload does not match packet', status: 403 };
  if (!(await verifyEcdsa(sourceKey, sourceSignature, sourceSignedPayload))) return { ok: false, error: 'Invalid source packet signature', status: 403 };
  if ((await relayFingerprint(sourceSignedPayload)) !== packetHash) return { ok: false, error: 'Packet fingerprint mismatch', status: 403 };

  // Gateway dedup: packet_key + packet_hash (multi-path safe: BLE/Wi-Fi/PWA)
  await deps.dedup.record(packetKey, packetHash, deps.actorInstitutionId);

  if (relayDevice) {
    const expectedRelaySigned = canonicalRelaySigned({ v: body.v ?? 2, k: packetKey, e: Date.parse(String(body.ttl_expires_at)), h: hops, m: maxHops, incident_id: body.incident_id, source_device_id: sourceDevice, x: packetHash, relay_device_id: relayDevice, minimal_payload: body.minimal_payload ?? {} });
    if (expectedRelaySigned !== relaySignedPayload) return { ok: false, error: 'Relay signed payload does not match packet', status: 403 };
    if (!(await verifyEcdsa(relayKey!, relaySignature!, relaySignedPayload!))) return { ok: false, error: 'Invalid relay signature', status: 403 };
  }
  const packet = { ...body, packet_key: packetKey, packet_hash: packetHash, hop_count: hops, max_hops: maxHops, transport: textValue(body.transport, 30) ?? 'native' };
  return { ok: true, packet };
}
