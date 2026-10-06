# REACH MVP production verification checklist

Applies to the current schema, migrations `0001`–`0022`. Every item is a control that must hold
before production traffic; the bracketed test is the gate that pins it in CI
(`npm run validate:all` from `reach-platform/`).

## Backend

- [ ] Apply the full migration set in order, `0001` → `0022`, to a fresh project. Never skip one
      (`npm run validate:migrations` executes every file transactionally).
- [ ] Confirm the migration run reports `22 migrations applied transactionally (31 tables)` and
      `row level security enabled on every public table`.
- [ ] Configure `REACH_ALLOWED_ORIGINS` with exact production origins (single-label wildcards are
      supported, but no bare `*`). A missing value makes every browser API call an opaque
      `Failed to fetch` — verify with the `Origin`-echo curl in the runbook.
- [ ] Keep `supabase/config.toml` `[functions.api] verify_jwt = false` (the API self-authenticates
      and serves an unauthenticated `/health`), or every webhook gets `401 Invalid JWT`.
- [ ] Configure a strong `REACH_OPERATOR_PROVISION_KEY`; it is bootstrap-only (below).
- [ ] Enable email verification and password recovery.
- [ ] Confirm `supabase_realtime` includes `incidents`, `incident_assignments` and `notifications`.
- [ ] Confirm Storage policies for the private `incident-evidence` bucket before enabling evidence
      uploads (path must be `${uid}/…`).
- [ ] Configure SMS/USSD/voice provider before enabling those channels.
- [ ] Configure the BMONI provider before enabling institutional payment processing.

## Identity and tenancy

- [ ] Public signup always produces `citizen` (`tests/rls_tenant_isolation.sql`).
- [ ] A citizen cannot update their role, institution or zone.
- [ ] A citizen cannot create an incident for another institution.
- [ ] A citizen cannot directly change incident status except permitted cancellation.
- [ ] A responder cannot update another responder's task.
- [ ] Cross-institution assignment fails.
- [ ] Tenant guards use `is distinct from` where NULL must fail closed, and an explicit
      `inst is null or inst <> current` where a NULL institution must fail the guard
      (migrations `0012`, `0021`; RLS assertions 8–9 and 19).
- [ ] Relay packets from another institution are rejected.
- [ ] Audit rows cannot be inserted/updated/deleted by a client.
- [ ] API rate limiting returns HTTP 429 after the configured threshold.
- [ ] Every JSON body is read via `readJsonLimited` (256 KiB; 512 KiB for the webhook)
      (`npm run test:security`).

## Operator access

- [ ] First operator: `POST /operator/provision` with the provision key → creates a **super-admin**;
      the key is disabled the moment any operator/super-admin exists.
- [ ] Further operators join only through a single-use, email-bound, 24-hour invitation
      (`POST /operator/invitations` → signup → `POST /operator/invitations/accept`), audited.
- [ ] Staff and security-desk join only through an institution-issued single-use invite
      (`POST /invites` → `POST /invites/redeem`).
- [ ] A resident citizen joins an estate through a `join`-type invite
      (`POST /citizen/join`, migration `0022`); it keeps the `citizen` role, rejects a non-citizen or
      an already-linked caller, and never retroactively reassigns pre-join incidents.
- [ ] The operator provisioning RPC rejects a direct authenticated call; the Edge Function secret is
      required.

## Evidence capture (`0015`/`0017`/`0018`/`0021`)

- [ ] `ingest_incident_evidence_service` is **service_role only**; a client-callable version would let
      any signed-in user manufacture `corroboration`.
- [ ] `attach_incident_evidence` requires the storage path to begin with the caller's own uid and to
      contain no `..`.
- [ ] A media kind (`image`/`audio`) requires a real uploaded object with a matching content type and
      hash; a bare claim is rejected (`0018`).
- [ ] `corroboration`, `sensor` and `motion` are not client-capturable — only the service-role derived
      path sets their weight.
- [ ] One incident accepts at most 20 evidence rows.
- [ ] Fusion confidence is derived server-side from `kind`, never sent by the client.
- [ ] A captured photo survives a re-assessment: `ingest_incident_evidence_service` replaces only rows
      tagged `derived: true`, and the tag is merged after client metadata so it cannot be forged.
- [ ] A NULL-institution reporter cannot attach evidence to another citizen's incident (`0021`).

## Relay

- [ ] `public.ingest_relay_packet(jsonb)` is `service_role` only (migration `0011`), so it cannot be
      used as a PostgREST bypass of the Edge Function.
- [ ] Server-side verification runs in `relay_verify.ts`; the signed payload does not contain `x`.
- [ ] A packet with `hop_count > 0` without a relay envelope is rejected.
- [ ] Gateway dedup goes through `record_relay_ingest_dedup()` (atomic upsert), not read-then-write.
- [ ] `ingest_relay_packet_service()` short-circuits a duplicate packet only for the same source
      device; a cross-tenant `packet_key` collision is rejected.
- [ ] Source device is an `active` `device_registrations` row whose `public_key` matches.
- [ ] Server TTL ceiling ~30 minutes and six-hop ceiling enforced; `minimal_payload` keys are
      snake_case.
- [ ] Service-role-only relay ingestion verified; a direct authenticated RPC call is rejected
      (`npm run test:relay-sim`).
- [ ] Offline alert export (`exportRelayPackets`) excludes dead-lettered and expired packets and can
      be handed to a relay node as a file (`npm run test:pwa-relay-export`).

## Billing (BMONI)

- [ ] BMONI API key and webhook secret exist only as Edge Function secrets (never `VITE_*`).
- [ ] `BMONI_BASE_URL` is mandatory and HTTPS-only; no implicit dev endpoint.
- [ ] Subscription amount and treasury destination are server controlled; a self-transfer to the
      payer's own wallet is refused.
- [ ] Payer phone is normalised to E.164 (`normalizePhone`); a non-E.164 value returns `422` instead
      of a provider round-trip (`npm run test:bmoni-phone`).
- [ ] The BMONI user id is read only through `bmoniUserIdFrom` (never the internal `user.id`), and
      already-broken rows heal on first use (`npm run test:bmoni-uid`).
- [ ] Webhook signature is verified with the official `X-Webhook-Signature` (constant-time compare).
- [ ] Duplicate webhook deliveries are idempotent (durable inbox by event ID).
- [ ] Settlement is monotonic: a late failure/reversal cannot downgrade a successful transaction;
      failed/reversed payments never activate a subscription.
- [ ] Successful settlement activates/extends the subscription only once.
- [ ] One active (initiated/pending) subscription payment per institution/subscription
      (`bmoni_one_active_subscription_payment`).
- [ ] Live emergency creation remains available during institutional grace/expiry policy.
- [ ] Verify against the real BMONI sandbox before enabling production payments
      (`npm run test:bmoni-demo` drives the documented sandbox persona).

## AI (advisory only)

- [ ] The provider system prompt is identity-neutral (`MODEL_SYSTEM_PROMPT`) and demands JSON only;
      do not point `REACH_AI_ENDPOINT` at a provider whose prompt contract is unverified
      (`npm run test:providers`).
- [ ] The API key is read server-side only (never `VITE_*`); `/system/health` reports the real
      breaker state.
- [ ] Contradictory evidence feeds only the contradiction penalty — never support or category scores.
- [ ] Non-numeric evidence `quality` is coerced or dropped, never allowed to become `NaN`.
- [ ] `assessEvidence` abstains when `decision_basis.blockers` is non-empty (`npm run test:ai`).
- [ ] Evidence capture is an explicit operator action; the second opinion is advisory and never
      authorizes response.
- [ ] Provider telemetry records a classified `failure_kind` for every `/ai/assess` call.
- [ ] AI output is labelled advisory and field calibration metrics are collected before any
      production accuracy claim.

## Frontend

- [ ] `VITE_REACH_DEMO_MODE=false` in every production frontend build.
- [ ] Production Supabase URL and anon key configured; no fallback auth.
- [ ] Loading, "unavailable" and "offline" states are honest: no page claims a failure while data is
      still loading (`npm run test:ui-honesty`).
- [ ] CORS, CSP, session storage and body-limit controls hold (`npm run test:security`).
- [ ] BLE queue is not deleted before peer acknowledgement; Wi-Fi queue is not deleted before send
      callback success.
- [ ] Physical relay tests cover disconnect, retry, duplicate, expiry, restart and revoked-device
      cases (`tests/PHYSICAL_RELAY_MATRIX.md`).

## End-to-end flow

1. Citizen registers (public signup → `citizen`).
2. Institution admin creates an invitation (staff/security) and, separately, a resident `join` code.
3. Staff/security user redeems the invitation; the resident joins with the join code.
4. Institution admin adds the member as a responder.
5. Citizen submits an emergency online.
6. Security desk sees the incident through Realtime.
7. Security desk verifies it.
8. Security desk assigns a responder.
9. Responder accepts and starts response.
10. Responder marks on scene.
11. Responder completes the task and incident becomes resolved.
12. Security desk closes the incident.
13. Citizen tracking reflects the server state.
14. Offline submission is queued and later synchronised without duplication.
15. Operator runs an AI assessment; the verdict and the model's second opinion are read back on the
    AI Performance page.
