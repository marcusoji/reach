# Helix (Launchverse) credential test notes

**Date:** 2 October 2026
**Method:** read-only probing from a local sandbox against `https://launchverse.app`
using the REACH team token (`lvse_…`, token id `da62b1e9-…`).
**Purpose:** establish whether the Helix/Launchverse credential can serve REACH, and record
the errors and weaknesses found. No state-changing call was made; nothing was deployed.

> The token is **not** stored in this repository and must not be committed. It has
> `read`/`write`/`deploy` scopes and was shared in conversation, so rotate it from the
> dashboard (Settings → API Tokens) once it is no longer needed.

## 1. What the credential is

`GET /api/v1/me` → `200`:

```json
{"team":{"id":"34dd7c71-…","name":"Marcus Oji's Team","plan_tier":"Free"},
 "scopes":["read","write","deploy"],"token_id":"da62b1e9-…"}
```

The token is valid. `lvse_` is a **Launchverse** per-team bearer token, and "Helix" is the
product family it fronts.

## 2. Endpoint matrix (observed)

| Call | Result | Notes |
|------|--------|-------|
| `GET /api/v1/me` | 200 | identity + scopes |
| `GET /api/v1/status` | 200 | `{"status":"ok","version":"1.0.0"}` |
| `GET /api/v1/teams` | 200 | one team, `Free` |
| `GET /api/v1/teams/{id}` | 200 | |
| `GET /api/v1/teams/{bogus-uuid}` | 404 | `{"error":"Team not found","code":"NOT_FOUND"}` |
| `GET /api/v1/teams/{not-a-uuid}` | 400 | zod field error for `id` |
| `GET /api/v1/tokens` | 200 | token metadata, `expires_at: null` |
| `GET /api/v1/usage` | 200 | **empty** `data` — no metrics populated |
| `GET /api/v1/models` | 200 | 5 model ids — **not in the published spec** |
| `POST /api/v1/chat/completions` | 401 | route exists (405 on GET), rejects our token |
| `GET /api/helix` (+ `/chat`, `/run`, `/agent`, …) | 401 | see §3.1 |
| `POST /api/v1/me` | 405 | **empty body** — see §3.3 |

Published spec: `GET /api/v1/openapi.json` lists exactly six operations
(`/me`, `/status`, `/teams`, `/teams/{id}`, `/tokens`, `/usage`). No inference operation.

## 3. Errors and weaknesses

### 3.1 Helix's agent surface is unreachable with this credential (blocking)

`/api/helix` and every `/api/helix/*` subpath return **401 for both a valid and an invalid
token**, with the generic body `{"error":"Unauthorized","code":"UNAUTHORIZED"}`. A valid
token therefore gives no signal about whether the failure is a route problem, a scope
problem, or a missing agent-specific key.

**Impact on REACH:** we could not exercise Helix at all — not the agent, not any model.
The credential authenticates the *account* API only.

### 3.2 No inference endpoint exists (blocking)

`/api/v1/models` advertises an OpenAI-shaped model list (`helix-advisor`, `helix-operator`,
`helix-autopilot`, `helix/swe-v1`, `helix/devops-v1`), but there is no completions route:
`/chat/completions`, `/completions`, `/responses`, `/invoke`, `/runs`, `/tasks` all 404.

This is a **misleading compatibility surface** — it looks OpenAI-compatible at the listing
step and then has nowhere to send a request.

**Impact on REACH:** Helix must not be wired to `REACH_AI_ENDPOINT`. Doing so 404s and trips
the AI circuit breaker, which would report the AI provider unhealthy on REACH's own
`/status` health check.

### 3.3 `405 Method Not Allowed` returns an empty body

`POST /api/v1/me` → `405` with no body, while every other failure path returns the
documented `{error, code}` envelope. A client cannot parse the reason.

### 3.4 CORS: wildcard origin combined with credentials

Authenticated responses carry:

```
access-control-allow-origin: *
access-control-allow-credentials: true
```

Per the Fetch spec this pair is invalid — browsers reject credentialed requests when the
origin is `*`. It is also over-permissive for an authenticated API.

### 3.5 `Cache-Control: public` on an authenticated response

`GET /api/v1/me` returns `cache-control: public, max-age=0, must-revalidate`. Marking a
per-user authenticated response `public` permits shared caches to store it.

### 3.6 `write` and `deploy` scopes have no reachable surface

The token grants `read`, `write` and `deploy`, but the published API exposes read-only
operations. The deploy path could not be tested at all, so its behaviour is unverified.

### 3.7 Usage metrics unpopulated

`GET /api/v1/usage` returns an empty list for a token that has been used, so consumption
cannot be observed from the API.

## 4. What held up

- **TLS enforced** — `http://` → `308` redirect to `https://`.
- **Token not accepted as a query parameter** — `?api_key=…` → `401`.
- **Auth is strict** — no token, bad token, wrong scheme (`Token` vs `Bearer`) and empty
  bearer all correctly `401`.
- **Error envelope consistent** for 401/400/404 (`{error, code}`), with `details` on
  validation failures.
- **Rate limiting is real** — `x-ratelimit-limit: 240`, remaining decrements per request,
  plus `x-request-id` on every response and `Deprecation`/`Sunset` headers advertised.
- **Versioning policy documented** — additive-only within a major, `/api/v2` for breaks.

## 5. Conclusion

The credential is a valid **Launchverse account/deploy token**. It cannot serve REACH's
runtime AI, and its agent surface was not reachable from this token, so no Helix
capability could be exercised end to end.

REACH's runtime AI stays where it is: the deterministic engine in `ai_engine.ts`, with the
optional external model behind `REACH_AI_ENDPOINT` (OpenAI-shaped only). The Helix token is
kept out of the Edge Function and out of every `VITE_` variable.

## 6. Follow-ups for Launchverse

1. Publish the `/api/helix/*` contract, or document the credential required to reach it.
2. Either add `/v1/chat/completions` or stop listing models in an OpenAI-compatible shape.
3. Return the standard error envelope on 405.
4. Replace `Access-Control-Allow-Origin: *` + credentials with an explicit origin allowlist.
5. Drop `public` from `Cache-Control` on authenticated responses.
