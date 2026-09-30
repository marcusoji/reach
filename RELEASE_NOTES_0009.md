# REACH 0009 Release Notes

## Baseline
Built from `REACH-FULL-HARDENED-FIXED-0008-FRESH` plus certification patches and a full source cross-check.

## Changes from 0008
1. **BillingPlanPage** — imports `submitBmoniInstitutionPaymentSignature` (fixes production `tsc` build).
2. **BMONI webhook** — aligns with official contract:
   - Primary header: `X-Webhook-Signature` (hex HMAC-SHA256 of raw body)
   - Event id: body `id` / `X-Webhook-Id`
   - Event type: body `eventType`
   - Legacy `x-bmoni-*` headers kept as fallback
   - Constant-time hex compare

## Verified in this package (source + local)
- `npm run validate` — PASS
- `npm run validate:hardening` — 10/10 PASS
- `npm run build` (`tsc && vite build`) — PASS
- AI Safety Fusion v2: advisory-only, abstention, weighted evidence, external model never authorizes response
- Relay: hop ≤ 6, TTL ≤ 30 min, ECDSA verify, device ownership, UUID guards, Android BLE + Wi-Fi Direct + signed queue
- BMONI: HTTPS-only base URL, monotonic settlement, single pending payment, official webhook headers
- Auth: demo mode explicit flag; API requires authentication; rate limiting present

## Still external (not claimed complete in this ZIP)
- Live Supabase migration/RLS on staging
- Real BMONI sandbox payment
- Physical multi-phone relay matrix
- SMS/USSD/IVR providers
- Pen test and 100/500/1000 load tests

## Migration order (unchanged)
`0001 → 0002 → 0003 → 0004 → 0005 → 0006 → 0007 → 0008`

## Demo mode (local only)
```env
VITE_REACH_DEMO_MODE=true
# leave Supabase URL/key empty for pure local demo
```
Never enable in production builds.
