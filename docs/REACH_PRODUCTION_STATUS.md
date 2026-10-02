# REACH Production Status

**Package:** REACH-PHASE4-CERT-READY (Phases 1–4)  
**Migrations:** 0001–0018  
**Last updated:** 2026-10-01  

This is the **authoritative** status document. Older audit/fix/next-fix notes
have been consolidated into [HARDENING_LOG.md](./HARDENING_LOG.md) and
[RELEASE_NOTES.md](./RELEASE_NOTES.md).

## What this package is
Integrated MVP: `reach-platform` (React), `reach-citizen-pwa`, `relay-node-android`, Supabase migrations `0001`–`0018`.

## Phase 1 implemented in this build

### Android relay (items 1–4, 12–16 partial)
| Item | Status |
|------|--------|
| 1. Packet expiry before forward + purge | **Done** — `RelayQueueDb.purgeExpired`, hard check in `due()` |
| 1b. Dead-letter after max attempts | **Done** — state `DEAD_LETTER` |
| 2. BLE delivery ACK | **Done** — ACK characteristic, verify id+hash, delete only on ACK |
| 3. Wi-Fi Direct delivery ACK | **Done** — framed send + ACK read; server validates+persists+ACKs |
| 4. Crash-safe SENDING→PENDING | **Done** — `recoverStaleSending()` |
| 12. Duplicate-safe enqueue | **Done** — `INSERT OR IGNORE` on packet id |
| 15. Hop max immutable 6 | **Done** — `MAX_HOPS=6`, client max clamped |
| 16. Full validate before forward | **Done** — `RelayProtocol.validate` |

### BMONI (items 5, 17–19 partial)
| Item | Status |
|------|--------|
| 5. Persistent payment idempotency | **Done (client)** — stable 24h localStorage key; server already required `x-idempotency-key` + unique (institution, key) |
| 17–19. Webhook inbox / idempotent / monotonic | **Prior migrations + official signature headers** — still verify live against provider (item 20) |

### Onboarding (items 6–7 foundation)
| Item | Status |
|------|--------|
| 6. onboarding_sessions table | **Done** — migration `0009_phase1_reliability.sql` |
| 7. Transactional onboarding RPC | **Schema ready** — full RPC wiring still to complete in Edge API |

### Security (items 8–11 partial)
| Item | Status |
|------|--------|
| 8. Operator invitations table | **Done** — `operator_invitations` (hashed token, expiry, single-use model) |
| 9. BLE bond attempt before transfer | **Partial** — `createBond()` on connect |
| 11. WebView origin lock | **Done** — host allowlist, HTTPS/localhost only, restricted JS bridge |

### PWA (item 26 partial)
| Item | Status |
|------|--------|
| 26. Dead-letter helpers | **Done** — states + `markQueueDead` / `listDeadLetter` |

## Local verification remaining on your machine
```bash
cd reach-platform && npm ci && npm run validate && npm run validate:hardening && npm run build
cd ../relay-node-android && ./gradlew assembleDebug   # add wrapper if missing
```

## Still NOT production-complete (must do live)
- Physical 2–3 phone BLE/Wi-Fi ACK matrix  
- Real BMONI sandbox payment + webhook fixtures (item 20)  
- Full operator invite accept flow in API UI  
- Transactional institution signup RPC end-to-end  
- RLS automated suite, load tests, pen tests  
- Notification providers  
- AI calibration metrics  

## Migration order
`0001 → 0002 → 0003 → 0004 → 0005 → 0006 → 0007 → 0008 → 0009`

## Demo mode
`VITE_REACH_DEMO_MODE=true` only for local demo with empty Supabase config. Never production.

## Phase 2 security (2026-10-01)

| Item | Status |
|------|--------|
| 8. Operator single-use invitations | **Done** — POST /operator/invitations, accept, list; bootstrap key only when zero operators |
| 10. WebView origin lock | Done (Phase 1) |
| 11. Token storage | **Improved** — access token in sessionStorage; refresh isolated; logout clears both |
| 12. Rate limiting | **Improved** — limits by path class + user + IP |
| 13. Request body limits | **Done** — readJsonLimited 256KiB; webhook 512KiB |
| 14. CORS / security headers | **Hardened** — explicit origins (no * by default); nosniff/frame/referrer on API; CSP on Vercel |

### Operator flow
1. First install: one bootstrap with `REACH_OPERATOR_PROVISION_KEY` → creates **super-admin**
2. Super-admin creates invitation → raw token returned once (hash stored)
3. Invitee signs up as citizen with **same email**, accepts token → becomes operator
4. Token single-use, 24h expiry, email-bound, audited

### Still open from Phase 2–4
- Full cookie/CSRF path (still Bearer tokens)
- Automated RLS/security/load suites
- Physical relay + BMONI live certification
- AI calibration

## Phase 3 reliability (2026-10-01)

| Item | Status |
|------|--------|
| 15. Relay gateway dedup | **Done** — `relay_ingest_dedup` by packet_key+hash; multi-path safe |
| 16. Dead-letter queues | **Done** — Android + PWA dead_letter states |
| 17. PWA recovery | **Done** — flushQueue dead/expired, resumeOfflineQueue on online/login |
| 18. Durable webhook inbox | **Improved** — attempt_count, last_attempt_at, next_attempt_at; failure keeps row for provider retry |
| 19. Notification idempotency | **Done** — `notification_deliveries` UNIQUE(notification_id, channel, recipient) + API |
| 20. Realtime validation | **Improved** — exponential backoff, token refresh before resubscribe, heartbeat retained |

### Migrations
`0001` … `0009` → **`0010_phase3_reliability.sql`**

### Still external
Physical multi-phone tests, live BMONI fixtures, full RLS/load/pen suites, real SMS/USSD providers, AI calibration.

## Phase 4 — Certification scaffolding (2026-10-01)

| Item | Status |
|------|--------|
| 21. Gradle wrapper | **Scaffolded** — properties + gradlew; jar must be generated once with `gradle wrapper` |
| 22. CI/CD | **Done** — `.github/workflows/ci.yml` (build, validate, security-static, PWA, migrations, Android if jar present) |
| 23. RLS tests | **Harness** — `tests/rls_tenant_isolation.sql` |
| 24. Physical relay | **Matrix** — `tests/PHYSICAL_RELAY_MATRIX.md` |
| 25. BMONI fixtures | **Harness** — `tests/bmoni_webhook_fixtures.mjs` |
| 26–28. Load/security | **Harness** — k6 script + `npm run test:security` |
| 29. AI calibration | **Harness** — `tests/ai_calibration_harness.mjs` |
| 30. Production audit | **Done** — `REACH_PRODUCTION_AUDIT.md` |

### Commands
```bash
cd reach-platform && npm ci && npm run validate:all && npm run build
# Generate Android wrapper once:
cd ../relay-node-android && gradle wrapper --gradle-version 8.7 && ./gradlew assembleDebug
```
