# REACH Deep Technical Audit — Relay, Bluetooth/Wi-Fi, AI

Date: 2026-09-28

## Executive result

The previous archive did **not** contain a working phone-to-phone Bluetooth/Wi-Fi relay implementation. It contained a backend relay-packet model and UI/demo flow. The PWA also contained simulated AI perception UI but no production sensor/vision/audio inference pipeline.

This revision adds:

- a versioned relay packet protocol with size, TTL and hop checks;
- browser capability detection for Web Bluetooth/WebRTC;
- an explicit Web Bluetooth adapter for a supported external GATT relay peripheral;
- a native Android relay-node reference implementation with BLE GATT server support;
- a native Wi-Fi Direct transport class for Android;
- a native PWA bridge path;
- a server-side evidence-fusion AI engine with abstention and human-verification rules;
- an authenticated server endpoint for storing AI assessments;
- stronger audit restrictions;
- wording changes so unsupported browser capabilities are not presented as guaranteed functionality.

## What can and cannot be verified in a browser

### Bluetooth

A normal web page cannot be treated as a universal phone-to-phone BLE relay. Web Bluetooth is limited-availability, secure-context-only, permission-controlled and is not exposed in Web Workers. The current browser adapter therefore targets a supported external GATT peripheral; it does not falsely claim that two ordinary PWAs can advertise as BLE peripherals to one another.

### Wi-Fi Direct

There is no general-purpose browser Wi-Fi Direct API in this project. The browser detects WebRTC capability but does not claim Wi-Fi Direct. Android native code contains the Wi-Fi P2P transport path instead.

### WebRTC

WebRTC DataChannel is suitable for peer-to-peer data transfer once a connection has been negotiated. A signaling path is still required to establish the peer connection. Therefore WebRTC is treated as an opportunistic connected/local-network transport, not as a magic no-network discovery mechanism.

### Background operation

The PWA does not guarantee unrestricted background relay. Device/OS/browser lifecycle and permission behavior can stop a web process. The native Android relay service is the dependable relay layer for the target Android deployment.

## Relay architecture

```text
Citizen PWA
   |
   | connected
   v
REACH API

Citizen PWA
   |
   | offline
   v
IndexedDB queue
   |
   +--> native Android relay bridge
           |
           +--> BLE GATT nearby hop
           |
           +--> Wi-Fi Direct native transport
           |
           v
       Relay node
           |
           | internet restored
           v
       REACH API
           |
           v
      Incident Core
```

Every relay packet has:

- protocol version
- packet key
- incident reference
- source device
- category/priority
- minimal location data
- creation/expiry timestamps
- current hop count
- maximum hop count
- SHA-256 packet fingerprint

The server additionally enforces TTL and hop limits and deduplicates by packet key.

## AI architecture

The AI layer is deliberately **assistive**, not autonomous emergency authority.

```text
User report
Image evidence (when explicitly enabled)
Audio evidence (when explicitly enabled)
Motion/sensor evidence (when explicitly enabled)
Location/context
Corroborating reports
Relay metadata
        |
        v
REACH Safety Fusion
        |
        +--> category assessment
        +--> evidence strength
        +--> consistency margin
        +--> contradiction penalty
        +--> temporal decay
        +--> abstention decision
        v
Assist / Recommend
        |
        v
Human verification
```

An optional server-side model adapter can add multimodal/text model reasoning when configured. Its output is validated and fused with the deterministic engine. The resulting score is a **decision-support score, not a calibrated probability**. Calibration requires a representative, labeled validation dataset from the actual deployment environment. The system therefore abstains when evidence is weak or contradictory rather than fabricating certainty.

No AI assessment can directly mark an incident verified or complete a response assignment.

## Automated tests performed

- All REACH JS/TS/TSX source files were parsed successfully with the TypeScript parser.
- Relay packet tests: PASS.
- Relay expiry validation: PASS.
- Relay hop-limit validation: PASS.
- Relay packet size validation: PASS.
- AI engine TypeScript compilation: PASS.
- AI strong-evidence/recommendation test: PASS.
- AI weak-evidence/abstention test: PASS.

## Remaining physical verification

The following cannot honestly be marked as physically verified from a source-code/container audit:

1. BLE transfer between two physical Android phones.
2. Wi-Fi Direct transfer between two physical Android phones.
3. Android background execution under battery optimization.
4. Bluetooth permission behavior across the exact target Android versions.
5. End-to-end relay upload with production device credentials.
6. AI model accuracy on real emergency data.
7. AI calibration against a representative labeled dataset.

These require controlled device testing and real deployment data.
