/**
 * Generates relay-node-android/app/src/test/resources/cross_cases.json.
 *
 * The fixture captures the EXACT canonical strings produced by the server/PWA canonicalisation
 * (relay_protocol.ts) for payloads that stress JSON serialisation differences between V8 and
 * Android's org.json. CrossLanguageCanonicalTest asserts the Kotlin canonicaliser reproduces
 * these byte for byte, and relay-verify.mjs asserts the committed fixture is still fresh.
 *
 * Run: node scripts/tests/cross-fixtures.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.join(HERE, '..', '..', 'supabase', 'functions', 'api');
const OUT = path.join(HERE, '..', '..', '..', 'relay-node-android', 'app', 'src', 'test', 'resources', 'cross_cases.json');

const outDir = mkdtempSync(path.join(tmpdir(), 'reach-cross-'));
const js = ts.transpileModule(readFileSync(path.join(API, 'relay_protocol.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/\.ts(["'])/g, '.mjs$1');
const file = path.join(outDir, 'relay_protocol.mjs');
writeFileSync(file, js);
const { canonicalSourceSigned, canonicalRelaySigned } = await import(pathToFileURL(file).href);

const CASES = {
  plain: { category: 'fire', priority: 'high', title: 'Fire', description: 'smoke', location_label: null, location_accuracy_m: null, latitude: null, longitude: null, created_at: 1700000000000 },
  unicode: { category: 'fire', title: 'Incendie 🔥', description: 'ligne1\nligne2\tTab', location_label: 'Rue de l\u2019Église' },
  quotes: { category: 'other', title: 'He said "help"', description: 'back\\slash and /slash' },
  slash_only: { category: 'other', title: 'see http://x/y', description: 'a/b/c' },
  c1_controls: { category: 'medical', title: 'range \u007f\u0080\u009f end', description: 'soft\u00adhyphen' },
  emoji_pair: { category: 'fire', title: '👩‍🚒 team', description: '🏠🏚️' },
  floats: { category: 'other', latitude: 48.8584, longitude: 2.2945, location_accuracy_m: 12.5 },
};

export function buildFixture() {
  const emit = {};
  for (const [name, minimal] of Object.entries(CASES)) {
    const p = { v: 2, k: 'pkt-abcdef01', incident_id: null, e: 1800000000000, h: 0, m: 6, source_device_id: 'dev123', minimal_payload: minimal };
    const source = canonicalSourceSigned(p);
    p.x = 'x'.repeat(64);
    const relay = canonicalRelaySigned({ ...p, h: 0, relay_device_id: 'relaydev' });
    emit[name] = { packetJson: JSON.stringify(p), sourceCanonical: source, relayCanonical: relay };
  }
  return emit;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(OUT, JSON.stringify(buildFixture(), null, 2) + '\n');
  console.log('wrote', OUT);
}
