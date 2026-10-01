# REACH — BMONI Embedded Institutional Billing

## Payment rule

**Only the institution pays for REACH.** Individual residents/citizens, students, staff, security personnel, responders and operators do not pay for emergency access.

## Implemented architecture

```text
Institution Admin
      |
      v
REACH Billing UI
      |
      v
REACH Supabase Edge API
      |
      +--> BMONI Embedded REST API (server-side x-api-key)
      |
      +--> PostgreSQL billing ledger
      |
      v
BMONI CNGN Smart Wallet
      |
      v
Institution Subscription
```

## BMONI lifecycle used

1. Create the institution's authorized BMONI payer user.
2. Provision the CNGN smart wallet on the payer device.
3. Create the owner-proof challenge.
4. Sign the owner-proof challenge with EIP-191 on the device.
5. Create the managed smart wallet.
6. Submit Nigerian onboarding with the BVN and wallet address.
7. Read onboarding status / NGN deposit account.
8. Create a REACH institutional subscription transfer proposal.
9. Approve the proposal.
10. Retrieve the sign payload.
11. Sign the raw transaction hash with `signTransactionHash` on the payer device.
12. Submit the signature.
13. Confirm settlement through the BMONI webhook/status mechanism.
14. Only after verified settlement is the REACH subscription marked active.

## Security rules

- `BMONI_API_KEY` is server-side only.
- `BMONI_WEBHOOK_SECRET` is server-side only.
- The browser never receives the BMONI API key.
- The browser never receives or stores the BMONI wallet private key.
- Owner-proof uses `signMessage` / EIP-191.
- Proposal/offramp signing uses `signTransactionHash` over the raw 32-byte hash.
- Subscription activation is not based on a browser success screen.
- Institutional payment mutations are protected by the `institution` role.
- No citizen/staff/security/responder payment endpoint is exposed.
- Payment creation uses an idempotency key.

## Server environment

Configure these as Supabase Edge Function secrets / server environment variables:

```text
BMONI_BASE_URL=https://embedded-dev.bmoni.com
BMONI_API_KEY=<sandbox-or-production-server-key>
BMONI_WEBHOOK_SECRET=<webhook-secret>
REACH_BMONI_TREASURY_ADDRESS=<REACH-CNGN-destination-wallet>
REACH_INSTITUTION_SUBSCRIPTION_AMOUNT_CNGN=<institution-price>
```

For production, use the production BMONI base URL and production credentials. Never commit secrets.

## Important deployment dependency

The current REACH web dashboard is React/TypeScript. BMONI's supplied wallet SDK is Flutter/mobile. Therefore the web dashboard prepares and tracks the institutional payment, while the private-key operation remains on the supported BMONI-enabled device. A native institution payer application must use the BMONI Embedded SDK to sign the owner-proof challenge and transaction hash.

## Database

Migration `0005_bmoni_institution_billing.sql` adds:

- `bmoni_institution_accounts`
- `bmoni_transactions`
- `bmoni_webhook_events`

The existing `payments` and `subscriptions` tables remain the REACH billing ledger. BMONI identifiers are linked to that ledger.
