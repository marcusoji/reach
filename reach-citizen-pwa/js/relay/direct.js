/**
 * Direct browser → nearby relay node over Web Bluetooth.
 *
 * A plain browser (or a PWABuilder/TWA shell, which is just Chrome) has no native relay node, so the
 * only way it can hand an offline alert to the relay network is to write the signed packet straight
 * to a nearby Android relay node's GATT service and wait for that node's ACK. This is foreground-only:
 * Web Bluetooth needs the page open and a user gesture to pick the device, and the web platform has
 * no background radio API. The native node (relay-node-android) is what runs the radios in the
 * background; this module is the citizen-device half that reaches it.
 */
import {
  buildRelayPacket,
  connectBluetoothRelay,
  sendBluetoothPacket,
  subscribeAck,
  awaitAck,
  RELAY_SERVICE_UUID,
  RELAY_DATA_UUID,
  RELAY_ACK_UUID,
} from './protocol.js';

let activeConnection = null;
let connecting = null;

function nativeBridge() {
  if (typeof window === 'undefined') return null;
  const bridge = window.REACH_NATIVE_RELAY;
  return bridge && typeof bridge === 'object' ? bridge : null;
}

/** True only in a plain browser that has Web Bluetooth and no native node to prefer. */
export function directRelayAvailable() {
  if (nativeBridge()) return false;
  return typeof navigator !== 'undefined' && Boolean(navigator.bluetooth?.requestDevice);
}

/** The currently paired relay node, if any. */
export function directRelayConnection() {
  return activeConnection ? { name: activeConnection.name } : null;
}

/**
 * Pair with a nearby relay node. Must be called from a user gesture (Web Bluetooth opens a chooser).
 * The connection is reused for later sends so a citizen pairs once.
 */
export async function connectDirectRelay() {
  if (!directRelayAvailable()) {
    throw new Error('Bluetooth is off on this device. Turn it on to relay, or keep the alert queued.');
  }
  if (activeConnection) return activeConnection;
  if (connecting) return connecting;
  connecting = (async () => {
    const connection = await connectBluetoothRelay({
      serviceUuid: RELAY_SERVICE_UUID,
      dataCharacteristicUuid: RELAY_DATA_UUID,
      ackCharacteristicUuid: RELAY_ACK_UUID,
    });
    activeConnection = { ...connection, name: connection.device?.name || 'nearby REACH device' };
    return activeConnection;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

export function disconnectDirectRelay() {
  try { activeConnection?.server?.disconnect?.(); } catch { /* already gone */ }
  activeConnection = null;
}

/**
 * Send one signed packet to a nearby relay node and wait for its ACK.
 * @returns {Promise<{ok:boolean, reason:string, device:string}>}
 */
export async function sendPacketViaDirectRelay(packet) {
  if (nativeBridge()) return { ok: false, reason: 'native_bridge', device: '' };
  const connection = await connectDirectRelay();
  if (connection.ackCharacteristic) await subscribeAck(connection.ackCharacteristic);
  // Attach the ACK listener before writing: the node notifies only once per packet, so a listener
  // added after the write could miss the notification and turn a delivery into a timeout.
  const ackPromise = awaitAck(connection.ackCharacteristic, { packetKey: packet.k, packetHash: packet.x });
  await sendBluetoothPacket(connection, packet);
  const ack = await ackPromise;
  return { ...ack, device: connection.name };
}

/**
 * Send a harmless low-priority probe packet and report whether a nearby relay node carried it.
 * This answers "can this phone relay to the network", not merely "is Bluetooth on".
 */
export async function probeDirectRelay() {
  if (!directRelayAvailable()) {
    return { ok: false, detail: 'Bluetooth is off on this device. Turn it on to test the relay link.' };
  }
  let packet;
  try {
    ({ packet } = await buildRelayPacket({
      packetKey: `pwa-direct-probe-${crypto.randomUUID()}`,
      incidentId: null,
      category: 'test',
      priority: 'low',
      title: 'REACH relay test',
      description: 'Relay link test — no emergency.',
      locationLabel: 'Relay test',
      locationSource: 'manual',
    }));
  } catch {
    return { ok: false, detail: 'The relay test could not build a packet.' };
  }
  try {
    const result = await sendPacketViaDirectRelay(packet);
    if (result.ok) return { ok: true, detail: `${result.device} accepted the test packet. Your phone can hand alerts to it.` };
    if (result.reason === 'timeout') return { ok: false, detail: `${result.device} accepted the packet but has not confirmed it yet. Keep both devices nearby and try again.` };
    if (result.reason === 'ack_unavailable') return { ok: false, detail: `${result.device} cannot confirm a carried packet yet. Keep both devices nearby and try again.` };
    return { ok: false, detail: `${result.device} did not accept the test packet. Keep both devices nearby and try again.` };
  } catch (error) {
    const message = `${error?.name || ''} ${error?.message || ''}`;
    if (/cancel|user/i.test(message)) return { ok: false, detail: 'No relay device was selected.' };
    if (/unavailable|not available|not supported|SecurityError|adapter|Bluetooth/i.test(message)) return { ok: false, detail: 'Bluetooth is off on this device. Turn it on to relay.' };
    return { ok: false, detail: 'Could not reach a nearby relay node. Keep both devices nearby and try again.' };
  }
}
