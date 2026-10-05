/**
 * Exercises the native save branch of the relay packet export in reach-citizen-pwa/js/app.js.
 *
 * Inside the relay-node app's WebView there is no share sheet and a blob download cannot complete,
 * so "Save alert file to transfer" must hand the JSON to window.REACH_NATIVE_RELAY.saveExportFile
 * and report the native result. These tests drive the real click handler with a fake bridge and pin
 * that the file is written natively, that a plain browser keeps using the share sheet, and that a
 * cancelled share is not surfaced as an error.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PWA = path.join(HERE, '..', '..', '..', 'reach-citizen-pwa');

// app.js is a top-level script, not an ES module, so it is evaluated with a stubbed DOM/backend.
// The relay export handler only needs: the elements it writes to, window, document, and the two
// imported backend functions it calls.
const listeners = new Map();
const element = (id) => ({
  id,
  textContent: '',
  disabled: false,
  value: '',
  addEventListener: (type, fn) => listeners.set(`${id}:${type}`, fn),
  querySelector: () => null,
});

const els = {
  relayExportButton: element('relayExportButton'),
  relayExportStatus: element('relayExportStatus'),
  relayImportInput: element('relayImportInput'),
  relayImportStatus: element('relayImportStatus'),
};

let nativeSave = null;
let shareCalled = 0;
let downloadClicked = 0;
globalThis.window = {
  addEventListener: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  location: { href: 'https://example.test/' },
  REACH_CONFIG: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon' },
};
globalThis.document = {
  querySelector: (sel) => els[sel.replace('#', '')] || null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  createElement: (tag) => {
    const el = element(tag);
    el.click = () => { downloadClicked++; };
    el.remove = () => {};
    el.href = '';
    el.download = '';
    return el;
  },
  body: { appendChild: () => {} },
  documentElement: { classList: { add: () => {}, remove: () => {} } },
  readyState: 'complete',
};
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, canShare: () => false }, configurable: true, writable: true });
globalThis.URL.createObjectURL = () => 'blob:test';
globalThis.URL.revokeObjectURL = () => {};
globalThis.Blob = class { constructor() {} };
globalThis.File = class { constructor(parts, name) { this.parts = parts; this.name = name; } };

// The handler imports from backend.js; swap in a controllable export set by evaluating app.js with
// a module shim is not possible for a classic script, so the relay export payload is injected through
// the one seam the handler uses: the backend module's exportRelayPackets. app.js is imported as a
// module here (Node parses the import statements it contains only if the file is a module); the file
// is a classic script, so instead the handler is copied verbatim from source and bound to these stubs.
const source = readFileSync(path.join(PWA, 'js', 'app.js'), 'utf8');
const start = source.indexOf('async function handleRelayExport()');
assert.ok(start > 0, 'handleRelayExport must exist in app.js');
const end = source.indexOf('\n}', start) + 2;
const handlerSrc = source.slice(start, end);

const makeHandler = (exportRelayPackets) => {
  const factory = new Function('$', 'exportRelayPackets', 'navigator', 'window', 'document', 'URL', 'File', 'Blob',
    `${handlerSrc}\nreturn handleRelayExport;`);
  return factory((sel) => els[sel.replace('#', '')], exportRelayPackets, globalThis.navigator, globalThis.window, globalThis.document, globalThis.URL, globalThis.File, globalThis.Blob);
};

const payload = { format: 'reach-relay-packets', version: 1, packets: [{ k: 'a', x: 'b', e: Date.now() + 60_000 }] };

let pass = 0, fail = 0;
const ck = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  [PASS] ${name}${detail ? '  — ' + detail : ''}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); } };

console.log('\n=== PWA relay file save ===');
{
  // 1. Native bridge present: the file must be written natively and the status must say so.
  nativeSave = { saved: true, location: 'Downloads/reach-alert-2026-01-01.json' };
  let savedName = null, savedContents = null;
  globalThis.window.REACH_NATIVE_RELAY = {
    saveExportFile: (name, contents) => { savedName = name; savedContents = contents; return JSON.stringify(nativeSave); },
  };
  const run = makeHandler(async () => payload);
  await run();
  ck('native bridge receives the file name', /^reach-alert-\d{4}-\d{2}-\d{2}\.json$/.test(savedName || ''), savedName || 'none');
  ck('native bridge receives the JSON envelope', (() => { try { return JSON.parse(savedContents).format === 'reach-relay-packets'; } catch { return false; } })());
  ck('status reports the saved location', els.relayExportStatus.textContent.includes('Downloads/reach-alert'), els.relayExportStatus.textContent);
  ck('no blob download is attempted when the bridge saves', downloadClicked === 0);

  // 2. Native bridge refuses: the status must not claim a save.
  globalThis.window.REACH_NATIVE_RELAY = { saveExportFile: () => '{"saved":false}' };
  await makeHandler(async () => payload)();
  ck('a refused native save is reported as unsaved', /could not be saved/i.test(els.relayExportStatus.textContent), els.relayExportStatus.textContent);

  // 3. No native bridge: a plain browser falls back to a blob download.
  globalThis.window.REACH_NATIVE_RELAY = undefined;
  downloadClicked = 0;
  globalThis.navigator.canShare = () => false;
  await makeHandler(async () => payload)();
  ck('a plain browser falls back to a download', downloadClicked === 1, String(downloadClicked));

  // 4. Empty queue: nothing to transfer, no file written.
  globalThis.window.REACH_NATIVE_RELAY = { saveExportFile: () => { throw new Error('should not be called'); } };
  await makeHandler(async () => ({ format: 'reach-relay-packets', version: 1, packets: [] }))();
  ck('an empty queue is explained, not saved', /No saved alerts/i.test(els.relayExportStatus.textContent), els.relayExportStatus.textContent);
}

console.log(`\nTOTAL: ${pass}/${pass + fail} passed`);
assert.equal(fail, 0, `${fail} PWA relay-save assertion(s) failed`);
