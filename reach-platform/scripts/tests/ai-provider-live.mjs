// Drives the real ai_provider.ts against a local HTTP stub that reproduces the exact Helix
// behaviours recorded in docs/HELIX_API_TEST_NOTES.md, so the adapter's handling of a live
// provider is exercised as real code rather than asserted from a mock of the adapter itself.
//
// Run: deno run --allow-net --allow-env scripts/tests/ai-provider-live.mjs
const here = new URL('.', import.meta.url).pathname;
const providerPath = new URL('../../supabase/functions/api/ai_provider.ts', import.meta.url).href;

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) failures++;
};

// A stub that answers exactly like Helix did on the wire.
function startStub(handler) {
  return Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, handler);
}

async function withStub(handler, fn) {
  const server = startStub(handler);
  const { port } = server.addr;
  const prevEndpoint = Deno.env.get('REACH_AI_ENDPOINT');
  const prevKey = Deno.env.get('REACH_AI_API_KEY');
  const prevModel = Deno.env.get('REACH_AI_MODEL');
  Deno.env.set('REACH_AI_ENDPOINT', `http://127.0.0.1:${port}/api/v1/chat/completions`);
  Deno.env.set('REACH_AI_API_KEY', 'helix_test_key');
  Deno.env.set('REACH_AI_MODEL', 'helix-advisor');
  try {
    return await fn(port);
  } finally {
    await server.shutdown();
    const restore = (k, v) => v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    restore('REACH_AI_ENDPOINT', prevEndpoint);
    restore('REACH_AI_API_KEY', prevKey);
    restore('REACH_AI_MODEL', prevModel);
  }
}

const completion = (content) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });

console.log('=== Helix provider adapter against a live-shaped stub ===');

// Import once; the module reads env per call, so the stub URL set in withStub is picked up.
const { modelAssist, aiLastFailureKind, aiLastFailure, resetAiCircuit, MODEL_SYSTEM_PROMPT } = await import(providerPath);

// 1. A bare JSON completion (helix-advisor's good path) is used.
await withStub(() => completion('{"category":"fire","confidence":90,"rationale":"visible smoke and flames","evidence_labels":["smoke"]}'), async () => {
  resetAiCircuit();
  const r = await modelAssist({ category: 'fire', description: 'smoke and flames', evidence: [] });
  check('bare JSON from the provider is parsed', r?.category === 'fire' && r?.confidence === 90, `got ${r?.category}/${r?.confidence}`);
});

// 2. An agentic model returns correct JSON then keeps talking (helix-autopilot/swe-v1 shape).
await withStub(() => completion('{"category":"medical","confidence":72,"rationale":"collapse","evidence_labels":["motion"]}\n\n## Delivery\n- **Changed:** no repository changes\n- **Verified:** none'), async () => {
  resetAiCircuit();
  const r = await modelAssist({ category: 'medical', description: 'person collapsed', evidence: [] });
  check('agentic JSON + trailing work report still yields an assessment', r?.category === 'medical' && r?.confidence === 72, `got ${r?.category}/${r?.confidence}`);
});

// 3. A refusal served as HTTP 200 prose must be classified, not silently swallowed.
await withStub(() => completion("I'm Helix, a software-engineering agent, so I can't take on the REACH Safety Assist role."), async () => {
  resetAiCircuit();
  const r = await modelAssist({ category: 'fire', description: 'x', evidence: [] });
  check('prose served as 200 is rejected', r === null);
  check('prose served as 200 is classified unparsable_response', aiLastFailureKind() === 'unparsable_response', aiLastFailureKind() ?? 'null');
});

// 4. Credit exhaustion is also HTTP 200 + prose (a distinct live behaviour).
await withStub(() => completion('Helix credit balance exhausted. Top up to continue.'), async () => {
  resetAiCircuit();
  const r = await modelAssist({ category: 'fire', description: 'x', evidence: [] });
  check('credit-exhausted prose is rejected', r === null);
  check('credit exhaustion is diagnosable from the recorded detail', /credit balance exhausted/i.test(aiLastFailure()), aiLastFailure().slice(0, 60));
});

// 5. A non-2xx status is an http_error.
await withStub(() => new Response('{"error":"nope"}', { status: 500 }), async () => {
  resetAiCircuit();
  const r = await modelAssist({ category: 'fire', description: 'x', evidence: [] });
  check('HTTP 500 yields no assessment', r === null);
  check('HTTP 500 is classified http_error', aiLastFailureKind() === 'http_error', aiLastFailureKind() ?? 'null');
});

// 6. The daily-limit 429 must also be http_error, not a parse failure.
await withStub(() => new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 }), async () => {
  resetAiCircuit();
  const r = await modelAssist({ category: 'fire', description: 'x', evidence: [] });
  check('HTTP 429 (daily limit) yields no assessment', r === null);
  check('HTTP 429 is classified http_error', aiLastFailureKind() === 'http_error', aiLastFailureKind() ?? 'null');
});

// 7. An unreachable endpoint is a network_error, and must not hang past the timeout.
await withStub(() => new Response('', { status: 200 }), async () => {
  resetAiCircuit();
  const prev = Deno.env.get('REACH_AI_ENDPOINT');
  Deno.env.set('REACH_AI_ENDPOINT', 'http://127.0.0.1:1/api/v1/chat/completions');
  const r = await modelAssist({ category: 'fire', description: 'x', evidence: [] });
  Deno.env.set('REACH_AI_ENDPOINT', prev);
  check('an unreachable provider yields no assessment', r === null);
  check('an unreachable provider is classified network_error', aiLastFailureKind() === 'network_error', aiLastFailureKind() ?? 'null');
});

// 8. JSON with an unusable category is an invalid_payload.
await withStub(() => completion('{"category":"alien","confidence":50}'), async () => {
  resetAiCircuit();
  const r = await modelAssist({ category: 'fire', description: 'x', evidence: [] });
  check('an out-of-vocabulary category is rejected', r === null);
  check('an out-of-vocabulary category is classified invalid_payload', aiLastFailureKind() === 'invalid_payload', aiLastFailureKind() ?? 'null');
});

// 9. The prompt must not claim an identity Helix would refuse.
check('the system prompt does not claim a REACH identity', !/you are reach|safety assist/i.test(MODEL_SYSTEM_PROMPT));
check('the system prompt states the JSON-only contract', /single JSON object and nothing else/i.test(MODEL_SYSTEM_PROMPT));

console.log(`\n${failures ? `${failures} check(s) FAILED` : 'All provider checks passed'}`);
if (failures) Deno.exit(1);
