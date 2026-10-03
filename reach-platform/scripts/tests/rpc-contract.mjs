#!/usr/bin/env node
// Every `supabase.rpc('name', { p_*: ... })` call in the Edge Function must pass exactly the
// parameter names the SQL function declares. PostgREST resolves named arguments against the
// function signature, so a single stale argument name makes the call fail with
// "function ... does not exist" at runtime -- a 500 on a webhook, not a type error at build time.
// This check is static and dependency-free, so it runs without a database.
//
// The BMONI webhook passed a `p_event_type` the RPC never declared, which meant every payment
// webhook failed; this guards that class of drift for all RPC calls.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const apiPath = join(root, 'supabase', 'functions', 'api', 'index.ts');
const migrationsDir = join(root, 'supabase', 'migrations');

const api = readFileSync(apiPath, 'utf8');
const sql = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(join(migrationsDir, f), 'utf8')).join('\n');

// Parameter names declared by each public function, unioned across redefinitions.
const declared = new Map();
for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.([a-z_]+)\s*\(([\s\S]*?)\)\s*returns/gi)) {
  const name = m[1];
  const params = new Set();
  for (const p of m[2].matchAll(/\bp_[a-z_]+/g)) params.add(p[0]);
  if (!declared.has(name)) declared.set(name, new Set());
  for (const p of params) declared.get(name).add(p);
}

// Argument names supplied by each `.rpc('name', { ... })` call. Only `p_*:` keys are read, so
// ternaries and template literals inside the values cannot be mistaken for argument names.
const problems = [];
let checked = 0;
for (const m of api.matchAll(/\.rpc\(\s*'([a-z_]+)'\s*(,\s*\{)?/g)) {
  const name = m[1];
  checked++;
  const params = declared.get(name);
  if (!params) { problems.push(`${name}: no public SQL function of that name`); continue; }
  const args = [];
  if (m[2]) {
    let i = m.index + m[0].length - 1, depth = 0, start = -1;
    for (; i < api.length; i++) {
      if (api[i] === '{') { depth++; if (depth === 1) start = i + 1; }
      else if (api[i] === '}') { depth--; if (depth === 0) break; }
    }
    for (const a of api.slice(start, i).matchAll(/\bp_[a-z_]+\s*:/g)) args.push(a[0].replace(/\s*:$/, ''));
  }
  const unknown = args.filter((a) => !params.has(a));
  if (unknown.length) problems.push(`${name}: Edge Function passes ${unknown.join(', ')} but SQL declares {${[...params].join(', ')}}`);
}

if (problems.length) {
  console.error('FAIL - RPC contract: Edge Function arguments do not match the SQL signatures.');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`PASS - RPC contract: ${checked} Edge Function RPC call(s) match their SQL signatures.`);
