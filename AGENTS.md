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
- **The Android relay node crashed on launch because the Keystore key pair was initialised with the
  wrong spec type.** `DeviceIdentity.keyPair()` called `KeyPairGenerator.getInstance("EC",
  "AndroidKeyStore").initialize(ECGenParameterSpec("secp256r1"))`. The `AndroidKeyStore` provider
  accepts *only* `KeyGenParameterSpec`; AOSP `AndroidKeyStoreKeyPairGeneratorSpi.initialize()` throws
  `InvalidAlgorithmParameterException("Unsupported params class: … ECGenParameterSpec …")` for
  anything else. The throw fired from `RelayProtocol.buildPairingBeacon()` inside
  `RelayService.startRelay()` → `Service.onCreate`, so the node died exactly when it tried to
  advertise. Use a `KeyGenParameterSpec.Builder(alias, PURPOSE_SIGN).setAlgorithmParameterSpec(
  ECGenParameterSpec("secp256r1")).setDigests(DIGEST_SHA256)` and cache the key pair per process.
  `DeviceIdentityTest` (in `testDebugUnitTest`) exercises the real path — Robolectric has no
  `AndroidKeyStore` provider, so it also proves the in-memory P-256 fallback works. Never leave
  `keyPair()` able to throw: it is called on every signature, `deviceId()` and beacon build.
- **The relay node must come up on whichever radio is available.** `RelayService.onCreate` ran
  `startForeground`/`startRelay`/`WifiDirectRelay.startAckServer` unguarded, and
  `startRelayServiceIfPermitted()` required *every* permission (including Wi-Fi Direct's
  `NEARBY_WIFI_DEVICES`/location) before starting the service. A citizen who declined Wi-Fi got no
  relay at all, and one transport throwing killed the service. Each transport is now wrapped, and the
  service starts on *either* the Bluetooth grant or the Wi-Fi grant — a citizen who allows only
  nearby Wi-Fi still gets the Wi-Fi relay path. `relayStateJson()` reports `permissions`
  (Bluetooth-or-Wi-Fi), `wifi_permission`, `ble_listening` and `wifi_listening` separately — do not
  collapse them back into one gate or infer "listening" from the permission alone.
- **Wi-Fi Direct is a first-class relay path, not only a fallback.** `relaySummary` used to ask for
  Bluetooth whenever `bluetooth:false`, even when the node was listening on Wi-Fi; it now asks only
  when *neither* radio is on. `WifiDirectRelay.listening` / `RelayService.wifiListening` expose the
  real ACK-listener state so a Wi-Fi-only node can honestly report "ready".
- **A relay packet imported from a transferred JSON file must reach the radios when offline.**
  `flushRelayQueue` now calls `handPacketToNativeRelay` for each live row when there is no
  internet/connection, so an imported file is carried over Bluetooth/Wi-Fi Direct by the node rather
  than waiting for a gateway that may never return. With no native bridge the row stays queued.
  `scripts/tests/pwa-relay-queue.mjs` pins both branches.
- **The relay node owns the alert-file hand-off natively.** The WebView cannot receive a file that
  arrived by the Android share sheet or a file manager, and its export only saw the PWA's IndexedDB
  rows — never the packets the node held. `RelayPacketFile` parses/validates/enqueues a
  `reach-relay-packets` document and re-exports `RelayQueueDb.livePackets()`; `MainActivity` handles
  `ACTION_SEND`/`ACTION_VIEW` (manifest `singleTop`) so a shared file is queued without the page;
  and the bridge exposes `importRelayFile`/`exportRelayFile`, which `backend.js` prefers over
  IndexedDB. Validation is structural only (the gateway still verifies signatures/registration), but
  a malformed/expired packet is rejected rather than queued, and a re-import is idempotent by `k`.
- Android BLE fragments must be sized from the negotiated ATT MTU, not a fixed 160 bytes. The default MTU
  is 23, so a write carries at most 20 bytes; `BleCentralRelay` now requests a larger MTU and captures the
  chunk size once per transfer (the MTU callback is async — resizing mid-transfer would desync `total`).
- The PWA and Kotlin BLE fragment headers now agree: both `protocol.js`'s `sendBluetoothPacket` and
  `BleTransfer`/`BleCentralRelay` use `[transferId:4][seq:1][total:1][payload...]` (the PWA previously
  sent a 16-byte transfer id and 2-byte seq/total, so a browser write could never be reassembled by a
  native node). A change here is a wire-format change — update the PWA sender, `BleTransfer`, the
  Android sender, and the framing tests together.
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
  into `extensions` so the local run reproduces this class of failure instead of hiding it.
  The sweep is complete. A PostGIS **type** in a declaration (`location geography(point,4326)`) is
  resolved at CREATE FUNCTION time against the function's own path, so 0002's
  `create_incident_for_current_user` aborted the whole file with `type "geography" does not exist`
  before any later migration could repair it — that is why the fix is an in-place edit to 0002's
  `search_path`, not a new migration. `ingest_relay_packet_service` (0013) calls PostGIS at run time
  and failed only when a relayed packet with coordinates arrived; it now also carries `extensions`.
  The fixture installs **PostGIS into `extensions`** and both `migrations.mjs` and
  `relay-ingest-sim.mjs` set the database default `search_path` to `"$user", public, extensions`, so
  a schema-less extension reference behaves as it does on Supabase. `migrations.mjs` asserts no
  SECURITY DEFINER function references PostGIS/pgcrypto without `extensions` on its path.
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
- **Linking Helix is a credential step, not a code change.** The adapter is already Helix-compatible,
  so the whole integration is `supabase secrets set REACH_AI_ENDPOINT=https://api.launchverse.app/api/v1/chat/completions
  REACH_AI_API_KEY=helix_… REACH_AI_MODEL=helix-advisor` (or the equivalent `REACH_AI_*` repo secrets,
  which `deploy-supabase.yml`'s "Link AI provider (optional)" step reads and pushes; it is a no-op when
  any is missing so the provider is never half-configured). `security-static.mjs` pins that the workflow
  links all three together and that the key never becomes a `VITE_` variable. Verify the link with
  `GET /system/health` (`AI provider: Healthy`) and `GET /ai/provider-events` (`ok` + `model:
  helix-advisor`). The `lvse_…` account token is a different credential and is rejected by the
  inference host — use the `helix_…` key. See `docs/DEPLOYMENT_RUNBOOK.md` §"Linking Helix".
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
- **Relay-path evidence now rebinds.** When a report is delivered by relay (native bridge, queued
  signed packet, or alert file), `sendOrQueueEmergency` binds the capture to the report's idempotency
  key (`bindEvidence({ reportKey: key })`) because the incident does not exist yet. The key is the
  packet's own `k`, and the incident is created server-side on ingest, so the rebind is done in two
  ways that both key off `k`:
  - The sender's own upload reads the created incident id out of the `POST /relay/packets` ingest
    response (it returns the `relay_packets` row, whose `incident_id` is set) and calls
    `rebindRelayEvidence(key, incidentId)` before the capture flushes. It falls back to
    `GET /relay/packets/:key` for an older gateway.
  - A packet delivered by another node or an alert file was never uploaded by this device, so
    `reconcileRelayEvidence()` runs on every sync: it collects the still report-keyed captures and
    asks the gateway which relay packets have become incidents (`GET /relay/packets/:key`), then
    repoints the matches. A key that has not been ingested yet simply 404s and is retried.
  `GET /relay/packets/:key` reads through RLS (`relay_select_scoped`), so a key belonging to another
  tenant is indistinguishable from a missing one (404) — it cannot be used to probe foreign packets.
  The native node's `packetStatus` only reports "delivered", not the incident id, so the export path
  relies on the packet key (which is already in the evidence row) rather than a native result channel.
  `scripts/tests/pwa-relay-evidence-rebind.mjs` (CI: `test:pwa-relay-evidence`) drives both paths.

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
- **The relay node now survives a reboot.** The foreground service was only ever started from
  `MainActivity.onCreate`, so after a phone restart the node silently stopped carrying packets until
  the citizen reopened the app — and a citizen with no internet is exactly the one who cannot be
  told to. `RelayStartReceiver` restarts the service on `BOOT_COMPLETED` / `MY_PACKAGE_REPLACED` /
  `QUICKBOOT_POWERON` (`RECEIVE_BOOT_COMPLETED` is declared), but only when a relay permission is
  held, so it never starts a radio the citizen refused. `RelayService.onStartCommand` returns
  `START_STICKY` so a memory-pressure kill is restarted too. Both radios are still started together
  in `onCreate`; the boot receiver is what makes that "background" rather than "until the next
  reboot".
- **The Android relay node must register its relay identity or every forwarded packet is refused.**
  `ingest_relay_packet_service` rejects a relay whose `(relay_device_id, relay_public_key)` is not an
  active `device_registrations` row ("Unregistered or revoked relay device"). The PWA self-registers
  its *source* identity on sign-in (`backend.js` → `POST /devices/register`), but the native node
  never registered its *relay* identity, so it could receive a packet over BLE/Wi-Fi and never
  deliver one — radios, ACKs and queue all looked healthy while the gateway rejected the uplink.
  `RelayGatewayUploader.registerDevice`/`registerDeviceAsync` now registers on every
  `configureSession` bridge handoff, and `upload` re-registers once if an uplink fails while
  unregistered (idempotent upsert; happy path pays no extra round trip). `initBackendSync` also hands
  the restored session to the bridge on a returning launch, since signup/login never runs then and
  the node would otherwise keep no uplink config. Pinned by
  `scripts/tests/relay-ingest-sim.mjs` section E (unregistered refused → register → accepted) and the
  wiring checks in `relay-verify.mjs` section I.
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

- **Inside the relay-node app the WebView must save/open the file itself.** A `WebView` cannot
  complete a blob download or a share sheet, and it has no file picker without an
  `onShowFileChooser` — so "Save alert file to transfer" and "Receive an alert file" (and the
  evidence-capture inputs) did nothing inside the app. `MainActivity` now answers
  `onShowFileChooser` / `onActivityResult` (a dismissed picker returns an empty result so the input
  is never stuck), and exposes a `saveExportFile(fileName, contents)` bridge that writes the JSON
  into the device's Downloads (MediaStore on API 29+, the app's external Downloads directory below
  that) and returns `{saved, location}`. `handleRelayExport` in `reach-citizen-pwa/js/app.js` uses
  the bridge when present, otherwise the share sheet / blob download as before. A `DownloadListener`
  handles a `data:`/`http(s)` download the page might trigger. Pinned by
  `scripts/tests/pwa-relay-save.mjs` (CI: `test:pwa-relay-save`) and two Robolectric tests in
  `MainActivityLaunchTest`.

- **The BMONI Configure modal has a one-click sandbox demo.** `Run sandbox demo` drives the
  real sandbox for payer / owner-proof challenge / onboarding / deposit account / proposal and
  marks the two signature steps (`Sign owner proof + create wallet`, `Sign + settle
  subscription`) as **simulated** — they need the wallet owner's private key, which never
  leaves the `bmoni-institution-mobile` device, and settlement additionally needs a funded
  wallet + a webhook pointed at REACH. The result panel labels every step `live`/`skipped`/
  `simulated`, so it never claims a settlement the sandbox did not make. `src/lib/bmoniDemo.ts`
  holds the documented Bunch Dillon persona (BVN `95888168924`) and generates a **fresh**
  E.164 phone per run, because the sandbox rejects a reused number with `409`. The runner is
  idempotent: an existing payer/wallet/onboarding/pending proposal is reused, since a second
  proposal trips the one-active-payment index. `scripts/tests/bmoni-demo.mjs` (CI:
  `test:bmoni-demo`) pins the persona, unique-phone generation and the live/simulated split.

- **The security-desk evidence panel must not describe evidence it was not given.** `MediaChips`
  hard-coded "911 Call Audio Stream #8841-A", "CCTV Feed Cam-04" and a specific lat/long geofence,
  so the Response Desk showed a fabricated CCTV/telemetry summary for every incident regardless of
  what was actually attached — an operator could act on invented evidence. The panel now derives its
  text from the incident (`evidence.audio/image/location`, `locationLabel`) and says "no audio clip
  / no image / no location is recorded" when the record is empty. The panel is also fed the *stored*
  evidence rows (`GET /evidence?incident_id=…`) rather than the derived `evidence` prop, which is
  left over from `mapIncident` and is always false — so even a real capture would have shown as
  absent. `ResponseDeskPage` folds the rows through `evidenceFlags` (audio/image/video/location,
  excluding the `user_report` placeholder). Pinned by `scripts/tests/ui-honesty.mjs`.

- **`/responders` returns a flat `full_name`, not a nested profile.** The assign-responder dropdown
  read `r.profiles?.full_name`, which is always undefined, so every option rendered as a raw uuid.
  The endpoint joins the profile server-side and returns `full_name` on the row. `AppContext`'s
  staff mapping already read `r.full_name`; the dropdown now does too.

- **The desk-settings page was a working-looking form that persisted nothing.** `teamOnDuty`
  ("Zone B Security"), `radioChannel` ("CH-3") and a toggle for AI auto-push lived only in
  `INITIAL_DESK_SETTINGS` in `data/system.ts` and were never read by any backend path (there is no
  per-desk settings table). The page now states plainly that per-desk settings are not persisted and
  shows only the real responder-on-duty count, instead of a radio channel that does not exist and an
  auto-push toggle that does nothing. `DeskSettings` and `INITIAL_DESK_SETTINGS` were dropped from
  the context.

- **A relay transport that cannot start yet must report it, and the service must retry it.** The
  citizen is asked for Bluetooth/Wi-Fi permissions on the relay screen, so a grant often arrives
  *after* `RelayService.onCreate`. `WifiDirectRelay.startAckServer` returns `Boolean` — `false` only
  when `Permissions.wifiDirect` is missing (it returns `true` when there is no Wi-Fi Direct radio at
  all, since retrying would never help), and `startRelay()` returns `false` while the Bluetooth
  permission/radio is missing. `RelayService.startTransports()` is idempotent (`bleStarted` /
  `wifiStarted` guards) and is retried from `onStartCommand` (which `MainActivity` re-fires after
  the permission dialog), `onResume`, and the 30s maintenance tick. Do not mark a transport started
  without checking that call's return value, and do not make `startAckServer` return early silently —
  that is what left one radio dead until the process was killed. Pinned by
  `RelayTransportRetryTest` in `relay-node-android`.

- **BMONI rail state is asynchronous; a read of the NGN endpoint is not proof of onboarding.**
  `start-nigeria` returns before `anchorStatus` becomes `active`, and until it does the NGN endpoint
  lists the shared pooled account. `GET /institution/billing/bmoni/deposit-account` must read
  `onboardingStatus` first and only mark `ngn_virtual_account_ready` / `onboarding_status: 'active'`
  when `anchorStatus == 'active'`; otherwise return `deposit_account: null`. The billing setup
  checklist derives "Nigeria onboarding" from `onboarding_status`, not `bvn_verified` (which
  `start-nigeria` sets on *submission*). Pinned by `scripts/tests/ui-honesty.mjs`.

- **`ui-honesty.mjs` is the static guard for these UI defects** (CI: `test:ui-honesty`, wired into
  `validate:all`). It fails if a fabricated CCTV/telemetry string returns to `MediaChips`, if the
  responder dropdown stops reading `full_name`, if the desk-settings page renders unpersisted
  values, if the relay-node identity registration / session handoff is removed, if a relay status
  line falls back to an unconditional "Ready to carry alerts nearby." for a browser with no
  transport, or if an open-incident count stops treating `Closed` as terminal.

- **A browser with no native node and no Web Bluetooth must not claim it can relay.**
  `js/relay/status.js`'s `relaySummary` previously ended with an unconditional
  `'Ready to carry alerts nearby.'` fallback, and `js/relay/permissions.js` returned
  "Your alert is carried to REACH through the nearby relay network" from its `unavailable`
  branch — both claim a delivery that cannot happen on a plain browser with no Web Bluetooth
  hand-off (which is exactly the "no relay node available on this device" screen). They now
  name the paths that actually work: connectivity, or "Save alert file to transfer". The
  `app.js` catch-fallback for an unreadable relay status was likewise changed from "Relaying
  an emergency alert nearby." to an honest "kept on this device" line.

- **A paired nearby node is used offline, not just on the send path.**
  `flushRelayQueue` only handed an offline packet to the *native* bridge; a plain browser that
  had paired a nearby node over Web Bluetooth queued the packet and waited for connectivity,
  wasting the pairing. It now falls back to `sendPacketViaDirectRelay` (delivery claimed only
  on the node's verified ACK) when `directRelayAvailable() && directRelayConnection()`.
  `scripts/tests/pwa-relay-queue.mjs` (CI: `test:pwa-relay`) drives both the native handoff
  and the paired-node handoff.

- **Open-incident counts treat `Closed` as terminal, not only `Resolved`.**
  `LiveQueuePage`, `OverviewPage` and `OperatorOverviewPage` filtered `status !== 'Resolved'`,
  so a closed incident still counted as open. They now exclude `['Resolved','Closed']` (matching
  `operator/summary`'s `activeCount`, which already excluded cancelled too). Pinned by
  `ui-honesty.mjs`.

- **"Institution data unavailable" was really "still loading".** `institutions[0]` is empty until
  `AppContext.refreshIncidents()` finishes, so on every cold reload the four institution pages
  (`Overview`, `Site Incidents`, `Billing and Plan`, `Security Roster`) rendered *"Institution data
  unavailable — Connect the REACH backend or finish institution setup"* for the first fetch — up to
  seconds on a slow network — while the data was on its way. It reads as a failed setup/connection
  and is the same class of dishonest status the rest of the UI avoids. `AppContext` now exposes
  `dataLoading` (true until the first load settles, in a `finally`), and each page shows a
  `LoadingPanel` while it is true, falling back to the unavailable message only when the load has
  settled with no institution. A reload still flashes the loading panel, but never claims the
  backend is missing while it is being fetched. Pinned by `ui-honesty.mjs`.


