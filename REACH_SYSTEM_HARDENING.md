# REACH Full-System Hardening Pass

## Payment boundary
Only institutions are billable. Residents/citizens, students, staff, security personnel, responders and REACH operators have no individual emergency-access payment.

The subscription payment path is:

Institution → REACH billing → BMONI Embedded → CNGN transfer proposal → device-side signature → BMONI settlement → verified webhook → REACH ledger → subscription activation.

A frontend success state never activates an institution subscription.

## Failure controls implemented
- Explicit production/demo separation. Missing backend configuration no longer silently enables demo authentication.
- Operator provisioning cannot call the privileged SQL promotion function directly from an authenticated browser. The Edge Function validates the provisioning secret and uses the service role for the actual privilege change.
- Relay ingestion is cryptographically verified in the Edge Function before the trusted service-only database function is called.
- Browser access to the old privileged relay ingestion RPC is revoked.
- Relay queue no longer marks asynchronous BLE/Wi-Fi delivery as successful before the peer callback.
- Native relay packets remain queued until gateway success or peer callback success.
- BMONI requests have a timeout and server-side API key handling.
- Institutional payment amount is server-controlled instead of accepting arbitrary browser-supplied amounts.
- BMONI payment signatures are format-validated as 65-byte 0x-prefixed signatures.
- Payment status can be retrieved by the owning institution.
- BMONI webhook processing is signature-gated and idempotent by event ID.
- Successful settlement updates the REACH payment ledger and activates/extends the institutional subscription.
- Reversal moves the subscription to `past_due`; failed payments do not activate it.
- Correlation IDs are returned for unexpected API failures while detailed errors are logged server-side.
- Demo credentials remain source-visible only inside the explicitly gated demo code path and are never used when production mode is active.

## Required production verification
These checks still require real infrastructure and/or physical devices and therefore are not claimed as completed by a source-code audit:
- Supabase migrations 0001–0006 against a fresh database.
- Supabase RLS regression tests with citizen, institution, security-desk, staff, operator and unauthenticated callers.
- BMONI sandbox user/wallet/KYC/onboarding flow with an approved sandbox persona.
- Real BMONI webhook signature verification against the exact production webhook contract.
- End-to-end CNGN institutional payment and settlement.
- Real Flutter BMONI SDK signing on Android/iOS.
- Physical BLE relay and Wi-Fi Direct tests across two devices.
- Android Gradle build/CI; the supplied relay module still needs a reproducible Gradle wrapper/CI environment.
- Load/failure testing for simultaneous incidents, relay duplicates, expired packets, database outages, BMONI outages, webhook retries and offline recovery.

## Non-payment rule
No emergency creation, relay, responder workflow or citizen functionality is conditioned on individual payment. Institutional subscription state may control institution administration/billing features, but a live emergency must not be blocked solely because billing has expired.

## 0007 hardening additions
- Offline relay ingestion now reconstructs a provisional incident when no server incident exists yet. Tenant ownership is derived from the registered source device's authenticated owner, not from attacker-controlled packet tenant fields.
- Relay packet duplicates are immutable/idempotent: an existing packet is returned rather than having security identity fields overwritten.
- Server relay ingestion clamps `max_hops` to 6 and rejects expired packets.
- Relay signatures are verified in the Edge Function with ECDSA P-256/SHA-256 and the packet fingerprint is recomputed before trusted SQL ingestion.
- Service-role access now fails closed; privileged operations no longer fall back to the anon key.
- Institutional BMONI payment intents are created locally before a provider proposal, giving retries a durable idempotency anchor.
- BMONI webhook events use a durable inbox and atomic SQL settlement. Events are only marked processed after payment/subscription state changes succeed; failed processing remains retryable.
- The BMONI webhook signing contract remains explicitly configurable and fail-closed. The exact provider header/algorithm was not independently verifiable from the supplied documentation, so production certification still requires matching the provider's exact webhook contract.
