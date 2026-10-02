# CI and test harnesses

## npm scripts (`reach-platform`)
| Script | What it does |
|--------|----------------|
| `npm run validate` | PWA JS syntax + production hardening markers + legacy relay RPC lockdown |
| `npm run validate:migrations` | Applies every migration to a throwaway Postgres+PostGIS, then runs the RLS tenant-isolation suite. Skips (exit 0) when no server is reachable |
| `npm run validate:hardening` | Static hardening regression checks |
| `npm run test:security` | Security static checks |
| `npm run test:ai` | Safety Fusion engine + provider adapter (`ai_engine.ts`, `ai_provider.ts`) |
| `npm run test:relay` | Relay packet verification: canonical form, tampering, fuzz, dedup, BLE framing |
| `npm run test:pwa-relay` | PWA offline relay queue: TTL expiry, backoff, dead-lettering |
| `npm run validate:all` | validate + hardening + security + ai + relay + pwa-relay |
| `npm run build` | `tsc && vite build` |

## GitHub Actions
`.github/workflows/ci.yml` — five jobs:
- `platform` — `npm ci`, then validate, hardening, ai, relay, pwa-relay and the production build.
- `pwa` — syntax-checks every PWA JS file and runs `reach-citizen-pwa/js/relay/test-protocol.mjs`.
- `sql-migrations` — boots `postgis/postgis:16-3.4` and applies every migration for real via `npm run validate:migrations`.
- `android` — `./gradlew assembleDebug lint` on JDK 17.
- `security-scripts` — `scripts/tests/security-static.mjs`.

## Harnesses (`tests/` and `scripts/tests/`)
| File | Use |
|------|-----|
| `scripts/tests/migrations.mjs` | Real migration execution + privileged-RPC ACL + RLS assertions |
| `tests/rls_tenant_isolation.sql` | Tenant isolation suite (role escalation, cross-institution reads/writes, audit immutability, anon access) |
| `scripts/tests/relay-verify.mjs` | Relay verification, tampering, fuzz, dedup, BLE framing |
| `scripts/tests/pwa-relay-queue.mjs` | PWA relay queue behaviour under a minimal IndexedDB shim |
| `scripts/tests/ai-engine.mjs` | Safety Fusion decisions, abstention trace, provider circuit breaker |
| `tests/bmoni_webhook_fixtures.mjs` | Signed webhook payloads |
| `tests/load_incidents_k6.js` | k6 concurrent incidents |
| `tests/ai_calibration_harness.mjs` | AI evaluation process (needs labelled data) |

## Android
`relay-node-android/CI.md` — `./gradlew assembleDebug lint` (no unit-test task; the
relay logic is exercised by physical-device matrices, not CI).
