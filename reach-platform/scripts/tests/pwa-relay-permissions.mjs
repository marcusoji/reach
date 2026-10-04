/**
 * Exercises the real PWA relay permission flow in js/relay/permissions.js.
 *
 * The module talks to two worlds: a native relay node exposed as window.REACH_NATIVE_RELAY,
 * and a plain browser with (or without) Web Bluetooth. This stubs both and asserts the module
 * reports what actually happened rather than optimistically claiming a radio is on.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PWA = path.join(HERE, '..', '..', '..', 'reach-citizen-pwa', 'js');

globalThis.window = {};
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
globalThis.RTCPeerConnection = function () {};

const mod = await import(pathToFileURL(path.join(PWA, 'relay', 'permissions.js')).href);
const { relayPermissionStatus, requestRelayPermissions } = mod;

let pass = 0, fail = 0;
const ck = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  [PASS] ${name}${detail ? '  — ' + detail : ''}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); } };

const reset = () => { globalThis.window.REACH_NATIVE_RELAY = undefined; Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true }); };

console.log('\n=== PWA relay permissions ===');
{
  // 1. Neither a native node nor Web Bluetooth: never claims success.
  reset();
  const result = await requestRelayPermissions();
  ck('no transport reports unavailable', result.granted === false && result.mode === 'unavailable');
  ck('unavailable message still promises delivery', /carried to REACH/i.test(result.detail));
}
{
  // 2. A browser that grants Bluetooth through the chooser.
  reset();
  let requested = false;
  Object.defineProperty(globalThis, 'navigator', { value: { bluetooth: { requestDevice: async () => { requested = true; return { name: 'REACH Node' }; } } }, configurable: true, writable: true });
  const result = await requestRelayPermissions();
  ck('browser chooser grants bluetooth', requested && result.granted === true && result.bluetooth === true);
  ck('browser mode cannot claim wifi', result.mode === 'browser-central-only' && result.wifi === false);
}
{
  // 3. A cancelled chooser is reported as not granted, not as an error.
  reset();
  Object.defineProperty(globalThis, 'navigator', { value: { bluetooth: { requestDevice: async () => { const e = new Error('User cancelled the requestDevice() chooser.'); throw e; } } }, configurable: true, writable: true });
  const result = await requestRelayPermissions();
  ck('cancelled chooser is not granted', result.granted === false);
  ck('cancelled chooser is worded plainly', /not granted/i.test(result.detail));
}
{
  // 4. A native relay node that answers immediately.
  reset();
  globalThis.window.REACH_NATIVE_RELAY = { requestPermissions: () => JSON.stringify({ accepted: true, bluetooth: true, wifi: true, detail: 'Relay node ready' }) };
  const result = await requestRelayPermissions();
  ck('native node grants bluetooth and wifi', result.granted === true && result.mode === 'native-relay-node' && result.bluetooth && result.wifi);
}
{
  // 5. A native node whose runtime dialog is asynchronous: poll until it reports granted.
  reset();
  let statusCalls = 0;
  globalThis.window.REACH_NATIVE_RELAY = {
    requestPermissions: () => JSON.stringify({ accepted: false, detail: 'Waiting for Bluetooth/Wi-Fi permission' }),
    getPermissionStatus: () => { statusCalls++; return JSON.stringify({ permissions: statusCalls >= 2, bluetooth: statusCalls >= 2, wifi: true }); },
  };
  const result = await requestRelayPermissions();
  ck('native pending dialog is polled to granted', result.granted === true && result.mode === 'native-relay-node');
  ck('polling stopped once granted', statusCalls === 2, `statusCalls=${statusCalls}`);
}
{
  // 6. relayPermissionStatus surfaces the native bridge and capability detail without prompting.
  reset();
  globalThis.window.REACH_NATIVE_RELAY = { getPermissionStatus: () => JSON.stringify({ permissions: true, bluetooth: true, wifi: true, hotspot: false }) };
  const status = await relayPermissionStatus();
  ck('status reports native relay', status.nativeRelay === true && status.native?.permissions === true);
  ck('status recommends the native path', status.recommendedPath === 'native-relay-node');
  ck('status carries the hotspot flag', status.native?.hotspot === false);
}

console.log(`\nTOTAL: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
