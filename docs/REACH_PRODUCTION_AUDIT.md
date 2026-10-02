# REACH Final Production Audit (Phase 4 scaffolding)

## Architecture
- `reach-platform` — React ops + Edge API
- `reach-citizen-pwa` — offline-capable citizen client
- `relay-node-android` — BLE + Wi-Fi Direct mesh with ACK
- Supabase — Auth, Postgres RLS, Realtime, Edge Functions
- BMONI — institutional subscription payments only

## Completed engineering phases
| Phase | Focus | Package |
|-------|--------|---------|
| 1 | Android TTL/ACK/crash-safe, payment idempotency, onboarding schema | PHASE1 |
| 2 | Operator invites, rate limits, CORS/CSP, token storage | PHASE2 |
| 3 | Dedup, dead-letter, webhook durability, notifications, Realtime | PHASE3 |
| 4 | CI, Gradle wrapper scaffold, RLS/load/BMONI/AI test harnesses | **this** |

## CI gates (`.github/workflows/ci.yml`)
- TypeScript production build
- validate + hardening + security-static
- PWA JS syntax
- Migration presence
- Android `assembleDebug` + `lint` (wrapper jar is committed)

## Known limitations (honest)
- Physical relay, live BMONI, load, and pen tests require staging credentials and devices
- Custom Realtime client improved but not fully replaced by official supabase-js channel API
- AI is advisory Safety Fusion Confidence until calibration dataset exists

## Production checklist (must all be green)
- [ ] Migrations 0001–0012 on production
- [ ] `VITE_REACH_DEMO_MODE=false`
- [ ] Secrets: BMONI_*, REACH_ALLOWED_ORIGINS, no star CORS
- [ ] Super-admin bootstrap then invitations only
- [ ] RLS suite signed off
- [ ] BMONI sandbox fixtures passed
- [ ] Physical relay matrix signed off
- [ ] k6 load thresholds met
- [ ] Monitoring on 5xx, webhook failures, relay ingest
- [ ] Backup/restore verified

## External dependencies
Supabase, BMONI, optional AI endpoint, optional SMS/USSD/push providers, Android devices for mesh.
