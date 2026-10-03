/**
 * Exercises the PWA backend's network-failure handling in js/backend.js.
 *
 * A CORS rejection or a dead socket reaches the browser as an opaque `TypeError: Failed to
 * fetch`. These tests pin the behaviour that turned the signup report into a confusing loop:
 * the error must be understandable, a hung request must time out, and a successful auth signup
 * must be usable even when the follow-up profile sync fails.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PWA = path.join(HERE, '..', '..', '..', 'reach-citizen-pwa', 'js');

const ls = new Map();
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
globalThis.window = { REACH_CONFIG: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon' }, REACH_REQUEST_TIMEOUT_MS: 150, addEventListener: () => {}, setInterval: () => 0 };
const nav = { onLine: true };
Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });

let mode = 'ok';
globalThis.fetch = async (url, init = {}) => {
  if (mode === 'network-error') throw new TypeError('Failed to fetch');
  if (mode === 'hang') return new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  if (String(url).includes('/auth/v1/signup')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', refresh_token: 'r', user: { id: 'u1' } }) };
  if (String(url).includes('/me')) return { ok: true, status: 200, json: async () => ({ data: { id: 'u1' } }) };
  return { ok: false, status: 404, json: async () => ({}) };
};

const backend = await import(pathToFileURL(path.join(PWA, 'backend.js')).href);

let pass = 0, fail = 0;
const ck = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  [PASS] ${name}${detail ? '  — ' + detail : ''}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); } };

console.log('\n=== PWA API resilience ===');
{
  // 1. A raw network failure is translated, not surfaced as "Failed to fetch".
  mode = 'network-error';
  let message = '';
  try { await backend.signup({ email: 'a@b.co', password: 'longenough1', fullName: 'A' }); } catch (e) { message = e.message; }
  ck('network failure is explained', /could not reach reach/i.test(message), message);
  ck('raw "Failed to fetch" never reaches the user', !/failed to fetch/i.test(message));
}
{
  // 2. A hung request aborts and reports a timeout instead of spinning forever.
  mode = 'hang';
  let message = '';
  const started = Date.now();
  try { await backend.signup({ email: 'a@b.co', password: 'longenough1', fullName: 'A' }); } catch (e) { message = e.message; }
  ck('a hung request times out', /took too long/i.test(message), `${Date.now() - started}ms ${message}`);
}
{
  // 3. A successful auth signup still yields a usable session.
  mode = 'ok';
  const result = await backend.signup({ email: 'a@b.co', password: 'longenough1', fullName: 'A' });
  ck('signup returns an access token', result.access_token === 'tok');
  ck('signup stores a session', backend.hasSession() === true);
}
{
  // 4. A profile sync that fails after a good signup reports a reachable message and does not
  //    corrupt the stored session.
  mode = 'network-error';
  let message = '';
  try { await backend.updateProfile({ full_name: 'A' }); } catch (e) { message = e.message; }
  ck('failed profile sync is explained', /could not reach reach/i.test(message), message);
  ck('a failed profile sync keeps the session', backend.hasSession() === true);
}

console.log(`\nTOTAL: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
