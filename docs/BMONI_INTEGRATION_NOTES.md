# BMONI integration notes — verified against the sandbox

**Verified:** 1 October 2026 against `https://embedded-dev.bmoni.com`, using the
shared sandbox key from the BMONI hackathon brief.

This file records what the sandbox **actually does**, where that differs from
BMONI's published documentation, and which differences matter to REACH. The
published docs are the source of intent; this file is the source of behaviour.

Everything below was observed directly. Two full lifecycle runs were completed
end to end (both documented personas, separate users, separate wallets, separate
owner keys), plus targeted failure-path probes.

## 1. What works

The whole REACH billing path is verified working:

| Step | Call | Result |
|------|------|--------|
| Create user | `POST /v1/users` | 201, returns `bmoniUserId` |
| KYC profile | `PATCH /v1/users/{id}/kyc` | 200, returns `saved` + `missing` |
| Owner proof | `POST .../owner-proof-challenges` | 201, EIP-191 signature recovers to the owner address |
| Wallet | `POST .../smart-wallets/create-managed` | 201, `isActive: true` |
| Onboarding | `POST .../onboarding/start-nigeria` | 200, `hasBvn: true` |
| Rail status | `GET .../onboarding/status` | `anchorStatus: active` (async — see §5) |
| Deposit account | `GET .../bank-accounts/deposit-accounts/NGN` | dedicated NGN virtual account issued |
| Proposal | `POST .../smart-wallets/{walletId}/proposals` | 201, `PENDING_APPROVALS` |
| Approve | `POST .../proposals/{id}/approve` | 200, `PENDING_SIGNATURES` |
| Sign payload | `GET .../proposals/{id}/sign-payload` | 200 |
| Sign | `POST .../proposals/{id}/sign` | 200 with a raw-digest signature |
| Withdrawal account | `POST .../bank-accounts/withdrawal-accounts/nigeria` | 201 |
| Offramp | `POST .../smart-wallets/{walletId}/offramp/nigeria` | 403 `E503` on an unfunded wallet (correct) |
| Webhook config | `GET /v1/webhooks/config` | 200 |

The two-signature contract is enforced exactly as documented, and this was
confirmed negatively as well as positively:

- **Owner proof** — sign the challenge text **with** the EIP-191 prefix
  (`signMessage`). Accepted.
- **Proposal** — sign the 32-byte digest **without** the prefix
  (`signTransactionHash`). Accepted.
- Signing the proposal digest with EIP-191 instead is rejected:
  `400 E101 "Signature does not match your registered owner address"`.

## 2. Field names that differ from the documentation

### 2.1 The sign-payload digest is `signingPayloadHash`

`GET .../proposals/{id}/sign-payload` returns these keys:

```
signingPayloadHash, typedData, signatureExpiresAt, proposalStatus
```

There is **no** `hashToSign` field and **no** `payload` field, although the
documentation names both. Code that reads `hashToSign || payload` gets `null`
and fails silently.

This was a real defect in REACH and is fixed in
`reach-platform/supabase/functions/api/index.ts` and
`reach-platform/src/pages/institution/BillingPlanPage.tsx`, which now read
`signingPayloadHash` first.

The response also carries a full EIP-712 `typedData` object (chainId `84532`,
domain `Coinbase Smart Wallet`, verifying contract = the smart wallet address).
**Do not** pass this to a `signTypedData` method — it describes the digest but
signing it would produce a different hash and be rejected. Sign
`signingPayloadHash` directly.

### 2.2 The KYC address wrapper is `address`, not `addressDetails`

The documented step-2 payload is rejected outright:

```json
{ "addressDetails": { "street": "...", "city": "...", "countryCode": "NGA" } }
→ 400 { "message": ["property addressDetails should not exist"] }
```

The working shape is a single `address` object with different field names:

```json
{
  "personalInfo": { "firstName": "Bunch", "lastName": "Dillon",
                    "dateOfBirth": "1990-01-15", "gender": "male" },
  "address": { "streetLine1": "121 Paul Gas Avenue", "city": "Lagos",
               "state": "Lagos", "postalCode": "100001", "countryCode": "NGA" }
}
```

`PATCH .../kyc` returns `canActivate` and a `missing[]` array naming what is
still required — use it rather than guessing.

### 2.3 `kyc/activate` needs an undocumented `sumsubLevelName`

Called with no body it returns `400`, listing the accepted values. The valid set
observed was `id-only`, `id-and-liveness`, `idv-and-phone-verification`,
`bmoni-monerium`. The documentation does not mention this parameter.

## 3. Sandbox personas

Only **Bunch Dillon** works reliably. Use that persona for all sandbox testing.

| Persona | BVN | Behaviour |
|---------|-----|-----------|
| **Bunch Dillon** | `95888168924` | Works fully. `bvn-lookup` returns a record; rail activates; a dedicated NGN virtual account is issued. |
| Samson Jabo | `22222222222` | **Broken on this host.** `bvn-lookup` returns `404 E501` ("We couldn't find this BVN"), the rail never leaves `not_started`, KYC stays `not_started`, and no dedicated account is issued. |

The documentation states `22222222222` "is a real sandbox test BVN" that "always
verifies successfully". That is not true on this host.

Also note:

- The persona phone `+2348000000000` is **already taken** by an existing sandbox
  user, so `POST /v1/users` returns `409 User already exists with this
  phoneNumber`. Use a unique phone number for new users.
- `bvn-lookup` for Bunch returns an **empty `nin`**, although the docs list
  `63184876213`. A `nin-lookup` for that value returns `404`.
- A look-up miss returns `404 E501` with a friendly message about dialling
  `*565*0#`, not the `requested item could not be found` wording the docs quote.

## 4. The `kyc/documents/*` endpoints return 500

All three upload endpoints fail with `500 Internal server error`:

```
POST /v1/users/{id}/kyc/documents/identification
POST /v1/users/{id}/kyc/documents/proof-of-address
POST /v1/users/{id}/kyc/documents/biometric
```

This is consistent across every combination tried — field name (`file`,
`document`, `image`), content type (PNG, JPEG), synthetic and real images, with
and without the documented `type` / `documentNumber` / `issuingCountry` fields.
A malformed upload should be `400`, so this looks like a server-side fault.
Worth reporting to `developers@bkey.me`.

**This does not affect REACH.** REACH never calls these endpoints, nor
`kyc/activate`, `kyc/readiness`, `bvn-lookup` or `nin-lookup`. Those paths belong
to the Global KYC flow (USD/EUR), which REACH does not use. The Nigerian flow
provisions the rail from the verified BVN and needs no document uploads.

## 5. Operational gotchas

**Rail provisioning is asynchronous.** `start-nigeria` returns immediately with
`hasBvn: true`, but `anchorStatus` is still `not_started`. It flips to `active`
roughly 30 seconds later, and only then does the dedicated NGN virtual account
appear in `deposit-accounts/NGN` (before that, only the shared pooled account is
listed). Poll `GET .../onboarding/status` until `anchorStatus == "active"` before
reading deposit accounts.

**`hasBvn: true` does not mean the BVN resolved.** It is returned even for the
broken Samson persona, whose BVN look-up 404s. Confirm with
`GET .../kyc/bvn-lookup/{bvn}` first; if that misses, onboarding will appear to
succeed but nothing downstream will provision.

**Cloudflare blocks the default Python user-agent.** Requests using the stock
`Python-urllib` UA are rejected with `403` and Cloudflare error 1010
(`browser_signature_banned`). Set an ordinary `user-agent` header. `curl` is
unaffected.

## 6. Security: the shared sandbox key is not tenant-scoped

The shared key can read across the whole sandbox partner:

- `GET /v1/users` returns **941 users**, including other teams' names, email
  addresses and phone numbers.
- `GET /v1/webhooks/config` returns the partner's `secretKey` in plaintext.

Anything created with this key is visible to everyone else using it, and the
demo webhook secret is readable by anyone holding the key. Treat all sandbox
data as public. Do not put real personal data in the sandbox, and do not reuse
the demo webhook secret for anything beyond local testing. Obtain a per-partner
key before any production work.

## 7. Webhook contract (verified)

REACH's verification in `index.ts` matches BMONI's real contract:

| Item | Value |
|------|-------|
| Signature header | `X-Webhook-Signature` |
| Algorithm | `hex(HMAC-SHA256(secretKey, rawBody))` |
| Event id | `body.id` (also sent as `X-Webhook-Id`) |
| Body shape | `{ id, eventType, payload, timestamp }` |

Confirmed with the live sandbox secret: a correctly-signed body verifies, while a
tampered body and a wrong secret both fail. The Edge Function also tolerates a
legacy `sha256=` prefix and the older `x-bmoni-*` headers.

## 8. Related

- [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md) §7 — the BMONI wiring steps
- [BMONI_INSTITUTION_BILLING.md](./BMONI_INSTITUTION_BILLING.md) — billing model
- [BMONI_DEPLOYMENT.md](./BMONI_DEPLOYMENT.md) — deployment checklist
