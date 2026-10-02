# REACH deployment runbook

How to stand REACH up yourself: what to run, where to host it, and how to wire the
BMONI payment connection. Written so you can execute it top to bottom without
guessing.

This runbook is the practical, self-contained guide: concrete commands, concrete
hosts, concrete BMONI steps. It carries the 12-phase map and the isolation
checklist inline, so you do not need the original setup document.

---

## 0. What "set up everything" actually means

REACH has four deployable pieces and one external integration. They are not all
set up the same way, and two of them cannot be finished without things you have to
obtain (a BMONI partner key, physical Android phones).

| Piece | What it is | Where it runs |
|-------|-----------|---------------|
| `reach-platform/` | React + Vite operations app (all staff roles) | Static host (Vercel) |
| `reach-citizen-pwa/` | Vanilla-JS citizen app, no build step | Static host (Vercel), HTTPS required |
| `reach-platform/supabase/` | Postgres + RLS + Auth + Realtime + Edge Function API | Supabase Cloud |
| `relay-node-android/` | Native Android BLE / Wi-Fi Direct relay | Physical Android phones |
| `bmoni-institution-mobile/` | Flutter device-side BMONI signer | Android / iOS device |

The split that matters: **Supabase is the backend for both frontends.** You do not
host a server yourself — Supabase Cloud is the server. You host two static sites
and one Edge Function.

### Local vs external

| Phase | Doable by you now, locally | Needs external |
|-------|---------------------------|----------------|
| 1. Local build certify | yes | — |
| 2. Supabase + migrations | yes (or Supabase Cloud) | — |
| 3. RLS / tenant isolation | yes | — |
| 4. BMONI sandbox billing | partly (fixtures) | **BMONI partner key** |
| 5. Deploy frontends | yes | hosting account |
| 6. End-to-end product flow | yes | — |
| 7. Android relay matrix | build yes | **2+ physical phones** |
| 8. SMS / USSD / IVR | no | **provider credentials** |
| 9. Operator bootstrap | yes | — |
| 10. Pen + load + failure | no | **deployed staging** |
| 11. AI discipline | no | **labelled dataset** |
| 12. Production cutover | no | all of the above |

---

## 1. Prerequisites

Install once:

- **Node.js 20+** (repo CI uses 20; local builds pass on 24)
- **Supabase CLI** — `npm i -g supabase`
- **Postgres client** (`psql`) — for migration validation
- **JDK 17** + **Android SDK** — only for the Android relay
- **Flutter 3.11+** — only for the BMONI signer app
- A **Supabase account** (free tier is enough to start)
- A **Vercel account** (free tier is enough)
- A **domain** you control (for HTTPS and PWA install)

---

## 2. Phase 1 — certify the build locally

```bash
cd reach-platform
npm ci
npm run validate:all      # hardening + security + PWA syntax
npm run build             # tsc && vite build -> dist/
```

Expected: all checks PASS, `dist/` created.

`validate:all` includes `validate:migrations`, which **executes every migration**
against a throwaway Postgres+PostGIS database. If it prints
`SKIP - no Postgres server reachable`, you are not actually validating migrations —
see §3.4 for a local Postgres. Do not ignore the skip.

---

## 3. Phase 2 — Supabase project and migrations

### 3.1 Create the project

1. Create a project at supabase.com (staging first, production later).
2. Note the **project ref**, the **URL**, the **anon key**, and the
   **service-role key** from Settings → API.

### 3.2 Link and push migrations

```bash
cd reach-platform
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

Migrations apply in filename order, `0001` → `0011`. **Never skip one.** If you
prefer, paste each file into the Supabase SQL editor in the same order.

### 3.3 Enable Realtime

In the Supabase dashboard, add to the `supabase_realtime` publication at least:
`incidents`, `notifications`, `incident_assignments`.

### 3.4 Optional — validate migrations locally first

This is what I verified works in this container:

```bash
# Postgres 15 + PostGIS, on port 55432
docker run -d --name reachpg -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgis/postgis:15-3.4

export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres PGPASSWORD=postgres

# the minimal Supabase scaffolding (auth schema, roles, realtime publication)
psql -d postgres -c "create database reach_dev template template_postgis;"
psql -d reach_dev -f reach-platform/scripts/tests/supabase-bootstrap.sql
for f in reach-platform/supabase/migrations/*.sql; do
  psql -d reach_dev -v ON_ERROR_STOP=1 -f "$f" || break
done

npm run validate:migrations
```

Result should be: `10 migrations applied transactionally (30 tables)` and
`row level security enabled on every public table`.

---

## 4. Phase 2b — deploy the Edge Function API

The API is one Deno function at `reach-platform/supabase/functions/api/`.

```bash
cd reach-platform
supabase functions deploy api
```

Then set its secrets. **These are server-side only — never put them in a
`VITE_` variable or in `config.js`.**

```bash
supabase secrets set \
  REACH_ALLOWED_ORIGINS="https://your-platform.vercel.app,https://your-pwa.vercel.app" \
  REACH_OPERATOR_PROVISION_KEY="$(openssl rand -hex 32)" \
  BMONI_BASE_URL="https://embedded-dev.bmoni.com" \
  BMONI_API_KEY="your-partner-key" \
  BMONI_WEBHOOK_SECRET="set-after-webhook-registration"
```

Optional AI adapter (leave unset to keep AI purely local/heuristic):

```bash
supabase secrets set REACH_AI_ENDPOINT= REACH_AI_API_KEY= REACH_AI_MODEL=
```

`REACH_ALLOWED_ORIGINS` must exactly match your deployed frontend origins or CORS
will reject them. Wildcard `*` is refused unless you explicitly set
`REACH_ALLOW_STAR_CORS=true` — do not do that in production.

---

## 5. Phase 3 — RLS and tenant isolation

Before trusting the backend, prove tenants cannot see each other.

1. Create two institutions (A and B) in the dashboard or via SQL.
2. Create users for each role: citizen, staff, security-desk, institution, operator.
3. Run the isolation suite:

```bash
psql "$REACH_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/rls_tenant_isolation.sql
```

That file seeds two institutions and asserts: a citizen cannot escalate their own
role, cross-institution incident reads return zero rows, same-institution reads
work, `audit_logs` is not client-writable, `anon` reads nothing, and privileged
RPCs are not anon-callable. Any failure raises and exits non-zero.

Then walk the wider isolation checklist below (rate limiting, responder task
boundaries, cross-institution assignment, and the rest):

| # | Check | Pass criteria |
|---|-------|---------------|
| 1 | Public signup role | Always citizen only |
| 2 | Citizen profile lock | Cannot change role, institution or zone |
| 3 | Citizen incident scope | Cannot create for another institution |
| 4 | Citizen status change | Only permitted cancellation |
| 5 | Responder tasks | Cannot update another responder's task |
| 6 | Cross-institution assign | Fails |
| 7 | Relay foreign packet | Rejected |
| 8 | Audit table | Client cannot insert/update/delete |
| 9 | Rate limit | HTTP 429 after threshold |
| 10 | Institution billing | Only own institution data |
| 11 | Operator boundary | No Accept / no AI approve for emergencies |
| 12 | Service-role paths | Relay ingest and operator provision reject normal JWT |

---

## 6. Phase 5 — where to host the frontends

Both frontends are static files. Host them anywhere that serves HTTPS.

### reach-platform (operations app)

**Recommended: Vercel.** `reach-platform/vercel.json` already defines the SPA
rewrite and the security headers (CSP, HSTS, X-Frame-Options, Permissions-Policy).

```bash
cd reach-platform
npm i -g vercel
vercel              # preview
vercel --prod       # production
```

Set build-time env vars in Vercel → Settings → Environment Variables:

```
VITE_REACH_DEMO_MODE=false
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_REACH_API_URL=https://YOUR_PROJECT.supabase.co/functions/v1/api
```

Alternatives that work equally well: **Netlify**, **Cloudflare Pages**, or any
static host. Vercel is the path of least resistance because the config is written.

### reach-citizen-pwa (citizen app)

No build step — it is plain files. Deploy the folder as-is.

```bash
cd reach-citizen-pwa
vercel --prod       # or: drag the folder into Netlify / Cloudflare Pages
```

Before deploying, edit `reach-citizen-pwa/js/config.js`:

```js
window.REACH_CONFIG = {
  SUPABASE_URL: 'https://YOUR_PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_SUPABASE_ANON_KEY',
  API_URL: 'https://YOUR_PROJECT.supabase.co/functions/v1/api',
  DEMO_MODE: false
};
```

**HTTPS is mandatory here** — service workers, geolocation and Web Bluetooth do
not work over plain HTTP or `file://`.

### Quick local preview instead

```bash
# operations app
cd reach-platform && npm run dev          # http://localhost:5173

# citizen PWA (any static server)
cd reach-citizen-pwa && python3 -m http.server 5500
```

Then add both origins to `REACH_ALLOWED_ORIGINS` on the Edge Function.

---

## 7. Phase 4 — the BMONI connection

This is the part that trips people up, so here is the whole flow.

### 7.1 What BMONI is here

BMONI Embedded (Bkey) is the Nigerian embedded wallet + banking provider. REACH
uses it for **institutional subscription billing**: an institution admin signs a
payment on their device, BMONI settles it, and a webhook activates the
subscription.

Two rules govern the whole integration:

1. **All BMONI REST calls happen server-side**, in the Edge Function. The partner
   key never reaches a browser or a phone app.
2. **Signing happens device-side**, in the Flutter app. The private key lives in
   the device secure element and never leaves it.

### 7.2 Get credentials

1. Contact BMONI for a partner account. You need a **partner key** (`x-api-key`).
2. Sandbox base URL: `https://embedded-dev.bmoni.com`
3. Production base URL: `https://embedded.bmoni.com`
4. Webhook docs: https://bkey.mintlify.app/api-reference/webhooks

Set `BMONI_BASE_URL` and `BMONI_API_KEY` as Edge Function secrets (§4). The code
refuses to call BMONI unless the base URL is HTTPS and a key is present — there is
no implicit dev fallback.

### 7.3 Register the webhook

`POST /v1/webhooks/config` with:

```json
{
  "callbackUrl": "https://YOUR_PROJECT.supabase.co/functions/v1/api/webhooks/bmoni",
  "events": [ /* the payment/deposit completion events BMONI documents */ ],
  "partnerId": "YOUR_PARTNER_ID",
  "active": true
}
```

The response returns a `secretKey`. Set it as `BMONI_WEBHOOK_SECRET` and redeploy
the function:

```bash
supabase secrets set BMONI_WEBHOOK_SECRET="returned-secret-key"
supabase functions deploy api
```

### 7.4 Signature contract (must match exactly)

| Item | Value |
|------|-------|
| Signature header | `X-Webhook-Signature` |
| Algorithm | `hex(HMAC-SHA256(secretKey, rawBody))` |
| Event id header | `X-Webhook-Id` (same as `body.id`) |
| Body shape | `{ id, eventType, payload, timestamp }` |

The Edge Function verifies this itself and tolerates a legacy `sha256=` prefix and
the older `x-bmoni-*` headers as fallback. If verification fails it returns 401.

### 7.5 The in-app payment path

An institution admin does this once:

1. **Create BMONI user** — `POST /v1/users` (name, email, phone).
2. **KYC** — `PATCH /v1/users/{id}/kyc`.
3. **Owner-proof challenge** — `POST /v1/users/{id}/smart-wallets/owner-proof-challenges`.
4. **Sign the challenge** on the device — Flutter `signMessage(challenge, pin)`.
5. **Create managed wallet** — `POST .../smart-wallets/create-managed` with the
   challenge id + signature.
6. **Nigeria onboarding** — `POST .../onboarding/start-nigeria` with BVN and NGN
   wallet address.
7. **Get deposit account** — `GET .../bank-accounts/deposit-accounts/NGN`.
8. **Create proposal** — `POST .../smart-wallets/{walletId}/proposals`.
9. **Get sign payload** — `GET .../proposals/{id}/sign-payload`. The digest is
    in **`signingPayloadHash`** — not `hashToSign` or `payload`, which the BMONI
    docs name but the API does not return. It is not always ready on the first
    call; retry on `409 E201` until it returns 200.
10. **Sign the payment hash** on the device — Flutter `signTransactionHash(hashHex, pin)`.
    This signs the **raw 32-byte hash**, not an EIP-191 message.
11. **Submit signature** — `POST .../proposals/{id}/sign`.
12. **Wait for the webhook** to settle and activate the subscription.

The device-side half is `bmoni-institution-mobile/lib/bmoni_signing_service.dart`.
Everything else is `reach-platform/supabase/functions/api/bmoni.ts` and is already
wired into the API.

**Read [BMONI_INTEGRATION_NOTES.md](./BMONI_INTEGRATION_NOTES.md) before debugging
anything here.** It records the field names and error codes the sandbox actually
returns, which differ from BMONI's published docs in several places — including
the sign-payload field name above, the KYC address shape, and which sandbox
persona works.

### 7.6 Test it without a live partner key

You can verify the webhook path locally before BMONI is live. The fixture
checklist to run against your deployed staging function:

- valid success → subscription activates exactly once
- modified signature → 401
- missing signature → rejected
- duplicate `X-Webhook-Id` → idempotent success, no double activation
- late failure after success → does **not** downgrade the subscription
- reversal → does not leave the subscription wrongly active

Send a correctly-signed body with:

```bash
BODY='{"id":"evt_1","eventType":"payment.completed","payload":{},"timestamp":"2026-01-01T00:00:00Z"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$BMONI_WEBHOOK_SECRET" | awk '{print $2}')

curl -i -X POST \
  "https://YOUR_PROJECT.supabase.co/functions/v1/api/webhooks/bmoni" \
  -H "content-type: application/json" \
  -H "X-Webhook-Signature: $SIG" \
  -H "X-Webhook-Id: evt_1" \
  -d "$BODY"
```

Then flip one byte of `$SIG` and confirm you get 401.

### 7.7 Sandbox testing

Verified against the live sandbox — see
[BMONI_INTEGRATION_NOTES.md](./BMONI_INTEGRATION_NOTES.md) for detail.

- **Use the Bunch Dillon persona** (BVN `95888168924`, name `Bunch` / `Dillon`).
  It is the only one that works: the Samson Jabo BVN `22222222222` returns
  `404 E501` and its rail never activates, despite the BMONI docs calling it
  valid.
- **Use a unique phone number.** The documented persona phone
  `+2348000000000` is already taken and returns `409`.
- **Verify the BVN resolves first** with `GET .../kyc/bvn-lookup/{bvn}`.
  `start-nigeria` returns `hasBvn: true` even when the BVN did not resolve, so
  that flag alone is not proof the persona matched.
- **Poll until the rail is active.** `start-nigeria` is asynchronous: read
  `GET .../onboarding/status` until `anchorStatus == "active"` (about 30s) before
  expecting a dedicated NGN deposit account.
- **The shared sandbox key is not tenant-scoped.** It exposes ~941 users across
  other teams and returns the partner webhook secret in plaintext. Treat all
  sandbox data as public and keep real personal data out of it.

---

## 8. Phase 7 — Android relay node

```bash
cd relay-node-android
./gradlew assembleDebug      # APK -> app/build/outputs/apk/debug/
./gradlew lint
```

The Gradle wrapper is committed, so no `gradle` install is needed. JDK 17 required.
`local.properties` (your SDK path) is gitignored — create it if the SDK is not in
the default location:

```
sdk.dir=/path/to/Android/sdk
```

Install the APK on **at least two physical phones** (emulators cannot test BLE or
Wi-Fi Direct). Run the 12-scenario matrix in `relay-node-android/README.md`:
offline store, A→B→gateway, A→B→C→gateway, duplicate, tampered, bad signature,
revoked device, TTL/hop limits, wrong institution, restart, radio interrupt,
gateway recovery.

Release builds need a signing keystore:

```bash
keytool -genkey -v -keystore reach-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias reach
```

Keep the keystore and its passwords out of git.

---

## 9. Phase 8 — notifications (SMS / USSD / IVR)

Not doable without a provider. You need credentials from a Nigerian aggregator
(Termii, Africa's Talking, or similar). Then:

1. Store them **only** as Edge Function secrets.
2. Enable the delivery workers with retries and dead-letter handling.
3. Verify provider webhook signatures and idempotency.
4. Only then switch the channels on in product config.

Until then, leave those channels off. In-app notifications work already.

---

## 10. Phase 9 — operator bootstrap

1. The **first** operator uses `REACH_OPERATOR_PROVISION_KEY` to become super-admin.
   This only works while zero operators exist.
2. Every **subsequent** operator is added by single-use email invitation
   (`POST /operator/invitations`).
3. Confirm the direct RPC path is rejected without the Edge Function secret.

Rotate `REACH_OPERATOR_PROVISION_KEY` to a random value after the first operator
exists — it is bootstrap-only.

---

## 11. Phase 10–12 — hardening, then cutover

These require a deployed staging environment and, for pen/load, dedicated tooling.

- **Security:** privilege escalation, RLS bypass with crafted JWTs, session abuse,
  relay replay/tampering, webhook replay, oversized payloads, prompt injection.
- **Load:** 100 / 500 / 1000 concurrent incident creates, plus bursts across relay
  ingest, webhooks, payments, AI and notifications.
- **Failure:** Supabase outage, BMONI outage, AI outage, SMS outage, and emergency
  creation during an institutional grace period.
- **AI discipline:** build a labelled evaluation set before making any accuracy
  claim. Measure precision, recall, false positive/negative rate, calibration,
  abstention and latency. Keep the UI labelled advisory.
- **Cutover:** `VITE_REACH_DEMO_MODE=false` everywhere, production Supabase URL and
  anon key, migrations `0001`–`0011` on production, production secrets, monitoring
  and backups.

---

## 12. Hosting summary and rough cost

| Piece | Recommended host | Cost to start |
|-------|-----------------|---------------|
| Operations app | Vercel | free |
| Citizen PWA | Vercel (same account) | free |
| Backend (Postgres/RLS/Auth/Realtime/Edge) | Supabase Cloud | free, ~$25/mo for Pro |
| Relay APK | Firebase App Distribution or Play internal testing | free |
| BMONI signer app | Play / App Store internal track | ~$25 one-off (Play) |
| Domain + TLS | any registrar | ~$10–15/yr |

Everything except BMONI, SMS and physical-device testing can be stood up on free
tiers.

---

## 13. Recommended order

1. Phase 1 locally — confirm the build is green.
2. Supabase project + `db push` + deploy the Edge Function.
3. Run the RLS isolation suite.
4. Deploy both frontends, add their origins to `REACH_ALLOWED_ORIGINS`.
5. Walk the end-to-end flow: citizen registers → admin creates an invitation →
   staff/desk redeems it → admin adds a responder → citizen submits an emergency →
   desk sees it over Realtime, reviews AI evidence and verifies → desk assigns →
   responder accepts, marks on scene, completes → incident resolves → citizen
   tracking matches server state. Also test offline queue then sync (no duplicate
   incident).
6. Then, and only then, start BMONI: get the key, register the webhook, run the
   fixtures.
7. Android relay and notifications last — they need hardware and providers.

Do not call it production-ready until the Phase 10–12 gates pass on real staging.
