/**
 * Exercises the real relay status module (js/relay/status.js).
 *
 * The point of this module is honesty: it must report the queue depth and radio state that
 * actually exist, and never claim the device is relaying when it is not. It reads the relay queue
 * through window.REACH_RELAY_QUEUE (exposed by backend.js), which this test stubs.
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

const { relayStatus, relaySummary } = await import(pathToFileURL(path.join(PWA, 'relay', 'status.js')).href);

let pass = 0, fail = 0;
const ck = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  [PASS] ${name}${detail ? '  — ' + detail : ''}`); } else { fail++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); } };
const reset = () => { globalThis.window.REACH_NATIVE_RELAY = undefined; globalThis.window.REACH_RELAY_QUEUE = undefined; };

console.log('\n=== PWA relay status ===');
{
  // 1. No queue handle: depth is zero, not guessed.
  reset();
  const status = await relayStatus();
  ck('no queue reports zero pending', status.queued === 0 && status.dead === 0);
  ck('plain browser cannot claim native relay', status.capability.nativeRelay === false);
}
{
  // 2. A pending packet is surfaced honestly.
  reset();
  globalThis.window.REACH_RELAY_QUEUE = {
    listRelayQueue: async () => [{ id: 'a', state: 'queued' }, { id: 'b', state: 'dead_letter', lastError: 'no_ack' }],
    listRelayDeadLetter: async () => [{ id: 'b', state: 'dead_letter', lastError: 'no_ack' }],
  };
  const status = await relayStatus();
  ck('pending counts exclude dead letters', status.queued === 1, `queued=${status.queued}`);
  ck('dead letters surfaced', status.dead === 1 && status.lastError === 'no_ack');
  ck('summary mentions the stuck packet', /could not be delivered/i.test(relaySummary(status)));
}
{
  // 3. A native node with Bluetooth off must say so, not claim readiness.
  reset();
  globalThis.window.REACH_NATIVE_RELAY = { getPermissionStatus: () => JSON.stringify({ permissions: true, bluetooth: false, wifi: false, hotspot: false }) };
  globalThis.window.REACH_RELAY_QUEUE = { listRelayQueue: async () => [], listRelayDeadLetter: async () => [] };
  const status = await relayStatus();
  ck('native relay detected', status.capability.nativeRelay === true && status.radio?.bluetooth === false);
  ck('summary asks for Bluetooth', /switch(ed)? on|Bluetooth/i.test(relaySummary(status)));
}
{
  // 4. Permission granted but the node is not advertising: "ready" would be a lie.
  reset();
  globalThis.window.REACH_NATIVE_RELAY = { getPermissionStatus: () => JSON.stringify({ permissions: true, bluetooth: true, wifi: true, hotspot: false, service_running: true, advertising: false }) };
  globalThis.window.REACH_RELAY_QUEUE = { listRelayQueue: async () => [], listRelayDeadLetter: async () => [] };
  const status = await relayStatus();
  ck('non-advertising node is not called ready', !/^Ready to carry/i.test(relaySummary(status)));
  ck('summary explains the node is not advertising', /getting ready/i.test(relaySummary(status)));
}
{
  // 5. A fully listening node may claim readiness.
  reset();
  globalThis.window.REACH_NATIVE_RELAY = { getPermissionStatus: () => JSON.stringify({ permissions: true, bluetooth: true, wifi: true, hotspot: false, service_running: true, advertising: true }) };
  globalThis.window.REACH_RELAY_QUEUE = { listRelayQueue: async () => [], listRelayDeadLetter: async () => [] };
  const status = await relayStatus();
  ck('advertising node reports ready', /^Ready to carry/i.test(relaySummary(status)));
}
{
  // 6. Wi-Fi is a relay path on its own: a node listening only on Wi-Fi (Bluetooth off) must not
  // be told to switch Bluetooth on, and must not be asked for a radio it is already using.
  reset();
  globalThis.window.REACH_NATIVE_RELAY = { getPermissionStatus: () => JSON.stringify({ permissions: true, bluetooth: false, wifi: true, hotspot: false, service_running: true, advertising: true, wifi_listening: true, ble_listening: false }) };
  globalThis.window.REACH_RELAY_QUEUE = { listRelayQueue: async () => [], listRelayDeadLetter: async () => [] };
  const status = await relayStatus();
  ck('Wi-Fi-only node is not asked to switch Bluetooth on', !/Turn Bluetooth/i.test(relaySummary(status)));
  ck('Wi-Fi-only listening node reports ready', /^Ready to carry/i.test(relaySummary(status)));
}

{
  // 7. A plain browser with no native node and no Web Bluetooth hand-off must not claim it can
  // relay. There is no transport it can use, so "Ready to carry alerts" would be a fabrication.
  reset();
  globalThis.window.REACH_RELAY_QUEUE = { listRelayQueue: async () => [], listRelayDeadLetter: async () => [] };
  const status = await relayStatus();
  ck('a transportless browser is not called ready', !/^Ready to carry/i.test(relaySummary(status)), relaySummary(status));
  ck('a transportless browser is told how to actually send', /connection|save the alert file/i.test(relaySummary(status)));
}

console.log(`\nTOTAL: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
