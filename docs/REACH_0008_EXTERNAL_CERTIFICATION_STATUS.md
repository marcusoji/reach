# REACH 0008 — External Certification Status Report

**Date:** 2026-09-30  
**Baseline package:** `REACH-FULL-HARDENED-FIXED-0008-FRESH.zip`  
**Sources reviewed:** consolidated into [HARDENING_LOG.md](./HARDENING_LOG.md)  
**Environment:** Network-enabled sandbox (no Supabase project credentials, no BMONI partner secrets, no physical Android devices)

---

## Executive summary

| Category | Status |
|----------|--------|
| Local static validators | **VERIFIED PASS** |
| Source-level 0008 hardening (13 items) | **FIXED in package** (per audit) |
| BMONI webhook signature contract | **FIXED in this session** to match official docs |
| `npm ci` / production build | **VERIFIED PASS** (`tsc && vite build` succeeded after import fix) |
| Supabase migrations 0001–0008 on live staging | **BLOCKED BY EXTERNAL DEPENDENCY** (need project URL + service role) |
| RLS / tenant isolation live tests | **BLOCKED BY EXTERNAL DEPENDENCY** |
| Real BMONI sandbox payment | **REQUIRES PROVIDER/CREDENTIAL** |
| Android build + multi-phone relay | **REQUIRES PHYSICAL DEVICE** |
| SMS/USSD/IVR providers | **REQUIRES PROVIDER/CREDENTIAL** |
| Pen test / 100–1000 load tests | **BLOCKED BY EXTERNAL DEPENDENCY** (deployed staging) |

**REACH is not production-certified.** Local source hardening is strong. External gates remain open.

---

## 1. FIXED (this session + 0008 baseline)

### 1.1 Already in 0008 package (per the hardening log)
1. Backend signup no longer depends on demo mode  
2. `BMONI_BASE_URL` mandatory + HTTPS-only (no implicit dev endpoint)  
3. AI authorization before external model call  
4. Real system-health DB/incident/relay probes  
5. Unexpected failures map to HTTP 500 (not false 400)  
6. Relay device ownership cannot transfer between users  
7. Relay ingest UUID guards + cross-institution source/actor checks  
8. Server-side relay TTL ≤ 30 minutes, hops ≤ 6  
9. Duplicate relay packets keep first-seen security identity  
10. BMONI settlement monotonic (late failure cannot downgrade success)  
11. Single initiated/pending institutional payment per institution/subscription  
12. PWA offline queue max size, 24h expiry, exponential backoff  
13. Vercel production security headers  

### 1.2 Fixed in this certification pass

**A. Missing frontend import (build blocker)**  
`BillingPlanPage.tsx` called `submitBmoniInstitutionPaymentSignature` without importing it from `reachApi.ts`. Import added; production build now passes.

**B. BMONI webhook verification aligned to official provider contract**  
Official docs (`bkey.mintlify.app/api-reference/webhooks`):

| Item | Official BMONI | Previous REACH code | After fix |
|------|----------------|---------------------|-----------|
| Signature header | `X-Webhook-Signature` | `x-bmoni-signature` / `x-signature` only | Accepts official first, legacy as fallback |
| Algorithm | HMAC-SHA256(raw body), **hex** | Hex + Base64 accepted; string `===` | Hex only; constant-time compare |
| Event id | Body `id` + `X-Webhook-Id` | `x-bmoni-event-id` | Body `id` → `X-Webhook-Id` → legacy → hash fallback |
| Event type | Body `eventType` | Header only | Body `eventType` primary |

Patched file: `reach-platform/supabase/functions/api/index.ts`  
Copy: `/home/workdir/artifacts/REACH_0008_CERT/index.ts.webhook-patched`

---

## 2. VERIFIED (local, this environment)

```text
$ node scripts/validate.mjs
REACH validation passed: 6 PWA JavaScript files syntax-checked and production hardening controls found.

$ node scripts/tests/final-hardening.mjs
PASS - backend signup does not require demo mode
PASS - AI authorization precedes model call
PASS - BMONI has no implicit dev endpoint
PASS - service-role fallback is absent
PASS - relay UUID cast is guarded
PASS - relay device takeover is blocked
PASS - relay TTL is server capped
PASS - BMONI late failures cannot downgrade successful
PASS - single active institutional payment enforced
PASS - system health performs database probes
```

**Result: 10/10 hardening checks PASS. Validator PASS.**

Migrations present and ordered:
- `0001_reach_mvp.sql`
- `0002_security_and_workflows.sql`
- `0003_ai_relay_hardening.sql`
- `0004_relay_identity_and_ai_ops.sql`
- `0005_bmoni_institution_billing.sql`
- `0006_production_hardening.sql`
- `0007_relay_bmoni_atomic_hardening.sql`
- `0008_final_hardening.sql`

---

## 3. FAILED / NOT COMPLETED HERE

| Item | Reason |
|------|--------|
| Full `npm run build` (tsc + vite) | **PASS** after fixing missing `submitBmoniInstitutionPaymentSignature` import |
| Live migration apply | No Supabase project credentials supplied |
| Live RLS suite | Requires applied migrations + test users per role |
| BMONI sandbox end-to-end payment | Requires partner API key + webhook secret + HTTPS callback |
| Android `assembleDebug` / device relay | No Android SDK / physical devices in this environment |
| SMS/USSD/IVR | No provider credentials |
| Pen test / load 100–1000 | Needs deployed staging URL |

---

## 4. BLOCKED BY EXTERNAL DEPENDENCY

Provide these to continue certification:

1. **Supabase staging**
   - Project URL  
   - `service_role` key  
   - Anon key  

2. **BMONI**
   - Sandbox: `https://embedded-dev.bmoni.com`  
   - Partner `x-api-key` (or shared sandbox key for exploratory only)  
   - Webhook `secretKey` from `POST /v1/webhooks/config`  
   - Public HTTPS callback URL pointing at `/webhooks/bmoni`  

3. **Notification providers** (optional for full gate)
   - SMS / USSD / IVR / email / push credentials  

4. **Deployed staging base URL** for pen/load tests  

---

## 5. REQUIRES PHYSICAL DEVICE

From [EXTERNAL_CERTIFICATION.md](./EXTERNAL_CERTIFICATION.md) §3 — must run on ≥2 Android phones:

- Offline emergency; A→B→gateway; A→B→C→gateway  
- Duplicate / modified packet / invalid ECDSA / wrong key / revoked device  
- TTL > 30 min, hop > 6, wrong institution  
- App restart, screen lock, BT/Wi-Fi interrupt, battery saver, permissions revoked  
- Gateway unavailable + recovery  

---

## 6. REQUIRES PROVIDER/CREDENTIAL

- Exact BMONI live/sandbox transaction lifecycle (success, fail, reverse, duplicate, late failure)  
- SMS/USSD/voice delivery + provider webhooks  
- Operator one-time invitation bootstrap (product decision + secret management)  

---

## 7. REMAINING SECURITY RISK (until external gates pass)

1. Webhook contract was misaligned to official headers — **patched in source**; must be redeployed and tested with real BMONI deliveries.  
2. Operator provisioning still uses a reusable browser-submitted secret — replace with one-time short-lived invite before broad production.  
3. Custom Realtime client not validated against deployed Supabase Realtime version.  
4. AI remains advisory; no labelled calibration metrics yet.  
5. No evidence of live RLS bypass testing with malicious cross-tenant JWTs.  
6. No load/failure evidence at 100 / 500 / 1,000 concurrent incidents.  

---

## 8. Exact next commands (for your staging machine)

```bash
# 1. Frontend build certification
cd reach-platform
npm ci
npm run build
npm run validate
npm run validate:hardening

# 2. Apply migrations (Supabase CLI)
supabase link --project-ref <STAGING_REF>
supabase db push   # applies 0001–0008 in order

# 3. Configure Edge secrets
supabase secrets set \
  BMONI_BASE_URL=https://embedded-dev.bmoni.com \
  BMONI_API_KEY=<partner_or_sandbox_key> \
  BMONI_WEBHOOK_SECRET=<secretKey_from_webhook_config>

# 4. Register webhook with BMONI
# POST https://embedded-dev.bmoni.com/v1/webhooks/config
# { "callbackUrl": "https://<your-api>/webhooks/bmoni", "events": [...], "partnerId": "...", "active": true }
# Store returned secretKey as BMONI_WEBHOOK_SECRET

# 5. Run RLS / E2E scripts (implement against staging)
# 6. Android: ./gradlew assembleDebug + physical relay matrix
# 7. Staging load: 100 / 500 / 1000 concurrent incident creates
```

### BMONI webhook fixture checklist
- [ ] valid signature + completed payment → subscription activates once  
- [ ] invalid signature → 401  
- [ ] modified body → 401  
- [ ] missing signature → 503/401  
- [ ] duplicate `X-Webhook-Id` → `{ ok: true, duplicate: true }`  
- [ ] late failure after success → does **not** downgrade  
- [ ] reversal → subscription not left active incorrectly  

### Official BMONI references
- Webhooks: https://bkey.mintlify.app/api-reference/webhooks  
- API intro / sandbox: https://embedded-docs.bmoni.com/api-reference/introduction/  
- Sandbox base URL: `https://embedded-dev.bmoni.com`  
- Production base URL: `https://embedded.bmoni.com`  

---

## 9. Reporting labels (as requested)

| Label | Items |
|-------|--------|
| **FIXED** | 0008 source hardening list; BMONI webhook official header/contract alignment |
| **VERIFIED** | `validate.mjs` PASS; `validate:hardening` 10/10 PASS; `npm run build` PASS |
| **FAILED** | None in local static/build scope after import + webhook fixes |
| **BLOCKED BY EXTERNAL DEPENDENCY** | Live Supabase migrations/RLS; deployed pen/load tests |
| **REQUIRES PHYSICAL DEVICE** | Android build + multi-hop BLE/Wi-Fi relay matrix |
| **REQUIRES PROVIDER/CREDENTIAL** | BMONI sandbox payment; SMS/USSD/IVR |
| **REMAINING SECURITY RISK** | See §7 until external gates pass |

**Do not label REACH production-ready until sections 4–6 pass on real staging.**
