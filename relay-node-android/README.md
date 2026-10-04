# REACH Native Relay Node v2

The native Android relay node is the reliable radio layer for REACH. A normal browser/PWA cannot guarantee background Bluetooth advertising/GATT server behavior or Wi-Fi Direct participation, so the PWA uses this native node when available.

A browser can also hand a single packet to a nearby node directly over Web Bluetooth, without the native bridge. See [Browser → node (Web Bluetooth)](#browser--node-web-bluetooth).

## Real transport paths

```text
Citizen PWA
   │
   ├── HTTPS ─────────────────────────► REACH Core
   │
   └── Native bridge
          │
          ├── BLE GATT ─► nearby REACH node
          │                  │
          └── Wi-Fi Direct ─┘
                     │
                     ▼
               durable queue
                     │
                     ▼
                gateway sync
```

## BLE

- native GATT server advertises the REACH service;
- native GATT central scans for the same service;
- packets are fragmented into bounded frames;
- fragments carry transfer ID, sequence and total count;
- receiver reassembles before validating;
- packet signature/fingerprint/TTL/hop checks happen before forwarding;
- native queue persists packets before forwarding.

## Wi-Fi Direct

- uses Android Wi-Fi P2P APIs;
- discovers nearby peers;
- connects to a peer;
- group owner exposes a bounded TCP packet endpoint;
- packets are framed with a 4-byte length prefix;
- packet size is capped;
- packet validation happens before persistence.

## Gateway uplink

A node with connectivity drains its durable queue straight to the gateway over HTTPS; a node
without connectivity forwards over radio instead.

- the PWA hands the node the gateway base URL, the session access token and the anon key through
  the `REACH_NATIVE_RELAY` bridge (`configureSession`); the session is stored on the device and is
  only accepted for an `https://` origin (or loopback for local development);
- each queued packet is POSTed to `/relay/packets` as the server body (`transport: "native"`);
- a packet that already travelled a radio hop (`h > 0`) is wrapped in this node's relay envelope
  before upload, because the gateway rejects a non-zero hop count that no relay envelope vouches
  for; the hop count itself is not incremented on upload;
- the row is deleted only on a 2xx response; any other outcome (including no connectivity) leaves
  it queued and it is retried with the same backoff as a radio hop.

## Security

Each native node generates a P-256 ECDSA identity in Android Keystore. The private key never leaves the device. Source packets and relay envelopes are signed. The backend verifies the signatures and requires registered, active devices.

## AI

AI is not part of the radio transport. The platform's Safety Fusion v2 layer combines user reports, evidence quality, freshness, corroboration, contradictions and optional multimodal model output. The AI can assist or recommend prioritization but cannot autonomously authorize emergency response.

## Browser → node (Web Bluetooth)

When the citizen device has no native bridge (a plain browser tab, or a PWABuilder/TWA
package), the PWA can still send one signed packet to a nearby node by connecting to the
node's GATT server and writing the packet, then waiting for the node's ACK.

The browser-side implementation is `reach-citizen-pwa/js/relay/direct.js`; the UUIDs and
framing are shared with `RelayProtocol.kt` / `BleTransfer.kt`:

| Purpose | UUID |
| --- | --- |
| Service | `6b4f1c20-…` (`RelayProtocol.SERVICE_UUID`) |
| Data (write) | `6b4f1c21-…` (`DATA_UUID`) |
| ACK (notify) | `6b4f1c22-…` (`ACK_UUID`) |

Frame header is `[transferId:4][seq:1][total:1]`, then up to 180 bytes of payload. The
node ACKs only after it has validated and persisted the packet, so a matching ACK means
the alert is in the relay queue.

This path is foreground-only (Web Bluetooth requires the page open and a user gesture to
choose the device); background relay remains the native node's job. Run the two-phone
acceptance test in `docs/DEPLOYMENT_RUNBOOK.md` (“Browser → relay node (Web Bluetooth)
physical test”).

---

## Physical verification still required

The code now contains the real Android transport paths, but radio behavior must be verified on at least two physical Android devices. Test:

1. both devices online;
2. source device offline, relay device online;
3. both devices offline, then gateway reconnect;
4. BLE enabled/disabled;
5. Wi-Fi Direct enabled/disabled;
6. device locked/unlocked;
7. Android battery optimization enabled/disabled;
8. duplicate packet delivery;
9. expired packets;
10. packet tampering;
11. multiple hops;
12. app/service restart during transfer.
