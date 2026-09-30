# REACH — Grok External Verification & Remaining Fixes

Use this file as an execution checklist, not as a claim that the system is already production-certified.

## 1. Build
Run:

```bash
npm ci
npm run build
npm run validate
npm run validate:hardening
```

Fix every compiler, type, lint, bundler and environment error. Do not suppress errors merely to obtain a green build.

## 2. Supabase
Create a fresh staging project and apply migrations 0001 through 0008 in order. Execute an RLS/tenant-isolation regression suite for every role.

Test cross-institution attempts for incidents, evidence, responders, members, notifications, payments, BMONI transactions, relay devices and audit records.

## 3. Relay
Use at least two physical phones and test:

- offline emergency
- A -> B -> gateway
- A -> B -> C -> gateway
- duplicate packet
- modified packet
- modified signed payload
- invalid ECDSA signature
- wrong public key
- revoked device
- device takeover attempt
- expired packet
- TTL > 30 minutes
- hop > 6
- wrong institution
- app restart
- screen lock
- Bluetooth interruption
- Wi-Fi interruption
- battery saver
- permissions revoked
- gateway unavailable/recovery

## 4. BMONI
Verify the exact current BMONI webhook contract from official provider documentation/account support. Do not assume HMAC-SHA256, header names, canonicalization or encoding.

Create provider-backed fixtures for:

- successful payment
- completed payment
- failed payment
- reversal
- duplicate event
- replayed event
- modified body
- invalid signature
- missing signature
- missing event ID
- late failure after success

Run a real sandbox payment and verify the complete institutional lifecycle.

## 5. Operator provisioning
Replace the reusable browser-submitted provisioning key with a one-time, short-lived invitation/bootstrap flow. Keep the initial platform bootstrap outside normal public signup.

## 6. Notifications
Connect and test real providers for SMS, USSD, voice/IVR, push and email. Add retries, dead-letter handling, delivery status and provider webhook verification.

## 7. Realtime
Validate the current custom Supabase Realtime/Phoenix implementation against the deployed Realtime version. Prefer the official Supabase client subscription API if it provides equivalent functionality without maintaining protocol code manually.

## 8. AI
Keep AI advisory only. Build a labelled evaluation set and measure precision, recall, F1, false positives, false negatives, Brier score, ECE/calibration, abstention rate, per-category performance and latency.

## 9. Security
Perform authenticated and unauthenticated penetration testing for XSS, CSRF, CORS, BOLA/IDOR, privilege escalation, RLS bypass, session abuse, relay replay/tampering, webhook replay, payment replay/idempotency abuse, prompt injection and oversized payloads.

## 10. Load/failure
Run staging tests at 100, 500 and 1,000 concurrent incidents and burst tests for relay ingestion, webhooks, payments, AI and notifications. Test Supabase/BMONI/AI/provider outages and recovery.

## Final reporting
Produce:

1. FIXED
2. VERIFIED
3. FAILED
4. BLOCKED BY EXTERNAL DEPENDENCY
5. REQUIRES PHYSICAL DEVICE
6. REQUIRES PROVIDER/CREDENTIAL
7. REMAINING SECURITY RISK

Do not label REACH production-ready until the external tests above pass.
