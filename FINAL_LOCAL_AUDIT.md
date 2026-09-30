# REACH Final Local Audit — 0008 Source Baseline

## Scope
This package is based on the recoverable `REACH-FULL-HARDENED-FIXED-0007.zip` and includes the reconstructed `0008_final_hardening.sql` plus source-level fixes.

## Fixed in this baseline
- Backend signup/demo-mode regression.
- BMONI implicit development endpoint removed; URL must be explicitly configured.
- AI incident authorization occurs before external AI provider invocation.
- Real system-health database/incident/relay probes.
- HTTP error handling no longer turns unexpected server/provider failures into generic 400 responses.
- Relay device ownership cannot silently transfer between users.
- Relay source/actor institution binding is enforced in SQL.
- Offline/local incident IDs are UUID-validated before casting.
- Relay TTL is capped server-side at 30 minutes.
- Relay hop ceiling remains server-enforced at 6.
- Duplicate relay packets preserve their original security identity.
- BMONI late failures cannot downgrade successful/reversed transactions.
- Only one initiated/pending institutional subscription payment is allowed per institution/subscription.
- BMONI webhook inbox retains retryability when processing fails.

## Local verification
Run:

```bash
npm run validate
npm run validate:hardening
```

The repository still requires a real `npm ci && npm run build` in a network-enabled environment for final production build certification.

## Not certifiable locally
- Exact BMONI webhook signature contract.
- Live Supabase migration/RLS execution.
- Real BMONI production transaction.
- Android release build/device behavior.
- Physical multi-hop BLE/Wi-Fi relay.
- SMS/USSD/voice/IVR provider delivery.
- AI statistical calibration on labelled emergency data.
- Penetration testing of the deployed environment.
- Load/failure testing against staging infrastructure.
