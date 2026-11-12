/**
 * ripgrep over the shipped asar container.
 *
 * `glob`/`grep` cannot see inside `app.asar`, and the DSH packages the bundle must
 * match live only there. This walks the container's header and searches selected
 * files' bytes.
 *
 * Usage:
 *   node verify/asar-grep.mjs <prefix> <regex> [--ext .js] [--max N]
 *   node verify/asar-grep.mjs <prefix> <regex> --files
 */

import { readAsarFile, readAsarHeader, listAsar } from './asar-extract.mjs'

const [prefix, pattern, ...rest] = process.argv.slice(2)
if (prefix === undefined || pattern === undefined) {
  console.error('usage: node verify/asar-grep.mjs <prefix> <regex> [--ext .js] [--max N] [--files]')
  process.exit(2)
}
const onlyFiles = rest.includes('--files')
const extIndex = rest.indexOf('--ext')
const ext = extIndex >= 0 ? rest[extIndex + 1] : null
const maxIndex = rest.indexOf('--max')
const max = maxIndex >= 0 ? Number(rest[maxIndex + 1]) : 400

const { header, base, buffer } = readAsarHeader()
void header
const files = listAsar(prefix).filter((path) => (ext === null ? true : path.endsWith(ext)))

if (onlyFiles) {
  for (const path of files) console.log(path)
  process.exit(0)
}

const re = new RegExp(pattern)
let hits = 0
for (const path of files) {
  const bytes = readAsarFile(path)
  if (bytes.includes(0)) continue
  const text = buffer === undefined ? bytes.toString('utf8') : bytes.toString('utf8')
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!re.test(line)) continue
    console.log(`${path}:${index + 1}: ${line.length > 400 ? `${line.slice(0, 400)}…` : line}`)
    if (++hits >= max) {
      console.log(`[stopped at ${max} matches]`)
      process.exit(0)
    }
  }
}
console.log(`[${hits} matches in ${files.length} files under ${prefix}]`)
void base
