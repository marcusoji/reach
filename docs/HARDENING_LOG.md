# REACH Hardening Log

Consolidated record of source-level hardening across the MVP, 0007, 0008 and
0009 eras. This is a **historical fix log**, not a certification claim. For
current status see [REACH_PRODUCTION_STATUS.md](./REACH_PRODUCTION_STATUS.md);
for what still requires external verification see
[EXTERNAL_CERTIFICATION.md](./EXTERNAL_CERTIFICATION.md).

## Hosted-debug pass (0019–0021)

Fixes found against the live hosted project, where several guard rails that the
local fixtures could not exercise were silently broken.

- **Staff invites returned 500 / redeem 422 (0019, 0020).** Two independent
  faults. First, `create_staff_invite`/`redeem_staff_invite` declared
  `p_role public.reach_role`, and PL/pgSQL lowered the parameter name to `role`,
  colliding with the reserved word / the `profiles.role` column; 0019 renames it.
  Second, both functions call `digest()` but pin `set search_path=public`, while
  Supabase installs pgcrypto into the `extensions` schema. The `if not exists`
  in 0001 was a no-op there, so the call failed with `42883 function
  digest(text, unknown) does not exist` — 0020 adds `extensions` to the path.
  The local bootstrap used to install pgcrypto in `public`, hiding this; it now
  mirrors Supabase.
- **API errors were opaque (index.ts).** The catch block only read a message
  from `Error` instances. A Supabase `PostgrestError` is a plain object, so
  every `raise exception` guard became a generic 500. The handler now reads the
  message/code off any error shape and maps PostgREST/SQLSTATE codes to HTTP
  statuses, surfacing caller-facing 4xx detail while keeping 5xx generic.
- **BMONI KYC sent the wrong field.** The wrapper forwarded `addressDetails`,
  which BMONI rejects; it expects a single `address` object.
- **Evidence capture bypassed by a NULL institution (0021).**
  `attach_incident_evidence` guarded with `institution_id is distinct from
  current_institution_id()`. A citizen's incident is `institution_id = NULL` and
  a citizen caller is `NULL`, so `NULL is distinct from NULL` is FALSE — the
  guard passed for *any* authenticated user. Any signed-in citizen could attach
  evidence (including the strongest image/audio/video weights) to, and read
  back, an unrelated citizen's institution-less report. 0021 requires an
  explicit non-NULL institution match for non-reporters; RLS assertion 19 pins
  it. NOTE: this is the *opposite* direction from the 0012 rule for the `<>`
  operator — `<>` needs NULL-safety to fail closed, a bare `is distinct from`
  on a NOT-guard needs it too. Compare institution ids explicitly in both
  shapes.

## Payment boundary (design invariant)

Only institutions are billable. Residents/citizens, students, staff, security
personnel, responders and REACH operators have no individual emergency-access
payment.

```
Institution → REACH billing → BMONI Embedded → CNGN transfer proposal
  → device-side signature → BMONI settlement → verified webhook
  → REACH ledger → subscription activation
```

A frontend success state never activates an institution subscription. No
emergency creation, relay, responder workflow or citizen functionality is
conditioned on individual payment — a live emergency must not be blocked
solely because billing has expired.

## MVP hardening pass

- Privileged signup role escalation: public signup always creates `citizen`.
- Institution account creation: an authenticated citizen creates an institution
  through a server-side transaction and is promoted only by that function.
- Staff/security access: single-use, expiring, email-bound invitations.
- Operator access: server-side provisioning key; no public self-assigned
  operator role. Super-admin is not self-assignable.
- Profile privilege tampering: role, institution and zone protected by a
  database trigger.
- Cross-institution incident injection: incident institution derived from the
  authenticated profile.
- Direct incident mutation: client-side update policies closed; workflow
  functions enforce state transitions (server-side state machine).
- Cross-institution responder assignment: server-side institution check.
  Responder task ownership: only the assigned responder can advance their task.
- Relay packet ingestion: authenticated function, tenant check, idempotent
  packet key, TTL and hop validation. Broad relay reads scoped by
  incident/institution.
- Direct notification insertion closed; a system trigger/function creates
  notifications. Audit log client insert/update/delete removed.
- API rate limiting on authenticated route buckets. CORS allowlist via
  `REACH_ALLOWED_ORIGINS` instead of wildcard production CORS.
- Auth refresh: access-token expiry refreshed through the Supabase refresh-token
  endpoint. Backend role spoofing: the login role selector is ignored when a
  backend is configured.
- Static/demo data removed from live-configured operation pages.
- Security-desk workflow: verify → assign → respond → on scene → resolve →
  close. Responder workflow: assigned → accepted → responding → on scene →
  completed. Responder directory/roster and institution invitations added.
- Trusted-contact backend CRUD; emergency-contact notification queue on incident
  creation; real GPS capture with accuracy metadata.
- PWA tracking uses the real incident UUID after synchronization; offline queue
  keeps idempotency and maps queued incidents to real server IDs. Non-retryable
  client validation errors are no longer queued as offline incidents.
- Service worker no longer caches cross-origin authenticated API responses.
  PWA no longer ships filled demo credentials.
- Fake "call placed", "payment completed", "AI confidence" and "background
  Bluetooth works everywhere" claims removed or marked as demo/unsupported.
- PWA install icons added (192px and 512px). Supabase Realtime incident
  subscription added with polling fallback, plus the realtime publication
  migration. Operator AI/relay/system/audit screens use backend data or
  explicit empty states. Billing UI no longer fabricates successful payments.

## 0007 hardening additions

- Explicit production/demo separation: missing backend configuration no longer
  silently enables demo authentication.
- Operator provisioning cannot call the privileged SQL promotion function
  directly from an authenticated browser — the Edge Function validates the
  provisioning secret and uses the service role for the privilege change.
- Relay ingestion is cryptographically verified in the Edge Function before the
  trusted service-only database function is called; browser access to the old
  privileged relay ingestion RPC is revoked.
- Offline relay ingestion reconstructs a provisional incident when no server
  incident exists yet. Tenant ownership is derived from the registered source
  device's authenticated owner, not attacker-controlled packet tenant fields.
- Relay packet duplicates are immutable/idempotent: an existing packet is
  returned rather than having security identity fields overwritten.
- Server relay ingestion clamps `max_hops` to 6 and rejects expired packets.
- Relay signatures verified in the Edge Function with ECDSA P-256/SHA-256; the
  packet fingerprint is recomputed before trusted SQL ingestion.
- Service-role access fails closed; privileged operations no longer fall back to
  the anon key.
- Relay queue no longer marks asynchronous BLE/Wi-Fi delivery as successful
  before the peer callback; native packets remain queued until gateway or peer
  callback success.
- BMONI requests have a timeout and server-side API key handling. Institutional
  payment amount is server-controlled rather than browser-supplied. Payment
  signatures are format-validated as 65-byte 0x-prefixed.
- Payment status retrievable by the owning institution. BMONI webhook processing
  is signature-gated and idempotent by event ID. Successful settlement updates
  the ledger and activates/extends the subscription; reversal moves the
  subscription to `past_due`; failed payments do not activate it.
- Institutional BMONI payment intents are created locally before a provider
  proposal, giving retries a durable idempotency anchor. Webhook events use a
  durable inbox and atomic SQL settlement, and are marked processed only after
  payment/subscription state changes succeed.
- Correlation IDs returned for unexpected API failures; detailed errors logged
  server-side. Demo credentials remain source-visible only inside the explicitly
  gated demo code path.

## 0008 source-level fixes

- Corrected backend signup so production signup does not depend on demo mode.
- Removed the implicit BMONI development endpoint: `BMONI_BASE_URL` is mandatory
  and HTTPS-only.
- Moved AI incident authorization before external model invocation.
- Replaced static system-health claims with real database/incident/relay probes
  plus BMONI/AI configuration checks.
- Improved API error mapping so unexpected server failures return 500 instead of
  being mislabeled 400.
- Hardened relay device registration: ownership cannot transfer between users
  and public-key changes require re-enrollment. Source/actor institution binding
  enforced in SQL; offline/local incident IDs UUID-validated before casting.
- Enforced a server-side 30-minute relay TTL ceiling and six-hop ceiling;
  duplicate relay packets preserve their original security identity.
- BMONI settlement made monotonic so late failures cannot downgrade successful
  transactions. A database guard prevents multiple initiated/pending
  institutional subscription payments for the same institution/subscription.
- BMONI webhook inbox retains retryability when processing fails.
- PWA offline queue maximum size, 24-hour expiry cleanup, and exponential retry
  backoff. Production HTTP security headers added to the Vercel configuration.

## 0009 source cross-check

**33/33 intended source checks PASS** after the BillingPlanPage and webhook
patches. Local: `validate` PASS, hardening 10/10 PASS, production build PASS.

- **AI (advisory):** labelled advisory in Safety Fusion v2; abstains on
  weak/contradictory/stale evidence; weighted fusion by evidence kind; external
  model is a second opinion only and never authorizes response; API keys
  server-side only (not `VITE_`); no operator "approve AI" API. Standard of
  care encoded: AI scores and routes; desk decides; operator oversees metrics.
- **Relay:** server hop ceiling 6; server TTL ~30 minutes; source/relay ECDSA
  verification; device takeover blocked; UUID cast guarded; cross-institution
  binding present; Android BLE + Wi-Fi Direct with signed packets and durable
  queue; PWA offline queue / `DEMO_MODE` config.
- **Billing/BMONI:** HTTPS-only `BMONI_BASE_URL`; no implicit dev endpoint;
  official `X-Webhook-Signature`; constant-time signature compare; monotonic
  settlement; single pending institutional payment; treasury/amount
  server-controlled; payment signature submit import (build).
- **Auth/tenancy/API:** explicit demo mode flag; citizen-oriented public signup;
  rate limiting; auth required on API; migrations present.

## Verification performed (local)

- `npm run validate` — PASS.
- `npm run validate:hardening` — 10/10 PASS.
- `npm run build` (`tsc && vite build`) — PASS.
- PWA JavaScript files pass Node syntax checking; HTML, manifest and package
  JSON parse.
- Migrations execute transactionally against PostGIS with RLS on every public
  table (see [CI_AND_TESTS.md](./CI_AND_TESTS.md)).

Local verification is source + build only. Live RLS, real payments, multi-phone
relay and load/pen tests remain external gates.
