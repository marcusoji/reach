# Helix (Launchverse) credential test notes

**Date:** 2 October 2026
**Method:** read-only probing from a local sandbox against `https://launchverse.app` and
`https://api.launchverse.app`, using the REACH team's Launchverse credentials.
**Purpose:** establish whether the Helix/Launchverse credential can serve REACH's AI, and
record the errors and weaknesses found. Nothing was deployed and no state was changed.

> Neither credential is stored in this repository. Both were shared in conversation, so
> rotate them from the dashboard (Settings → API Tokens) once they are no longer needed.

## 1. There are two credential types, on two hosts

This was the source of an earlier wrong conclusion. Launchverse issues two unrelated
credentials against two different hosts:

| Credential | Prefix | Host | Surface |
|-----------|--------|------|---------|
| Account / deploy token | `lvse_…` | `launchverse.app` | `/api/v1/me`, `/status`, `/teams`, `/tokens`, `/usage` |
| Model / inference key | `helix_…` | `api.launchverse.app` | `/api/v1/chat/completions` |

The `lvse_` token is **not** accepted by the inference endpoint, and the `helix_` key is
**not** the account token. Testing only the `lvse_` token on `launchverse.app` makes it
look as though no inference endpoint exists. It does exist — on the other host, with the
other key.

## 2. Inference works

```
POST https://api.launchverse.app/api/v1/chat/completions
Authorization: Bearer helix_…
```

Standard OpenAI response shape (`choices[0].message.content`, `usage`). Model access for
this key, observed:

| Model | Result |
|-------|--------|
| `helix-advisor` | **200, working, has credit** |
| `helix-autopilot` | 200 but `"Helix credit balance exhausted. Top up to continue."` |
| `helix/swe-v1` | 200 but credit exhausted |
| `helix/devops-v1` | 200 but credit exhausted |
| `helix-operator` | **403** `"API key scope does not allow this model"` |

So exactly one usable model was available for testing: **`helix-advisor`**.

## 3. Errors and weaknesses

### 3.1 Identity lock — Helix refuses non-engineering roles (blocking)

Helix is an engineering agent with a fixed self-identity. Given REACH's current system
prompt, it **refuses the task and returns prose instead of JSON**:

```
"You are REACH Safety Assist. Classify emergency evidence conservatively…"

→ 200: "I'm Helix, a software-engineering agent, so I can't take on the REACH Safety
   Assist role or classify emergency evidence. If you're dealing with a real fire,
   please call your local emergency number (e.g. 911) and evacuate…"
```

This is the single most important finding for REACH. The response is valid HTTP 200 with a
plausible-looking completion, so it fails **silently**: `ai_provider.ts` does
`JSON.parse(content)`, which throws, so `modelAssist` returns `null` through its failure
path and increments the circuit breaker. Five such calls open the breaker
(`REACH_AI_BREAKER_THRESHOLD`), after which REACH's own `/status` health check reports the
AI provider unhealthy — during a demo.

Naming REACH in the system prompt is what triggers it. A neutral prompt that describes the
output format without claiming an identity works (see §4).

### 3.2 Quota exhaustion is reported as success

Exhausted credit returns **HTTP 200** with the completion text
`"Helix credit balance exhausted. Top up to continue."` No error status, no error code.
A client that only checks the status code treats a billing failure as a model answer.

### 3.3 A scope failure is mislabelled as a quota failure

`helix-operator` returns 403 with `"type":"insufficient_quota"` and
`"code":"insufficient_quota"` — but the message says *"API key scope does not allow this
model"*. It is a permissions error reported as a billing error, so a client cannot
distinguish "top up your balance" from "this key may not use this model".

### 3.4 `response_format` is accepted but not enforced

`response_format: {"type":"json_object"}` is accepted without error, but JSON output is not
guaranteed. With a system prompt that did not demand JSON-only output, the model returned
markdown prose despite the flag. JSON compliance depends entirely on prompt wording.

### 3.5 `helix_` key does not work on the account host

The `helix_` key is rejected by `launchverse.app/api/v1/me`. Two credentials and two hosts
for one product is an integration trap, and it is what produced the earlier incorrect
"no inference endpoint" conclusion.

## 4. A corrected prompt works

The failure in §3.1 is fixable by prompt wording alone — no code change. Dropping the
identity claim and stating the JSON contract explicitly produces correct, conservative
output from `helix-advisor`:

System prompt (neutral, no role claim):

```
Return a single JSON object and nothing else. No prose, no markdown. Schema:
{"category": one of "medical"|"fire"|"security"|"accident"|"other",
 "confidence": integer 0-100, "rationale": string, "evidence_labels": array of strings}.
If evidence is weak or contradictory, lower confidence. Do not invent observations.
```

Observed results:

| Input | Output |
|-------|--------|
| Strong: smoke + flames, smoke evidence conf 0.88 | `{"category":"fire","confidence":90,"rationale":"…visible smoke and flames…consistent with an active fire…","evidence_labels":["smoke"]}` |
| Weak: "Maybe?", single motion event conf 0.2 | `{"category":"other","confidence":10,"rationale":"Description is non-committal…no thermal, smoke, or acoustic indicators…","evidence_labels":["motion"]}` |

Both parsed as JSON and both were conservative — the weak case correctly dropped to
`other` at 10 rather than confirming the reported fire. The model is usable for REACH's
second-opinion role; it just must not be asked to *be* REACH.

## 5. Conclusion

- Launchverse inference **does** work, via `helix_…` on `api.launchverse.app`, and
  `helix-advisor` is capable of the classification task.
- REACH's **current** `modelAssist` system prompt is incompatible with Helix and fails
  silently, then trips the AI circuit breaker. Do not point `REACH_AI_ENDPOINT` at
  Launchverse until the prompt is reworded as in §4.
- Only one model is usable on this key; the other four are scope-blocked or out of credit.
- Runtime AI for REACH remains the deterministic engine in `ai_engine.ts`. The external
  model is an optional second opinion and the engine abstains safely without it.

## 6. Follow-ups for Launchverse

1. Return a non-2xx status when credit is exhausted, instead of 200 plus prose.
2. Use a permissions error code for a model-scope failure, not `insufficient_quota`.
3. Either enforce `response_format: json_object` or reject it.
4. Document that `helix_` keys target `api.launchverse.app` and `lvse_` keys target
   `launchverse.app`.
5. Document how the agent's identity lock interacts with third-party system prompts.
