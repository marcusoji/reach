/**
 * Exercises the citizen estate-join client path in reach-citizen-pwa/js/backend.js.
 *
 * A citizen joins an estate with an institution-issued code so their reports are attributed to
 * that institution. These tests pin that getProfile reads the linked estate from /me and that
 * joinInstitution posts the code to /citizen/join, translating a rejected code into a readable
 * message rather than a raw HTTP status.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PWA = path.join(HERE, '..', '..', '..', 'reach-citizen-pwa', 'js');

const ls = new Map();
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
globalThis.window = { REACH_CONFIG: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon' }, addEventListener: () => {}, setInterval: () => 0 };
const nav = { onLine: true };
Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });

ls.set('reach_pwa_session', JSON.stringify({ access_token: 'tok', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600 }));

const calls = [];
let meBody = { data: { id: 'u1', institution_id: null, institution_name: null } };
let joinBody = { data: { institution_id: 'inst-1', institution_name: 'Greenfield Estate' } };
let joinStatus = 200;
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
  if (String(url).includes('/citizen/join')) return { ok: joinStatus < 400, status: joinStatus, json: async () => joinBody };
  if (String(url).includes('/me')) return { ok: true, status: 200, json: async () => meBody };
  return { ok: false, status: 404, json: async () => ({}) };
};

const backend = await import(pathToFileURL(path.join(PWA, 'backend.js')).href);

let pass = 0, fail = 0;
const ck = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  [PASS] ${name}${detail ? '  — ' + detail : ''}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); } };

console.log('\n=== PWA estate join ===');
{
  const profile = await backend.getProfile();
  ck('getProfile reads /me', calls.some(c => c.url.endsWith('/me')));
  ck('an unlinked citizen reports no institution', profile.institution_id === null);
}
{
  meBody = { data: { id: 'u1', institution_id: 'inst-1', institution_name: 'Greenfield Estate' } };
  const profile = await backend.getProfile();
  ck('a linked citizen exposes the estate name', profile.institution_name === 'Greenfield Estate');
}
{
  const result = await backend.joinInstitution('REACH-ABC123');
  const call = calls.find(c => c.url.endsWith('/citizen/join'));
  ck('joinInstitution posts to /citizen/join', Boolean(call) && call.method === 'POST');
  ck('the join code is sent in the body', call && JSON.parse(call.body).code === 'REACH-ABC123');
  ck('the join response is returned', result.institution_name === 'Greenfield Estate');
}
{
  joinStatus = 422;
  joinBody = { error: 'Invalid or expired join code' };
  let message = '';
  try { await backend.joinInstitution('BAD'); } catch (e) { message = e.message; }
  ck('a rejected code surfaces the server message', /invalid or expired join code/i.test(message), message);
  ck('no raw status leaks to the user', !/422/.test(message));
}

console.log(`\nTOTAL: ${pass}/${pass + fail} passed`);
assert.equal(fail, 0, `${fail} estate-join assertion(s) failed`);
