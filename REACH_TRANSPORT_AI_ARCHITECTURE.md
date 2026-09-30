# REACH Transport + AI Architecture v2

## 1. Transport strategy

REACH uses a **layered transport architecture**, not a claim that a browser can create a universal mesh.

```text
                    ┌───────────────────────┐
                    │     REACH Citizen     │
                    │       PWA / UI        │
                    └───────────┬───────────┘
                                │
                    Connected? ─┴─ Yes ───────► HTTPS API
                                │
                                No
                                │
                    ┌───────────▼───────────┐
                    │ Durable Local Queue   │
                    │ IndexedDB / SQLite     │
                    └───────────┬───────────┘
                                │
                ┌───────────────┼────────────────┐
                │               │                │
                ▼               ▼                ▼
          BLE GATT          Wi-Fi Direct     Store/Forward
          short packets     higher volume     retry queue
                │               │                │
                └───────────────┼────────────────┘
                                ▼
                       Connected Gateway
                                │
                                ▼
                         REACH Core/API
```

### BLE
- GATT service discovery
- authenticated packet envelope
- MTU-safe fragmentation
- transfer IDs and sequence numbers
- bounded packet size
- reassembly timeout
- SHA-256 packet fingerprint
- source-device ECDSA signature
- relay-device ECDSA signature
- TTL + hop limit
- durable queue after receipt

BLE is used for **small, urgent packets**, not media transfer.

### Wi-Fi Direct
- native Android only
- peer discovery
- explicit P2P connection
- group-owner/server model
- bounded TCP packet framing
- packet validation before persistence
- higher-throughput fallback for larger evidence when policy allows

Wi-Fi Direct is intentionally not exposed as a fake browser API.

### Web Bluetooth
The PWA may connect to a REACH native relay node when the browser supports Web Bluetooth and the user grants permission. It is a capability, not a universal guarantee.

### Relay rules
1. Never forward an expired packet.
2. Never exceed the maximum hop count.
3. Never accept a packet with a mismatched fingerprint.
4. Never accept a packet whose source signature is invalid.
5. Never silently modify the source-signed payload.
6. Every relay adds its own authenticated envelope.
7. Duplicate packet keys are idempotent.
8. Store first, forward second.
9. Never place unnecessary personal information in relay packets.
10. A relay node never becomes the authority that verifies an emergency.

## 2. Device identity

Each native relay node generates a P-256 ECDSA key pair in Android Keystore.

The private key never leaves the device.

The public key is registered against the authenticated REACH account. Relay packets contain:

```text
source_device_id
source_public_key
source_signed_payload
source_signature
relay_device_id
relay_public_key
relay_signed_payload
relay_signature
```

The API verifies both the immutable source evidence and the current relay envelope.

## 3. AI architecture

REACH uses **AI as safety intelligence, not autonomous authority**.

```text
User report ───────┐
Image evidence ────┤
Audio evidence ────┤
Motion/sensors ────┤
Location/context ──┤
Nearby reports ────┤
Relay evidence ────┘
          │
          ▼
   Evidence Normalizer
          │
          ▼
   Quality + freshness
          │
          ▼
 Deterministic Fusion
          │
          ├───────────────┐
          ▼               ▼
 On-device model     Cloud model
 (when available)    (when connected)
          │               │
          └───────┬───────┘
                  ▼
            Model Agreement
                  │
          Contradiction Check
                  │
          Confidence Calibration
                  │
            Abstention Gate
                  │
         ┌────────┴────────┐
         ▼                 ▼
      Assist           Recommend
         │                 │
         └────────┬────────┘
                  ▼
          Human Verification
                  │
                  ▼
            Responder Action
```

### AI safety properties
- deterministic evidence fusion remains the baseline;
- external model output is a second opinion;
- model disagreement reduces confidence;
- weak evidence causes abstention;
- stale evidence decays;
- duplicate evidence is de-duplicated;
- contradictory evidence is penalized;
- model/provider/version are recorded;
- explanations are stored with the assessment;
- no AI output directly authorizes emergency action;
- model credentials remain server-side;
- field calibration is required before treating scores as probabilities.

## 4. AI maturity path

### MVP
- deterministic fusion
- optional multimodal model
- confidence + uncertainty
- evidence provenance
- human review

### Field pilot
- collect reviewer outcomes
- measure false positives/false negatives
- calibrate confidence
- compare model versions in shadow mode
- evaluate per-category performance

### Production
- versioned model registry
- calibration curves
- drift detection
- latency monitoring
- model rollback
- adversarial-input testing
- privacy-preserving evidence retention

## 5. Important platform limitation

A normal web page cannot be treated as a guaranteed background Bluetooth/Wi-Fi mesh node. REACH therefore uses a native Android relay node for reliable background radio participation, while the PWA remains the citizen-facing interface.
