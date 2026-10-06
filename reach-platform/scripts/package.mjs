#!/usr/bin/env node
// Build the distribution archive from git-tracked files only.
//
// `git archive` emits exactly the committed tree, so dependency directories can never leak in:
// `node_modules/` is git-ignored, and a stale `node_modules_old/` that is also ignored stays out
// regardless of what happens to be sitting in the working copy. Earlier packages were zipped from
// the working directory and shipped a partial `node_modules`, which is both huge and broken.
//
// Usage: node scripts/package.mjs [output.zip] [--ref <ref>]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

const args = process.argv.slice(2);
const refIndex = args.indexOf('--ref');
const ref = refIndex >= 0 ? args[refIndex + 1] : 'HEAD';
const out = resolve(args.find((a) => !a.startsWith('--') && a !== ref) || 'reach-source.zip');

// `--worktree-attributes` is intentionally NOT used: the committed .gitattributes is what ships.
execFileSync('git', ['archive', '--format=zip', '-o', out, ref], { cwd: repoRoot, stdio: 'inherit' });

// Fail loudly if a dependency directory ever made it in — the whole point of this script.
const listing = execFileSync('git', ['ls-tree', '-r', '--name-only', ref], { cwd: repoRoot, encoding: 'utf8' });
const leaked = listing.split('\n').filter((p) => /(^|\/)node_modules(_old)?\//.test(p));
if (leaked.length) {
  rmSync(out, { force: true });
  console.error(`Refusing to ship ${out}: archive contains dependency directories:`);
  for (const p of leaked.slice(0, 10)) console.error(`  ${p}`);
  process.exit(1);
}

console.log(`Wrote ${out} (${(statSync(out).size / 1024).toFixed(0)} KiB) from ${ref}; no node_modules included.`);
