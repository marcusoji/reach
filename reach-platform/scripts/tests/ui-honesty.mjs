#!/usr/bin/env node
/**
 * Static honesty gates for the REACH UIs.
 *
 * These are cheap source assertions that fail CI when a fabricated string or a broken field mapping
 * comes back. They do not replace the runtime tests; they pin the specific defects that were found by
 * hand and are easy to reintroduce:
 *
 *   - the security-desk evidence panel must describe evidence that is actually attached, not a
 *     hard-coded CCTV/telemetry/geofence summary;
 *   - the responder dropdown must read the field `/responders` actually returns;
 *   - the desk-settings page must not present invented, unpersisted settings as if they were live;
 *   - the native relay node must register its relay identity and be handed the restored session.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const read = (rel) => (existsSync(join(repo, rel)) ? readFileSync(join(repo, rel), 'utf8') : null);

let pass = 0, fail = 0;
const ck = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`); };

console.log('\n=== UI honesty ===');
{
  const media = read('reach-platform/src/components/incidents/MediaChips.tsx') || '';
  // Strip block/line comments first: the module's own doc comment explains *why* it refuses to
  // invent a CCTV summary, so the words "CCTV"/"geofence" legitimately appear in prose.
  const code = media.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ck('MediaChips has no fabricated CCTV/telemetry strings',
    !/CCTV|Cam-0|#8841|Audio Telemetry/i.test(code));
  ck('MediaChips reports absence honestly',
    /No audio clip is attached/.test(code) && /No image is attached/.test(code));
  ck('MediaChips shows the recorded location, not an invented geofence',
    /locationLabel/.test(code) && /Recorded location/.test(code));
}
{
  const desk = read('reach-platform/src/pages/security-desk/ResponseDeskPage.tsx') || '';
  ck('ResponseDesk reads stored evidence', /listIncidentEvidence/.test(desk));
  ck('ResponseDesk does not pass the always-empty derived evidence to the panel',
    !/MediaChips evidence=\{activeIncident\.evidence\}/.test(desk));
  ck('responder dropdown reads the flat full_name /responders returns',
    /r\.full_name/.test(desk));
}
{
  const team = read('reach-platform/src/pages/security-desk/TeamOnDutyPage.tsx') || '';
  ck('TeamOnDuty does not claim a hard-coded "Zone C" deployment',
    !/Zone C/.test(team));
}
{
  const settings = read('reach-platform/src/pages/security-desk/DeskSettingsPage.tsx') || '';
  ck('DeskSettings does not render unpersisted radio channel / team-on-duty values',
    !/deskSettings\.radioChannel/.test(settings) && !/deskSettings\.teamOnDuty/.test(settings));
  ck('DeskSettings states the settings are not persisted',
    /not persisted|not configurable/i.test(settings));
}
{
  const uploader = read('relay-node-android/app/src/main/java/com/reach/relay/RelayGatewayUploader.kt') || '';
  ck('relay node registers its relay identity', /fun registerDevice\(/.test(uploader) && /registerDeviceAsync/.test(uploader));
  const main = read('relay-node-android/app/src/main/java/com/reach/relay/MainActivity.kt') || '';
  ck('bridge session handoff registers the relay identity',
    /configureSession/.test(main) && /registerDeviceAsync/.test(main));
  const backend = read('reach-citizen-pwa/js/backend.js') || '';
  ck('PWA re-hands the restored session to the native bridge on launch',
    /initBackendSync/.test(backend) && /syncNativeBridgeSession/.test(backend));
}

console.log(`\nTOTAL: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
