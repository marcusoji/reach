# REACH 0008 — Next Full Fixes & External Certification Plan

## Source-level fixes completed in this package

1. Corrected the backend signup flow so production backend signup does not depend on demo mode.
2. Removed the implicit BMONI development endpoint. `BMONI_BASE_URL` is now mandatory and HTTPS-only.
3. Moved AI incident authorization before external model invocation.
4. Replaced static system-health claims with real database/incident/relay probes plus BMONI/AI configuration checks.
5. Improved API error mapping so unexpected server failures return 500 instead of being mislabeled as 400.
6. Hardened relay device registration so ownership cannot transfer between users and public-key changes require re-enrollment.
7. Hardened relay ingestion against unsafe UUID casts and cross-institution source/actor mismatches.
8. Enforced a server-side 30-minute relay TTL ceiling and six-hop ceiling.
9. Preserved first-seen relay packet security identity on duplicates.
10. Made BMONI webhook settlement monotonic so late failures cannot downgrade successful transactions.
11. Added a database guard preventing multiple initiated/pending institutional subscription payments for the same institution/subscription.
12. Added PWA offline queue maximum size, 24-hour expiry cleanup, and exponential retry backoff.
13. Added production HTTP security headers to the Vercel configuration.

## Verification performed here

- Existing REACH validator: PASS.
- New final-hardening static regression suite: PASS (10/10 checks).
- PWA `backend.js` JavaScript syntax check: PASS.
- Full React production build: NOT CERTIFIED; dependency installation timed out in this environment.
- Live Supabase migration/RLS execution: NOT PERFORMED.
- Android build/device testing: NOT PERFORMED.
- BMONI live/provider verification: NOT PERFORMED.

## External work that remains

### BMONI
Verify the exact current webhook signature contract from BMONI. Do not assume the HMAC implementation is correct without provider evidence. Build provider-backed fixtures for valid, invalid, modified, replayed, duplicate, late-failure and reversal events.

### Supabase
Apply migrations 0001–0008 to a fresh staging project. Test all RLS policies and tenant boundaries for every role, including malicious cross-institution requests.

### React
Run `npm ci`, `npm run build`, and available typecheck/lint scripts in a network-enabled environment. Fix every real compiler/build error.

### Android
Add/verify the Gradle wrapper and run assemble/test/lint. Then perform physical relay tests on at least two Android devices.

### Relay
Test offline A→B→gateway, A→B→C→gateway, duplicates, tampering, invalid signatures, revoked devices, wrong institution, expiration, hop limits, app restart, screen lock, Bluetooth/Wi-Fi interruption, permissions and gateway recovery.

### Notifications
Connect real SMS/USSD/voice/IVR/push/email providers and implement/test delivery workers, retries, dead-letter handling and provider webhook verification.

### Operator provisioning
Replace the reusable browser-submitted provisioning secret with a one-time short-lived operator invitation/bootstrap flow before broad production deployment.

### Realtime
Validate the custom Supabase Realtime implementation against the deployed version or migrate to the official Supabase subscription client.

### AI
Keep AI advisory. Build a labelled evaluation set and measure precision, recall, F1, false-positive/false-negative rates, Brier score, calibration error, abstention rate, per-category performance and latency.

### Security and resilience
Perform deployed penetration testing and load/failure testing at 100, 500 and 1,000 concurrent incidents plus relay/webhook/payment/AI/notification bursts and dependency outages.
