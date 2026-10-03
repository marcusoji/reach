// Drives the real bmoni.ts client against a local HTTPS stub that reproduces the sandbox
// request shapes recorded in docs/BMONI_INTEGRATION_NOTES.md (paths, x-api-key auth, the
// signingPayloadHash field name, and error shapes). The client only talks to an https base URL,
// so the stub is served over TLS. This exercises the actual Edge Function module, so a
// regression in the payment-proposal request chain is caught without a sandbox key.
//
// Run: deno run --allow-net --allow-env --allow-read scripts/tests/bmoni-client-live.mjs
const providerPath = new URL('../../supabase/functions/api/bmoni.ts', import.meta.url).href;

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) failures++;
};

const certPath = Deno.env.get('REACH_TEST_TLS_CHAIN');
const keyPath = Deno.env.get('REACH_TEST_TLS_KEY');
if (!certPath || !keyPath) {
  console.log('SKIP - BMONI client test: REACH_TEST_TLS_CHAIN/REACH_TEST_TLS_KEY not set.');
  Deno.exit(0);
}
const cert = await Deno.readTextFile(certPath);
const key = await Deno.readTextFile(keyPath);
const seen = [];
const server = Deno.serve({
  port: 18443, hostname: '127.0.0.1', cert, key, onListen: () => {},
}, async (req) => {
  const url = new URL(req.url);
  const body = await req.text();
  seen.push({ method: req.method, path: url.pathname, apiKey: req.headers.get('x-api-key'), body });
  if (url.pathname.endsWith('/proposals')) return Response.json({ proposalId: 'prop_sbx_9', status: 'pending' });
  if (url.pathname.endsWith('/approve')) return Response.json({ ok: true });
  // BMONI returns the digest as signingPayloadHash; the other documented names are unused.
  if (url.pathname.endsWith('/sign-payload')) return Response.json({ signingPayloadHash: '0x' + 'ab'.repeat(32) });
  if (url.pathname.endsWith('/sign')) return Response.json({ ok: true, txHash: '0xdeadbeef' });
  if (url.pathname.includes('/boom')) return Response.json({ message: 'insufficient balance' }, { status: 400 });
  return Response.json({ ok: true });
});

Deno.env.set('BMONI_BASE_URL', 'https://127.0.0.1:18443');
Deno.env.set('BMONI_API_KEY', 'sandbox_test_key');
const { bmoni, bmoniConfigured } = await import(providerPath);

console.log('=== BMONI client against a live-shaped HTTPS sandbox stub ===');

check('bmoniConfigured() is true for an https base URL with a key', bmoniConfigured() === true, String(bmoniConfigured()));

// The exact proposal the Edge Function sends for an institutional subscription.
const proposal = { proposal: { type: 'TRANSFER', toAddress: '0xTreasury', amount: '1450000', currency: 'CNGN', description: 'REACH institutional subscription' } };
const created = await bmoni.createProposal('user_1', 'wallet_1', proposal);
check('createProposal returns the proposal id', created?.proposalId === 'prop_sbx_9', created?.proposalId);
const p1 = seen.at(-1);
check('createProposal hits /v1/users/{u}/smart-wallets/{w}/proposals', p1.path === '/v1/users/user_1/smart-wallets/wallet_1/proposals', p1.path);
check('createProposal is a POST carrying the x-api-key header', p1.method === 'POST' && p1.apiKey === 'sandbox_test_key', `${p1.method} key=${p1.apiKey}`);
check('createProposal sends the TRANSFER/CNGN body verbatim', JSON.parse(p1.body).proposal.type === 'TRANSFER' && JSON.parse(p1.body).proposal.currency === 'CNGN');

await bmoni.approveProposal('user_1', 'prop_sbx_9');
const p2 = seen.at(-1);
check('approveProposal hits .../proposals/{id}/approve as POST', p2.method === 'POST' && p2.path === '/v1/users/user_1/smart-wallets/proposals/prop_sbx_9/approve', `${p2.method} ${p2.path}`);

const sign = await bmoni.proposalSignPayload('user_1', 'prop_sbx_9');
const p3 = seen.at(-1);
check('proposalSignPayload hits .../sign-payload as GET', p3.method === 'GET' && p3.path === '/v1/users/user_1/smart-wallets/proposals/prop_sbx_9/sign-payload', `${p3.method} ${p3.path}`);
check('the signingPayloadHash field survives the adapter', typeof sign?.signingPayloadHash === 'string' && sign.signingPayloadHash.startsWith('0x'), sign?.signingPayloadHash?.slice(0, 12));

await bmoni.signProposal('user_1', 'prop_sbx_9', '0x' + 'cd'.repeat(65));
const p4 = seen.at(-1);
check('signProposal posts the signature to .../sign', p4.method === 'POST' && p4.path.endsWith('/sign') && JSON.parse(p4.body).signature.startsWith('0x'), p4.path);

// A provider 4xx must surface its status and message for the failure_reason column.
let err = null;
try { await bmoni.onboardingStatus('boom'); } catch (e) { err = e; }
check('a provider 4xx throws with the status attached', err?.status === 400, String(err?.status));
check('a provider 4xx message includes the provider text', /insufficient balance/.test(err?.message || ''), err?.message);

await server.shutdown();

// A non-https base URL must fail closed before any request goes out.
Deno.env.set('BMONI_BASE_URL', 'http://127.0.0.1:18443');
const insecure = await import(providerPath + '?insecure');
check('bmoniConfigured() is false for a non-https base URL', insecure.bmoniConfigured() === false, String(insecure.bmoniConfigured()));
let failClosed = false;
try { await insecure.bmoni.createUser({ firstName: 'A', lastName: 'B', email: 'a@b.c', phoneNumber: '+2348000000001' }); }
catch (e) { failClosed = /not configured/i.test(e.message); }
check('a non-https base URL fails closed before any request', failClosed);

// An unreachable host must be reported as unreachable, not hang.
Deno.env.set('BMONI_BASE_URL', 'https://127.0.0.1:18444');
const unreachable = await import(providerPath + '?unreachable');
let networkMsg = '';
try { await unreachable.bmoni.onboardingStatus('user_1'); } catch (e) { networkMsg = e.message; }
check('an unreachable provider reports "Unable to reach BMONI"', /Unable to reach BMONI/.test(networkMsg), networkMsg);

console.log(`\n${failures ? `${failures} check(s) FAILED` : 'All BMONI client checks passed'}`);
if (failures) Deno.exit(1);
