#!/usr/bin/env node
// Runs the Deno-based live-provider tests for the Edge Function modules (ai_provider.ts,
// bmoni.ts) against local stubs. Deno is not a build dependency of the app, so this wrapper
// skips cleanly where it is absent, and skips the TLS-dependent BMONI test when openssl cannot
// mint a throwaway certificate chain.
//
// The BMONI client refuses a non-https base URL, so its stub must be served over TLS. A leaf
// certificate signed by a throwaway CA is generated here; the CA is passed to Deno as the trust
// root for the run only.

import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const has = (cmd) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
if (!has('deno')) {
  console.log('SKIP - live provider tests: deno is not installed.');
  process.exit(0);
}

const runDeno = (script, args = [], env = {}) =>
  spawnSync('deno', ['run', '--allow-net', '--allow-env', '--allow-read', ...args, script], {
    encoding: 'utf8', env: { ...process.env, ...env }, stdio: 'inherit',
  });

const aiStatus = runDeno(join(here, 'ai-provider-live.mjs'));
if (aiStatus.status !== 0) process.exit(aiStatus.status ?? 1);

if (!has('openssl')) {
  console.log('SKIP - BMONI client test: openssl is not installed.');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'reach-tls-'));
const openssl = (args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
try {
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-nodes', '-subj', '/CN=REACH Test CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
  openssl(['req', '-newkey', 'rsa:2048', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-nodes', '-subj', '/CN=localhost']);
  writeFileSync(join(dir, 'leaf.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
  openssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.crt', '-days', '2', '-extfile', 'leaf.ext']);
  writeFileSync(join(dir, 'chain.crt'), readFileSync(join(dir, 'leaf.crt'), 'utf8') + readFileSync(join(dir, 'ca.crt'), 'utf8'));
} catch (error) {
  console.log(`SKIP - BMONI client test: could not generate a test certificate (${error.message}).`);
  process.exit(0);
}

const bmoniStatus = runDeno(join(here, 'bmoni-client-live.mjs'), ['--cert', join(dir, 'ca.crt')], {
  REACH_TEST_TLS_CHAIN: join(dir, 'chain.crt'),
  REACH_TEST_TLS_KEY: join(dir, 'leaf.key'),
});
process.exit(bmoniStatus.status ?? 1);
