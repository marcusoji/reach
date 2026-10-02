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

Standard OpenAI response shape (`choices[0].message.content`, `usage`). Access was observed
against two keys, which gave different results — the second key had been topped up:

| Model | Key A (`…p2JU`) | Key B (`…5df0`) |
|-------|-----------------|-----------------|
| `helix-advisor` | 200, working | 200, working |
| `helix-autopilot` | 200, credit exhausted | **200, working** (agentic) |
| `helix/swe-v1` | 200, credit exhausted | **200, working** (agentic) |
| `helix/devops-v1` | 200, credit exhausted | **200, working** (agentic) |
| `helix-operator` | 403, scope | **403, scope** |

`helix-operator` was scope-blocked on both keys. `helix_` keys are **not** accepted on the
account host — `launchverse.app/api/v1/me` returns 401 for them.

### 2.1 The models are agentic, and answer a classification task as a work report

This is the most important property to understand before choosing a model. `helix-autopilot`,
`helix/swe-v1` and `helix/devops-v1` are **software-engineering agents**. Given the REACH
classification prompt they return the correct JSON object — and then keep going, appending
an agent work report to the same completion:

```
{"category":"fire","confidence":95}

## Delivery
- **Changed:** no repository changes
- **Verified:** no automated checks were run in this run
- **Uncertain:** nothing flagged
```

The JSON is correct and comes **first**, so `JSON.parse` on the whole string throws and
`modelAssist` discards a perfectly good assessment. `helix/swe-v1` instead appends
*"I've hit my turn limit mid-task…"*. Only `helix-advisor` returns a bare JSON object with
zero trailing content.

**Recommendation: use `helix-advisor` for this role.** If an agentic model is ever wanted,
the adapter must extract the leading JSON object (see §3.6) rather than parsing the whole
completion.

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
path and increments the circuit breaker. After five such calls the breaker opens and the
model column silently loses its second opinion.

Note that this degradation is **not surfaced**: the `/status` health check reports the AI
provider from environment variables alone (`'Configured'` / `'Not configured'`), so it keeps
saying `Configured` while every call is failing. A breaker-aware health check would be a
worthwhile follow-up.

Naming REACH in the system prompt is what triggers it. A neutral prompt that describes the
output format without claiming an identity works (see §4).

### 3.2 Quota exhaustion is reported inconsistently

Exhausted **credit** returns **HTTP 200** with the completion text
`"Helix credit balance exhausted. Top up to continue."` No error status, no error code.

Exhausted **daily query allowance** is different — and inconsistent with the above: it
returns **429** with `"Daily Helix query limit reached (20/day on Free Helix access).
Resets at 00:00 UTC."`, carrying the same `insufficient_quota` code as a model-scope
failure (§3.3).

The Free-tier ceiling is therefore **20 Helix queries per day**, resetting at 00:00 UTC.
Two different exhaustion conditions are reported in two different ways, and the error code
is shared with a permissions failure.

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

### 3.6 Output is not deterministic even at `temperature: 0`

Two identical weak-evidence requests to `helix-advisor` with `temperature: 0` returned
different things:

- First: the expected bare JSON — `{"category":"other","confidence":15,"rationale":"…"}`
- Second: prose — *"The classification is complete — the evidence was too weak…"*

So even the recommended model is not reliably JSON-only. `response_format: json_object` does
not prevent this (§3.4). For REACH this means the second opinion is inherently intermittent:
the engine's own result stands and the model column sometimes reads `none`. That is a safe
degradation, but it should not be presented as a guaranteed feature.

### 3.7 Recommended hardening: extract the leading JSON object

Because correct JSON arrives **first** and any trailing text is model commentary, the adapter
should tolerate trailing content instead of discarding a valid assessment:

```ts
// Take the leading {...} block: scan to the matching close brace, then parse that slice.
const start = raw.indexOf('{');
let depth = 0, end = -1;
for (let i = start; i >= 0 && i < raw.length; i++) {
  if (raw[i] === '{') depth++;
  else if (raw[i] === '}' && --depth === 0) { end = i + 1; break; }
}
const obj = end > 0 ? JSON.parse(raw.slice(start, end)) : null;
```

Rejected alternative: keeping strict `JSON.parse` and accepting the lost assessments. It is
the conservative choice, but it throws away a correct `category`/`confidence` on every
agentic model and on roughly half of `helix-advisor` calls. A tolerant parse is safe here
because the engine independently validates the result — `CATEGORIES.includes(obj.category)`
and a finite numeric `confidence` are still enforced afterwards, and the engine decides
regardless of what the model says.

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

End-to-end, the corrected prompt was verified against the live endpoint: strong fire
evidence → `fire`/88, empty evidence → `other`/10 with a rationale explaining that there
was nothing to classify.

Across the four reachable models, on identical strong-fire input, every model that returned
JSON agreed on the verdict — `helix-advisor` 90–92, `helix-autopilot` 86, `helix/swe-v1` 85,
`helix/devops-v1` 85. The classifications are consistent; only the *wrapping* differs
(§2.1) and, for `helix-advisor`, only the occasional prose turn (§3.6). Expect the model
column to be populated on roughly half of calls, not every call.

### 4.1 The 20/day ceiling constrains a demo

The Free tier allows **20 Helix queries per day**, resetting at 00:00 UTC. This is a
**team-level** limit, not a per-key one — a second `helix_` key does not add headroom.
Every incident assessment that reaches the provider costs one query, so a demo that
classifies more than 20 incidents in a day will start seeing 429s. REACH degrades safely
when that happens — the breaker opens and the deterministic engine keeps producing
assessments with `model_agreement: 'none'` — but the model column will stop lighting up
mid-demo.

Mitigations, in order of preference:

1. Set `REACH_AI_BREAKER_THRESHOLD` low (e.g. 3) so a demo degrades predictably rather than
   after 5 failures.
2. Spend queries deliberately — rehearse the exact incidents that will be shown, and prefer
   pre-recorded evidence over live random classification.
3. If a larger allowance is needed, check whether the Launchverse plan can be raised; the
   20/day figure is a Free-tier limit, not an API limit.

## 5. Conclusion

- Launchverse inference **does** work, via `helix_…` on `api.launchverse.app`, and
  `helix-advisor` is capable of the classification task.
- REACH's **old** `modelAssist` system prompt was incompatible with Helix and failed
  silently. It has been replaced with a neutral, JSON-only prompt (`MODEL_SYSTEM_PROMPT` in
  `ai_provider.ts`), and `ai-engine.mjs` section G now pins both the prompt contract and the
  rejection of prose-as-200.
- **Use `helix-advisor`.** The agentic models (`helix-autopilot`, `helix/swe-v1`,
  `helix/devops-v1`) return correct JSON followed by an agent work report, which the current
  strict parse rejects; `helix-operator` is scope-blocked on both keys tested.
- The second opinion is **intermittent by nature**: `response_format` is not enforced and
  even `helix-advisor` occasionally answers in prose. Expect `model_agreement: 'none'` on a
  meaningful share of calls, not an exception. Hardening the parse (§3.7) would raise the hit
  rate but cannot make it certain.
- Runtime AI for REACH remains the deterministic engine in `ai_engine.ts`. The external
  model is an optional second opinion and the engine abstains safely without it.

## 6. Wiring Launchverse as `REACH_AI_ENDPOINT`

If the second opinion is wanted at runtime, the configuration is:

```
REACH_AI_ENDPOINT=https://api.launchverse.app/api/v1/chat/completions
REACH_AI_API_KEY=<helix_ key>          # server-side secret only
REACH_AI_MODEL=helix-advisor
REACH_AI_BREAKER_THRESHOLD=3           # optional; fail over sooner than the default 5
```

These are Edge Function secrets (`Deno.env`), never `VITE_` variables. The engine continues
to decide; the model only contributes a second opinion and can never force a `recommend`.

## 7. How the second opinion is surfaced in REACH

The assessment endpoint (`POST /ai/assess`) is called from the operator's **All Incidents**
page, one incident at a time, via the "Run AI assessment" button. It is a deliberate
operator action rather than an automatic side effect of loading an incident, because each
call can spend one of the 20 daily Helix queries.

The engine's verdict and the model's contribution are then readable on the operator's
**AI Performance** page, which shows per assessment:

- the fused verdict (`category`, `confidence`, `decision`) and its `fp_code`
- a badge for the second opinion: *Model agrees* / *Model disagrees* / *No second opinion*
- the model's own `category`, `confidence` and `evidence_labels` when one was used
- the abstention blockers, when the engine abstained

That view is backed by `ai_assessments.metadata` (migration `0014_ai_second_opinion.sql`),
which persists the fusion signals the API already computed. Before that column existed,
`model_agreement` reached only the audit log and could not be queried back out, so the
model's contribution was invisible.

Note the two headline figures on that page: **Second opinion obtained** is the share of
assessments where the model returned usable JSON at all — expect this to be well under
100% given §3.6 — and **Model agreement** is computed only over those, not over all
assessments.

### 7.1 Why a second opinion was missing

"Model unavailable" used to be undiagnosable. The adapter's failure state lived only in
memory, and `/system/health` reported the AI as `Configured` purely from the presence of
env vars — so a provider that had been answering in prose, or whose circuit breaker had
opened, still looked healthy.

Two changes fix that:

- **`ai_provider_events`** (migration `0016`) records every `/ai/assess` provider attempt
  with an `outcome`, a classified `failure_kind` and a capped `detail`. `GET
  /ai/provider-events` returns the last 50, and the AI Performance page renders them as a
  "Second-opinion provider" panel, translating each kind into plain language.
- **`/system/health`** now reports the real breaker state — `Healthy`, `Degraded` (last call
  failed) or `Circuit open` — plus the consecutive-failure count and the last failure, rather
  than the string `Configured`.

The `failure_kind` values and what they mean:

| kind | meaning |
| --- | --- |
| `unconfigured` | No `REACH_AI_ENDPOINT` / `REACH_AI_API_KEY` / `REACH_AI_MODEL` on the server. |
| `breaker_open` | Circuit open after consecutive failures; the provider is skipped entirely. |
| `http_error` | The provider returned a non-2xx status. |
| `network_error` | The provider could not be reached, or the call timed out. |
| `unparsable_response` | The provider answered with prose and no JSON object. |
| `invalid_payload` | The provider returned JSON with an unusable `category` or `confidence`. |

### 7.2 Tolerant parse

The strict `JSON.parse` discarded valid assessments from the agentic Helix models, which
emit the JSON object and then keep talking (§3.6). The adapter now extracts the first
*balanced* JSON object (`extractLeadingJson`), so a completion of the form

```
Here is the assessment:
{"category":"fire","confidence":88,"rationale":"smoke","evidence_labels":["smoke"]}

## Delivery
...
```

yields a usable second opinion. A truncated object (no balanced close) and prose containing
no object at all are still rejected — with `unparsable_response`, not silently.

## 8. Follow-ups for Launchverse

1. Return a non-2xx status when credit is exhausted, instead of 200 plus prose.
2. Use a permissions error code for a model-scope failure, not `insufficient_quota`.
3. Either enforce `response_format: json_object` or reject it.
4. Document that `helix_` keys target `api.launchverse.app` and `lvse_` keys target
   `launchverse.app`.
5. Document how the agent's identity lock interacts with third-party system prompts.
