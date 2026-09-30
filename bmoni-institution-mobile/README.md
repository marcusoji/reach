# REACH Institution BMONI Mobile Signer

This companion Flutter client is the device-side signing boundary for institutional BMONI payments. It is intentionally separate from the React/PWA dashboard because the supplied BMONI Embedded specification requires wallet keys to remain on-device.

## Responsibilities
- Initialize `BmoniEmbeddedSdk` once.
- Create/reuse the device wallet.
- Sign owner-proof challenges with `signMessage()` (EIP-191).
- Sign payment proposal hashes with `signTransactionHash()` (raw 32-byte digest; no EIP-191 prefix).
- Send only public wallet address and signatures to the REACH API.
- Never store or transmit the private key.

## Packages
Use the versions currently approved by BMONI on pub.dev:
- `bmoni_embedded_sdk`
- `bkey_uikit`
- `bmoni_embedded_wallets_cards`

## Integration contract
1. Institution admin creates/loads the BMONI payer account from the React dashboard.
2. Mobile app calls the REACH API to obtain an owner-proof challenge.
3. Mobile SDK signs the challenge with `signMessage(message, pin: ...)`.
4. React/backend completes managed-wallet creation.
5. Institution completes Nigeria onboarding/KYC.
6. React dashboard creates a subscription proposal.
7. Backend returns `hashToSign`.
8. Mobile SDK calls `signTransactionHash(hashToSign, pin: ...)`.
9. Mobile app submits the resulting 65-byte signature to `POST /institution/billing/bmoni/payment/sign`.
10. REACH waits for BMONI settlement/webhook before activating the subscription.

## Security
- Do not place `BMONI_API_KEY`, `BMONI_WEBHOOK_SECRET`, or `REACH_OPERATOR_PROVISION_KEY` in this app.
- Do not accept a raw private key from the web dashboard.
- Do not use `signMessage()` for payment proposals/offramps.
- Do not treat a successful UI submission as payment settlement.
