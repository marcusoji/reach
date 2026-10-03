/**
 * Verifies the BMONI client's phone normalisation and provider-error detail.
 *
 * BMONI answers a non-E.164 phone number with a bare `400 { message: "Validation failed" }`,
 * which surfaced to institutions as an opaque "BMONI request failed (400): Validation failed"
 * during payer-account creation. `normalizePhone` converts the common Nigerian input shapes to
 * E.164 before the request, and the client now surfaces the provider's array-shaped `message`
 * detail instead of collapsing it.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.join(HERE, '..', '..', 'supabase', 'functions', 'api');

// bmoni.ts reads Deno.env at module scope; provide the minimal shim before importing.
globalThis.Deno = { env: { get: (key) => ({ BMONI_BASE_URL: 'https://embedded-dev.bmoni.com', BMONI_API_KEY: 'test-key' }[key]) } };

const outDir = mkdtempSync(path.join(tmpdir(), 'reach-bmoni-'));
const loadTs = async (file) => {
  const js = ts.transpileModule(readFileSync(path.join(API, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/\.ts(['"])/g, '.mjs$1');
  const out = path.join(outDir, file.replace(/\.ts$/, '.mjs'));
  writeFileSync(out, js);
  return import(pathToFileURL(out).href);
};

const { normalizePhone, bmoni } = await loadTs('bmoni.ts');

let passed = 0, failed = 0;
const check = (name, condition) => {
  if (condition) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.error(`  [FAIL] ${name}`); }
};

console.log('\n=== A. normalizePhone maps input shapes to E.164 ===');
check('already E.164 is preserved', normalizePhone('+2348012345678') === '+2348012345678');
check('local Nigerian 0-prefix gains +234', normalizePhone('08012345678') === '+2348012345678');
check('country-code, no plus, gains +', normalizePhone('2348012345678') === '+2348012345678');
check('spaces and dashes are stripped', normalizePhone('  +234 801-234-5678 ') === '+2348012345678');
check('non-Nigerian E.164 is preserved', normalizePhone('+1 (415) 555-2671') === '+14155552671');

console.log('\n=== B. normalizePhone rejects what BMONI would reject ===');
check('empty is rejected', normalizePhone('') === null);
check('missing is rejected', normalizePhone(undefined) === null);
check('letters-only is rejected', normalizePhone('not-a-phone') === null);
check('short local number is rejected', normalizePhone('0801234') === null);
check('bare digits without country code are rejected', normalizePhone('123456789') === null);
check('too-short E.164 is rejected', normalizePhone('+123') === null);
check('too-long E.164 is rejected', normalizePhone('+1234567890123456') === null);

console.log('\n=== C. the provider message survives a 400 ===');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ message: ['property phoneNumber must be E.164'] }), { status: 400, headers: { 'content-type': 'application/json' } });
let thrown = null;
try { await bmoni.createUser({ firstName: 'Bunch', lastName: 'Dillon', email: 'x@example.test', phoneNumber: '08012345678' }); }
catch (error) { thrown = error; }
globalThis.fetch = originalFetch;
check('a 400 throws', Boolean(thrown));
check('the status is attached', thrown?.status === 400);
check('the provider detail is surfaced, not "Validation failed" alone', /phoneNumber must be E\.164/.test(thrown?.message || ''));

console.log(`\nTOTAL: ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
