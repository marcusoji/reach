/**
 * Detailed verification of REACH Safety Fusion v2 (ai_engine.ts) and the provider
 * adapter (ai_provider.ts).
 *
 * Everything runs against the real source. The only stub is globalThis.fetch for the
 * provider section: modelAssist's whole job is talking to an external HTTP provider,
 * so its parsing/validation/retry/timeout logic cannot be exercised without either a
 * live endpoint+credentials or a stub at that boundary.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.join(HERE, '..', '..', 'supabase', 'functions', 'api');

// The engine is TypeScript. Node only strips .ts types natively from v22.6, and CI runs
// Node 20, so transpile with the repo's declared `typescript` dependency instead of
// depending on the runtime version (or on esbuild, which is only a transitive dep).
const outDir = mkdtempSync(path.join(tmpdir(), 'reach-ai-'));
const loadTs = async (file) => {
  const js = ts.transpileModule(readFileSync(path.join(API, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/\.ts(['"])/g, '.mjs$1');
  const out = path.join(outDir, file.replace(/\.ts$/, '.mjs'));
  writeFileSync(out, js);
  return import(pathToFileURL(out).href);
};
const { assessEvidence } = await loadTs('ai_engine.ts');

const NOW = Date.now();
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const M = 60 * 1000;

const results = [];
let section = '';
const S = (s) => { section = s; console.log(`\n=== ${s} ===`); };
function ck(name, pass, detail) {
  results.push({ section, name, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------------------------------------------------------------- A: decision paths
S('A. Decision paths');
{
  const r = assessEvidence({ evidence: [] });
  ck('empty evidence abstains', r.abstain === true && r.decision === 'assist');
  ck('empty evidence still returns a category', ['medical','fire','security','accident','other'].includes(r.category));
}
{
  const r = assessEvidence({ reportedCategory: 'fire', userConfirmed: true, corroboratingReports: 3, evidence: [
    { id: 'a', kind: 'user_report', category: 'fire', confidence: 0.9, quality: 1, source: 'c1', timestamp: at(30_000) },
    { id: 'b', kind: 'image', category: 'fire', confidence: 0.85, quality: 0.95, source: 'c1', timestamp: at(20_000) },
    { id: 'c', kind: 'sensor', category: 'fire', confidence: 0.8, quality: 1, source: 'smoke-4', timestamp: at(10_000) },
  ] });
  ck('strong corroborated evidence recommends', r.decision === 'recommend' && r.abstain === false, `conf=${r.confidence}`);
  ck('correct category selected', r.category === 'fire');
}
{
  const r = assessEvidence({ reportedCategory: 'security', evidence: [
    { id: 'h', kind: 'user_report', category: 'security', confidence: 0.9, quality: 1, source: 'c1', timestamp: at(45 * M) },
  ] });
  ck('stale-only evidence abstains', r.abstain === true, `conf=${r.confidence}`);
}
{
  const r = assessEvidence({ evidence: [
    { id: 'w', kind: 'text', category: 'other', confidence: 0.1, quality: 0.2, source: 'c1', timestamp: at(20 * M) },
  ] });
  ck('single weak low-quality report abstains', r.abstain === true, `conf=${r.confidence}`);
}

// ------------------------------------------------------------ B: classification
S('B. Category classification');
{
  const r = assessEvidence({ evidence: [
    { id: '1', kind: 'user_report', category: 'medical', confidence: 0.95, quality: 1, source: 'c1', timestamp: at(5_000) },
    { id: '2', kind: 'audio', category: 'medical', confidence: 0.9, quality: 1, source: 'c1', timestamp: at(5_000) },
  ] });
  ck('medical evidence classifies as medical', r.category === 'medical', `got ${r.category}`);
}
{
  const r = assessEvidence({ evidence: [
    { id: '1', kind: 'user_report', category: 'accident', confidence: 0.95, quality: 1, source: 'c1', timestamp: at(5_000) },
    { id: '2', kind: 'motion', category: 'accident', confidence: 0.9, quality: 1, source: 'c1', timestamp: at(5_000) },
  ] });
  ck('accident evidence classifies as accident', r.category === 'accident', `got ${r.category}`);
}
{
  // userConfirmed should lift the reported category over an unconfirmed rival
  const r = assessEvidence({ reportedCategory: 'fire', userConfirmed: true, evidence: [
    { id: '1', kind: 'text', category: 'other', confidence: 0.5, quality: 1, source: 'c1', timestamp: at(5_000) },
  ] });
  ck('user-confirmed reported category is weighted', r.category === 'fire', `got ${r.category}`);
}
{
  const r = assessEvidence({ reportedCategory: 'nonsense-category', evidence: [] });
  ck('invalid reported category ignored', ['medical','fire','security','accident','other'].includes(r.category));
}
{
  const r = assessEvidence({ evidence: [
    { id: '1', kind: 'user_report', category: 'not-a-category', confidence: 0.9, quality: 1, source: 'c1', timestamp: at(5_000) },
  ] });
  ck('invalid evidence category does not crash or leak', ['medical','fire','security','accident','other'].includes(r.category));
}
{
  const r = assessEvidence({ evidence: [
    { id: '1', kind: 'user_report', category: 'medical', confidence: 0.9, quality: 1, source: 'c1', timestamp: at(5_000) },
  ] });
  ck('urgency high for medical', r.urgency === 'high');
  const r2 = assessEvidence({ evidence: [
    { id: '1', kind: 'user_report', category: 'other', confidence: 0.9, quality: 1, source: 'c1', timestamp: at(5_000) },
  ] });
  ck('urgency medium for other', r2.urgency === 'medium');
}

// ---------------------------------------------------------------- C: invariants
S('C. Invariants and output shape');
const REQUIRED = ['model_name','category','confidence','fp_code','decision','abstain','evidence_strength','margin','contradiction_penalty','source_diversity','model_agreement','urgency','reasons','explanation','decision_basis'];
const BLOCKERS = ['no_usable_evidence','confidence_below_threshold','category_margin_below_threshold','evidence_strength_below_threshold','contradiction_penalty_above_threshold','model_disagreement'];
{
  const r = assessEvidence({ evidence: [] });
  const missing = REQUIRED.filter((k) => !(k in r));
  ck('all required keys present', missing.length === 0, missing.length ? 'missing ' + missing.join(',') : '');
  ck('explanation equals reasons joined', r.explanation === r.reasons.join(' '));
  ck('reasons non-empty', Array.isArray(r.reasons) && r.reasons.length > 0);
  ck('reasons always mention human verification', r.reasons.some((s) => /human verification/i.test(s)));
  ck('model_name stable', r.model_name === 'REACH-Safety-Fusion-v2');
  ck('fp_code format FP2-<CAT>-<conf>-<margin>', /^FP2-[A-Z]+-\d+-\d+$/.test(r.fp_code), r.fp_code);
  // decision_basis gives consumers an exact reason instead of matching prose.
  ck('decision_basis exposes signals and blockers', r.decision_basis && typeof r.decision_basis.signals === 'object' && Array.isArray(r.decision_basis.blockers));
  ck('empty evidence reports the no_usable_evidence blocker', r.decision_basis.blockers.includes('no_usable_evidence'));
  ck('abstain iff at least one blocker', r.abstain === (r.decision_basis.blockers.length > 0));
  ck('every blocker is a known label', r.decision_basis.blockers.every((b) => BLOCKERS.includes(b)), r.decision_basis.blockers.join(','));
}
{
  // decision_basis must stay consistent with abstain across a fuzz run, and the signals must
  // mirror the top-level fields so downstream audit cannot read two different stories.
  let inconsistent = 0, mismatched = 0;
  const kinds = ['user_report','image','audio','motion','location','corroboration','relay','sensor','text'];
  for (let i = 0; i < 300; i++) {
    const n = i % 6;
    const evidence = Array.from({ length: n }, (_, j) => ({
      id: `d${i}-${j}`, kind: kinds[(i + j) % kinds.length], category: ['fire','medical','other'][(i + j) % 3],
      confidence: ((i * 7 + j * 13) % 100) / 100, quality: ((i * 3 + j) % 100) / 100,
      source: `s${(i + j) % 4}`, timestamp: at((i + j) * 4000), contradiction: (i + j) % 5 === 0,
    }));
    const r = assessEvidence({ reportedCategory: ['fire','medical',undefined][i % 3], userConfirmed: i % 4 === 0, corroboratingReports: i % 3, evidence });
    if (r.abstain !== (r.decision_basis.blockers.length > 0)) inconsistent++;
    if (r.margin !== r.decision_basis.signals.margin || r.evidence_strength !== r.decision_basis.signals.evidence_strength || r.contradiction_penalty !== r.decision_basis.signals.contradiction_penalty) mismatched++;
  }
  ck('fuzz: abstain matches blockers exactly', inconsistent === 0, `${inconsistent} violations`);
  ck('fuzz: decision_basis signals mirror top-level fields', mismatched === 0, `${mismatched} violations`);
}
{
  // corroborates:false is counter-evidence. It must lower confidence rather than being
  // discounted support that still raises the category score.
  const strong = (corroborates) => assessEvidence({ evidence: [
    { id: 'a', kind: 'user_report', category: 'fire', confidence: 0.9, quality: 1, source: 'c1', timestamp: at(20_000) },
    { id: 'b', kind: 'image', category: 'fire', confidence: 0.85, quality: 1, source: 'cam', timestamp: at(15_000), corroborates },
  ] });
  const yes = strong(true), no = strong(false);
  ck('corroborates:false lowers confidence vs corroborates:true', no.confidence < yes.confidence, `${yes.confidence} -> ${no.confidence}`);
  ck('corroborates:false raises the contradiction penalty', no.contradiction_penalty > 0);
  ck('a single corroborates:false item alone cannot recommend', assessEvidence({ evidence: [
    { id: 'x', kind: 'image', category: 'fire', confidence: 1, quality: 1, source: 'cam', timestamp: at(1000), corroborates: false },
  ] }).decision === 'assist');
}
{
  // fuzz: random evidence must never violate the core invariants
  let bad = 0, badAbstain = 0, badConf = 0, badCat = 0;
  const kinds = ['user_report','image','audio','motion','location','corroboration','relay','sensor','text'];
  const cats = ['medical','fire','security','accident','other',undefined,'bogus'];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 3000; i++) {
    const n = Math.floor(rnd() * 12);
    const evidence = Array.from({ length: n }, (_, j) => ({
      id: rnd() < 0.7 ? `e${j}` : undefined,
      kind: kinds[Math.floor(rnd() * kinds.length)],
      category: cats[Math.floor(rnd() * cats.length)],
      confidence: rnd() < 0.1 ? [NaN, -1, 2, 150, 'x', null, Infinity][Math.floor(rnd() * 7)] : rnd(),
      quality: rnd() < 0.1 ? undefined : rnd(),
      timestamp: rnd() < 0.2 ? 'not-a-date' : at(Math.floor(rnd() * 60 * M)),
      source: rnd() < 0.5 ? `s${Math.floor(rnd() * 4)}` : undefined,
      contradiction: rnd() < 0.25,
      corroborates: rnd() < 0.2 ? false : undefined,
    }));
    const r = assessEvidence({ reportedCategory: rnd() < 0.5 ? cats[Math.floor(rnd() * cats.length)] : undefined, userConfirmed: rnd() < 0.5, evidence, corroboratingReports: Math.floor(rnd() * 6) });
    if (!Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 100) badConf++;
    if (!['medical','fire','security','accident','other'].includes(r.category)) badCat++;
    if (r.abstain && r.decision !== 'assist') badAbstain++;
    if (!r.abstain && r.decision !== 'recommend') badAbstain++;
    if (!(r.reasons.length > 0) || !REQUIRED.every((k) => k in r)) bad++;
  }
  ck('fuzz 3000 inputs: confidence always in [0,100]', badConf === 0, `${badConf} violations`);
  ck('fuzz: category always valid', badCat === 0, `${badCat} violations`);
  ck('fuzz: decision always consistent with abstain', badAbstain === 0, `${badAbstain} violations`);
  ck('fuzz: shape always complete', bad === 0, `${bad} violations`);
}
{
  // determinism with time frozen
  const realNow = Date.now;
  Date.now = () => NOW;
  const input = { reportedCategory: 'fire', userConfirmed: true, evidence: [
    { id: 'z', kind: 'user_report', category: 'fire', confidence: 0.9, quality: 1, source: 'c1', timestamp: at(1000) },
    { id: 'y', kind: 'sensor', category: 'fire', confidence: 0.7, quality: 1, source: 's2', timestamp: at(2000) },
  ] };
  const outs = Array.from({ length: 20 }, () => JSON.stringify(assessEvidence(input)));
  Date.now = realNow;
  ck('deterministic across 20 runs (time frozen)', new Set(outs).size === 1);
}
{
  // dedup
  const dup = { id: 'same', kind: 'user_report', category: 'accident', confidence: 0.9, quality: 1, source: 'c1', timestamp: at(5_000) };
  const r = assessEvidence({ evidence: [dup, dup, dup, dup] });
  ck('duplicate ids collapse to one source', r.source_diversity === 1, `diversity=${r.source_diversity}`);
  // same id, different content -> still one
  const r2 = assessEvidence({ evidence: [{ ...dup }, { ...dup, confidence: 0.1 }] });
  ck('same id different content still deduped', r2.source_diversity === 1);
}
{
  // evidence cap of 80
  const many = Array.from({ length: 200 }, (_, i) => ({ id: `e${i}`, kind: 'user_report', category: 'fire', confidence: 0.9, quality: 1, source: `s${i}`, timestamp: at(1000) }));
  const r = assessEvidence({ evidence: many });
  ck('evidence capped at 80 items', r.source_diversity === 80, `diversity=${r.source_diversity}`);
}

// ------------------------------------------------------------- D: monotonicity
S('D. Monotonicity properties');
{
  // more corroborating evidence should never lower confidence
  const base = [{ id: 'u', kind: 'user_report', category: 'fire', confidence: 0.8, quality: 1, source: 'c1', timestamp: at(5_000) }];
  const series = [0, 1, 2, 3, 4, 5].map((n) => assessEvidence({ reportedCategory: 'fire', evidence: [
    ...base, ...Array.from({ length: n }, (_, i) => ({ id: `c${i}`, kind: 'corroboration', category: 'fire', confidence: 0.8, quality: 1, source: `c${i + 2}`, timestamp: at(5_000) })),
  ] }).confidence);
  const monotone = series.every((v, i) => i === 0 || v >= series[i - 1]);
  ck('corroborating evidence never lowers confidence', monotone, series.join(' -> '));
}
{
  // higher quality on the same evidence should never lower confidence
  const mk = (q) => assessEvidence({ evidence: [{ id: 'u', kind: 'user_report', category: 'fire', confidence: 0.8, quality: q, source: 'c1', timestamp: at(5_000) }] }).confidence;
  const series = [0.1, 0.3, 0.5, 0.7, 0.9, 1].map(mk);
  const monotone = series.every((v, i) => i === 0 || v >= series[i - 1]);
  ck('increasing evidence quality never lowers confidence', monotone, series.join(' -> '));
}
{
  // fresher evidence should never lower confidence
  const mk = (ago) => assessEvidence({ evidence: [{ id: 'u', kind: 'user_report', category: 'fire', confidence: 0.8, quality: 1, source: 'c1', timestamp: at(ago) }] }).confidence;
  const series = [60 * M, 30 * M, 10 * M, 5 * M, 1 * M, 10_000].map(mk);
  const monotone = series.every((v, i) => i === 0 || v >= series[i - 1]);
  ck('fresher evidence never lowers confidence', monotone, series.join(' -> '));
}
{
  // MODEL AGREEMENT: stronger agreeing model should never lower confidence
  const mk = (c) => assessEvidence({ evidence: [{ id: 'u', kind: 'user_report', category: 'fire', confidence: 0.8, quality: 1, source: 'c1', timestamp: at(5_000) }], modelAssist: { category: 'fire', confidence: c } }).confidence;
  const series = [0, 0.25, 0.5, 0.75, 1].map(mk);
  const monotone = series.every((v, i) => i === 0 || v >= series[i - 1]);
  ck('stronger agreeing model never lowers confidence', monotone, series.join(' -> '));
}
{
  // CONTRADICTION: adding contradicting evidence must not RAISE confidence.
  const series = [0, 1, 2, 3, 4, 5, 6].map((n) => assessEvidence({ reportedCategory: 'fire', evidence: [
    { id: 'sup', kind: 'user_report', category: 'fire', confidence: 0.8, quality: 1, source: 'c1', timestamp: at(5_000) },
    ...Array.from({ length: n }, (_, i) => ({ id: `k${i}`, kind: 'sensor', category: 'fire', confidence: 0.8, quality: 1, source: `s${i}`, timestamp: at(5_000), contradiction: true })),
  ] }).confidence);
  const nonIncreasing = series.every((v, i) => i === 0 || v <= series[i - 1]);
  ck('adding contradicting evidence never raises confidence', nonIncreasing, series.join(' -> '));
}
{
  // CONTRADICTION: a packet with any contradiction should be treated cautiously
  const r = assessEvidence({ reportedCategory: 'fire', evidence: [
    { id: 'sup', kind: 'user_report', category: 'fire', confidence: 0.8, quality: 1, source: 'c1', timestamp: at(5_000) },
    { id: 'k0', kind: 'sensor', category: 'fire', confidence: 0.8, quality: 1, source: 's0', timestamp: at(5_000), contradiction: true },
    { id: 'k1', kind: 'sensor', category: 'fire', confidence: 0.8, quality: 1, source: 's1', timestamp: at(5_000), contradiction: true },
    { id: 'k2', kind: 'sensor', category: 'fire', confidence: 0.8, quality: 1, source: 's2', timestamp: at(5_000), contradiction: true },
  ] });
  ck('3 contradicting sensors should not yield recommend', r.decision !== 'recommend', `decision=${r.decision} conf=${r.confidence} penalty=${r.contradiction_penalty}`);
}

// -------------------------------------------------------------- E: robustness
S('E. Adversarial and malformed inputs');
{
  const r = assessEvidence({ evidence: null });
  ck('null evidence array handled', r.abstain === true && Number.isFinite(r.confidence));
  const r2 = assessEvidence({ evidence: undefined });
  ck('undefined evidence handled', r2.abstain === true);
  const r3 = assessEvidence({});
  ck('missing evidence key handled', r3.abstain === true);
}
{
  const weird = [
    ['NaN confidence', { id: '1', kind: 'user_report', category: 'fire', confidence: NaN, quality: 1, timestamp: at(1000) }],
    ['Infinity confidence', { id: '2', kind: 'user_report', category: 'fire', confidence: Infinity, quality: 1, timestamp: at(1000) }],
    ['negative confidence', { id: '3', kind: 'user_report', category: 'fire', confidence: -5, quality: 1, timestamp: at(1000) }],
    ['confidence > 1 (percent)', { id: '4', kind: 'user_report', category: 'fire', confidence: 90, quality: 1, timestamp: at(1000) }],
    ['string confidence', { id: '5', kind: 'user_report', category: 'fire', confidence: '0.9', quality: 1, timestamp: at(1000) }],
    ['bad timestamp', { id: '6', kind: 'user_report', category: 'fire', confidence: 0.9, quality: 1, timestamp: 'garbage' }],
    ['negative quality', { id: '7', kind: 'user_report', category: 'fire', confidence: 0.9, quality: -3, timestamp: at(1000) }],
    ['unknown kind', { id: '8', kind: 'telepathy', category: 'fire', confidence: 0.9, quality: 1, timestamp: at(1000) }],
    ['missing kind', { id: '9', category: 'fire', confidence: 0.9, quality: 1, timestamp: at(1000) }],
  ];
  let bad = 0;
  for (const [, ev] of weird) {
    const r = assessEvidence({ evidence: [ev] });
    if (!Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 100) bad++;
  }
  ck('malformed field values never break confidence', bad === 0, `${bad} bad`);
  // percent interpretation: 90 should behave like 0.9
  const pct = assessEvidence({ evidence: [weird[3][1]] }).confidence;
  const frac = assessEvidence({ evidence: [weird[0][1] ? { ...weird[3][1], confidence: 0.9 } : null] }).confidence;
  ck('confidence=90 treated as 0.90', Math.abs(pct - frac) < 0.01, `${pct} vs ${frac}`);
}
{
  const long = 'A'.repeat(50_000);
  const r = assessEvidence({ evidence: [{ id: '1', kind: 'text', category: 'fire', confidence: 0.9, quality: 1, source: long, timestamp: at(1000), metadata: { note: long } }] });
  ck('very long source string handled', Number.isFinite(r.confidence));
  const r2 = assessEvidence({ evidence: [{ id: '1', kind: 'text', category: 'fire', confidence: 0.9, quality: 1, timestamp: at(1000), metadata: { x: '<script>alert(1)</script>' } }] });
  ck('script content in metadata does not surface in output', !JSON.stringify(r2).includes('<script>'));
}
{
  // future timestamp -> age clamped to 0, must not explode
  const r = assessEvidence({ evidence: [{ id: '1', kind: 'user_report', category: 'fire', confidence: 0.9, quality: 1, source: 'c1', timestamp: new Date(NOW + 5 * M).toISOString() }] });
  ck('future timestamp handled', Number.isFinite(r.confidence) && r.confidence <= 100);
}
{
  // JSON bodies are untyped: a non-numeric quality used to yield Number('abc')=NaN, which
  // poisoned confidence/margin/strength. That silenced every abstention blocker and produced
  // decision='recommend' with a NaN fingerprint on unverified evidence.
  const r = assessEvidence({ evidence: [{ id: '1', kind: 'sensor', category: 'fire', confidence: 0.9, quality: 'abc', source: 's', timestamp: at(1_000) }] });
  ck('non-numeric quality does not produce NaN confidence', Number.isFinite(r.confidence), `conf=${r.confidence}`);
  ck('non-numeric quality cannot force recommend', r.decision !== 'recommend' || Number.isFinite(r.confidence), `decision=${r.decision}`);
  ck('non-numeric quality leaves a finite fingerprint', !/NaN/.test(r.fp_code), r.fp_code);
  ck('non-numeric quality abstains', r.abstain === true, `conf=${r.confidence}`);
  const absent = assessEvidence({ evidence: [{ id: '1', kind: 'sensor', category: 'fire', confidence: 0.9, source: 's', timestamp: at(1_000) }] });
  const invalid = assessEvidence({ evidence: [{ id: '1', kind: 'sensor', category: 'fire', confidence: 0.9, quality: 'abc', source: 's', timestamp: at(1_000) }] });
  ck('invalid quality scores strictly below absent quality', invalid.confidence < absent.confidence, `${absent.confidence} -> ${invalid.confidence}`);
  // corroborating_reports is coerced by the handler, but the engine must be safe on its own.
  const cr = assessEvidence({ evidence: [], corroboratingReports: 'abc' });
  ck('non-numeric corroboratingReports stays finite', Number.isFinite(cr.confidence), `conf=${cr.confidence}`);
  // A non-finite model confidence must be ignored, not propagate.
  const mm = assessEvidence({ evidence: [{ id: '1', kind: 'user_report', category: 'fire', confidence: 0.9, quality: 1, source: 's', timestamp: at(1_000) }], modelAssist: { category: 'fire', confidence: NaN } });
  ck('NaN model confidence does not poison the result', Number.isFinite(mm.confidence) && mm.model_agreement === 'none', `conf=${mm.confidence} agreement=${mm.model_agreement}`);
  // Non-array / null-bearing evidence must not throw.
  let threw = null;
  try { assessEvidence({ evidence: 'x' }); assessEvidence({ evidence: [null] }); assessEvidence({ evidence: [undefined, { id: '1', kind: 'text', confidence: 0.5, source: 's', timestamp: at(1_000) }] }); } catch (e) { threw = e.message; }
  ck('non-array and null-bearing evidence never throw', threw === null, threw || '');
}

// ------------------------------------------------- F: model disagreement
S('F. Model second-opinion behaviour');
{
  const ev = [{ id: 'u', kind: 'user_report', category: 'medical', confidence: 0.9, quality: 1, source: 'c1', timestamp: at(5_000) }, { id: 'a', kind: 'audio', category: 'medical', confidence: 0.85, quality: 1, source: 'c1', timestamp: at(5_000) }];
  const none = assessEvidence({ evidence: ev });
  const agree = assessEvidence({ evidence: ev, modelAssist: { category: 'medical', confidence: 0.9 } });
  const disagree = assessEvidence({ evidence: ev, modelAssist: { category: 'security', confidence: 0.95 } });
  ck('model_agreement=none when no model', none.model_agreement === 'none');
  ck('model_agreement=agree when categories match', agree.model_agreement === 'agree');
  ck('model_agreement=disagree when categories differ', disagree.model_agreement === 'disagree');
  ck('agreement raises confidence', agree.confidence > none.confidence, `${none.confidence} -> ${agree.confidence}`);
  ck('disagreement lowers confidence', disagree.confidence < none.confidence, `${none.confidence} -> ${disagree.confidence}`);
  ck('disagreement recorded in reasons', disagree.reasons.some((s) => /disagrees/i.test(s)));
  ck('confident disagreement forces abstain', disagree.abstain === true, `conf=${disagree.confidence}`);
}
{
  // a low-confidence disagreement is not announced as a downgrade reason
  const ev = [{ id: 'u', kind: 'user_report', category: 'medical', confidence: 0.9, quality: 1, source: 'c1', timestamp: at(5_000) }];
  const r = assessEvidence({ evidence: ev, modelAssist: { category: 'security', confidence: 0.3 } });
  ck('low-confidence disagreement does not claim a downgrade', !r.reasons.some((s) => /downgraded/i.test(s)), `conf=${r.confidence}`);
}
{
  // modelAssist=null is the same as absent
  const ev = [{ id: 'u', kind: 'user_report', category: 'fire', confidence: 0.9, quality: 1, source: 'c1', timestamp: at(5_000) }];
  const a = assessEvidence({ evidence: ev, modelAssist: null });
  const b = assessEvidence({ evidence: ev });
  ck('modelAssist=null equals absent', JSON.stringify(a) === JSON.stringify(b));
}

// ------------------------------------------------------- G: provider adapter
S('G. Provider adapter (fetch stubbed at the HTTP boundary)');
{
  // Deno.env is read at module load (breaker/timeout config), so the stub must exist first.
  globalThis.Deno = { env: { get: () => undefined } };
  const { modelAssist, aiCircuitSnapshot, resetAiCircuit, aiLastFailure, aiLastFailureKind, MODEL_SYSTEM_PROMPT } = await loadTs('ai_provider.ts');
  const realFetch = globalThis.fetch;
  const setEnv = (o) => { globalThis.Deno = { env: { get: (k) => o[k] } }; };
  const okResponse = (obj) => ({ ok: true, json: async () => obj });
  const configured = { REACH_AI_ENDPOINT: 'https://x/ai', REACH_AI_API_KEY: 'k', REACH_AI_MODEL: 'm' };
  // Failures accumulate in module state, so clear the breaker before each independent check.
  const fresh = (o = configured) => { resetAiCircuit(); setEnv(o); };

  setEnv({});
  ck('returns null when unconfigured', (await modelAssist({ evidence: [] })) === null);
  setEnv({ REACH_AI_ENDPOINT: 'https://x/ai' });
  ck('returns null when partially configured', (await modelAssist({ evidence: [] })) === null);
  setEnv({ REACH_AI_ENDPOINT: 'https://x/ai', REACH_AI_API_KEY: 'k' });
  ck('returns null with only 2 of 3 vars', (await modelAssist({ evidence: [] })) === null);

  fresh();

  globalThis.fetch = async () => okResponse({ choices: [{ message: { content: JSON.stringify({ category: 'fire', confidence: 88, rationale: 'smoke', evidence_labels: ['a'] }) } }] });
  {
    const r = await modelAssist({ category: 'fire', evidence: [{ id: '1', kind: 'user_report', confidence: 0.9 }] });
    ck('parses a well-formed provider response', r && r.category === 'fire' && r.confidence === 88 && r.model === 'm');
    ck('reports latency_ms', r && Number.isFinite(r.latency_ms));
  }

  // The system prompt must not claim an agent identity. A provider that does not recognise the role
  // can refuse it and answer in prose with HTTP 200 - observed live with Helix/Launchverse, which
  // replied "I'm Helix, a software-engineering agent, so I can't take on the REACH Safety Assist
  // role...". That is a silent failure: JSON.parse throws, the breaker opens, and /status reports the
  // AI provider unhealthy. Pin the contract instead.
  ck('system prompt does not claim an agent identity', !/\b(you are|act as|you're)\b/i.test(MODEL_SYSTEM_PROMPT));
  ck('system prompt demands a bare JSON object', /single JSON object/i.test(MODEL_SYSTEM_PROMPT) && /no prose/i.test(MODEL_SYSTEM_PROMPT));

  // A refusal or billing notice served as 200 with prose is a failure, not an assessment.
  fresh();
  globalThis.fetch = async () => okResponse({ choices: [{ message: { content: "I'm Helix, a software-engineering agent, so I can't take on the REACH Safety Assist role or classify emergency evidence." } }] });
  ck('prose served as 200 is rejected', (await modelAssist({ evidence: [] })) === null);
  ck('prose rejection is recorded for diagnosis', /software-engineering agent/.test(aiLastFailure()), aiLastFailure().slice(0, 60));

  fresh();
  globalThis.fetch = async () => okResponse({ choices: [{ message: { content: 'Helix credit balance exhausted. Top up to continue.' } }] });
  ck('billing notice served as 200 is rejected', (await modelAssist({ evidence: [] })) === null);
  ck('billing notice is recorded for diagnosis', /credit balance/i.test(aiLastFailure()));

  fresh();
  globalThis.fetch = async () => okResponse({ choices: [{ message: { content: JSON.stringify({ category: 'fire', confidence: 70 }) } }] });
  {
    const r = await modelAssist({ evidence: [] });
    ck('a successful call clears the recorded failure', r?.category === 'fire' && aiLastFailure() === '');
  }

  globalThis.fetch = async () => okResponse({ output: { category: 'medical', confidence: 40, rationale: 'r', evidence_labels: [] } });
  ck('accepts {output:{...}} shape', (await modelAssist({ evidence: [] }))?.category === 'medical');

  fresh();
  globalThis.fetch = async () => okResponse({ choices: [{ message: { content: JSON.stringify({ category: 'bogus', confidence: 50 }) } }] });
  ck('rejects invalid category', (await modelAssist({ evidence: [] })) === null);

  fresh();
  globalThis.fetch = async () => okResponse({ choices: [{ message: { content: JSON.stringify({ category: 'fire', confidence: 'nope' }) } }] });
  ck('rejects non-numeric confidence', (await modelAssist({ evidence: [] })) === null);

  fresh();
  globalThis.fetch = async () => okResponse({ choices: [{ message: { content: '{not json' } }] });
  ck('rejects malformed JSON', (await modelAssist({ evidence: [] })) === null);

  fresh();
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  ck('returns null on provider error status', (await modelAssist({ evidence: [] })) === null);

  fresh();
  globalThis.fetch = async () => { throw new Error('network down'); };
  ck('returns null when fetch throws', (await modelAssist({ evidence: [] })) === null);

  // confidence clamping: provider sends 250 -> clamped to 100
  fresh();
  globalThis.fetch = async () => okResponse({ choices: [{ message: { content: JSON.stringify({ category: 'fire', confidence: 250 }) } }] });
  ck('provider confidence clamped to 100', (await modelAssist({ evidence: [] }))?.confidence === 100);

  // retry: first attempt fails, second succeeds
  fresh();
  {
    let calls = 0;
    globalThis.fetch = async () => { calls++; if (calls === 1) throw new Error('transient'); return okResponse({ choices: [{ message: { content: JSON.stringify({ category: 'fire', confidence: 70 }) } }] }); };
    const r = await modelAssist({ evidence: [] });
    ck('retries once on transient failure', r?.category === 'fire' && calls === 2, `calls=${calls}`);
  }
  // evidence truncated to 30
  fresh();
  {
    let seen = 0;
    globalThis.fetch = async (_u, init) => { seen = JSON.parse(init.body).messages[1].content.length; return okResponse({ choices: [{ message: { content: JSON.stringify({ category: 'fire', confidence: 70 }) } }] }); };
    await modelAssist({ evidence: Array.from({ length: 100 }, (_, i) => ({ id: `e${i}`, kind: 'text', metadata: { pad: 'x'.repeat(50) } })) });
    ck('provider payload is bounded', seen < 5000, `payload chars=${seen}`);
  }
  // provider never authorizes: result is advisory only, engine still decides
  fresh();
  {
    globalThis.fetch = async () => okResponse({ choices: [{ message: { content: JSON.stringify({ category: 'security', confidence: 99, rationale: 'trust me' }) } }] });
    const m = await modelAssist({ evidence: [] });
    const r = assessEvidence({ evidence: [], modelAssist: m ? { category: m.category, confidence: m.confidence / 100 } : null });
    ck('a confident model cannot force a recommend on empty evidence', r.abstain === true, `decision=${r.decision}`);
  }

  // ---- circuit breaker ----
  {
    fresh({ ...configured, REACH_AI_BREAKER_THRESHOLD: '3', REACH_AI_BREAKER_COOLDOWN_MS: '60000' });
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('provider down'); };
    for (let i = 0; i < 3; i++) await modelAssist({ evidence: [] });
    const afterOpen = calls;
    const snap = aiCircuitSnapshot();
    ck('breaker opens after threshold consecutive failures', snap.open === true && snap.failures >= 3, `failures=${snap.failures} calls=${afterOpen}`);
    // subsequent calls are skipped entirely (no fetch)
    for (let i = 0; i < 5; i++) await modelAssist({ evidence: [] });
    ck('breaker skips the provider while open (no extra calls)', calls === afterOpen, `calls went ${afterOpen} -> ${calls}`);
    ck('breaker returns null while open', (await modelAssist({ evidence: [] })) === null);
    // a success closes the breaker
    resetAiCircuit();
    globalThis.fetch = async () => { throw new Error('down'); };
    for (let i = 0; i < 2; i++) await modelAssist({ evidence: [] });
    ck('two failures do not open the breaker', aiCircuitSnapshot().open === false, `failures=${aiCircuitSnapshot().failures}`);
    globalThis.fetch = async () => okResponse({ choices: [{ message: { content: JSON.stringify({ category: 'fire', confidence: 70 }) } }] });
    const recovered = await modelAssist({ evidence: [] });
    ck('a success closes the breaker', recovered?.category === 'fire' && aiCircuitSnapshot().open === false);
  }
  // ---- abort / timeout path: a fetch that honours the abort signal ----
  {
    fresh({ ...configured, REACH_AI_TIMEOUT_MS: '60' });
    // Real fetch rejects immediately when the signal is already aborted; the stub must too,
    // otherwise the retry attempt waits on an event that has already fired.
    globalThis.fetch = (_u, init) => new Promise((_res, rej) => {
      const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (init.signal.aborted) return rej(abortErr());
      init.signal.addEventListener('abort', () => rej(abortErr()));
    });
    const t0 = Date.now();
    const r = await modelAssist({ evidence: [] });
    const dt = Date.now() - t0;
    ck('timeout aborts the provider call', r === null, `took ${dt}ms`);
    ck('timeout fires near the configured limit, not 6.5s', dt < 500, `took ${dt}ms`);
    ck('an aborted call counts as a failure', aiCircuitSnapshot().failures >= 1, `failures=${aiCircuitSnapshot().failures}`);
  }
  // ---- failure kinds are reported, not just a null ----
  {
    fresh();
    globalThis.fetch = async () => okResponse({ choices: [{ message: { content: 'No JSON at all, just prose.' } }] });
    await modelAssist({ evidence: [] });
    ck('an unparsable response is reported as such', aiLastFailureKind() === 'unparsable_response', String(aiLastFailureKind()));

    fresh();
    globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
    await modelAssist({ evidence: [] });
    ck('an HTTP error is reported as such', aiLastFailureKind() === 'http_error', String(aiLastFailureKind()));

    fresh();
    globalThis.fetch = async () => { throw new Error('down'); };
    await modelAssist({ evidence: [] });
    ck('a network error is reported as such', aiLastFailureKind() === 'network_error', String(aiLastFailureKind()));

    fresh();
    globalThis.fetch = async () => okResponse({ choices: [{ message: { content: JSON.stringify({ category: 'bogus', confidence: 50 }) } }] });
    await modelAssist({ evidence: [] });
    ck('an unusable payload is reported as such', aiLastFailureKind() === 'invalid_payload', String(aiLastFailureKind()));

    fresh();
    globalThis.fetch = async () => okResponse({ choices: [{ message: { content: JSON.stringify({ category: 'fire', confidence: 70 }) } }] });
    await modelAssist({ evidence: [] });
    ck('a success clears the failure kind', aiLastFailureKind() === null, String(aiLastFailureKind()));

    resetAiCircuit();
    setEnv({});
    await modelAssist({ evidence: [] });
    ck('an unconfigured provider is reported as such', aiLastFailureKind() === 'unconfigured', String(aiLastFailureKind()));
  }

  // ---- tolerant parse: agentic models prefix the JSON and then keep talking ----
  {
    fresh();
    globalThis.fetch = async () => okResponse({ choices: [{ message: { content: 'Here is the assessment:\n{"category":"fire","confidence":88,"rationale":"smoke","evidence_labels":["smoke"]}\n\nLet me know if you need anything else.' } }] });
    const r = await modelAssist({ evidence: [] });
    ck('recovers JSON wrapped in agent chatter', r?.category === 'fire' && r.confidence === 88, `got ${r ? r.category : 'null'}`);

    fresh();
    // A brace inside a string value must not be mistaken for the end of the object.
    globalThis.fetch = async () => okResponse({ choices: [{ message: { content: 'Sure: {"category":"medical","confidence":42,"rationale":"brace } inside","evidence_labels":[]} done' } }] });
    const r2 = await modelAssist({ evidence: [] });
    ck('handles braces inside string values', r2?.category === 'medical' && r2.confidence === 42, `got ${r2 ? r2.category : 'null'}`);

    fresh();
    // A truncated object has no balanced close, so it must be rejected rather than half-parsed.
    globalThis.fetch = async () => okResponse({ choices: [{ message: { content: '{"category":"fire","confidence":88' } }] });
    ck('rejects a truncated JSON object', (await modelAssist({ evidence: [] })) === null);
    ck('a truncated object is an unparsable response', aiLastFailureKind() === 'unparsable_response', String(aiLastFailureKind()));

    fresh();
    // Prose containing no JSON at all is still a failure.
    globalThis.fetch = async () => okResponse({ choices: [{ message: { content: "I'm Helix, a software-engineering agent, so I can't take on the REACH Safety Assist role." } }] });
    ck('prose with no JSON object is still rejected', (await modelAssist({ evidence: [] })) === null);
  }

  // ---- breaker keeps the engine working when the provider is dead ----
  {
    fresh({ ...configured, REACH_AI_BREAKER_THRESHOLD: '2' });
    globalThis.fetch = async () => { throw new Error('down'); };
    await modelAssist({ evidence: [] });
    await modelAssist({ evidence: [] });
    const m = await modelAssist({ evidence: [] });
    const r = assessEvidence({ reportedCategory: 'fire', userConfirmed: true, evidence: [{ id: '1', kind: 'user_report', category: 'fire', confidence: 0.9, quality: 1, source: 'c1', timestamp: new Date().toISOString() }], modelAssist: m ? { category: m.category, confidence: m.confidence / 100 } : null });
    ck('engine still produces an assessment with a dead provider', Number.isFinite(r.confidence) && r.category === 'fire', `conf=${r.confidence} model_agreement=${r.model_agreement}`);
    ck('dead provider is reported as model_agreement=none', r.model_agreement === 'none');
  }
  resetAiCircuit();
  globalThis.fetch = realFetch;
}

// -------------------------------------------------- H: distribution sanity
S('H. Output distribution sanity (not calibration)');
{
  const mk = (n, cat, conf) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, kind: 'user_report', category: cat, confidence: conf, quality: 1, source: `s${i}`, timestamp: at(2000) }));
  const scenarios = [
    ['empty', { evidence: [] }],
    ['single weak', { evidence: [{ id: '1', kind: 'text', category: 'other', confidence: 0.2, quality: 0.3, source: 'c', timestamp: at(20 * M) }] }],
    ['single strong', { evidence: mk(1, 'fire', 0.9) }],
    ['two strong', { evidence: mk(2, 'fire', 0.9) }],
    ['four strong', { evidence: mk(4, 'fire', 0.9) }],
    ['eight strong', { evidence: mk(8, 'fire', 0.9) }],
  ];
  const confs = scenarios.map(([n, i]) => [n, assessEvidence(i).confidence]);
  const distinct = new Set(confs.map(([, c]) => c)).size;
  ck('confidence is not degenerate (varies across scenarios)', distinct >= 4, confs.map(([n, c]) => `${n}=${c}`).join(' '));
  const abstainRate = confs.filter(([, c]) => c < 60).length / confs.length;
  ck('abstention is not all-or-nothing', abstainRate > 0 && abstainRate < 1, `rate=${abstainRate.toFixed(2)}`);
  const e0 = assessEvidence({ evidence: [] }).confidence, e8 = assessEvidence({ evidence: mk(8, 'fire', 0.9) }).confidence;
  ck('more strong evidence yields higher confidence', e8 > e0, `${e0} -> ${e8}`);
}

// ---------------------------------------------------------------- summary
const failed = results.filter((r) => !r.pass);
console.log(`\n${'='.repeat(64)}`);
console.log(`TOTAL: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('\nFAILURES:');
  for (const f of failed) console.log(`  - [${f.section}] ${f.name}`);
}
console.log('='.repeat(64));
process.exit(failed.length ? 1 : 0);
