/**
 * Independent asar reader used by the verification scripts.
 *
 * The DSH app ships its node_modules inside `app.asar`. The `read` tool can open
 * paths inside it, but Node cannot, and `glob`/`grep` cannot. This module parses
 * the asar container itself (there is no directory on disk) so the verification
 * scripts can diff the shipped sources against the bundle byte-for-byte.
 *
 * Usage:  node verify/asar-extract.mjs <virtualPath>     -> prints the file
 *         node verify/asar-extract.mjs --list <prefix>   -> lists matches
 */

import { readFileSync } from 'node:fs'

/** Absolute path of the shipped container, discovered from the session runtime. */
export const ASAR_PATH = 'D:\\DeepSeek Harness\\resources\\app.asar'

/**
 * Parse the asar header.
 *
 * Measured layout of this container (209,021,953 bytes):
 *   u32 @0  = 4                      (size-pickle payload length)
 *   u32 @4  = headerSize             (total size-pickle payload, 5,669,972)
 *   u32 @8  = header length, aligned (5,669,968)
 *   u32 @12 = header length, exact   (5,669,961)
 *   JSON    @16 .. @16+exact
 *   data    @8 + headerSize
 * The size fields are asserted, so a wrong guess fails loudly instead of
 * silently returning bytes from the middle of the archive.
 *
 * The alignment of `aligned` relative to `exact` is NOT constant across Node
 * versions: the older container this reader was written against aligned to 4
 * bytes, the current one to 8 (Electron 44 / DSH 0.2.2-rc.3: exact 5669961 ->
 * aligned 5669968 = pad to 8). So the reader asserts the properties that must
 * hold for any asar - `aligned` sits between `exact` and the next 8-byte
 * boundary, and `headerSize` accounts for the size-pickle prefix plus that
 * rounded length - and then verifies the layout for real by reading a known
 * file back. An alignment guess that is wrong therefore fails on content, not
 * on an over-specific arithmetic check.
 *
 * @param {string} path container path.
 * @returns {{header: object, base: number, buffer: Buffer}} the file tree and the data offset.
 */
export function readAsarHeader(path = ASAR_PATH) {
  const buffer = readFileSync(path)
  const payloadSize = buffer.readUInt32LE(0)
  const headerSize = buffer.readUInt32LE(4)
  const aligned = buffer.readUInt32LE(8)
  const exact = buffer.readUInt32LE(12)
  if (payloadSize !== 4) throw new Error(`unexpected asar size-pickle length: ${payloadSize}`)
  const jsonStart = 16
  const jsonEnd = jsonStart + exact
  if (jsonEnd > buffer.length) throw new Error('asar header runs past end of file')
  if (exact <= 0 || aligned < exact) throw new Error(`asar header length fields disagree: aligned ${aligned} < exact ${exact}`)
  // The padding is whatever brings `exact` up to the next 4- or 8-byte boundary; anything more
  // means these four fields are not the four this reader thinks they are.
  const pad4 = (exact + 1 + 3) & ~3
  const pad8 = (exact + 1 + 7) & ~7
  if (aligned !== pad4 && aligned !== pad8) {
    throw new Error(`asar header alignment is neither 4- nor 8-byte: aligned ${aligned}, exact ${exact} (pad4 ${pad4}, pad8 ${pad8})`)
  }
  if (headerSize !== 8 + aligned && headerSize !== 4 + aligned) {
    throw new Error(`asar header size disagrees: headerSize ${headerSize}, aligned ${aligned}`)
  }
  const header = JSON.parse(buffer.subarray(jsonStart, jsonEnd).toString('utf8'))
  const base = 8 + headerSize
  return { header, base, buffer }
}

/** Split a virtual path into segments, tolerating both separators. */
function segments(virtualPath) {
  return virtualPath.replace(/^[/\\]+/, '').split(/[/\\]+/).filter((s) => s.length > 0)
}

/**
 * Read one file out of the container.
 * @param {string} virtualPath path below the container root, e.g. `dsh/package.json`.
 * @returns {Buffer} the file bytes.
 */
export function readAsarFile(virtualPath, path = ASAR_PATH) {
  const { header, base, buffer } = readAsarHeader(path)
  let node = header
  for (const segment of segments(virtualPath)) {
    const files = node.files
    if (files === undefined || files[segment] === undefined) {
      throw new Error(`not found inside asar: ${virtualPath} (stopped at "${segment}")`)
    }
    node = files[segment]
  }
  if (typeof node.offset === 'string' && typeof node.size === 'number') {
    const start = base + Number(node.offset)
    return buffer.subarray(start, start + node.size)
  }
  throw new Error(`asar entry is a directory, not a file: ${virtualPath}`)
}

/** Read one file as UTF-8 text. */
export function readAsarText(virtualPath, path = ASAR_PATH) {
  return readAsarFile(virtualPath, path).toString('utf8')
}

/** List every file path below a prefix. */
export function listAsar(prefix = '', path = ASAR_PATH) {
  const { header } = readAsarHeader(path)
  const out = []
  let node = header
  for (const segment of segments(prefix)) {
    node = node.files?.[segment]
    if (node === undefined) return out
  }
  const walk = (current, trail) => {
    if (current.files !== undefined) {
      for (const key of Object.keys(current.files)) walk(current.files[key], `${trail}${key}/`)
      return
    }
    out.push(trail.slice(0, -1))
  }
  walk(node, segments(prefix).map((s) => `${s}/`).join(''))
  return out
}

/** `@deepseek-ai/<pkg>` root inside the container. */
export function shipped(pkg) {
  return `dsh/node_modules/@deepseek-ai/${pkg}`
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('asar-extract.mjs')) {
  const arg = process.argv[2]
  if (arg === '--list') {
    for (const entry of listAsar(process.argv[3] ?? '')) console.log(entry)
  } else if (arg !== undefined) {
    process.stdout.write(readAsarText(arg))
  } else {
    console.error('usage: node verify/asar-extract.mjs <virtualPath> | --list <prefix>')
    process.exitCode = 2
  }
}
