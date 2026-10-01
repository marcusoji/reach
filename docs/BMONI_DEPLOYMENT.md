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
