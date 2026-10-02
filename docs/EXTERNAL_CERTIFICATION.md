# REACH External Certification Checklist

Source hardening and local validators pass. The items below require real
infrastructure, provider credentials or physical devices and are **not**
certified by a source-code audit. Do not label REACH production-ready until
these pass.

## 1. Build

```bash
npm ci
npm run build
npm run validate
npm run validate:hardening
```

Fix every compiler, type, lint, bundler and environment error. Do not suppress
errors merely to obtain a green build.

## 2. Supabase

Create a fresh staging project and apply migrations `0001`–`0018` in order.
Execute an RLS/tenant-isolation regression suite for every role (citizen,
institution, security-desk, staff, operator, unauthenticated). Test
cross-institution attempts for incidents, evidence, responders, members,
notifications, payments, BMONI transactions, relay devices and audit records.

## 3. Relay (physical devices)

Use at least two Android devices with an `assembleDebug` build. Run the full
[physical relay matrix](./PHYSICAL_RELAY_MATRIX.md): offline emergency,
A→B→gateway, A→B→C→gateway, duplicate/modified/tampered packets, invalid or
wrong-key ECDSA signatures, revoked device, device takeover, expired packet,
TTL > 30 min, hop > 6, wrong institution, app restart, screen lock, Bluetooth
and Wi-Fi interruption, battery saver, revoked permissions, gateway
unavailable/recovery.

## 4. BMONI

Verify the exact current BMONI webhook contract from official provider
documentation or account support. Do not assume HMAC-SHA256, header names,
canonicalization or encoding.

Build provider-backed fixtures for: successful, completed, failed and reversed
payments; duplicate and replayed events; modified body; invalid or missing
signature; missing event ID; late failure after success. Run a real sandbox
payment and verify the complete institutional lifecycle end to end.

## 5. Notifications

Connect and test real providers for SMS, USSD, voice/IVR, push and email. Add
retries, dead-letter handling, delivery status and provider webhook
verification.

## 6. Realtime

Validate the custom Supabase Realtime/Phoenix implementation against the
deployed Realtime version. Prefer the official Supabase client subscription API
if it provides equivalent functionality without maintaining protocol code
manually.

## 7. AI

Keep AI advisory only. Build a labelled evaluation set and measure precision,
recall, F1, false positives, false negatives, Brier score, ECE/calibration,
abstention rate, per-category performance and latency.

## 8. Security

Perform authenticated and unauthenticated penetration testing for XSS, CSRF,
CORS, BOLA/IDOR, privilege escalation, RLS bypass, session abuse, relay
replay/tampering, webhook replay, payment replay/idempotency abuse, prompt
injection and oversized payloads.

## 9. Load and failure

Run staging tests at 100, 500 and 1,000 concurrent incidents, plus burst tests
for relay ingestion, webhooks, payments, AI and notifications. Test
Supabase/BMONI/AI/provider outages and recovery.

## 10. Operator provisioning

Replace the reusable browser-submitted provisioning secret with a one-time,
short-lived operator invitation/bootstrap flow before broad production
deployment. Keep the initial platform bootstrap outside normal public signup.

## Final reporting

Produce a report classified as:

1. FIXED
2. VERIFIED
3. FAILED
4. BLOCKED BY EXTERNAL DEPENDENCY
5. REQUIRES PHYSICAL DEVICE
6. REQUIRES PROVIDER/CREDENTIAL
7. REMAINING SECURITY RISK
