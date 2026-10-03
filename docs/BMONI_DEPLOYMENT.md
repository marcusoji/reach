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

**Reusing one identity across institutions.** Each institution gets its own payer
user, wallet and NGN deposit account, but the Bunch Dillon identity (BVN
`95888168924`) can be reused. The phone number must be **unique per payer** — the
documented sandbox number is taken and a duplicate returns `409`.

Sign in as `admin@northgate.reach.dev` (the seeded trial tenant) and run Configure
BMONI → Create payer (Bunch Dillon persona, BVN `95888168924`, fresh phone) → wallet →
KYC → Start Nigeria → Load NGN virtual account → Pay.
