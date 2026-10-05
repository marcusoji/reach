# BMONI Deployment Checklist

1. Apply Supabase migration `0005_bmoni_institution_billing.sql` after migrations 0001–0004.
2. Configure Supabase Edge Function secrets:
   - `BMONI_BASE_URL`
   - `BMONI_API_KEY`
   - `BMONI_WEBHOOK_SECRET`
   - `REACH_BMONI_TREASURY_ADDRESS`
   - `REACH_INSTITUTION_SUBSCRIPTION_AMOUNT_CNGN`
3. Configure the BMONI webhook callback to the deployed endpoint:
   `/functions/v1/api/webhooks/bmoni`
4. Use the BMONI webhook secret returned by BMONI for verification.
5. Test entirely in BMONI sandbox first.
6. Use the Bunch Dillon sandbox persona (`95888168924`) only. The Samson Jabo
   persona (`22222222222`) does not resolve on the sandbox host and its rail
   never activates — see `BMONI_INTEGRATION_NOTES.md`.
7. Replace sandbox API/base URL and credentials with production values only during production cutover.
8. Verify an institution can complete onboarding and a subscription payment.
9. Verify a citizen, staff member and security-desk user cannot access institution billing endpoints.
10. Verify a successful BMONI settlement changes the linked REACH payment to `paid` and subscription to `active`.
11. Verify duplicate webhook delivery is ignored.
12. Verify a failed/reversed payment does not activate or keep an institution incorrectly marked as paid.

## Sandbox enablement for the demo

`BMONI_BASE_URL` (`https://embedded-dev.bmoni.com`) and `BMONI_API_KEY` are already
set on the hosted function, so `GET /institution/billing/bmoni` reports
`configured: true` and the whole setup flow reaches the sandbox.

**Pay works with no extra configuration.** The destination and the price are both
server-controlled and have working defaults:

- **Destination** — `REACH_BMONI_TREASURY_ADDRESS` when set; otherwise the built-in
  `DEFAULT_BMONI_TREASURY_ADDRESS` (REACH's receive-only demo treasury). The
  destination must be **different from the payer's own wallet**: BMONI rejects a
  self-transfer (`400 Recipient wallet must be different from the group wallet`), so
  the institution's own wallet cannot be used. A client can never name the destination.
- **Amount** — `REACH_INSTITUTION_SUBSCRIPTION_AMOUNT_CNGN` when set (plain
  decimal, e.g. `14500`, not wei); otherwise the built-in default
  `DEFAULT_SUBSCRIPTION_AMOUNT_CNGN` (`14500`). A client can never name the amount.

Setting both as Edge Function secrets (and redeploying) overrides the defaults and
is still the right move for production:

```bash
supabase secrets set REACH_INSTITUTION_SUBSCRIPTION_AMOUNT_CNGN="<decimal CNGN price>"
supabase secrets set REACH_BMONI_TREASURY_ADDRESS="<0x destination wallet>"
supabase functions deploy api
```

**Async signing.** After `approve`, BMONI prepares the transfer asynchronously, so
`GET .../proposals/{id}/sign-payload` can return `409 Signing payload is not ready
yet` for a few seconds. The proposal route persists the proposal id first and retries
on 409 (~24s). The device signs the **raw** `signingPayloadHash` (not EIP-191).

**Settlement.** A signed proposal on an unfunded sandbox wallet reaches
`PENDING_SIGNATURES` and does not move CNGN, so no settlement webhook arrives and the
local payment stays `pending`. The subscription only flips to `active` when BMONI
delivers the settlement webhook (`successful`/`completed`) to
`/functions/v1/api/webhooks/bmoni`. A funded wallet (load the NGN deposit account)
is what makes that happen.

**Funding the sandbox is manual, and the default price exceeds it.** There is no
faucet. Sandbox wallets start at `0` and BMONI credits them on request: email
`developers@bkey.me` the payer's signup phone and they credit NGN 1,000 / USD 10
(usually within a business day) — see
`https://embedded-docs.bmoni.com/request-test-tokens`. Because the built-in
`DEFAULT_SUBSCRIPTION_AMOUNT_CNGN` is `14500`, the default Pay flow can never
settle on the sandbox credit; set `REACH_INSTITUTION_SUBSCRIPTION_AMOUNT_CNGN` to
`1000` (or less) and redeploy to demo a real settlement.

**The shared sandbox webhook points elsewhere.** `GET /v1/webhooks/config` returns
`callbackUrl: https://bmoni-hackathon-demo.workers.dev/webhooks/bmoni`. Re-register
the callback to REACH's `/functions/v1/api/webhooks/bmoni` (with the payment
completion events) before expecting any settlement to arrive.

**Reusing one identity across institutions.** Each institution gets its own payer
user, wallet and NGN deposit account, but the Bunch Dillon identity (BVN
`95888168924`) can be reused. The phone number must be **unique per payer** — the
documented sandbox number is taken and a duplicate returns `409`.

Sign in as `admin@northgate.reach.dev` (the seeded trial tenant) and run Configure
BMONI → Create payer (Bunch Dillon persona, BVN `95888168924`, fresh phone) → wallet →
KYC → Start Nigeria → Load NGN virtual account → Pay.

**One-click sandbox demo.** The Configure BMONI modal now has **Run sandbox demo** and
**Load sandbox details**. "Load sandbox details" prefills the documented Bunch Dillon
persona with a freshly generated E.164 phone (`src/lib/bmoniDemo.ts`), because the sandbox
rejects a reused number with `409`. "Run sandbox demo" drives the **real** sandbox for the
steps it can actually perform — create payer, owner-proof challenge, Nigeria onboarding,
NGN virtual account, subscription proposal — and marks the two steps that cannot be
automated from the browser as **simulated**:

- **Sign owner proof + create wallet** — the owner-proof signature needs the wallet owner's
  private key, which by design never leaves the institution's BMONI device
  (`bmoni-institution-mobile`). The sandbox call is live the moment a signature is supplied.
- **Sign + settle subscription** — the payment signature needs that same owner key, and
  settlement additionally needs a funded sandbox wallet with the webhook re-registered to
  REACH. The sandbox wallet starts at `0` and is credited manually.

So the demo reaches a real, provider-returned proposal with a sign payload, and the panel
says plainly which steps were live and which were simulated. It never claims a settlement
the sandbox did not make. The demo is idempotent: an institution that already has a payer,
wallet, onboarding or a pending proposal reuses it rather than creating a duplicate (a
second proposal would trip the one-active-payment index). `scripts/tests/bmoni-demo.mjs`
pins the persona, the unique-phone generation and the live/simulated split (CI:
`test:bmoni-demo`).
