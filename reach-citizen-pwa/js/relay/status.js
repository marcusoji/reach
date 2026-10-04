/**
 * Relay participation status.
 *
 * A relay node does two jobs: it forwards its own alerts, and it carries packets for other
 * devices. The queue a browser holds is real (IndexedDB), and a native node reports its own
 * state, so this module reports what is actually happening rather than a scripted animation:
 * how many packets are waiting, whether any are permanently stuck, and what the last hop did.
 */
import { detectRelayCapabilities } from './capabilities.js';

const CAPABILITY_LABEL = {
  'native-gatt-relay': 'Bluetooth + Wi-Fi Direct relay node',
  'browser-central-only': 'Bluetooth (foreground only)',
  'native-relay-required': 'Needs the REACH relay app',
  unavailable: 'No relay radio on this device',
};

function nativeBridge() {
  if (typeof window === 'undefined') return null;
  const bridge = window.REACH_NATIVE_RELAY;
  return bridge && typeof bridge === 'object' ? bridge : null;
}

function relayQueue() {
  return window.REACH_RELAY_QUEUE || null;
}

/**
 * Snapshot of relay participation: capability, radios, and the real queue depth.
 * @returns {Promise<{capability:object, radio:object|null, queued:number, dead:number, lastError:string|null, transport:string|null}>}
 */
export async function relayStatus() {
  const capability = await detectRelayCapabilities();
  const bridge = nativeBridge();
  let radio = null;
  if (bridge && typeof bridge.getPermissionStatus === 'function') {
    try { radio = JSON.parse(bridge.getPermissionStatus()); } catch { radio = null; }
  }

  let queued = 0;
  let dead = 0;
  let lastError = null;
  const queue = relayQueue();
  if (queue) {
    try {
      const rows = await queue.listRelayQueue();
      queued = (rows || []).filter((i) => i.state !== 'dead_letter').length;
      dead = (rows || []).filter((i) => i.state === 'dead_letter').length;
      lastError = (rows || []).find((i) => i.state === 'dead_letter')?.lastError || null;
    } catch { /* queue unreadable */ }
  }

  return {
    capability,
    capabilityLabel: CAPABILITY_LABEL[capability.bluetoothMode] || capability.bluetoothMode,
    radio,
    queued,
    dead,
    lastError,
    transport: capability.nativeRelay ? 'native-relay-node' : 'browser',
  };
}

/** One-line, honest description of relay participation for a chip or status line. */
export function relaySummary(status) {
  if (!status) return 'Relay status unavailable.';
  if (status.dead > 0) return `${status.dead} packet${status.dead === 1 ? '' : 's'} could not be delivered — reconnect to retry.`;
  if (status.queued > 0) return `${status.queued} packet${status.queued === 1 ? '' : 's'} waiting to be carried.`;
  const radio = status.radio;
  if (radio && !radio.bluetooth) return 'Waiting for Bluetooth to be switched on.';
  // Permission granted is not the same as listening: report the real advertising state rather than
  // telling the citizen the node is ready when it cannot be discovered.
  if (radio && radio.permissions && radio.advertising === false) return 'Bluetooth is on, but this node is not advertising yet.';
  if (status.capability.nativeRelay) return 'Ready to carry emergency packets nearby.';
  if (status.capability.bluetoothApi) return 'Ready while this screen is open.';
  return 'This device cannot relay; your own alert still reaches REACH over the network.';
}
