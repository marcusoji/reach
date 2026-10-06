# REACH Release Notes

## 0009

Baseline: `REACH-FULL-HARDENED-FIXED-0008-FRESH` plus certification patches and
a full source cross-check.

Changes from 0008:

1. **BillingPlanPage** imports `submitBmoniInstitutionPaymentSignature` (fixes
   the production `tsc` build).
2. **BMONI webhook** aligns with the official contract:
   - primary header `X-Webhook-Signature` (hex HMAC-SHA256 of the raw body)
   - event id from body `id` / `X-Webhook-Id`
   - event type from body `eventType`
   - legacy `x-bmoni-*` headers kept as fallback
   - constant-time hex compare

Verified locally: `validate` PASS, `validate:hardening` 10/10 PASS,
`build` PASS. See [HARDENING_LOG.md](./HARDENING_LOG.md) for the full control
list and [EXTERNAL_CERTIFICATION.md](./EXTERNAL_CERTIFICATION.md) for what
remains external.

## 0008

Baseline: reconstructed from the recoverable REACH FULL HARDENED 0007 source
package after the earlier 0008 archive expired.

Contains the 0008 source-level fixes that can be safely implemented and verified
locally. It is **not** a production certification — live-provider, database,
Android-device, penetration and load testing remain required.

## Migration order

Run migrations in order and do not skip earlier ones:

`0001 → ... → 0021 → 0022`

## Demo mode (local only)

```env
VITE_REACH_DEMO_MODE=true
# leave Supabase URL/key empty for pure local demo
```

Never enable in production builds.
