// Verifies the BMONI sandbox-demo helper (src/lib/bmoniDemo.ts): the persona matches the
// documented working sandbox identity, the phone is a fresh unique E.164 number (a duplicate
// is rejected by the sandbox with 409), and the step plan separates real sandbox calls from
// the two steps that are structurally un-automatable and therefore labelled simulated.
//
// Run: node scripts/tests/bmoni-demo.mjs
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..', 'src', 'lib', 'bmoniDemo.ts');
const outDir = mkdtempSync(path.join(tmpdir(), 'reach-bmoni-demo-'));
const js = ts.transpileModule(readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const out = path.join(outDir, 'bmoniDemo.mjs');
writeFileSync(out, js);
const { BMONI_DEMO_PERSONA, bmoniDemoPhone, bmoniDemoPayer, bmoniDemoPlan, bmoniDemoHasLiveSteps } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const ck = (name, cond, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`);
  cond ? pass++ : fail++;
};

console.log('=== BMONI sandbox demo helper ===');

ck('persona is the documented Bunch Dillon identity', BMONI_DEMO_PERSONA.first_name === 'Bunch' && BMONI_DEMO_PERSONA.last_name === 'Dillon');
ck('persona carries the working sandbox BVN 95888168924', BMONI_DEMO_PERSONA.bvn === '95888168924');

const phone = bmoniDemoPhone(1_700_000_000_000, () => 0.5);
ck('phone is E.164 Nigerian (+234, 10 digits after the country code)', /^\+234\d{10}$/.test(phone) && phone.length === 14, phone);
ck('two runs at different times produce different phones', bmoniDemoPhone(1_700_000_000_000, () => 0.5) !== bmoniDemoPhone(1_700_001_000_000, () => 0.5));
ck('same clock with different randomness still differs', bmoniDemoPhone(1_700_000_000_000, () => 0.1) !== bmoniDemoPhone(1_700_000_000_000, () => 0.9));

const payer = bmoniDemoPayer('reach.dev', 1_700_000_000_000, () => 0.5);
ck('payer uses the persona names', payer.first_name === 'Bunch' && payer.last_name === 'Dillon');
ck('payer email is fresh and namespaced', /^bmoni\.demo\.\d{8}@reach\.dev$/.test(payer.email), payer.email);
ck('payer phone is the generated E.164 number', payer.phone_number === phone, payer.phone_number);
ck('two payers do not share an email', bmoniDemoPayer('reach.dev', 1_700_001_000_000, () => 0.5).email !== payer.email);

const plan = bmoniDemoPlan();
const live = plan.filter((s) => s.status === 'live').map((s) => s.key);
const simulated = plan.filter((s) => s.status === 'simulated').map((s) => s.key);
ck('plan drives the real sandbox for payer/wallet/onboarding/proposal', ['payer', 'challenge', 'onboarding', 'deposit', 'proposal'].every((k) => live.includes(k)), live.join(','));
ck('owner-proof signing and settlement are labelled simulated', simulated.includes('wallet') && simulated.includes('sign'), simulated.join(','));
ck('the plan has live steps', bmoniDemoHasLiveSteps(plan) === true);

const skipped = bmoniDemoPlan(['payer', 'challenge']);
ck('already-done steps are marked skipped, not re-run', skipped.find((s) => s.key === 'payer')?.status === 'skipped' && skipped.find((s) => s.key === 'challenge')?.status === 'skipped');
ck('a fully-skipped plan has no live steps', bmoniDemoHasLiveSteps(bmoniDemoPlan(plan.map((s) => s.key))) === false);

console.log(`\nTOTAL: ${pass}/${pass + fail} passed`);
assert.equal(fail, 0, `${fail} BMONI demo assertion(s) failed`);
