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
