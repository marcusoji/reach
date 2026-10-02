/** Shared relay packet canonicalisation, used by the Edge Function's /relay/packets
 * verification. The Kotlin relay node mirrors this in DeviceIdentity.kt and the PWA
 * in js/relay/protocol.js — keep the key orders in sync across all three.
 */

export const RELAY_MAX_HOPS = 6;
export const RELAY_TTL_MS = 30 * 60 * 1000;

export const SOURCE_SIGNED_KEYS = ['v', 'k', 'e', 'm', 'incident_id', 'source_device_id', 'minimal_payload'];
export const RELAY_SIGNED_KEYS = ['v', 'k', 'e', 'h', 'm', 'incident_id', 'source_device_id', 'x', 'relay_device_id', 'minimal_payload'];

const value = (v: unknown) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v));
const build = (p: Record<string, unknown>, keys: string[]) => keys.map((k) => `${k}=${value(p[k])}`).join('&');

/**
 * The source-signed payload deliberately omits `x`. `x` is defined as the SHA-256 of
 * this exact string, so embedding `x` inside it would be self-referential: no hash can
 * equal the digest of a string containing that same hash. The fingerprint still binds
 * every other field, and the ECDSA signature over this string binds `x`.
 */
export const canonicalSourceSigned = (p: Record<string, unknown>) => build(p, SOURCE_SIGNED_KEYS);
export const canonicalRelaySigned = (p: Record<string, unknown>) => build(p, RELAY_SIGNED_KEYS);

export const relayFingerprint = async (signedPayload: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signedPayload))))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
