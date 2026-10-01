# AGENTS.md — REACH repository notes

## Layout

- `reach-platform/` — React + Vite + TypeScript operations platform (4 roles: security-desk, staff, institution, operator).
- `reach-citizen-pwa/` — vanilla-JS citizen emergency PWA (no build step).
- `reach-platform/supabase/` — Postgres schema/RLS/workflows (`migrations/0001`–`0010`) and the `api` Edge Function (`functions/api/`).
- `relay-node-android/` — native Android relay (Kotlin). `bmoni-institution-mobile/` — Flutter BMONI signing service.
- `docs/` — product documentation index (`docs/README.md`). Root-level `*.md` are kept for history.
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
- `relay-node-android/` ships `gradlew` + `gradle/wrapper/gradle-wrapper.properties` but **no `gradle-wrapper.jar`**,
  so `./gradlew` will not run until the jar is generated (`gradle wrapper`) or committed. CI's android job is
  guarded on that jar and skips meanwhile.
