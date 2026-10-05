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

## 0022 BMONI payer id: nested `user.bmoniUserId` (BUG-5)

**Symptom.** Institution payer creation returns `201`, but every user-scoped BMONI
call afterwards — `GET /institution/billing/bmoni/status`, `deposit-account`,
`owner-proof-challenge`, `start-nigeria`, `kyc` — returns
`404 {"error":"BMONI request failed (404): User not found"}`.

**Root cause (reproduced against the sandbox).** `POST /v1/users` answers with the
record wrapped in a `user` object that carries **two different ids**:

```
201 {"user": {"id": "<internal row id>", "bmoniUserId": "<the real user id>", ...}}
```

`bmoni_user_id` was extracted as `result.bmoniUserId || result.id || result.user.id
|| ...` — for the real response every earlier key is absent, so the fallback chain
landed on `result.user.id`, i.e. the **internal row id**. That id is accepted by no
user-scoped path: `GET /v1/users/{internalId}/onboarding/status` returns `404`,
while `GET /v1/users/{bmoniUserId}/onboarding/status` returns `200`. This is why the
id used in the earlier successful lifecycle worked (it was the real `bmoniUserId`)
and the payer-creation path did not.

**Fix.**
- `bmoniUserIdFrom(payload)` reads the nested `user.bmoniUserId` and **never** falls
  back to the internal row `id`; it returns `null` on an unrecognised shape so the
  caller fails loudly instead of storing a broken id.
- Payer creation uses it. When the create is a `409` (user already exists, no record
  returned) or an account row has no id, the id is recovered by
  `findBmoniUserIdByEmail` (BMONI has no email filter, so `GET /v1/users` is paged,
  bounded to 10x100).
- `withBmoniUserId(account, run, persist)` wraps every user-scoped route: on a `404`
  for the stored id it looks the payer up by email, persists the corrected id, and
  retries once. Accounts already broken by the old extraction heal on first use.
- The payment-proposal route resolves/heals the id *before* writing
  `bmoni_transactions`, so the id reused later by `payment/sign` matches the provider.

**Verification.** `bmoniUserIdFrom` 7/7 unit assertions pass (nested, flat, data-,
409-body, and the regression guard that the internal id is never returned); raw
sandbox reproduction confirmed `internal id -> 404` and `bmoniUserId -> 200` on the
same user; esbuild bundles the Edge Function cleanly.

## 0023 Payment signing: heal the stored BMONI id (BUG-5 follow-up)

**Symptom.** The proposal route heals a stale `bmoni_user_id`, but `payment/sign`
called `bmoni.signProposal(tx.bmoni_user_id, ...)` with the raw stored value. A
`bmoni_transactions` row created before the 0022 fix could still carry the internal
row id, so signing that proposal would `404` on the provider even though the proposal
step had already repaired the account row.

**Fix.** `payment/sign` now resolves the payer id through the account row (keyed on
`institution_id`), probes it with `onboardingStatus`, and on a `404` heals it by email
(`findBmoniUserIdByEmail`) — updating both `bmoni_transactions.bmoni_user_id` and
`bmoni_institution_accounts.bmoni_user_id` — before signing. The probe only runs when
the transaction id differs from the account id, so the common path stays a single
provider call.

## 0024 Demo data reset + seed

**Context.** The hosted database had accumulated mixed-up test data from repeated
manual signup/incident runs, which made every screen ambiguous for the pitch.

**Deliverable.** `reach-platform/scripts/seed-demo-data.sql` clears every REACH data
record (FK-safe order; schema untouched) and inserts exactly one representative row in
every table, so each screen has something real to show. It is wrapped in a single
transaction (a failure rolls the whole reset back), is idempotent (re-running returns
the same known state), and ends with a per-table row-count summary. Demo sign-ins use
the password `ReachDemo!2026` (`admin@greenfield.reach.dev`, `staff@…`, `desk@…`,
`citizen@…`, `ops@reach.dev`, `superadmin@reach.dev`, plus a second institution
`admin@northgate.reach.dev`). `ai_model_registry` keeps the two canonical rows from
migration 0004 and only the demo row is cleared.

`.github/workflows/seed-demo-data.yml` runs the script against the hosted project via
the Supabase Management API, reusing the repo's existing `SUPABASE_ACCESS_TOKEN` and
`SUPABASE_PROJECT_ID` secrets. It is `workflow_dispatch` only — never automatic —
because it is destructive.

**Verification.** Applied twice against a throwaway Postgres+PostGIS database with the
full migration set (bootstrap + 0001–0021): every one of the 30 public tables reports
at least one row, the second run reproduces the same counts, and RLS read checks pass
for an institution admin and a super-admin.

## 0025 Full-system audit (read/write routes, schema, isolation)

**Context.** Before clearing and re-seeding the hosted database for the pitch, the
system was exercised end to end to catch schema, logic and runtime faults.

**Checks.** All 21 migrations apply transactionally (31 tables) on a throwaway
Postgres+PostGIS 16 database; RLS is enabled on every public table (the five policy-less
tables are deliberately service-role-only); every `SECURITY DEFINER` function pins
`search_path`; the full local suite passes (migration/hardening/security, RPC contract
19/19, AI, relay, PWA, BMONI, tenant-isolation and RPC-shadowing SQL fixtures). Against
the hosted project, every GET route was called as each of the six roles and no route
returned 5xx; the write paths were exercised live (contact CRUD, incident create →
AI assess → evidence → status walk `reported→received→verifying→verified→assigned→
responding→on_scene→resolved→closed`, staff invite create + redeem, responder add +
self status, assignment accept, device register, operator invitation, notification
delivery, and a fresh signup → self-service institution creation, which previously
500'd). Cross-tenant reads are denied and incident creation auto-queues the reporter's
emergency-contact notification and the institution security-desk notification.

**Fix.** `GET /incidents/{id}` used `.single()`, so a missing — or RLS-hidden,
cross-tenant — incident surfaced PostgREST's raw `PGRST116` text ("Cannot coerce the
result to a single JSON object"). It now uses `.maybeSingle()` and returns a clean
`404 { error: 'Incident not found' }`; the global handler also stops echoing the
`PGRST116` message (status was already correct).

## 0026 Citizen estate join + offline alert file transfer

**Context.** Two gaps in the offline emergency path surfaced from a live test.

1. A plain citizen had no way to attach to an institution. `0002` let an institution invite
   *staff* and *security-desk* only; the only institution path for a citizen was to *create* one,
   which hands the caller the institution role. A resident's incident therefore carried
   `institution_id = NULL` and the estate's desk never saw it.
2. A device with no native relay node and no internet had no way to hand its signed alert to the
   relay network. `probeNativeRelay` correctly reported "no relay node", but the only remaining
   options were a live Web Bluetooth pairing (needs the relay app to advertise) or the queued
   gateway path (needs connectivity).

**Fix 1 — migration `0022_citizen_institution_join.sql`.**
`institution_invites` gains an `invite_type` (`member` | `join`). A `join` invite is
institution-scoped, has no email, and keeps the redeemer's `citizen` role. `join_institution_with_code(text)`
links the profile to the invite's institution, records the membership and audits
`membership.joined`. It rejects a caller who is not a citizen and a caller already linked to an
institution, so it is neither a role-escalation nor a tenant-hopping primitive. The code is
hashed with pgcrypto and single-use, like a staff invite. `create_institution_invite` and the
`create_staff_invite` wrapper create either flavour; `list_institution_invites` /
`revoke_institution_invite` manage pending codes for admins only. New RPCs are revoked from
`anon`/PUBLIC and granted to `authenticated`. Joining binds the profile, so incidents filed
*after* the join are stamped with the estate; incidents filed *before* the join are not
retroactively reassigned (a backfill would be a separate workflow).

**Fix 2 — offline alert file transfer (PWA).**
`exportRelayPackets()` (js/backend.js) returns the live, unexpired signed packets as a
`reach-relay-packets` JSON document; `handleRelayExport` offers them through the native share
sheet (or a download fallback). A citizen with no radio path can save the file and hand it to any
REACH relay node over Bluetooth or Wi-Fi file transfer — the packets are already source-signed,
so the node uploads them unchanged (it adds only its own relay envelope). Dead-lettered and
expired packets are excluded. The relay screen's "Test relay link" refusal now points at this
path instead of a dead end.

**Wiring.** Edge Function routes `POST /citizen/join`, `POST /invites` (`type:'join'`),
`GET /institution/invites`, `DELETE /institution/invites/{id}`; `GET /me` now returns
`institution_name`. Platform: `createJoinCode`/`listInstitutionInvites`/`revokeInstitutionInvite`/
`joinInstitutionWithCode` in `reachApi.ts`, a resident join-code panel on the security-roster
page, and a join card on the citizen portal. PWA: an optional join code on the register screen,
a post-report "Join your estate" button, a home estate chip, and the join screen.

**Verification.** `validate:migrations` 22/22 (citizen institution-join suite 9 assertions);
`validate:all` green including two new DB-free PWA suites — `pwa-estate-join` (8) and
`pwa-relay-export` (7); platform `build` passes. The join flow does not retroactively attribute
pre-join incidents, which is stated in the migration header and the UI.
