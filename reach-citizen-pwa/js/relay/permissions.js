/**
 * Relay permission acquisition.
 *
 * A browser cannot silently switch the Bluetooth or Wi-Fi radios on, and there is no web API for
 * Wi-Fi Direct at all. What we can do honestly:
 *
 * - When the PWA runs inside the native relay node (the `REACH_NATIVE_RELAY` bridge), ask the
 *   node to request its runtime Bluetooth/Wi-Fi permissions and prompt the user to enable the
 *   radios. The node owns the real transport.
 * - In a plain browser, surface the Web Bluetooth chooser (which is also what grants the
 *   page Bluetooth access) from a user gesture, and report the adapter availability.
 *
 * Everything here is best-effort and reports what actually happened; it never claims a radio is
 * on when the platform refused.
 */
import { detectRelayCapabilities } from './capabilities.js';

const SERVICE_UUID = '6b4f1c20-9f4a-4f6e-9c2d-1a2b3c4d5e6f';

function nativeBridge() {
  if (typeof window === 'undefined') return null;
  const bridge = window.REACH_NATIVE_RELAY;
  return bridge && typeof bridge === 'object' ? bridge : null;
}

/** Best-effort capability snapshot. Safe to call without a user gesture. */
export async function relayPermissionStatus() {
  const caps = await detectRelayCapabilities();
  const bridge = nativeBridge();
  let native = null;
  if (bridge && typeof bridge.getPermissionStatus === 'function') {
    try { native = JSON.parse(bridge.getPermissionStatus()); } catch { native = null; }
  }
  return {
    nativeRelay: !!(bridge || caps.nativeRelay),
    bluetoothApi: caps.bluetoothApi,
    bluetoothAvailable: caps.bluetoothAvailable,
    wifiMode: caps.wifiMode,
    recommendedPath: caps.recommendedPath,
    native,
  };
}

/** Request relay permissions. Must be called from a user gesture in a browser. */
export async function requestRelayPermissions() {
  const bridge = nativeBridge();

  // Native node: it can actually request permissions and enable the radios.
  if (bridge && typeof bridge.requestPermissions === 'function') {
    try {
      const raw = bridge.requestPermissions();
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed?.accepted) {
        return { granted: true, mode: 'native-relay-node', bluetooth: !!parsed.bluetooth, wifi: !!parsed.wifi, detail: parsed.detail || 'Relay node ready' };
      }
      // The runtime dialog is asynchronous, so the first answer is usually "pending". Poll the
      // node's real state briefly rather than reporting a refusal the user never made.
      if (typeof bridge.getPermissionStatus === 'function') {
        for (let i = 0; i < 10; i++) {
          await new Promise(resolve => setTimeout(resolve, 400));
          try {
            const status = JSON.parse(bridge.getPermissionStatus());
            if (status?.permissions) {
              return { granted: true, mode: 'native-relay-node', bluetooth: !!status.bluetooth, wifi: !!status.wifi, detail: status.detail || 'Relay node ready' };
            }
          } catch { /* keep polling */ }
        }
      }
      return { granted: false, mode: 'native-relay-node', detail: parsed?.detail || 'Waiting for Bluetooth/Wi-Fi permission.' };
    } catch (error) {
      return { granted: false, mode: 'native-relay-node', detail: 'The relay node did not answer the permission request.' };
    }
  }

  // Plain browser: Web Bluetooth is the only relay radio we can reach, and it is granted
  // through the chooser. Wi-Fi Direct is not available to a page.
  if (typeof navigator !== 'undefined' && navigator.bluetooth?.requestDevice) {
    try {
      const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [SERVICE_UUID] });
      return {
        granted: true,
        mode: 'browser-central-only',
        bluetooth: true,
        wifi: false,
        detail: device?.name ? `Paired with ${device.name}` : 'Bluetooth access granted',
      };
    } catch (error) {
      // A cancelled chooser is not an error worth shouting about.
      const cancelled = /cancel|user/i.test(String(error?.message || ''));
      return { granted: false, mode: 'browser-central-only', detail: cancelled ? 'Bluetooth permission was not granted.' : String(error?.message || 'Bluetooth is unavailable.') };
    }
  }

  return {
    granted: false,
    mode: 'unavailable',
    detail: 'This browser cannot turn Bluetooth or Wi-Fi on. The emergency is still delivered through the normal connection or the offline queue.',
  };
}
