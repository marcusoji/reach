/**
 * Verifies the BMONI user-id extraction and email recovery.
 *
 * `POST /v1/users` answers with `{ user: { id, bmoniUserId, ... } }`, where `id` is an
 * internal row id and `bmoniUserId` is the value every user-scoped path accepts. The
 * previous extraction (`result.bmoniUserId || result.id || result.user.id || ...`) fell
 * through to `result.user.id` — the internal id — which then 404s ("User not found") on
 * every later call (status, kyc, deposit-account, start-nigeria). `bmoniUserIdFrom` reads
 * only the real id, and `findBmoniUserIdByEmail` recovers it for already-broken accounts.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.join(HERE, '..', '..', 'supabase', 'functions', 'api');

globalThis.Deno = { env: { get: (key) => ({ BMONI_BASE_URL: 'https://embedded-dev.bmoni.com', BMONI_API_KEY: 'test-key' }[key]) } };

const outDir = mkdtempSync(path.join(tmpdir(), 'reach-bmoni-uid-'));
const js = ts.transpileModule(readFileSync(path.join(API, 'bmoni.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/\.ts(['"])/g, '.mjs$1');
const out = path.join(outDir, 'bmoni.mjs');
writeFileSync(out, js);
const { bmoniUserIdFrom, findBmoniUserIdByEmail } = await import(pathToFileURL(out).href);

const INTERNAL = '65e57a01-eb0d-4a54-bbf3-e0dfcc2d2d13';
const REAL = 'ea47364f-9c9e-4cda-93dc-a6e08d547f8c';

let passed = 0, failed = 0;
const check = (name, condition) => {
  if (condition) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.error(`  [FAIL] ${name}`); }
};

console.log('\n=== A. bmoniUserIdFrom reads only the real user id ===');
check('nested user.bmoniUserId is used', bmoniUserIdFrom({ user: { id: INTERNAL, bmoniUserId: REAL } }) === REAL);
check('flat bmoniUserId is used', bmoniUserIdFrom({ bmoniUserId: REAL }) === REAL);
check('data.bmoniUserId is used', bmoniUserIdFrom({ data: { bmoniUserId: REAL } }) === REAL);
check('data.user.bmoniUserId is used', bmoniUserIdFrom({ data: { user: { bmoniUserId: REAL } } }) === REAL);
check('a GET /v1/users/{id} body is used', bmoniUserIdFrom({ id: INTERNAL, bmoniUserId: REAL }) === REAL);

console.log('\n=== B. the internal row id is never returned ===');
check('a record exposing only the internal id yields null', bmoniUserIdFrom({ user: { id: INTERNAL } }) === null);
check('a 409 conflict body yields null', bmoniUserIdFrom({ message: 'User already exists with this email and phoneNumber', statusCode: 409 }) === null);
check('an empty body yields null', bmoniUserIdFrom({}) === null);
check('the old fallback chain would have picked the internal id', ({ user: { id: INTERNAL, bmoniUserId: REAL } }).user.id === INTERNAL && bmoniUserIdFrom({ user: { id: INTERNAL, bmoniUserId: REAL } }) !== INTERNAL);

console.log('\n=== C. findBmoniUserIdByEmail pages the tenant and matches case-insensitively ===');
const page = (users) => new Response(JSON.stringify({ users, total: 964, page: 1, limit: 100 }), { status: 200, headers: { 'content-type': 'application/json' } });
const filler = (n) => Array.from({ length: n }, (_, i) => ({ id: `internal-${i}`, bmoniUserId: `real-${i}`, email: `filler${i}@example.test` }));
const originalFetch = globalThis.fetch;

let calls = 0;
globalThis.fetch = async (url) => {
  calls++;
  const u = String(url);
  if (u.includes('page=1')) return page([...filler(99), { id: INTERNAL, bmoniUserId: REAL, email: 'Payer@Example.test' }]);
  return page([]);
};
check('recovers the id by email (case-insensitive)', (await findBmoniUserIdByEmail('payer@example.test')) === REAL);
check('it paged rather than assuming page 1', calls === 1);

calls = 0;
globalThis.fetch = async (url) => {
  calls++;
  const p = Number(new URL(String(url)).searchParams.get('page'));
  if (p === 1) return page(filler(100));
  if (p === 2) return page([{ id: INTERNAL, bmoniUserId: REAL, email: 'payer@example.test' }]);
  return page([]);
};
check('walks to a later page when the first is full', (await findBmoniUserIdByEmail('payer@example.test')) === REAL);
check('stopped as soon as it matched', calls === 2);

calls = 0;
globalThis.fetch = async () => { calls++; return page(filler(100)); };
check('a short page with no match yields null', (await findBmoniUserIdByEmail('missing@example.test')) === null);
check('the page scan is bounded', calls === 10);

globalThis.fetch = originalFetch;

console.log(`\nTOTAL: ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
