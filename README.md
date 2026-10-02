# REACH Integrated MVP (Phase 4 cert-ready)

## Components
- `reach-platform/` — React operations app + Supabase Edge API
- `reach-citizen-pwa/` — Citizen emergency PWA (offline queue)
- `relay-node-android/` — Native BLE + Wi-Fi Direct relay with ACK
- `reach-platform/supabase/` — Migrations `0001`–`0018` + Edge functions
- `docs/` — **All product documentation** (start at `docs/README.md`)
- `tests/` — RLS, BMONI, load, AI harnesses
- `.github/workflows/ci.yml` — CI gates

## Quick start
```bash
cd reach-platform && npm ci && npm run validate:all && npm run build
```

## Documentation
See **[docs/README.md](docs/README.md)** for the full index. Highlights:
- [docs/REACH_PRODUCTION_STATUS.md](docs/REACH_PRODUCTION_STATUS.md) — authoritative status
- [docs/HARDENING_LOG.md](docs/HARDENING_LOG.md) — consolidated hardening history
- [docs/EXTERNAL_CERTIFICATION.md](docs/EXTERNAL_CERTIFICATION.md) — what still needs staging, providers or devices

## Production honesty
Source hardening and local validators pass. Live RLS, BMONI sandbox, multi-phone relay, and load/pen tests remain external certification steps ([docs/EXTERNAL_CERTIFICATION.md](docs/EXTERNAL_CERTIFICATION.md)).
