# AGENTS.md — REACH repository notes

## Layout

- `reach-platform/` — React + Vite + TypeScript operations platform (4 roles: security-desk, staff, institution, operator).
- `reach-citizen-pwa/` — vanilla-JS citizen emergency PWA (no build step).
- `reach-platform/supabase/` — Postgres schema/RLS/workflows (`migrations/0001`–`0010`) and the `api` Edge Function (`functions/api/`).
- `relay-node-android/` — native Android relay (Kotlin). `bmoni-institution-mobile/` — Flutter BMONI signing service.
- `docs/` — **all** product documentation; start at `docs/README.md`. Keep the root free of loose notes: only `README.md` and `AGENTS.md` live there. Merge new fix logs into `docs/HARDENING_LOG.md` and release notes into `docs/RELEASE_NOTES.md` rather than adding another root `*_FIXES.md`.
- `tests/` — RLS, BMONI webhook, load (k6) and AI-calibration harnesses.
- `.github/workflows/ci.yml` — CI gates (platform, PWA syntax, migration order, android, security scripts).

## Commands (run inside `reach-platform/`)

- `npm run build` — `tsc && vite build`.
- `npm run validate` — PWA syntax + hardening controls + **executes all migrations** when a DB is reachable.
- `npm run validate:migrations` — migration execution only (needs `psql` + PostGIS).
- `npm run validate:hardening` — static hardening assertions.
- `npm run test:security` — static security assertions (CORS, body limit, CSP, session storage…).
- `npm run validate:all` — validate + hardening + security.

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
