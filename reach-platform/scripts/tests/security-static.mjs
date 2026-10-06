#!/usr/bin/env node
/** Static security gates for REACH — fail CI on obvious regressions. */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fails = [];
const pass = [];

function read(rel) {
  const p = join(root, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

const api = read('supabase/functions/api/index.ts') || '';
const reachApi = read('src/lib/reachApi.ts') || '';
const envEx = read('.env.example') || '';
const vercel = read('vercel.json') || '';
const auth = read('src/context/AuthContext.tsx') || '';
const deploy = read('../.github/workflows/deploy-supabase.yml') || '';

function check(name, cond) {
  if (cond) pass.push(name); else fails.push(name);
}

check('No wildcard CORS by default', !/allowedOrigins\[0\] === '\*'/.test(api) || /REACH_ALLOW_STAR_CORS/.test(api));
// The allow-list is matched through a single-label wildcard matcher, so a preview/tunnel host can
// be allowed without reflecting an arbitrary origin; a regression to plain `includes` silently
// breaks those origins (the browser then reports "Failed to fetch").
check('CORS origin matcher supports exact + single-label wildcard', /function originMatches/.test(api) && /some\(entry => originMatches/.test(api));
check('Operator invitations exist', api.includes('/operator/invitations'));
check('Bootstrap key blocked after first operator', api.includes('zero operators') || api.includes('first operator'));
check('Webhook official signature header', /x-webhook-signature/i.test(api));
check('Rate limit uses IP+user', api.includes('x-forwarded-for') || api.includes('clientIp'));
check('JSON body size limit', api.includes('MAX_JSON_BODY') || api.includes('readJsonLimited'));
// The check above passes if ANY handler is bounded. In fact every JSON body must go through the
// size-limited reader; a single raw `req.json()` re-opens the unbounded-body hole for that route.
check('Every JSON body is read through the size-limited reader', !/req\.json\(\)/.test(api));
check('Demo mode explicit flag', reachApi.includes('VITE_REACH_DEMO_MODE'));
check('Session storage hardened', reachApi.includes('sessionStorage'));
check('CSP on Vercel', /Content-Security-Policy/i.test(vercel));
check('HSTS on Vercel', /Strict-Transport-Security/i.test(vercel));
check('No demo password in production path comment', !auth.includes('demo1234') || auth.includes('DEMO_USERS'));
check('BMONI HTTPS-only', /https:/.test(read('supabase/functions/api/bmoni.ts') || ''));
// The Helix/Launchverse key is a server-side secret. The deploy workflow is the only place the AI
// config is linked, so pin that it reads the REACH_AI_* repo secrets, links all three together, and
// never surfaces the key to the browser.
check('Deploy workflow links the AI provider from REACH_AI_* secrets',
  /REACH_AI_ENDPOINT/.test(deploy) && /REACH_AI_API_KEY/.test(deploy) && /REACH_AI_MODEL/.test(deploy));
check('Deploy workflow links the AI secrets as a set (no partial config)',
  /if \[ -z "\$\{AI_ENDPOINT:-\}" \] \|\| \[ -z "\$\{AI_KEY:-\}" \] \|\| \[ -z "\$\{AI_MODEL:-\}" \]/.test(deploy));
check('AI provider key is never a VITE_ variable',
  !/VITE_[A-Z_]*AI/i.test(api) && !/VITE_[A-Z_]*AI/i.test(reachApi) && !/VITE_[A-Z_]*AI/i.test(envEx));

console.log('Security static checks');
pass.forEach(p => console.log('PASS -', p));
fails.forEach(f => console.log('FAIL -', f));
if (fails.length) {
  console.error(`\n${fails.length} failed`);
  process.exit(1);
}
console.log(`\nAll ${pass.length} checks passed`);
