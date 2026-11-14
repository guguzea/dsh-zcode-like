/**
 * In-app self-update for the plugin bundle: check, download, verify, replace, roll back.
 *
 * WHY THIS EXISTS: a user who installed the bundle once should not have to find the repository, copy
 * files and restart by hand for every fix. The update is done in-app, from a manifest published next to
 * the source, and the flow is the same one the reference `dsh-our-free-model` plugin uses:
 *
 *   manifest → download every file into memory → SHA-256 verify → stage → back up → atomic rename over
 *   → read the whole file back and verify → delete the staging directory; any failure after the first
 *   write restores the backups.
 *
 * TRUST MODEL, stated plainly because the UI must say the same thing: there is **no signature chain**.
 * The only trust root is HTTPS to the manifest address. A compromised manifest address (or a MITM who
 * can present a valid certificate for it) can run arbitrary code inside DSH, exactly like a compromised
 * npm registry can. That is why this module never auto-applies, never applies on a timer, and only ever
 * runs when a user clicked "upgrade" on a page that names the limitation.
 *
 * INVARIANTS this file must never break:
 *
 *   1. **Total.** No exported function throws or rejects. Every failure is an `{ok:false, error}` value
 *      with a stable, machine-readable prefix; the caller renders the reason.
 *   2. **All-or-nothing.** Nothing on disk is touched until every byte has been downloaded, length-
 *      checked and hash-checked in memory. A half-written bundle is worse than an old one.
 *   3. **Only listed files.** A manifest decides what is replaced, never what is deleted: files the
 *      manifest does not mention are left alone, including the user's own notes next to the plugin.
 *   4. **No hot reload.** Replacing files on disk cannot reload a mounted Cordis row. Success reports
 *      `reload:'restart-required'`; claiming otherwise would be a lie the page repeats to the user.
 *   5. **Version truth.** An apply is refused unless the `package.json` it is about to install
 *      declares exactly the manifest's version (and unless the manifest carries one), so the version
 *      the checker reports after an update is the version that is actually installed.
 *   6. **Containment.** Lexical path checks plus a `realpath` check of every target's deepest existing
 *      ancestor: a symlink or junction inside the plugin directory cannot redirect a written file
 *      outside it. A target that is itself a link is refused outright (`lstat`), so the backup phase
 *      never copies a link's outside bytes into the backup directory.
 *
 * The module uses `node:` builtins only, plus one intra-bundle relative import for the shared default
 * address (`./config.js`). It is shipped inside the bundle and loaded from a profile, where a bare
 * specifier cannot resolve (INTERFACES.md §0).
 *
 * @module session-log-upload/update
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

import { DEFAULT_UPDATE_URL } from './config.js'

/**
 * Default manifest address: the repository's raw copy on `main`.
 *
 * Imported and re-exported rather than declared here, so `host/config.js`, `index.js` and this module
 * can never disagree about where updates come from: it is the trust root of the whole path, and two
 * copies of a trust root are one copy too many. The fallback rule lives here because only the updater
 * acts on it: exactly this string may fall back to {@link FALLBACK_UPDATE_URL}.
 */
export { DEFAULT_UPDATE_URL }

/**
 * Mirror used ONLY when the configured address is exactly {@link DEFAULT_UPDATE_URL} and the raw copy
 * failed. A user-supplied mirror is never silently replaced by this one: the page shows which address
 * was actually used (`source`), and a custom address that fails reports its own failure.
 */
export const FALLBACK_UPDATE_URL = 'https://cdn.jsdelivr.net/gh/guguzea/dsh-zcode-like@main/update-manifest.json'

/** The only manifest schema this module understands. A different number is rejected, not guessed. */
export const UPDATE_MANIFEST_SCHEMA = 1

/** Cap on the manifest body: 256 KiB. A manifest is a list of names and hashes, never a payload. */
export const MAX_MANIFEST_BYTES = 256 * 1024

/** Cap on one downloaded file: 4 MiB. The whole bundle is a few hundred KiB. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024

/** Cap on the sum of all downloaded files: 16 MiB. Checked against what actually arrived, too. */
export const MAX_TOTAL_BYTES = 16 * 1024 * 1024

/** Prefix of the directory that receives the verified bytes before they replace anything. */
const STAGING_PREFIX = '.update-staging-'

/** Prefix of the directory that receives the originals being replaced. */
const BACKUP_PREFIX = '.update-backup-'

/** The full character set a manifest path may use. Everything else (spaces, `:`, `\`, control chars) is refused. */
const SAFE_PATH_CHARS = /^[A-Za-z0-9._/-]+$/

/** A manifest hash is 64 lowercase hexadecimal characters, nothing else. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/

/**
 * Accepted version shapes: one to four dot-separated numeric segments, an optional `-prerelease` whose
 * identifiers are compared with SemVer's numeric/alphanumeric rule, and optional `+build` metadata that
 * is ignored for ordering. Deliberately narrower than full SemVer (no `v` prefix, no leading zero
 * rules, no length limit beyond the guard below): the comparison must be *strict*, and a manifest whose
 * version this module cannot order is refused instead of being compared by string.
 */
const VERSION_PATTERN = /^([0-9]+(?:\.[0-9]+){0,3})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** A version string longer than this is not a version; the bound keeps `BigInt` parsing cheap. */
const MAX_VERSION_LENGTH = 64

/** Longest manifest path accepted, so directory creation work stays bounded. */
const MAX_PATH_LENGTH = 512

/** Longest error detail carried in a returned error string. */
const MAX_ERROR_LENGTH = 300

/**
 * The module-wide "an apply is in flight" flag.
 *
 * The contract asks for one flag, not a per-directory queue: two upgrades racing would interleave
 * downloads and replacements, and the second one would overwrite the first one's backups. The flag is
 * set synchronously before the first `await`, so a second call made in the same tick is refused even if
 * the first one has not reached the network yet.
 */
let applying = false

/** Shorten a detail string for one-line error payloads; never throws. */
function clip(value) {
  try {
    if (typeof value !== 'string') return ''
    const oneLine = value.replace(/[\r\n\t]+/g, ' ').trim()
    return oneLine.length <= MAX_ERROR_LENGTH ? oneLine : `${oneLine.slice(0, MAX_ERROR_LENGTH)}...`
  } catch {
    return ''
  }
}

/** Build the canonical `{ok:false, error}` value. */
function failure(code, detail) {
  const suffix = typeof detail === 'string' && detail.length > 0 ? `: ${clip(detail)}` : ''
  return { ok: false, error: `${code}${suffix}` }
}

/** Describe an arbitrary thrown value without ever throwing itself. */
function describeError(error) {
  try {
    if (error === null || error === undefined) return 'unknown error'
    const name = typeof error.name === 'string' && error.name.length > 0 ? `${error.name}: ` : ''
    const message = typeof error.message === 'string' && error.message.length > 0 ? error.message : String(error)
    let cause = ''
    try {
      const rawCause = error.cause
      if (rawCause !== null && rawCause !== undefined && typeof rawCause === 'object') {
        if (typeof rawCause.code === 'string' && rawCause.code.length > 0) cause = ` (${rawCause.code})`
        else if (typeof rawCause.message === 'string' && rawCause.message.length > 0) cause = ` (${rawCause.message})`
      }
    } catch {
      /* an unreadable cause is not worth failing the diagnostic over */
    }
    return `${name}${message}${cause}`
  } catch {
    return 'unknown error'
  }
}

/** Whether a thrown value is an abort. */
function isAbortError(error) {
  try {
    return error !== null && typeof error === 'object' && (error.name === 'AbortError' || error.code === 'ABORT_ERR')
  } catch {
    return false
  }
}

/** Hex SHA-256 of a Buffer. */
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Parse a version string into a comparable shape, or `null` when it is not one of the accepted shapes.
 * @returns `{core: bigint[], prerelease: string[]|null}` or `null`.
 */
function parseVersion(value) {
  try {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VERSION_LENGTH) return null
    const match = VERSION_PATTERN.exec(value)
    if (match === null) return null
    const core = match[1].split('.').map((part) => BigInt(part))
    const prerelease = match[2] === undefined ? null : match[2].split('.')
    return { core, prerelease }
  } catch {
    return null
  }
}

/** SemVer identifier ordering: numeric identifiers compare numerically and rank below alphanumeric ones. */
function compareIdentifiers(left, right) {
  const leftNumeric = /^[0-9]+$/.test(left)
  const rightNumeric = /^[0-9]+$/.test(right)
  if (leftNumeric && rightNumeric) {
    const leftNumber = BigInt(left)
    const rightNumber = BigInt(right)
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0
  }
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

/** Compare two parsed versions. */
function compareParsedVersions(left, right) {
  const coreLength = Math.max(left.core.length, right.core.length)
  for (let index = 0; index < coreLength; index += 1) {
    // A missing segment is zero: `1.0` and `1.0.0` are the same version.
    const leftNumber = left.core[index] ?? 0n
    const rightNumber = right.core[index] ?? 0n
    if (leftNumber < rightNumber) return -1
    if (leftNumber > rightNumber) return 1
  }
  // A prerelease sorts BELOW its release: `1.1.0-beta.1` precedes `1.1.0`.
  if (left.prerelease === null && right.prerelease === null) return 0
  if (left.prerelease === null) return 1
  if (right.prerelease === null) return -1
  const prereleaseLength = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < prereleaseLength; index += 1) {
    // Alphanumeric exhaustion inside a prerelease: the shorter list is the smaller one.
    if (index >= left.prerelease.length) return -1
    if (index >= right.prerelease.length) return 1
    const comparison = compareIdentifiers(left.prerelease[index], right.prerelease[index])
    if (comparison !== 0) return comparison
  }
  return 0
}

/**
 * Read the version declared by `<directory>/package.json`.
 *
 * Returns `null` — never a guess — when the file is missing, unreadable, malformed, or carries a
 * version this module cannot order. Both callers depend on that honesty: `checkUpdate` refuses to
 * declare "up to date" when it does not know what is installed, and `applyUpdate` refuses to replace
 * anything without a comparable before-version (it also names the backup directory).
 *
 * @param directory the plugin directory (any value; unusable input reads as `null`).
 * @returns the version string, or `null`.
 */
export function readCurrentVersion(directory) {
  try {
    if (typeof directory !== 'string' || directory.length === 0) return null
    const packageJsonPath = join(directory, 'package.json')
    // Bound the read like the manifest: a "package.json" that is not a small JSON file is not one, and
    // reading an arbitrarily large local file into memory is not this function's job.
    const stats = statSync(packageJsonPath)
    if (!stats.isFile() || stats.size > MAX_MANIFEST_BYTES) return null
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (typeof parsed.version !== 'string') return null
    return parseVersion(parsed.version) === null ? null : parsed.version
  } catch {
    return null
  }
}

/**
 * Read the `version` out of the package.json bytes an update is about to install.
 *
 * A manifest can claim any `version` it likes; what the runtime will report after the apply is
 * whatever this file says. The two must agree, so the check in {@link applyUpdate} runs against the
 * downloaded bytes, never against the manifest's declaration. Returns `null` when the bytes are not a
 * JSON object with a string `version`.
 *
 * @param bytes the verified downloaded bytes of the manifest's `package.json` entry.
 * @returns the declared version string, or `null`.
 */
function readShippedVersion(bytes) {
  try {
    const parsed = JSON.parse(bytes.toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/**
 * Strictly compare two version strings.
 *
 * @param left candidate version.
 * @param right candidate version.
 * @returns `-1`, `0`, `1`, or `null` when either shape is not a version this module recognises.
 */
export function compareVersions(left, right) {
  try {
    const parsedLeft = parseVersion(left)
    const parsedRight = parseVersion(right)
    if (parsedLeft === null || parsedRight === null) return null
    return compareParsedVersions(parsedLeft, parsedRight)
  } catch {
    return null
  }
}

/**
 * Normalize one manifest path into the relative form used on disk, or `null` when it is unsafe.
 *
 * Rules, all of them enforced here so no later stage has to remember them:
 *   - non-empty string, at most {@link MAX_PATH_LENGTH} characters;
 *   - only `[A-Za-z0-9._/-]` — this already excludes `\`, `:`, spaces, drive letters and UNC prefixes;
 *   - no leading `/` (absolute POSIX path);
 *   - no empty segment (`a//b`, `a/`, `/a`), no `..` segment (traversal);
 *   - `.` segments are harmless and are normalized away, so `./a` and `a` cannot be used to list the
 *     same target twice;
 *   - a segment may not end with `.`: Windows silently strips the trailing dot, so `a.` and `a` would
 *     be the same file on the host but different entries in the manifest.
 *
 * @param value the manifest `path` value.
 * @returns the normalized relative path, or `null`.
 */
function normalizeManifestPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) return null
  if (!SAFE_PATH_CHARS.test(value)) return null
  if (value.startsWith('/')) return null
  const output = []
  for (const segment of value.split('/')) {
    if (segment.length === 0) return null
    if (segment === '..') return null
    if (segment === '.') continue
    if (segment.endsWith('.')) return null
    output.push(segment)
  }
  if (output.length === 0) return null
  return output.join('/')
}

/**
 * Parse and validate a manifest body.
 *
 * Success returns `{ok:true, manifest:{schema, version, notes, files}}` with paths normalized and fresh
 * arrays; failure returns `{ok:false, error}` and the caller treats the whole manifest as unusable. Any
 * single bad entry rejects everything: a partially-trusted manifest is not a smaller problem, it is the
 * same problem.
 *
 * `manifestUrl` is accepted for call-site symmetry and diagnostics; it is deliberately not used for
 * validation, because manifest paths are always relative to the *plugin directory*, never to the
 * manifest address. The two only meet later, in `applyUpdate`, where files are fetched with
 * `new URL(path, manifestUrl)`.
 *
 * @param text the manifest body (a string; anything else is refused).
 * @param manifestUrl the address the body came from, for diagnostics only.
 * @returns `{ok:true, manifest}` or `{ok:false, error}`.
 */
export function parseManifest(text, manifestUrl) {
  try {
    if (typeof text !== 'string') return failure('manifest-not-text')
    // A UTF-8 BOM in front of JSON is common from hand-edited files; strip it rather than fail on it.
    const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    if (source.length === 0) return failure('manifest-empty')
    if (Buffer.byteLength(source, 'utf8') > MAX_MANIFEST_BYTES) {
      return failure('manifest-too-large', `${Buffer.byteLength(source, 'utf8')} bytes (max ${MAX_MANIFEST_BYTES}) from ${clip(manifestUrl)}`)
    }
    let parsed
    try {
      parsed = JSON.parse(source)
    } catch (error) {
      return failure('manifest-not-json', describeError(error))
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return failure('manifest-not-object')
    if (parsed.schema !== UPDATE_MANIFEST_SCHEMA) {
      return failure('manifest-schema', `expected ${UPDATE_MANIFEST_SCHEMA}, got ${JSON.stringify(parsed.schema)}`)
    }
    if (parseVersion(parsed.version) === null) {
      return failure('manifest-version', `not a comparable version: ${JSON.stringify(parsed.version)}`)
    }
    if (parsed.notes !== undefined && parsed.notes !== null && typeof parsed.notes !== 'string') {
      return failure('manifest-notes', 'notes must be a string when present')
    }
    const notes = typeof parsed.notes === 'string' ? parsed.notes : ''
    if (!Array.isArray(parsed.files) || parsed.files.length === 0) return failure('manifest-files', 'files must be a non-empty array')
    const files = []
    const seenPaths = new Set()
    let totalBytes = 0
    for (const entry of parsed.files) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return failure('manifest-file-entry', 'each files entry must be an object')
      }
      const path = normalizeManifestPath(entry.path)
      if (path === null) return failure('manifest-path', `unsafe or non-relative path ${JSON.stringify(entry.path)}`)
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
        return failure('manifest-file-bytes', `${path}: bytes must be a non-negative safe integer`)
      }
      if (entry.bytes > MAX_FILE_BYTES) return failure('manifest-file-too-large', `${path}: ${entry.bytes} bytes (max ${MAX_FILE_BYTES})`)
      if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) {
        return failure('manifest-file-sha256', `${path}: sha256 must be 64 lowercase hexadecimal characters`)
      }
      // Case-folded duplicate rejection: on a case-insensitive filesystem (Windows) `a.js` and `A.js`
      // are one file, so two entries would fight over one target. Refusing keeps the guarantee that
      // one manifest entry maps to exactly one file on every platform this bundle runs on.
      const key = path.toLowerCase()
      if (seenPaths.has(key)) return failure('manifest-duplicate-path', path)
      seenPaths.add(key)
      totalBytes += entry.bytes
      if (totalBytes > MAX_TOTAL_BYTES) {
        return failure('manifest-total-too-large', `declared files total more than ${MAX_TOTAL_BYTES} bytes`)
      }
      files.push({ path, bytes: entry.bytes, sha256: entry.sha256 })
    }
    return { ok: true, manifest: { schema: UPDATE_MANIFEST_SCHEMA, version: parsed.version, notes, files } }
  } catch (error) {
    return failure('manifest-parse-failed', describeError(error))
  }
}

/** Resolve the fetch implementation: the caller's, else the platform's, else `null`. */
function resolveFetch(fetchImpl) {
  try {
    if (typeof fetchImpl === 'function') return fetchImpl
    const globalFetch = globalThis.fetch
    if (typeof globalFetch !== 'function') return null
    return (request, init) => globalFetch.call(globalThis, request, init)
  } catch {
    return null
  }
}

/**
 * Decide which manifest address to use for the first attempt.
 *
 * An absent address (or `null`/`undefined`) means "the default", which is the only case allowed to try
 * {@link FALLBACK_UPDATE_URL}. Any explicitly supplied address must be an absolute `http(s)` URL; the
 * module refuses anything else instead of quietly falling back, because "I could not parse your mirror"
 * and "your mirror is down" are different failures and the page must say which one happened.
 */
function resolveManifestAddress(configured) {
  try {
    if (configured === undefined || configured === null) {
      return { url: DEFAULT_UPDATE_URL, source: 'primary', fallbackAllowed: true }
    }
    if (typeof configured !== 'string' || configured.length === 0) return { error: 'manifest-url-refused' }
    if (!/^https?:\/\//i.test(configured)) return { error: 'manifest-url-refused' }
    if (configured === DEFAULT_UPDATE_URL) return { url: configured, source: 'primary', fallbackAllowed: true }
    return { url: configured, source: 'custom', fallbackAllowed: false }
  } catch {
    return { error: 'manifest-url-refused' }
  }
}

/**
 * Read a response body into memory with a hard cap.
 *
 * Streaming, not `arrayBuffer()` first: `arrayBuffer()` would buffer however much the server sends
 * before the size check, which is exactly the unbounded read the cap exists to prevent. A declared
 * `content-length` over the cap short-circuits before a single byte of body is consumed.
 *
 * @returns `{ok:true, bytes}` or `{ok:false, error}` never throws.
 */
async function readCappedBody(response, maxBytes, what) {
  try {
    const headers = response === null || response === undefined ? undefined : response.headers
    if (headers !== null && headers !== undefined && typeof headers.get === 'function') {
      const declared = Number(headers.get('content-length'))
      if (Number.isFinite(declared) && declared > maxBytes) {
        return failure('download-too-large', `${what} declares ${declared} bytes (max ${maxBytes})`)
      }
    }
    const body = response === null || response === undefined ? undefined : response.body
    if (body !== null && body !== undefined && typeof body.getReader === 'function') {
      const reader = body.getReader()
      const chunks = []
      let total = 0
      for (;;) {
        const read = await reader.read()
        if (read.done === true) break
        const value = read.value
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        total += chunk.length
        if (total > maxBytes) {
          try {
            await reader.cancel()
          } catch {
            /* cancelling is best-effort */
          }
          return failure('download-too-large', `${what} is larger than ${maxBytes} bytes`)
        }
        chunks.push(chunk)
      }
      return { ok: true, bytes: Buffer.concat(chunks, total) }
    }
    if (typeof response.arrayBuffer === 'function') {
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length > maxBytes) return failure('download-too-large', `${what} is larger than ${maxBytes} bytes`)
      return { ok: true, bytes }
    }
    return failure('download-empty', `${what} returned no body`)
  } catch (error) {
    if (isAbortError(error)) return { ok: false, error: 'aborted' }
    return failure('download-failed', `${what}: ${describeError(error)}`)
  }
}

/**
 * GET a URL and return at most `maxBytes` of body.
 *
 * Redirects are refused (`redirect:'error'`) rather than followed. The trust root is "HTTPS to the
 * manifest address"; following a redirect would let that address hand the update to another origin, or
 * downgrade to plain HTTP, without the page being able to say so. The two shipped addresses serve
 * directly, so a mirror that redirects is a mirror that must be configured at its final address.
 */
async function requestBytes(url, fetchImpl, signal, maxBytes, what) {
  try {
    if (signal !== null && signal !== undefined && signal.aborted === true) return { ok: false, error: 'aborted' }
  } catch {
    /* an unreadable signal is not a reason to hang */
  }
  let response
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal, headers: { accept: '*/*' } })
  } catch (error) {
    if (isAbortError(error) || (signal !== null && signal !== undefined && signal.aborted === true)) return { ok: false, error: 'aborted' }
    return { ok: false, error: `transport-error: ${describeError(error)}` }
  }
  try {
    const status = response === null || response === undefined ? NaN : Number(response.status)
    const ok =
      response !== null && response !== undefined && typeof response.ok === 'boolean'
        ? response.ok
        : status >= 200 && status < 300
    if (!ok) return { ok: false, error: `http-error: status ${Number.isFinite(status) ? status : 'unknown'} for ${what}` }
    const body = await readCappedBody(response, maxBytes, what)
    if (!body.ok) return body
    if (body.bytes.length > maxBytes) return failure('download-too-large', `${what} is larger than ${maxBytes} bytes`)
    return { ok: true, bytes: body.bytes }
  } catch (error) {
    if (isAbortError(error) || (signal !== null && signal !== undefined && signal.aborted === true)) return { ok: false, error: 'aborted' }
    return { ok: false, error: `response-error: ${describeError(error)}` }
  }
}

/** Fetch one manifest body and validate it. */
async function fetchManifestFrom(url, fetchImpl, signal) {
  const fetched = await requestBytes(url, fetchImpl, signal, MAX_MANIFEST_BYTES, 'the manifest')
  if (!fetched.ok) return fetched
  const text = fetched.bytes.toString('utf8')
  const parsed = parseManifest(text, url)
  if (!parsed.ok) return parsed
  return { ok: true, text, manifest: parsed.manifest }
}

/**
 * Turn the transport's raw status line into something a user can act on.
 *
 * The common real-world failure is not a broken updater: it is a manifest address that answers 404,
 * which is exactly what GitHub returns for a private repository (or a renamed path, or a file that only
 * exists on another branch). And 401/403 means the address wants credentials. Saying "http-error: status
 * 404" leaves the user guessing; these two prefixes name the cause without inventing detail we do not
 * have.
 *
 * @param error the transport error string.
 * @returns the same string, or a prefixed explanation for 404/401/403.
 */
function explainManifestError(error) {
  if (typeof error !== 'string') return 'manifest-unavailable'
  if (error.includes('status 404')) {
    return `not-public: ${error}. A private repository, a renamed path and a file on another branch all answer 404 anonymously`
  }
  if (error.includes('status 401') || error.includes('status 403')) {
    return `unauthorized: ${error}. The update address refuses anonymous access`
  }
  return error
}

/**
 * Fetch and validate the update manifest, applying the fallback rule.
 * @returns `{ok:true, source, manifestUrl, text, manifest}` or `{ok:false, source, manifestUrl, error, aborted}`.
 */
async function downloadManifest(fetchImpl, configuredUrl, signal) {
  const address = resolveManifestAddress(configuredUrl)
  if (address.error !== undefined) {
    return {
      ok: false,
      error: address.error,
      source: 'custom',
      manifestUrl: typeof configuredUrl === 'string' ? configuredUrl : DEFAULT_UPDATE_URL,
      aborted: false,
    }
  }
  const primary = await fetchManifestFrom(address.url, fetchImpl, signal)
  if (primary.ok) {
    return { ok: true, source: address.source, manifestUrl: address.url, text: primary.text, manifest: primary.manifest }
  }
  const aborted = primary.error === 'aborted'
  const primaryError = aborted ? primary.error : explainManifestError(primary.error)
  if (aborted || !address.fallbackAllowed) {
    return { ok: false, error: primaryError, source: address.source, manifestUrl: address.url, aborted }
  }
  const fallback = await fetchManifestFrom(FALLBACK_UPDATE_URL, fetchImpl, signal)
  if (fallback.ok) {
    return { ok: true, source: 'fallback', manifestUrl: FALLBACK_UPDATE_URL, text: fallback.text, manifest: fallback.manifest }
  }
  const fallbackError = fallback.error === 'aborted' ? fallback.error : explainManifestError(fallback.error)
  return {
    ok: false,
    // Both attempts are reported: the user is looking at one error line and needs to know the fallback
    // was tried, otherwise "raw failed" looks like the whole check gave up too early.
    error: `${primaryError}; fallback: ${fallbackError}`,
    source: address.source,
    manifestUrl: address.url,
    aborted: fallback.error === 'aborted',
  }
}

/** The default result of a check, with every contract field present. */
function emptyCheck(manifestUrl, source) {
  return {
    ok: false,
    current: null,
    latest: null,
    available: false,
    notes: '',
    manifestUrl,
    source,
    files: [],
    error: null,
  }
}

/**
 * Check for an update **without writing anything to disk**.
 *
 * Order matters: the local version is read first. A directory without a readable `package.json` is a
 * broken install, and asking the network about it cannot make the answer more useful; the check fails
 * with `current-version-unavailable` and makes no request at all.
 *
 * @param options `{fetchImpl?, manifestUrl?, directory?, signal?}`; every field is optional and tolerated.
 * @returns the contract shape `{ok, current, latest, available, notes, manifestUrl, source, files, error}`.
 */
export async function checkUpdate(options) {
  try {
    const settings = options !== null && typeof options === 'object' ? options : {}
    const fetchImpl = resolveFetch(settings.fetchImpl)
    const address = resolveManifestAddress(settings.manifestUrl)
    const initialUrl = address.error === undefined ? address.url : typeof settings.manifestUrl === 'string' ? settings.manifestUrl : DEFAULT_UPDATE_URL
    const initialSource = address.error === undefined ? address.source : 'custom'
    const base = emptyCheck(initialUrl, initialSource)
    if (fetchImpl === null) return { ...base, error: 'no-fetch' }
    const directory = settings.directory
    if (typeof directory !== 'string' || directory.length === 0) return { ...base, error: 'no-directory' }
    const current = readCurrentVersion(directory)
    if (current === null) return { ...base, error: 'current-version-unavailable' }
    const fetched = await downloadManifest(fetchImpl, settings.manifestUrl, settings.signal)
    if (!fetched.ok) {
      return { ...base, manifestUrl: fetched.manifestUrl ?? initialUrl, source: fetched.source ?? initialSource, error: fetched.error }
    }
    return {
      ok: true,
      current,
      latest: fetched.manifest.version,
      available: compareVersions(fetched.manifest.version, current) === 1,
      notes: fetched.manifest.notes,
      manifestUrl: fetched.manifestUrl,
      source: fetched.source,
      files: fetched.manifest.files.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
      error: null,
    }
  } catch (error) {
    return { ...emptyCheck(DEFAULT_UPDATE_URL, 'primary'), error: `check-failed: ${describeError(error)}` }
  }
}

/** Pick a fresh directory name inside `directory`, never colliding with one already there. */
function freshDirectoryName(directory, prefix) {
  const stamp = Date.now()
  let name = `${prefix}${stamp}`
  let attempt = 1
  while (existsSync(join(directory, name))) {
    attempt += 1
    name = `${prefix}${stamp}-${attempt}`
  }
  return name
}

/** Remove a path without ever throwing. */
function removeQuietly(path) {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    /* cleanup must never mask the original failure */
  }
}

/** Remove one now-empty directory without ever throwing. */
function removeDirectoryQuietly(path) {
  try {
    rmdirSync(path)
  } catch {
    /* not empty, or already gone: both are fine */
  }
}

/**
 * Create the parent directory of one manifest path inside `root`, recording what was created.
 *
 * Recorded rather than pre-created in a separate pass: this runs as the first step of placing one file,
 * so a target tree that cannot accept the file fails inside the replace loop and goes through the same
 * rollback as a failed rename. Rollback removes the directories again, deepest first.
 */
function ensureParentDirectory(root, relativePath, createdDirectories) {
  const parent = dirname(relativePath)
  if (parent === '.' || parent === '') return
  let current = root
  for (const segment of parent.split('/')) {
    current = join(current, segment)
    if (existsSync(current)) continue
    try {
      mkdirSync(current)
    } catch (error) {
      // Another process may have created it between the check and the call; only a real failure throws.
      if (error === null || error === undefined || error.code !== 'EEXIST') throw error
    }
    createdDirectories.push(current)
  }
}

/**
 * Replace `target` with `source` by rename.
 *
 * The primary path is a single `renameSync`, which is atomic on POSIX and is MoveFileEx-with-replace on
 * Windows. Some Windows setups still refuse the replace (read-only target, an antivirus holding the
 * file, a directory where a file is expected); then unlink-then-rename is attempted so a locked-then-
 * recoverable target does not fail the whole update. If that also fails, the error propagates and the
 * replace loop rolls back — the fallback is never allowed to leave a half-replaced bundle behind.
 */
function renameWithReplace(source, target) {
  try {
    renameSync(source, target)
    return
  } catch (error) {
    const code = error !== null && error !== undefined && typeof error === 'object' ? error.code : undefined
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTEMPTY' && code !== 'EISDIR') throw error
  }
  try {
    unlinkSync(target)
  } catch (error) {
    if (error === null || error === undefined || error.code !== 'ENOENT') throw error
  }
  renameSync(source, target)
}

/**
 * Restore every replaced path from the backup directory and remove newly created files.
 *
 * New files (no backup entry) are deleted, not emptied: "restore the originals" means the target tree
 * is byte-identical to what it was, including the absence of files the failed attempt created.
 *
 * @returns `{restored:true}` or `{restored:false, error}`; an incomplete rollback keeps the backup.
 */
function rollbackFiles(directory, backupDir, replaced, originals, createdDirectories) {
  const problems = []
  for (const relativePath of [...replaced].reverse()) {
    const target = join(directory, relativePath)
    const originalHash = originals.get(relativePath)
    try {
      if (originalHash === undefined) rmSync(target, { force: true })
      else copyFileSync(join(backupDir, relativePath), target)
    } catch (error) {
      problems.push(`${relativePath}: restore failed: ${describeError(error)}`)
      continue
    }
    try {
      if (originalHash === undefined) {
        if (existsSync(target)) problems.push(`${relativePath}: new file still present`)
      } else if (sha256Hex(readFileSync(target)) !== originalHash) {
        problems.push(`${relativePath}: restored bytes differ from the original`)
      }
    } catch (error) {
      problems.push(`${relativePath}: read-back after restore failed: ${describeError(error)}`)
    }
  }
  for (const createdDirectory of [...createdDirectories].reverse()) removeDirectoryQuietly(createdDirectory)
  return problems.length === 0 ? { restored: true } : { restored: false, error: problems.join('; ') }
}

/**
 * Whether a canonical path is `parent` itself or lies under it.
 *
 * Windows paths are compared case-insensitively (the filesystem is), and the separator is part of the
 * prefix test so `C:\plugin` cannot cover `C:\plugin-evil` by name.
 */
function isPathInside(parent, candidate) {
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const foldedParent = fold(parent)
  const foldedCandidate = fold(candidate)
  if (foldedCandidate === foldedParent) return true
  const boundary = foldedParent.endsWith(sep) ? foldedParent : `${foldedParent}${sep}`
  return foldedCandidate.startsWith(boundary)
}

/**
 * Refuse a replace whose target is redirected outside the plugin directory by a symlink/junction.
 *
 * Manifest path validation is lexical: it rejects `..`, absolute paths and separators, but it cannot
 * know that `host/locale` is a directory junction pointing at `C:\Windows\Temp`. If it were followed,
 * `rename` would place a file outside the plugin directory while every check above still passed. So,
 * right before the first write, resolve the deepest EXISTING ancestor of every target with
 * `realpathSync` and require the result to stay under `realpath(directory)`.
 *
 * Walking up matters: a manifest may create `host/foreign/new.js` where `host/foreign` does not exist
 * yet, and `realpathSync` on a missing path throws. The loop stops at the plugin directory, which is
 * known to exist. If an ancestor exists but cannot be resolved, that is refused too — an unreadable
 * path is not a safe path.
 *
 * @returns `{ok:true}` or `{ok:false, error}`; never throws.
 */
function checkTargetContainment(directory, entries) {
  let root
  try {
    root = realpathSync(directory)
  } catch (error) {
    return failure('target-containment-failed', `cannot resolve the plugin directory: ${describeError(error)}`)
  }
  for (const entry of entries) {
    let ancestor = dirname(join(directory, entry.path))
    try {
      // The plugin directory always exists, so the walk terminates there even for a brand-new tree.
      while (ancestor !== directory && !existsSync(ancestor)) {
        const next = dirname(ancestor)
        if (next === ancestor) break
        ancestor = next
      }
      const canonical = realpathSync(ancestor)
      if (!isPathInside(root, canonical)) {
        return failure('target-escapes-plugin', `${entry.path}: ${ancestor} resolves to ${canonical}, outside ${root}`)
      }
    } catch (error) {
      return failure('target-containment-failed', `${entry.path}: cannot resolve ${ancestor}: ${describeError(error)}`)
    }
  }
  return { ok: true }
}

/**
 * Refuse a manifest target that is a symbolic link or a junction.
 *
 * The replace itself would not write through a link (rename replaces the link entry), but the BACKUP
 * phase copies each existing target first, and `copyFileSync` follows a file symlink: a pre-existing
 * link inside the plugin directory could make the updater copy bytes from outside the plugin directory
 * into `.update-backup-*` and report that directory on the page. So the link must be detected without
 * touching its target — `lstatSync`, never `statSync`/`existsSync` (both follow, and `existsSync` even
 * reports a dangling link as absent). A dangling link is refused too: replacing it would still be a
 * link-directed write decision the manifest did not earn.
 *
 * Junction detection on Windows comes for free: a directory junction is a reparse point, and `lstatSync`
 * reports it as a symbolic link. This runs before the staging directory is created, so a refusal leaves
 * no trace.
 *
 * @returns `{ok:true}` or `{ok:false, error}`; never throws.
 */
function checkTargetsAreNotLinks(directory, entries) {
  for (const entry of entries) {
    let stats
    try {
      stats = lstatSync(join(directory, entry.path))
    } catch (error) {
      // An absent target is the normal case (a new file); anything else is refused rather than guessed.
      if (error !== null && error !== undefined && error.code === 'ENOENT') continue
      return failure('target-inspection-failed', `${entry.path}: ${describeError(error)}`)
    }
    if (stats.isSymbolicLink()) {
      return failure('target-is-link', `${entry.path} exists as a symbolic link or junction; refusing to replace it`)
    }
  }
  return { ok: true }
}

/**
 * Write the verified bytes: staging → backup → rename over → read back → drop staging.
 *
 * `entries` is one array of `{path, bytes, sha256}` where `bytes` are the already verified downloaded
 * buffers. All writes below happen only after the whole download and verification phase succeeded, and
 * after {@link checkTargetContainment} has proven no symlink/junction redirects a target out of the
 * plugin directory (ancestors) and {@link checkTargetsAreNotLinks} has proven no target is itself a
 * link (so the backup phase never follows one).
 *
 * @returns `{ok:true, backupDir}` or `{ok:false, error, backupDir?}`; never throws.
 */
function writeFiles(directory, from, to, entries) {
  // 0. Refuse redirects and links before creating anything: not even the staging directory exists yet.
  const containment = checkTargetContainment(directory, entries)
  if (!containment.ok) return containment
  const links = checkTargetsAreNotLinks(directory, entries)
  if (!links.ok) return links

  const backupPrefix = `${BACKUP_PREFIX}${String(from).replace(/[^0-9A-Za-z._-]/g, '_')}-`
  const stagingDir = join(directory, freshDirectoryName(directory, STAGING_PREFIX))
  const createdDirectories = []
  const replaced = []
  const originals = new Map()
  let backupDir = null

  // 1. Stage every file. A failure here cannot have touched an original yet.
  try {
    mkdirSync(stagingDir)
    for (const entry of entries) {
      const staged = join(stagingDir, entry.path)
      mkdirSync(dirname(staged), { recursive: true })
      writeFileSync(staged, entry.bytes)
    }
  } catch (error) {
    removeQuietly(stagingDir)
    return failure('staging-failed', describeError(error))
  }

  // 2. Back up every original that is about to be replaced. Again: nothing original is modified yet.
  try {
    backupDir = join(directory, freshDirectoryName(directory, backupPrefix))
    mkdirSync(backupDir)
    for (const entry of entries) {
      const target = join(directory, entry.path)
      // lstat, not stat/existsSync: those follow a link. The preflight already refused links, so this
      // only matters for the race where a local actor swaps the target for a link between the two
      // phases — and then the backup must fail rather than copy the link's target into `.update-backup-*`.
      let targetStats
      try {
        targetStats = lstatSync(target)
      } catch (error) {
        if (error !== null && error !== undefined && error.code === 'ENOENT') continue
        throw error
      }
      if (targetStats.isSymbolicLink()) throw new Error(`${entry.path} became a symbolic link after validation; refusing`)
      if (!targetStats.isFile()) throw new Error(`${entry.path} exists and is not a regular file`)
      const backupTarget = join(backupDir, entry.path)
      mkdirSync(dirname(backupTarget), { recursive: true })
      copyFileSync(target, backupTarget)
      // Hash the BACKUP, not the target: that is the byte sequence rollback will restore, so it is the
      // one the post-rollback read-back must match.
      originals.set(entry.path, sha256Hex(readFileSync(backupTarget)))
    }
  } catch (error) {
    removeQuietly(stagingDir)
    if (backupDir !== null) removeQuietly(backupDir)
    return failure('backup-failed', describeError(error))
  }

  // 3. Replace, one rename per file.
  try {
    for (const entry of entries) {
      const staged = join(stagingDir, entry.path)
      const target = join(directory, entry.path)
      ensureParentDirectory(directory, entry.path, createdDirectories)
      renameWithReplace(staged, target)
      replaced.push(entry.path)
    }
  } catch (error) {
    const rollback = rollbackFiles(directory, backupDir, replaced, originals, createdDirectories)
    removeQuietly(stagingDir)
    if (rollback.restored) removeQuietly(backupDir)
    const detail = `${describeError(error)}${rollback.restored ? '' : `; rollback incomplete (${rollback.error}); backups kept at ${backupDir}`}`
    return rollback.restored ? failure('replace-failed', detail) : { ...failure('replace-failed', detail), backupDir }
  }

  // 4. Read the whole file back and re-verify. This catches a write that "succeeded" with stale or
  //    truncated content (a cache, an antivirus rewrite, a full disk that reported success).
  try {
    for (const entry of entries) {
      const written = readFileSync(join(directory, entry.path))
      if (written.length !== entry.bytes.length) {
        throw new Error(`${entry.path}: read back ${written.length} bytes, expected ${entry.bytes.length}`)
      }
      if (sha256Hex(written) !== entry.sha256) throw new Error(`${entry.path}: read-back hash differs`)
    }
  } catch (error) {
    const rollback = rollbackFiles(directory, backupDir, replaced, originals, createdDirectories)
    removeQuietly(stagingDir)
    if (rollback.restored) removeQuietly(backupDir)
    const detail = `${describeError(error)}${rollback.restored ? '' : `; rollback incomplete (${rollback.error}); backups kept at ${backupDir}`}`
    return rollback.restored ? failure('readback-mismatch', detail) : { ...failure('readback-mismatch', detail), backupDir }
  }

  // 5. The replacement is verified; only the staging copy is garbage now. The backup stays: it is the
  //    documented recovery path (`backupDir` in the success result) for a bundle that starts failing.
  removeQuietly(stagingDir)
  return { ok: true, backupDir }
}

/**
 * Download, verify, replace, read back, and roll back on failure.
 *
 * Success returns `{ok:true, from, to, files:[path], backupDir, reload:'restart-required', error:null}`.
 * Failure returns `{ok:false, error, from, to, files:[], backupDir:null, reload:null}`; after a failure
 * that happened while writing, the originals are byte-identical to before the call.
 *
 * The function never throws and never rejects. It refuses a second concurrent call with
 * `error:'already-running'`, refuses a directory without a readable `package.json`, refuses a manifest
 * whose version is not strictly newer than the installed one, refuses a manifest without a
 * `package.json` entry (`missing-package-json`) or whose downloaded `package.json` version differs from
 * `manifest.version` (`version-mismatch`), refuses a target redirected outside the plugin directory by
 * a symlink/junction (`target-escapes-plugin`), and refuses a target that is itself a symbolic link or
 * junction (`target-is-link`). Every refusal happens before the first write, so the installed tree is
 * untouched.
 *
 * @param options `{fetchImpl?, manifestUrl?, directory, signal?}`.
 * @returns the result shape above.
 */
export async function applyUpdate(options) {
  if (applying) {
    return { ok: false, error: 'already-running', from: null, to: null, files: [], backupDir: null, reload: null }
  }
  applying = true
  let from = null
  let to = null
  const fail = (code, detail) => ({
    ok: false,
    error: failure(code, detail).error,
    from,
    to,
    files: [],
    backupDir: null,
    reload: null,
  })
  try {
    const settings = options !== null && typeof options === 'object' ? options : null
    if (settings === null) return fail('invalid-options')
    const fetchImpl = resolveFetch(settings.fetchImpl)
    if (fetchImpl === null) return fail('no-fetch')
    const rawDirectory = settings.directory
    if (typeof rawDirectory !== 'string' || rawDirectory.length === 0) return fail('no-directory')
    const directory = resolve(rawDirectory)
    let stat
    try {
      stat = statSync(directory)
    } catch (error) {
      return fail('not-a-directory', describeError(error))
    }
    if (!stat.isDirectory()) return fail('not-a-directory', directory)
    from = readCurrentVersion(directory)
    if (from === null) {
      // Distinguish the two causes: "you pointed me at the wrong directory" and "your package.json is
      // damaged" need different fixes, and the page shows this string verbatim.
      return fail(existsSync(join(directory, 'package.json')) ? 'current-version-unavailable' : 'no-package.json', directory)
    }

    const fetched = await downloadManifest(fetchImpl, settings.manifestUrl, settings.signal)
    if (!fetched.ok) return fail(fetched.error === 'aborted' ? 'aborted' : 'manifest-unavailable', fetched.error)
    to = fetched.manifest.version
    if (compareVersions(to, from) !== 1) return fail('not-newer', `installed ${from}, manifest ${to}`)

    // Phase 1: download everything into memory. No disk writes can happen before this loop ends.
    const downloaded = []
    let totalBytes = 0
    for (const file of fetched.manifest.files) {
      let fileUrl
      try {
        fileUrl = new URL(file.path, fetched.manifestUrl)
      } catch (error) {
        return fail('file-url-invalid', `${file.path}: ${describeError(error)}`)
      }
      const response = await requestBytes(fileUrl.href, fetchImpl, settings.signal, MAX_FILE_BYTES, file.path)
      if (!response.ok) {
        if (response.error === 'aborted') return fail('aborted')
        return fail('download-failed', `${file.path}: ${response.error}`)
      }
      totalBytes += response.bytes.length
      if (totalBytes > MAX_TOTAL_BYTES) return fail('total-too-large', `more than ${MAX_TOTAL_BYTES} bytes arrived`)
      downloaded.push(response.bytes)
    }

    // Phase 2: verify every byte length and hash. Still nothing on disk has been touched.
    for (let index = 0; index < fetched.manifest.files.length; index += 1) {
      const file = fetched.manifest.files[index]
      const bytes = downloaded[index]
      if (bytes.length !== file.bytes) {
        return fail('byte-count-mismatch', `${file.path}: manifest says ${file.bytes} bytes, downloaded ${bytes.length}`)
      }
      if (sha256Hex(bytes) !== file.sha256) return fail('sha256-mismatch', file.path)
    }

    // Phase 2b: the version the update will actually install must be the version the manifest claims.
    //
    // `readCurrentVersion` reads package.json, so a manifest that never lists package.json can never
    // move the installed version: the page would offer the same update forever. And a split-brain
    // manifest could declare 2.0.0 while shipping package.json 0.9.0, making the checker and the
    // runtime disagree after a "successful" apply. Both cases are refused before the first write, and
    // the comparison uses the DOWNLOADED bytes — what will really land — not the manifest's claim.
    const packageIndex = fetched.manifest.files.findIndex((file) => file.path === 'package.json')
    if (packageIndex === -1) {
      return fail('missing-package-json', 'the manifest lists no package.json, so an apply could not move the installed version')
    }
    const shippedVersion = readShippedVersion(downloaded[packageIndex])
    if (shippedVersion === null) {
      return fail('version-mismatch', 'the shipped package.json has no readable version string')
    }
    if (shippedVersion !== to) {
      return fail('version-mismatch', `manifest says ${to}, shipped package.json says ${shippedVersion}`)
    }

    // Phase 3: the only phase that writes.
    const entries = fetched.manifest.files.map((file, index) => ({ path: file.path, bytes: downloaded[index], sha256: file.sha256 }))
    const installed = writeFiles(directory, from, to, entries)
    if (!installed.ok) {
      // Keep the inner code (`staging-failed`, `backup-failed`, `replace-failed`, `readback-mismatch`)
      // as the leading token: the page renders it, and the tests assert it.
      return { ok: false, error: installed.error, from, to, files: [], backupDir: installed.backupDir ?? null, reload: null }
    }
    return {
      ok: true,
      from,
      to,
      files: fetched.manifest.files.map((file) => file.path),
      backupDir: installed.backupDir,
      // Replacing files on disk cannot reload a mounted Cordis row. Saying anything else would make
      // the page promise a restart it cannot perform.
      reload: 'restart-required',
      error: null,
    }
  } catch (error) {
    return fail('apply-failed', describeError(error))
  } finally {
    applying = false
  }
}
