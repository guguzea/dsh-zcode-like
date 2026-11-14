/**
 * Run every verification script and report a single verdict.
 *
 * Each script runs in its own Node process with inherited stdio: two of the
 * implementers' suites call `process.exit()` themselves, so they cannot be
 * imported into one runner, and `stdio: 'inherit'` keeps their output intact.
 *
 * Usage: node verify/run-all.mjs
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SUITE = [
  ['implementer host unit tests', 'host-unit.mjs'],
  ['implementer client checks', 'client-check.mjs'],
  ['other-harness adapters', 'foreign-adapters.mjs'],
  ['other-harness envelope forging', 'foreign-forge.mjs'],
  ['in-app update (download, verify, backup, rollback)', 'update.mjs'],
  // A released manifest that disagrees with the tree on disk would ship a broken or refused update, so
  // this is part of the suite rather than a release-only step.
  ['update manifest matches the files on disk', 'build-update-manifest.mjs', ['--check']],
  ['payload fidelity (differential vs the shipped uploader)', 'fidelity.mjs'],
  ['host adversarial checks', 'adversarial-host.mjs'],
  ['client consent-gate checks', 'adversarial-client.mjs'],
  ['Config schema vs the real schemastery from app.asar', 'schema-check.mjs'],
  ['theme-token existence', 'check-tokens.mjs'],
]

const results = []
for (const [title, name, args] of SUITE) {
  const path = fileURLToPath(new URL(name, import.meta.url))
  console.log(`\n${'='.repeat(78)}\n=== ${title}  (${name}${args === undefined ? '' : ` ${args.join(' ')}`})\n${'='.repeat(78)}`)
  const run = spawnSync(process.execPath, [path, ...(args ?? [])], { stdio: 'inherit' })
  if (run.error) console.log(`SUITE FAILED TO START: ${run.error.message}`)
  results.push([title, run.status === 0])
}

console.log(`\n${'='.repeat(78)}\n=== verdict\n${'='.repeat(78)}`)
let failed = 0
for (const [title, ok] of results) {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${title}`)
}
console.log(failed === 0 ? '\nALL SUITES PASS' : `\n${failed} SUITE(S) FAILED`)
process.exitCode = failed === 0 ? 0 : 1
