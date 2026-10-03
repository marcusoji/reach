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
`configured: true` and user creation reaches the sandbox. Two secrets are still
required before the **Pay** step can prepare a transfer proposal:

```bash
supabase secrets set REACH_INSTITUTION_SUBSCRIPTION_AMOUNT_CNGN="<decimal CNGN price>"
supabase secrets set REACH_BMONI_TREASURY_ADDRESS="<0x destination wallet>"
supabase functions deploy api
```

- `REACH_BMONI_TREASURY_ADDRESS` is the REACH CNGN wallet that receives the
  institutional subscription transfer. Without it the proposal route returns
  `503 REACH BMONI treasury wallet is not configured`.
- `REACH_INSTITUTION_SUBSCRIPTION_AMOUNT_CNGN` is a plain decimal (e.g. `14500`),
  not wei. Without it the proposal route returns `422 A valid institutional
  subscription amount is required`.

After both are set, sign in as `admin@northgate.reach.dev` (the seeded trial
tenant) and run Configure BMONI → Create payer (Bunch Dillon persona, BVN
`95888168924`) → wallet → KYC → Start Nigeria → Load NGN virtual account → Pay.
The proposal signs on a BMONI-enabled device; the subscription flips to `active`
when BMONI delivers the settlement webhook to
`/functions/v1/api/webhooks/bmoni`.
