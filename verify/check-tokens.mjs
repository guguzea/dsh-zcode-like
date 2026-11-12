/**
 * Adversarial check: every CSS custom property `client.js` uses must be declared
 * somewhere in the shipped theme/frontend CSS. A misspelled token does not fail a
 * build — the declaration silently becomes invalid, so the control renders unstyled
 * (an invisible dialog backdrop is a consent-surface problem, not just cosmetic).
 *
 * Usage: node verify/check-tokens.mjs
 */

import { readFileSync } from 'node:fs'
import { readAsarText, listAsar } from './asar-extract.mjs'

const CLIENT = readFileSync('client.js', 'utf8')

/** Tokens the client references, with the line that references them. */
const used = new Map()
CLIENT.split('\n').forEach((line, index) => {
  for (const match of line.matchAll(/var\((--dsw-[a-z0-9-]+)/g)) {
    if (!used.has(match[1])) used.set(match[1], index + 1)
  }
})

/** Every `--dsw-*:` declaration found in the shipped theme and frontend CSS. */
const declared = new Set()
const sources = []
const collect = (label, text) => {
  let before = declared.size
  for (const match of text.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)) declared.add(match[1])
  sources.push(`${label} (+${declared.size - before} tokens)`)
}

for (const path of listAsar('dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib').filter((p) => p.endsWith('.js'))) {
  collect(path, readAsarText(path))
}
for (const path of listAsar('dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets').filter((p) => p.endsWith('.css'))) {
  collect(path, readAsarText(path))
}
// The theme package also ships raw CSS sources in some builds.
for (const path of listAsar('dsh/node_modules/@deepseek-ai/dsh-client-ui-theme').filter((p) => p.endsWith('.css'))) {
  collect(path, readAsarText(path))
}

console.log(`reference: ${used.size} tokens in client.js`)
console.log(`reference sources: ${sources.length} files, ${declared.size} distinct declarations`)
let missing = 0
for (const [token, line] of [...used].sort()) {
  if (!declared.has(token)) {
    missing++
    console.log(`MISSING  ${token}  (client.js:${line})`)
  }
}
console.log(missing === 0 ? 'OK: every referenced token is declared in the shipped theme' : `${missing} token(s) are referenced but never declared`)
