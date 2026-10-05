# AGENTS.md — REACH repository notes

## Layout

- `reach-platform/` — React + Vite + TypeScript operations platform (4 roles: security-desk, staff, institution, operator).
- `reach-citizen-pwa/` — vanilla-JS citizen emergency PWA (no build step).
- `reach-platform/supabase/` — Postgres schema/RLS/workflows (`migrations/0001`–`0012`) and the `api` Edge Function (`functions/api/`).
- `relay-node-android/` — native Android relay (Kotlin). `bmoni-institution-mobile/` — Flutter BMONI signing service.
- `docs/` — **all** product documentation; start at `docs/README.md`. Keep the root free of loose notes: only `README.md` and `AGENTS.md` live there. Merge new fix logs into `docs/HARDENING_LOG.md` and release notes into `docs/RELEASE_NOTES.md` rather than adding another root `*_FIXES.md`.
- `tests/` — RLS, BMONI webhook, load (k6) and AI-calibration harnesses.
- `.github/workflows/ci.yml` — CI gates (platform, PWA syntax, migration order, android, security scripts).
- `docs/HELIX_API_TEST_NOTES.md` — read-only test of the Helix (Launchverse) credentials: endpoint
  matrix, errors and weaknesses. Two credential types exist on two hosts: `lvse_…` is the
  account/deploy token for `launchverse.app`; `helix_…` is the inference key for
  `api.launchverse.app/api/v1/chat/completions`. Inference works, but Helix's agent identity makes it
  **refuse** REACH's current `modelAssist` system prompt and answer in prose, which fails silently
  (`JSON.parse` throws → `modelAssist` returns null → circuit breaker opens → `/status` reports the AI
  provider unhealthy). Do not set `REACH_AI_ENDPOINT` to Launchverse unless the system prompt is
  neutral and demands JSON only (see §4 of the notes). Keep both credentials out of the Edge Function
  and out of every `VITE_` variable.

## Commands (run inside `reach-platform/`)

- `npm run build` — `tsc && vite build`.
- `npm run validate` — PWA syntax + hardening controls + **executes all migrations** when a DB is reachable.
- `npm run validate:migrations` — migration execution only (needs `psql` + PostGIS).
- `npm run validate:hardening` — static hardening assertions.
- `npm run test:security` — static security assertions (CORS, body limit, CSP, session storage…).
- `npm run test:relay-sim` — relay ingest + gateway dedup concurrency against a real DB (see below).
- `npm run validate:all` — validate + hardening + security + all test suites.

Local full run (needs a PostGIS DB; the AI/relay/PWA suites are DB-free):
`docker run -d --name reachpgtest -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgis/postgis:16-3.4`
then `PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=postgres npm run validate:all`.

## Migration testing

Migrations are executed, not just grepped: `scripts/tests/migrations.mjs` creates a throwaway
database, applies `scripts/tests/supabase-bootstrap.sql` (auth schema, `auth.uid()`, anon/authenticated/
service_role roles, `supabase_realtime` publication), then runs each migration with
`--single-transaction` — mirroring Supabase. It also asserts RLS is on for every non-extension table and
that privileged `SECURITY DEFINER` RPCs are not anon/PUBLIC-callable.

Connection via `REACH_TEST_DATABASE_URL`, or `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`. Skips with a notice
(exit 0) when no DB/psql/PostGIS is available. Local example:
`docker run -d --name reachpgtest -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgis/postgis:15-3.4`.

## Gotchas

- Static text checks in `final-hardening.mjs` pass even when the SQL cannot run — always use `validate:migrations` for schema changes.
- A migration that aborts mid-file rolls back the whole file; later files then fail on missing functions.
- `revoke all on public.func(...)` is invalid — it must be `revoke all on function public.func(...)`.
- PostgREST resolves `rpc('name', { p_x: ... })` named arguments against the SQL function signature. A
  single stale argument name makes the call fail at runtime with `function ... does not exist` (a 500),
  not at build time. The BMONI webhook passed a `p_event_type` the RPC never declared, so every payment
  webhook failed and no sandbox settlement reached the payment records. `scripts/tests/rpc-contract.mjs`
  now checks every `rpc()` argument name against the SQL signatures statically; `tests/bmoni_webhook_flow.sql`
  exercises the flow end-to-end on the migrated schema.
- `text[]` literals need braces: `'{a,b}'`, not `'a,b'`.
- Supabase Edge Functions default to `verify_jwt = true` at the platform edge, *before* the function
  code runs. `supabase/functions/api/` serves a self-authenticating webhook (`/webhooks/bmoni` HMAC) and
  an unauthenticated `/health` probe, so `supabase/config.toml` must keep `[functions.api] verify_jwt = false`
  or every webhook gets `401 Invalid JWT` and no payment ever settles. `final-hardening.mjs` pins this.
  The function still calls `supabase.auth.getUser()` on every non-webhook route and returns 401 without a user.
- Granting execute to `authenticated` is intended; only `anon`/PUBLIC access is a defect.
- `spatial_ref_sys` (PostGIS) is extension-owned and has RLS off by design.
- Local bootstrap defines `auth.jwt()` (used by migrations `0009`+) alongside `auth.uid()`/`auth.role()`.
- The zip packages (`REACH-*-main.zip`, `REACH-PHASE4-CERT-READY.zip`) were built from an older baseline and
  regress migrations `0002` (`revoke all on public.func` → must be `on function`) and `0004` (unbraced `text[]`).
  When merging a package, always keep the repo's `supabase/migrations/0002`,`0004`, `scripts/tests/migrations.mjs`,
  `scripts/tests/supabase-bootstrap.sql` and the `validate:migrations` script, then re-run `validate:migrations`.
- `relay-node-android/` build works from a clean checkout: the Gradle wrapper jar is committed, and
  `./gradlew assembleDebug lint` passes on JDK 17 with `ANDROID_HOME` set (`local.properties` is git-ignored).
  CI's android job gates on `gradle/wrapper/gradle-wrapper.jar` being present.
- The Kotlin DSL files use double-quoted Kotlin string literals — `settings.gradle.kts`/`build.gradle.kts`
  originally shipped Groovy single quotes (`rootProject.name='x'`), which never compiled.
- `gradle.properties` must set `android.useAndroidX=true` (AndroidX deps) and the Java/Kotlin JVM target
  must match (`compileOptions` + `kotlinOptions.jvmTarget = "17"`), or AGP fails configuration.
- Privileged Bluetooth/Wi-Fi Direct calls are gated by `Permissions.kt`; the transports carry
  `@SuppressLint("MissingPermission")` because lint cannot follow the `permissions()` helper. Do not
  remove those gates — `RelayService.startRelay()` and `WifiDirectRelay.sendWithAck()` fail closed.
- Relay packet signing has one invariant that is easy to break: the signed payload must NOT contain `x`.
  `x` is defined as `sha256(signed payload)`, so embedding `x` in it is self-referential and no packet can
  satisfy verification. `x` still binds every other field, and the ECDSA signature over the signed payload
  binds `x`. The canonical form is duplicated in three places that must agree exactly —
  `supabase/functions/api/relay_protocol.ts`, `reach-citizen-pwa/js/relay/protocol.js`, and
  `relay-node-android/.../DeviceIdentity.kt` — so change all three together.
- `crypto.subtle.sign()` returns an `ArrayBuffer`, not a `Uint8Array`. Anything that indexes the signature
  bytes (e.g. `p1363ToDer`) must normalise with `new Uint8Array(raw)` first.
- `minimal_payload` keys must stay snake_case (`location_label`, `location_source`, `location_accuracy_m`):
  `ingest_relay_packet_service` reads those exact names, and camelCase silently drops location data.
- `reach-citizen-pwa/js/relay/test-protocol.mjs` needs an `indexedDB` shim to run under Node; it is wired
  into the `pwa` CI job, so it now actually executes (it previously only ever crashed).
- In `ai_engine.ts`, evidence flagged `contradiction:true` must feed ONLY the contradiction penalty -
  never `support`, the category scores, or source diversity. It previously did, so confidence *rose* with
  the number of contradicting sensors (48 -> 53 -> 57 -> 60 at three sensors) and returned
  `decision:'recommend'`, violating the module's own "abstains when contradictory" contract.
- `scripts/tests/ai-engine.mjs` verifies the engine and is in CI via `npm run test:ai`. CI's platform job
  runs Node 20, which cannot `import` a `.ts` file (type stripping landed in 22.6), so the test transpiles
  with the repo's `typescript` dependency instead of relying on the runtime version.
- Server-side relay verification lives in `supabase/functions/api/relay_verify.ts`, not inline in
  `index.ts`. `scripts/tests/relay-verify.mjs` imports that exact module (transpiled in memory) so the test
  cannot drift from production. If you edit the request handler, keep calling `verifyRelayBody`.
- `public.ingest_relay_packet(jsonb)` (created in 0002/0003) writes `relay_packets` without verifying the
  device registration, fingerprint or signatures. It is granted to `authenticated` by 0002 and never revoked,
  so it is a PostgREST bypass of the Edge Function. `0011_relay_ingest_lockdown.sql` restricts it to
  `service_role`; keep it that way and keep the ACL assertion in `scripts/tests/migrations.mjs`.
- The source-signed payload does not cover `h` (hop count), so `relay_verify.ts` rejects any packet with
  `hop_count > 0` that lacks a relay envelope. A forwarding node always adds a relay signature, and that
  signature does cover `h`. Without this rule a client could upload a packet claiming any hop count.
- Android BLE fragments must be sized from the negotiated ATT MTU, not a fixed 160 bytes. The default MTU
  is 23, so a write carries at most 20 bytes; `BleCentralRelay` now requests a larger MTU and captures the
  chunk size once per transfer (the MTU callback is async — resizing mid-transfer would desync `total`).
- The PWA and Kotlin BLE fragment headers are still different: `protocol.js` prefixes a 16-byte transfer id
  (`[id:16][seq:2][total:2]`), while `BleTransfer`/`BleCentralRelay` use `[seq:1][total:1]`. They are only
  interoperable within a peer group (PWA↔PWA, Android↔Android). Unifying them is a wire-format change; pick
  one header and update both senders, `BleTransfer`, and the framing tests together.
- `validate:migrations` executes every migration against Postgres+PostGIS and is now run in CI's
  `sql-migrations` job via a `postgis/postgis:16-3.4` service container. It skips (exit 0) when no server is
  reachable, so a local run without Postgres is not a failure.
- Demo data: `scripts/seed-demo-data.sql` clears every REACH record and inserts one row per table for
  the demo (password `ReachDemo!2026`, e.g. `admin@greenfield.reach.dev`, `ops@reach.dev`). It is
  destructive, wrapped in one transaction, and idempotent. Run it manually — either paste it into the
  Supabase SQL editor or dispatch `.github/workflows/seed-demo-data.yml`, which posts it through the
  Supabase Management API using the repo's `SUPABASE_ACCESS_TOKEN`/`SUPABASE_PROJECT_ID` secrets. It
  keeps the two canonical `ai_model_registry` rows from 0004 and only clears the demo row.
- `auth.users` on real Supabase has columns the local bootstrap omits (`instance_id`, `aud`, `role`,
  `email_confirmed_at`, `raw_app_meta_data`, `updated_at`) plus `auth.identities`. The seed writes them,
  so testing it locally means adding those columns to the bootstrap DB first.
- The AI fusion logic lives only in `ai_engine.ts`; the SQL migrations just store assessments
  (`store_ai_assessment_for_incident`) and do not reimplement scoring.
- `assessEvidence` returns `decision_basis: {signals, blockers}`. `blockers` is the exact list of
  abstention triggers (`no_usable_evidence`, `confidence_below_threshold`,
  `category_margin_below_threshold`, `evidence_strength_below_threshold`,
  `contradiction_penalty_above_threshold`, `model_disagreement`) and `abstain` is exactly
  `blockers.length > 0`. Prefer it over substring-matching the prose in `reasons`; the handler also
  stores it in the assessment metadata. `ai-engine.mjs` asserts the two never drift.
- Evidence with `corroborates:false` is counter-evidence: it adds to the contradiction penalty and
  contributes no support and no category score. It used to be discounted support (x0.45) that still
  raised confidence.
- The PWA relay queue (`flushRelayQueue` in `js/backend.js`) drops packets past their own TTL
  (`packet.e`), backs off exponentially and dead-letters after 8 attempts, and refuses to queue past
  50 live rows. It previously retried every 30s forever with no expiry. `scripts/tests/pwa-relay-queue.mjs`
  drives the real queue under a minimal in-memory IndexedDB and is in CI via `npm run test:pwa-relay`.
- `reach-citizen-pwa/sw.js` must precache every module the app imports. `validate.mjs` walks the import
  graph and fails if an imported module is missing from the `ASSETS` list, so adding a new relay/JS
  module means adding it there too. A network-only module breaks the cold offline start.
- `tests/rls_tenant_isolation.sql` runs inside `npm run validate:migrations` (and therefore CI), so a
  policy regression fails alongside the migration that caused it. The suite grants full DML to
  `authenticated` before asserting, so a failure reflects RLS/policy, not a missing table grant.
- The Android relay queue (`RelayForwarder`/`RelayQueueDb`) dead-letters after 8 attempts like the PWA.
  The attempt count must be read from the `relay_queue` row: the packet JSON is re-parsed on every
  drain, so a counter carried in the packet object resets to 0 each cycle and the packet would retry
  until TTL. There are no Android unit tests — this is only exercised by physical-device matrices.
- Tenant scoping must use `is distinct from`, not `<>`, when comparing a row's institution to
  `public.current_institution_id()`. `<>` is NULL when the caller has no institution, so
  `if x.institution_id <> current_institution_id() then raise ...` silently skips the guard and the
  cross-tenant branch runs. `0012_null_safe_authorization.sql` fixes `transition_incident`,
  `assign_incident`, `transition_assignment`, `create_institution_for_current_user` and
  `register_my_relay_device`; the suite's assertions 8–9 pin it. (`promote_current_user_to_operator`
  is redefined there too, but its ACL — revoked from `authenticated` by 0006 — must not be re-granted.)
- `is distinct from` fails OPEN when it is the *negative* of the comparison. The same operator
  that fixes a `<>` guard (where NULL must fail closed) is unsafe in a `NOT permitted` guard of
  the shape `if reporter_id <> uid and institution_id is distinct from current_institution_id() ...`.
  Two NULL institutions are "not distinct", so the middle term is FALSE and any authenticated user
  passes. `0021_fix_evidence_authz_null_institution.sql` rewrites `attach_incident_evidence` to
  compare institution ids explicitly (`inst is null or inst <> current`); assertion 19 in the RLS
  suite seeds two institution-less citizens and pins it. When adding a NOT-guard, write the
  comparison so that "no institution" fails — do not reach for `is distinct from` reflexively.
- A Supabase `PostgrestError` is a **plain object**, not an `Error`. Any `error instanceof Error ?
  error.message : error` yields `[object Object]`, and the Edge Function's catch block used to read a
  message only from `Error` instances, turning every deliberate `raise exception` guard into an opaque
  500. `index.ts` now reads `message`/`code`/`details` off any shape and maps PostgREST + SQLSTATE
  codes to HTTP statuses. Keep error handling shape-agnostic.
- Supabase installs extensions (pgcrypto, PostGIS) into the **`extensions` schema**, not `public`,
  and its default `search_path` is `"$user", public, extensions`. A `security definer ... set
  search_path=public` function cannot resolve `digest()`/`crypt()` unless `extensions` is also on its
  path; 0001's `create extension if not exists pgcrypto` is a no-op there. `0020_fix_pgcrypto_search_path.sql`
  adds `extensions` to the two invite RPCs. `scripts/tests/supabase-bootstrap.sql` now installs pgcrypto
  into `extensions` so the local run reproduces this class of failure instead of hiding it. A broader
  sweep for extension functions called from a pinned path is still open.
- `tests/rls_tenant_isolation.sql` seeds profiles with an upsert, not `on conflict do nothing`:
  inserting `auth.users` fires `handle_new_user`, which already creates a `citizen`/NULL-institution
  profile, so a do-nothing insert is a silent no-op and the suite would run entirely as citizens.
- Gateway relay dedup must go through `record_relay_ingest_dedup()` (an atomic upsert). The previous
  read-then-write in `index.ts` lost `receive_count` updates and raised duplicate-key errors when the
  same packet arrived over BLE/Wi-Fi/PWA at once. `scripts/tests/relay-ingest-sim.mjs` (CI: `test:relay-sim`)
  drives 16 concurrent arrivals through both `record_relay_ingest_dedup` and `ingest_relay_packet_service`.
- `ingest_relay_packet_service()` short-circuits on an existing packet only when the packet_key belongs
  to the *same source device*. A client-supplied `packet_key` colliding across tenants is rejected
  explicitly; before this, institution B replaying A's key got A's `relay_packets` row back (cross-tenant
  disclosure) and B's incident was silently dropped. See `0013_relay_ingest_hardening.sql`.
- Every JSON request body must be read via `readJsonLimited(req)`; a raw `req.json()` has no size cap.
  `security-static.mjs` fails on any remaining `req.json()`.
- The canonical relay/source signed string is built as `k=String(v)&…`; the Kotlin relay node must emit
  JS-compatible JSON (not `org.json`, which escapes `/` as `\/` and does not lowercase keys). The
  committed fixture `relay-node-android/.../resources/cross_cases.json` is regenerated by
  `scripts/tests/cross-fixtures.mjs` and pinned by `relay-verify.mjs` and `CrossLanguageCanonicalTest`.
- `ai_engine.ts` reads untyped JSON: an evidence `quality` that is a non-numeric string must be coerced
  (or the item dropped), never allowed to become `NaN`. NaN in the fusion math nulls `confidence`,
  `margin` and `evidence_strength`, which silences every abstention blocker and yields a bogus
  `decision:'recommend'` with a NaN fingerprint. `ai-engine.mjs` section E pins this.
- `ai_provider.ts`'s system prompt is deliberately identity-neutral (`MODEL_SYSTEM_PROMPT`): it states
  the JSON contract and safety limits but never claims a role. A provider that does not recognise a
  claimed identity can *refuse* it and answer in prose with **HTTP 200** (observed with Helix, which
  replied "I'm Helix, a software-engineering agent, so I can't take on the REACH Safety Assist role").
  That is a silent failure — `JSON.parse` throws, the breaker opens, and the model column quietly loses
  its second opinion. Non-JSON prose is recorded via `aiLastFailure()` for diagnosis. Do not re-add
  "You are REACH …" framing, and do not point `REACH_AI_ENDPOINT` at a provider whose prompt contract
  has not been verified against the live endpoint (`ai-engine.mjs` section G pins both).
- Launchverse model choice matters: the agentic Helix models (`helix-autopilot`, `helix/swe-v1`,
  `helix/devops-v1`) return the correct JSON object **followed by an agent work report** ("## Delivery
  …"). `helix-operator` is scope-blocked. Use `helix-advisor`, which returns bare JSON. Even so the
  second opinion is intermittent — `helix-advisor` sometimes answers in prose at `temperature: 0` —
  so `model_agreement: 'none'` is normal, not a bug. The adapter now recovers the *leading* balanced
  JSON object (`extractLeadingJson`), so a completion that prefixes a sentence or trails a work report
  still yields a usable second opinion; only a completion with no JSON object at all is rejected.
  See `docs/HELIX_API_TEST_NOTES.md` §2.1, §3.6, §3.7.
- The adapter's live behaviour is pinned by `scripts/tests/ai-provider-live.mjs` (run through
  `npm run test:providers`), which drives the real `ai_provider.ts` against a stub that reproduces the
  recorded Helix wire behaviours: bare JSON, agentic JSON + work report, prose served as HTTP 200,
  credit exhaustion, 4xx/429, unreachable host, and out-of-vocabulary category. Each must map to the
  right `aiLastFailureKind`. The provider config is env-driven (`REACH_AI_ENDPOINT`/`_API_KEY`/`_MODEL`),
  the key is read only server-side (never a `VITE_` var), and `/system/health` reports the AI status.
- The model's contribution is persisted in `ai_assessments.metadata` (migration `0014`), not just the
  audit log. Without it `model_agreement` cannot be queried back and the operator view can only show
  the fused result. The assessment is triggered deliberately by the operator (All Incidents → "Run AI
  assessment") rather than automatically, because each call can spend a daily Helix query; the verdict
  and the second opinion are read back on the AI Performance page. Keep those two pages in step.
- Evidence: nothing wrote to `incident_evidence` before migration `0015`, so the engine always fused an
  empty set and every assessment abstained with `no_usable_evidence`. The API now derives a deliberately
  weak evidence set from the incident (`deriveEvidenceFromIncident`) and persists it via
  `ingest_incident_evidence_service`, which is **service_role only**: a client-callable version would
  let any signed-in user manufacture `corroboration` (weighted 0.8, second only to `user_report`) and
  push an assessment past the confidence threshold. Keep the derived items weak enough that a single
  incident still abstains. `0015` also widens the `incident_evidence.evidence_type` check to the union
  of the old vocabulary and the engine's `EvidenceKind` values — the two had drifted, and
  `user_report`, `motion` and `corroboration` were being rejected on write.
- Provider telemetry (`ai_provider_events`, migration `0016`): "no second opinion" was previously
  indistinguishable from "the model was never called", because the adapter's failure state is in-memory
  and `/system/health` reported only env configuration. Every `/ai/assess` call now records an outcome
  and a classified `failure_kind` (`unconfigured`, `breaker_open`, `http_error`, `network_error`,
  `unparsable_response`, `invalid_payload`), readable at `GET /ai/provider-events` and surfaced on the
  AI Performance page. `/system/health` reports the real breaker state (`Healthy` / `Degraded` /
  `Circuit open`) instead of the string `Configured`. Telemetry writes are best-effort and must never
  fail the assessment.
- Evidence capture (`0017`, hardened by `0018`): 0015 derived evidence only from what the incident
  already recorded, so the strong fusion kinds — `image` (0.9), `audio`, `sensor`, `motion` — were
  unreachable and the engine could never leave `assist`. `attach_incident_evidence` is the
  client-callable capture path: the citizen uploads to the private `incident-evidence` bucket under
  `${uid}/…`, then registers the path. The invariants that hold it together:
  - **The storage path must begin with the caller's own uid**, and must not contain `..`. The
    `storage.objects` policy and the RPC both enforce it. Without that check a caller could reference
    someone else's object and have it counted as their evidence.
  - **A media kind requires a real uploaded object with a matching content type.** 0017 left
    `storage_path` optional, so a client could claim `image` with no upload at all and collect the
    strongest weight; 0018 requires the path, the content hash, and a `metadata->>'mimetype'` that
    matches the claimed kind. The hash makes the object content-addressed, but note the schema has
    *no* unique constraint on `content_hash`; double-counting is actually prevented downstream by
    `cleanEvidence`, which collapses rows sharing `kind|source|timestamp|category`, plus the API
    stamping every row of one incident with the same `reported_at`. `scripts/tests/ai-engine.mjs`
    section F pins that collapse. A unique `(incident_id, content_hash)` would be the stronger guard
    if the capture path ever carries per-row extraction or timestamps.
  - **The fusion confidence is derived server-side from `kind`**, never sent by the client, and
    `corroboration` is deliberately not an accepted capture kind — it must mean independent
    corroboration, not a self-asserted flag. `sensor` and `motion` are likewise not client-capturable:
    they describe device integrations a client cannot perform, so they stay reachable only through the
    service-role derived path, where the server decides the weight.
  - **One incident accepts at most 20 evidence rows**, so a single caller cannot flood the fusion.
- The citizen PWA captures evidence on the review screen (`reach-citizen-pwa/js/evidence.js`) and
  uploads it with the same content-addressed `${uid}/${sha256}.${ext}` path. A capture taken before the
  citizen sends has no incident yet, so it is held in IndexedDB and bound at send time — to the real
  incident id, or to the queued report's idempotency key and rebound when the queue flushes.
  `js/evidence.js` owns the `reach-offline/evidence-queue` store; `backend.js` only rebinds and flushes it.
- `ingest_incident_evidence_service` (0015) replaced *all* evidence for an incident; 0017 narrows that
  to rows tagged `derived: true`, so a captured photo survives an assessment. The tag is merged after
  the client metadata, so a caller cannot forge it. When adding anything to the derived path, keep that
  marker and keep `/ai/assess` reading back the full stored set — captured and derived — so the engine
  fuses what is actually attached. In practice one incident's derived set alone abstains (~45% for a
  sparse report, ~54% with a description) while one captured image takes it to ~64-72% and a
  `recommend` decision; that separation is the point. The exact figures drift with the report's age
  (evidence ages out), so `scripts/tests/ai-engine.mjs` section F pins the qualitative claim --
  derived-only abstains, one captured image reaches `recommend` -- rather than the decimals.
- **Known limitation — relay-path evidence never rebinds.** When a report is delivered by relay
  (native bridge or queued signed packet), `sendOrQueueEmergency` binds the capture to the report's
  idempotency key (`bindEvidence({ reportKey: key })`). Only the *queued-incident* path ever rebinds:
  `rebindQueuedEvidence` is called from the queue flush (`backend.js:156`) with the real incident id,
  but the relay path stores nothing for a later rebind — the native path only writes
  `localStorage['reach_relay_packet_key']`, which has no reader, and `flushEvidenceQueue` passes
  `row => row.incidentId || null`, so a row bound to a key is skipped forever. The capture therefore
  uploads to Storage but is never registered against the incident, and the operator cannot see it.
  Fixing it needs the relay ingest response to carry the created incident id (or a
  packet-key → incident endpoint) so the client can repoint the row; that is a server + client change
  and is deliberately left out of scope for the hackathon MVP. Until then, treat relay-path evidence
  as upload-only.

- **Reserved SQL keywords are a silent variable-shadowing trap in PL/pgSQL.** Migrations 0002/0012
  declared `current_role public.reach_role` inside `create_institution_for_current_user` and
  `redeem_staff_invite`. `current_role` is a reserved SQL keyword, so PL/pgSQL never bound the
  variable: `select role into current_role` left it NULL and `current_role <> 'citizen'` resolved to
  the SQL keyword — the database role of the SECURITY DEFINER owner (`postgres` locally,
  `authenticated`/`supabase_admin` on Supabase), never `'citizen'`. The guard therefore raised on
  every call, so `POST /institutions` returned 500 for every institution signup and staff-invite
  redemption always reported "Account is already assigned a role". Migration `0019` renames the
  variable to `caller_role` and restores the NULL-safe `is distinct from` check. Reproduced on a fresh
  Postgres+PostGIS database and against the deployed project; `tests/rpc_variable_shadowing.sql`
  (wired into `validate:migrations`) fails with `ERROR: Institution account cannot be created from
  this account` if the collision ever returns. When declaring a PL/pgSQL variable, avoid every
  reserved keyword — notably `current_role`, `current_user`, `session_user`, `user`, `current_schema`,
  `current_date`, `localtime` — or the variable will silently read the built-in value instead.


- **BMONI answers a non-E.164 phone with a bare `400 Validation failed`.** In the institution billing
  flow, `POST /institution/billing/bmoni/user` forwards the payer phone to BMONI `POST /v1/users`.
  `+2348012345678` is accepted; `08012345678` is rejected with only `{ "message": "Validation failed" }`
  — no field named, so it looks like a server fault rather than bad input. `normalizePhone`
  (`supabase/functions/api/bmoni.ts`) converts the `+`/`234…`/local-`0…` shapes to E.164 and returns
  `null` for anything else, which the endpoint turns into a `422` instead of a provider round-trip.
  The BMONI client also joins the array-shaped `message` detail into the thrown error, because a
  validation failure lists the offending properties there. `scripts/tests/bmoni-phone-normalize.mjs`
  pins both behaviours (wired into `validate:all`).


- **`POST /v1/users` returns two ids; only `bmoniUserId` works in user-scoped paths.** The response is
  `{ user: { id, bmoniUserId, ... } }`. `user.id` is an internal row id and `user.bmoniUserId` is the
  value every `/v1/users/{id}/...` route accepts — they differ. Extracting `result.user.id` (the old
  `result.bmoniUserId || result.id || result.user.id || ...` chain did) stores an id that 404s
  ("User not found") on status, kyc, deposit-account, start-nigeria and the payment paths. Read the id
  only through `bmoniUserIdFrom` (`supabase/functions/api/bmoni.ts`), which never falls back to the
  internal id; `findBmoniUserIdByEmail` recovers it (paged `GET /v1/users`, no email filter exists) and
  `withBmoniUserId` heals already-broken rows on first use. `scripts/tests/bmoni-user-id.mjs` pins this
  (wired into `validate:all`).

- **Demo seed is two institutions × one of every stakeholder.** `scripts/seed-demo-data.sql` inserts
  Greenfield Estate (`1111…`, active subscription) and Northgate University (`2222…`, trial, no BMONI
  account) with one account per role (institution, staff, security-desk, citizen; platform operator
  and super-admin), ten incidents spread across the status lifecycle plus matching events,
  assignments, evidence, AI rows, relay packets and notifications. Every sign-in uses
  `ReachDemo!2026`. Re-seeding is idempotent. `scripts/clear-demo-data.sql` empties every data table
  while keeping schema, RLS and the two canonical `ai_model_registry` rows; both run hosted through
  the `seed-demo-data` / `clear-demo-data` `workflow_dispatch` workflows (Supabase Management API).
  `scripts/tests/supabase-bootstrap.sql` mirrors the real `auth.users` columns so both scripts can be
  exercised locally against the full migration set.

- **Registration paths, by role.** A citizen self-signs-up at `POST /auth/v1/signup` (the GoTrue
  trigger creates a `citizen` profile) and can immediately file incidents and add contacts. An
  unassigned citizen becomes an institution via `POST /institutions`
  (`create_institution_for_current_user`). Staff and security-desk join only through an
  institution-issued invite: admin `POST /invites` → new signup → `POST /invites/redeem` (single-use
  code). Operators join through a single-use `POST /operator/invitations` (super-admin only) → signup
  → `POST /operator/invitations/accept` (email-bound). The bootstrap `POST /operator/provision` key is
  disabled the moment any operator/super-admin exists, by design.

- **Relay (Bluetooth/Wi-Fi) needs a registered device public key.** A `/relay/packets` source must be
  an `active` `device_registrations` row whose `public_key` matches the packet's `source_public_key`
  (`ingest_relay_packet_service`); the PWA registers it on sign-in (`register_my_relay_device`,
  ECDSA-P256). The signed payload is compact JSON with **no** spaces (`JSON.stringify` style) and
  `null` for absent values; the expiry must land on a whole second because `ttl_expires_at` is
  re-serialised through `Date.parse` server-side. `sendOrQueueEmergency` queues a signed packet when
  offline with no native bridge and uploads it on reconnect, so relay works without the native Android
  relay node. On a relayed incident the `delivery_method` is `relay` and `via_relay` is true.

- **BMONI Pay: destination must differ from the payer wallet.** Verified live: BMONI rejects a
  transfer whose recipient is the payer's own smart wallet (`400 Recipient wallet must be
  different from the group wallet`), so a self-transfer is not a usable shortcut. The proposal
  route uses `REACH_BMONI_TREASURY_ADDRESS` when set, otherwise the built-in
  `DEFAULT_BMONI_TREASURY_ADDRESS` (REACH's receive-only demo treasury), and guards against a
  destination equal to the institution wallet. The amount is
  `REACH_INSTITUTION_SUBSCRIPTION_AMOUNT_CNGN` (decimal CNGN, e.g. `14500`) when set, otherwise
  `DEFAULT_SUBSCRIPTION_AMOUNT_CNGN`. Neither amount nor destination can be client-supplied.
- **Sign-payload is prepared asynchronously.** After `approve`, `GET .../proposals/{id}/sign-payload`
  can return `409 Signing payload is not ready yet` for a few seconds; the route persists the
  proposal id first and retries on 409 (~24s). The sign step signs the **raw** `signingPayloadHash`
  (`eth_account.unsafe_sign_hash`), not EIP-191. Re-verified live: only the raw-hash signature is
  accepted (`payment/sign` → 200, proposal `PENDING_SIGNATURES`); signing the returned EIP-712
  `typedData` (both v=27 and v=0/1) or the hash via `personal_sign` each return
  `400 Signature does not match your registered owner address`.
- **One active subscription payment per institution.** The partial unique index
  `bmoni_one_active_subscription_payment` covers `(institution_id, subscription_id)` while a
  transaction is `initiated`/`pending`, so a second proposal returns a duplicate-key 409 until the
  first reaches a terminal state. Failed/cancelled/reversed attempts do not block a retry.
- **A signed proposal does not settle on an unfunded sandbox wallet.** The proposal reaches
  `PENDING_SIGNATURES` and the local payment stays `pending`; the subscription only flips to
  `active` on the BMONI settlement webhook (`process_bmoni_webhook_event`, statuses
  successful/completed/failed/reversed). Nothing in the browser or a signed proposal activates it.
- **Sandbox funding is not self-service, and it cannot cover the default price.** Verified against
  BMONI's docs and the live sandbox: there is no faucet/mint endpoint. Sandbox balances start at
  `0` (`GET .../smart-wallets/{id}/balance`) and BMONI credits them **manually** on request —
  email `developers@bkey.me` the payer's signup phone, and they credit NGN 1,000 / USD 10
  (embedded-docs.bmoni.com/request-test-tokens). The built-in subscription amount is
  `DEFAULT_SUBSCRIPTION_AMOUNT_CNGN` = 14500 CNGN, so the default Pay flow can never settle in
  sandbox even after the credit. A demoable sandbox settlement needs
  `REACH_INSTITUTION_SUBSCRIPTION_AMOUNT_CNGN` set to ≤ 1000 (and a fresh deploy). The shared
  sandbox key is published in BMONI's own docs, so the sandbox is directly inspectable.
- **The shared sandbox webhook does not point at REACH.** `GET /v1/webhooks/config` returns
  `callbackUrl: https://bmoni-hackathon-demo.workers.dev/webhooks/bmoni` with events
  `employee.deposit.completed`, `employee.withdrawal.completed`, `onboarding.completed`,
  `kyc.action_required`. Until that callback is re-registered to REACH's
  `/functions/v1/api/webhooks/bmoni` (via `POST /v1/webhooks/config`), no settlement event reaches
  REACH regardless of balance. That re-registration is partner-key work, not a client change.
- **Reusing one BVN across institutions works.** Verified: two payers sharing Bunch Dillon's BVN
  `95888168924` both went `anchorStatus: active` and got their own NGN deposit account. What must
  be **fresh per payer** is the phone number — the documented sandbox number is taken and a
  duplicate returns `409`; `normalizePhone` + a unique `+2348…` works. The sandbox API key is
  shared/not tenant-scoped.
- Subscription walkthrough uses the Northgate trial tenant; Greenfield is already configured.
  `GET /audit` is operator/super-admin only; `/audit-logs` is not a route.
- **"Failed to fetch" on signup/login is a CORS symptom, not an auth failure.** Supabase GoTrue
  (`/auth/v1/*`) reflects the request `Origin`, so signup/login usually succeed; the failure is the
  follow-up call to the Edge API (`/functions/v1/api/*`). That API only emits
  `Access-Control-Allow-Origin` when the request `Origin` matches `REACH_ALLOWED_ORIGINS`, and the
  browser drops a header-less response as an opaque `TypeError: Failed to fetch`. The deployed
  project had no matching origin, so every browser call to the API was blocked. `corsFor` now
  matches exact origins **and** single-label wildcards (`https://*.prod-runtime.all-hands.dev`), and
  the deploy workflow sets `REACH_ALLOWED_ORIGINS` from the repo secret or a dev/preview fallback so
  a missing secret cannot leave the API refusing everything. Diagnose with:
  `curl -s -D - -o /dev/null -H "Origin: <app-origin>" -H "apikey: $ANON" .../functions/v1/api/health | grep -i access-control-allow-origin`.
- **A failed post-signup profile sync must not fail the registration.** `signup` creates the auth
  user and session; the extra `PATCH /me` (name/phone/relay flag) is best-effort. The PWA used to
  await it unguarded, so a CORS/network error on the patch surfaced as "account creation failed"
  while the account already existed — the second attempt then said "user already exists". The
  handler now swallows that sync failure (retried by `initBackendSync`) and guards against a
  double-tap with an in-flight flag.
- **Every PWA/platform request is bounded and its network error is translated.** Both
  `reach-citizen-pwa/js/backend.js` and `reach-platform/src/lib/reachApi.ts` route through a
  `fetchWithTimeout` helper so a hung socket or a CORS rejection reads as "Could not reach REACH"
  or "REACH took too long" instead of a raw `Failed to fetch`.
- **A page cannot switch Bluetooth/Wi-Fi on; the native node can only prompt.** The relay
  permission screen previously did nothing. `js/relay/permissions.js` now asks the native node
  (`window.REACH_NATIVE_RELAY.requestPermissions`) when present — which requests the runtime
  permissions and fires `ACTION_REQUEST_ENABLE` / the Wi-Fi panel at launch — and otherwise opens
  the Web Bluetooth chooser from the user gesture. Wi-Fi Direct has no browser API and modern
  Android forbids programmatic Wi-Fi enable, so the code reports the real outcome and never claims
  a radio is on. `NEARBY_WIFI_DEVICES` only exists from API 33; requesting it on 31–32 would always
  read as denied.
- **The relay ingest path is verified live end-to-end.** Registering a device via
  `POST /devices/register`, then uploading a signed packet to `POST /relay/packets`, creates a
  provisional incident (`source_channel=relay`, `via_relay=true`) readable by the reporter; the
  direct `POST /incidents` path also returns 201. Both reach REACH.
- **The Wi-Fi Direct relay path was silently disabled on API 31–32.** `Permissions.wifiDirect`
  required `NEARBY_WIFI_DEVICES`, which does not exist before API 33, so on 31–32 the gate always
  read denied and the Wi-Fi transport never ran — Bluetooth alone carried the relay. The gate now
  uses `ACCESS_FINE_LOCATION` below 33. `WifiDirectRelay.startAckServer` also binds the group-owner
  listener only when the permission is actually held, instead of advertising a path that can never
  complete.
- **The relay node reports the real radio state, not an optimistic one.** `MainActivity.Bridge`
  `getPermissionStatus`/`requestPermissions` previously echoed the permission grant back as
  `bluetooth: true, wifi: true` even when the radios were off, and the foreground notification
  always claimed "listening". They now read `bluetoothEnabled()` / `wifiEnabled()` /
  `RelayGatewayUploader.hotspotActive()` and word the status honestly (Bluetooth on → turn Wi-Fi or
  hotspot on → ready). A hotspot is a local-only link and is not treated as a gateway path.
- **A relayed packet keeps the envelope of the node that forwarded it.** `RelayGatewayUploader
  .buildBody` re-signed a packet with a non-zero hop count using *this* device's key, stamping the
  wrong node as the relay of a hop it did not make. It now uploads an existing relay envelope
  verbatim and only builds one for a hop this node actually performed.
- **The PWA requests the relay radios on open (native only) and shows real relay status.**
  `requestRadiosOnOpen()` asks the native node for Bluetooth-then-Wi-Fi permission at launch; a
  plain browser is skipped because Web Bluetooth only opens its chooser from a real user gesture.
  `js/relay/status.js` reads the live relay queue (exposed as `window.REACH_RELAY_QUEUE` to avoid a
  backend import cycle) and the home chip / relay-notification text report what is actually
  queued or stuck instead of a scripted "relaying" claim. The incident-history screen lists only
  the signed-in citizen's own reports, falls back to a local cache offline, and never fabricates
  rows.
- **A plain browser can hand a packet to a nearby relay node over Web Bluetooth.** `js/relay/direct.js`
  is the citizen-device half of the relay: it pairs with a nearby Android node's GATT service
  (`RELAY_SERVICE_UUID`/`_DATA_UUID`/`_ACK_UUID`, shared with `RelayProtocol.kt`), writes the signed
  packet with the same `[transferId:4][seq:1][total:1]` framing `sendBluetoothPacket` already used,
  and waits for the node's ACK before claiming delivery. It is foreground-only — Web Bluetooth needs
  the page open and a user gesture to choose a device, and the web platform has no background radio
  API — so this is *not* the background relay; the native node owns that. `probeNativeRelay()` falls
  through to `probeDirectRelay()` when there is no `REACH_NATIVE_RELAY` bridge, and the offline send
  reuses a pairing made on the relay screen (it never opens a chooser from a send). `capabilities.js`
  reports `directRelay` and `bluetoothMode:'browser-direct-relay'`, and `status.js` words the home
  chip honestly. `scripts/tests/pwa-relay-direct.mjs` (CI: `test:pwa-relay-direct`) drives the real
  module against a fake GATT server. A PWABuilder/TWA package is just Chrome, so it gets this path
  and nothing more — it has no native relay service, which is what `relay-node-android` provides.
- **GPS inside the Android app was dead: the WebView denied it.** `MainActivity` set
  `setGeolocationEnabled(false)` and had no `WebChromeClient`, so `navigator.geolocation` in the PWA
  was silently refused; and on API 33+ the split Bluetooth permissions no longer imply location, so
  fine location was never requested. The WebView now enables geolocation, answers
  `onGeolocationPermissionsShowPrompt` only for the configured REACH origin and only when the app
  holds the permission (holding the prompt while the runtime dialog is answered), and the app
  requests location separately from the relay set so denying GPS cannot disable the relay.
- **Coordinates belong to a GPS fix and nothing else.** `setSelectedLocation` left `latitude`/
  `longitude` in state when the citizen switched from GPS back to a registered zone, so the report
  shipped a "Zone B" label alongside the abandoned GPS point — a responder would be sent to the
  wrong place. Leaving GPS now clears the coordinates, and a non-GPS report carries none.
- **A GPS read must not hang or overwrite a good choice.** `requestGpsLocation` used a bare
  `getCurrentPosition` with `alert()` on failure. On iOS Safari a denied grant can leave the call
  unresolved, so it now wraps each attempt in a watchdog and falls back from a high-accuracy fix to
  a coarse one. A *failed* read drops back to the registered zone rather than leaving "GPS" selected
  with no coordinates. The row's status text is updated in place, and the static default no longer
  claims "Unavailable — no signal" before anything was attempted.
- **A citizen joins an estate with a join code, not by creating an institution.** Migration `0022`
  adds `invite_type='join'` to `institution_invites` and `join_institution_with_code(text)`. A join
  code is institution-scoped (no email), keeps the redeemer's `citizen` role, is hashed and
  single-use, and refuses a caller who is already linked to an institution — so it is not a
  role-escalation or tenant-hopping primitive. It binds `profiles.institution_id`, so incidents
  filed *after* the join are stamped with the estate (the desk sees them via `incidents_select`).
  Incidents filed *before* the join keep `institution_id = NULL` and are **not** retroactively
  reassigned; the migration header says so, and the UI offers "Join your estate" on the home screen
  so a citizen links before reporting. RPCs: `create_institution_invite` / `create_staff_invite`
  (wrapper) / `join_institution_with_code` / `list_institution_invites` / `revoke_institution_invite`.
- **When there is no relay node and no internet, the citizen exports the signed packets as a file.**
  `exportRelayPackets()` in `reach-citizen-pwa/js/backend.js` returns the live, unexpired signed
  packets as a `reach-relay-packets` JSON document, offered through the native share sheet (download
  fallback). The citizen hands that file to any REACH relay node over Bluetooth or Wi-Fi file
  transfer; the packets are already source-signed, so the node uploads them unchanged and adds only
  its own relay envelope. Dead-lettered and expired packets are excluded (the gateway rejects them).
  The receiving half is `importRelayPackets()`, wired to "Receive an alert file" on the relay screen:
  it sanity-checks structure and expiry, then queues each packet under its own key for upload, so a
  node with no radio peer can still carry a file-transferred alert. The gateway binds the incident's
  institution from the *source* device registration (`ingest_relay_packet_service`), not the
  uploader, so a file handoff does not leak or mis-tenant the incident. `probeNativeRelay`'s "no
  relay radio" message points at this path. Pinned by `scripts/tests/pwa-relay-export.mjs`
  (CI: `test:pwa-relay-export`).

