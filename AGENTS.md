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
- `text[]` literals need braces: `'{a,b}'`, not `'a,b'`.
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
