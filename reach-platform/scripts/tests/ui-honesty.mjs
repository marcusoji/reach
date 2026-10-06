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
{
  // BMONI onboarding honesty: the rail is provisioned asynchronously, so a read of the NGN
  // endpoint must not mark the account ready, and the setup checklist must reflect the real
  // rail state rather than a flag that only a successful start sets.
  const api = read('reach-platform/supabase/functions/api/index.ts') || '';
  const deposit = api.slice(api.indexOf("'/institution/billing/bmoni/deposit-account'"));
  ck('deposit-account verifies anchorStatus before marking the account ready',
    /anchorStatus/.test(deposit.slice(0, 2400)) && /ngn_virtual_account_ready: true/.test(deposit.slice(0, 2400)));
  ck('deposit-account does not mark ready on a not-yet-active anchor',
    /anchorActive/.test(deposit.slice(0, 2400)) && /if \(!anchorActive\)/.test(deposit.slice(0, 2400)));

  const billing = read('reach-platform/src/pages/institution/BillingPlanPage.tsx') || '';
  ck('billing setup checklist derives onboarding from the rail status, not bvn_verified',
    !/Boolean\(account\?\.bvn_verified\)/.test(billing) && /onboarding_status/.test(billing));
  ck('billing sandbox demo does not read a pooled deposit account while the rail is inactive',
    /anchor/.test(billing) && !/deposit\?\.data\?\.accounts\?\.find/.test(billing));
}
{
  // Relay honesty: a browser with no native node and no Web Bluetooth must not claim it can carry
  // a packet. The status line and the permission result must point at the paths that actually work.
  const status = read('reach-citizen-pwa/js/relay/status.js') || '';
  const permissions = read('reach-citizen-pwa/js/relay/permissions.js') || '';
  ck('relay status never falls through to an unconditional "ready to carry"',
    !/return 'Ready to carry alerts nearby\.';/.test(status));
  ck('relay status tells a transportless browser how to actually send',
    /cannot carry alerts to a relay node on its own/i.test(status));
  ck('relay permissions does not promise delivery with no transport',
    !/carried to REACH through the nearby relay network/i.test(permissions));
}
{
  // Open-incident counts must treat Closed as terminal, not only Resolved.
  for (const rel of [
    'reach-platform/src/pages/security-desk/LiveQueuePage.tsx',
    'reach-platform/src/pages/institution/OverviewPage.tsx',
    'reach-platform/src/pages/operator/OperatorOverviewPage.tsx',
  ]) {
    const page = read(rel) || '';
    ck(`${rel.split('/').pop()} counts Closed as terminal`, /'Closed'/.test(page) && !/status !== 'Resolved'\)/.test(page));
  }
}

console.log(`\nTOTAL: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
