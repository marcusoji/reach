# REACH Native Relay Node v2

The native Android relay node is the reliable radio layer for REACH. A normal browser/PWA cannot guarantee background Bluetooth advertising/GATT server behavior or Wi-Fi Direct participation, so the PWA uses this native node when available.

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

## Security

Each native node generates a P-256 ECDSA identity in Android Keystore. The private key never leaves the device. Source packets and relay envelopes are signed. The backend verifies the signatures and requires registered, active devices.

## AI

AI is not part of the radio transport. The platform's Safety Fusion v2 layer combines user reports, evidence quality, freshness, corroboration, contradictions and optional multimodal model output. The AI can assist or recommend prioritization but cannot autonomously authorize emergency response.

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
