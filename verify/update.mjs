#!/usr/bin/env node
/**
 * Standalone verification for the in-app update module �?run `node verify/update.mjs`.
 *
 * Plain `node`, no test runner, no network beyond a loopback HTTP server, no npm dependencies. The
 * suite starts a real `node:http` server on `127.0.0.1:0` and serves a manifest plus its files from a
 * temporary "remote" directory, then drives the REAL `host/update.js` against temporary fake plugin
 * directories. Nothing under the repository is written; everything lives under the OS temp directory
 * and is removed at the end.
 *
 * Why an HTTP server instead of a fake `fetch`: the module's contract is about bytes on a wire (size
 * caps, status codes, relative file resolution against the manifest address). A fake `fetch` returning
 * canned objects cannot prove the streaming cap, the content-length short circuit, or that file URLs
 * resolve against the address that actually served the manifest. Loopback keeps it offline and fast.
 *
 * Coverage, in order:
 *   1. the frozen module surface and the trust-root constant shared with `host/config.js`
 *   2. `compareVersions` (numeric ordering, prereleases, build metadata, unknown shapes)
 *   3. `readCurrentVersion` (honest nulls for every failure)
 *   4. `parseManifest` (schema, version, path safety, hashes, byte bounds, duplicates, totality)
 *   5. `checkUpdate` (available / current / malformed / custom address / no fallback / oversized /
 *      redirect refusal / abort / no disk writes)
 *   6. `applyUpdate` (byte-count and hash mismatches, one-good-one-bad, traversal, oversize, total cap,
 *      missing package.json, not-newer, concurrent refusal, abort, fetch failure — all proving that
 *      nothing on disk changed)
 *   7. a successful apply (new bytes, nested new file, backups kept, unlisted files untouched,
 *      `reload:'restart-required'`, package.json version move)
 *   8. a replace-phase failure (rollback restores every original byte-for-byte)
 *
 * Exits non-zero when any check fails and prints one line per check, so a pasted report is
 * self-explanatory.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  DEFAULT_UPDATE_URL,
  FALLBACK_UPDATE_URL,
  MAX_FILE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_TOTAL_BYTES,
  UPDATE_MANIFEST_SCHEMA,
  applyUpdate,
  checkUpdate,
  compareVersions,
  parseManifest,
  readCurrentVersion,
} from '../host/update.js'
import { DEFAULT_UPDATE_URL as CONFIG_DEFAULT_UPDATE_URL } from '../host/config.js'

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// harness
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'dsh-update-verify-'))
const REMOTE_DIR = join(TEMP_ROOT, 'remote')
const PLUGIN_ROOT = join(TEMP_ROOT, 'plugins')
mkdirSync(REMOTE_DIR, { recursive: true })
mkdirSync(PLUGIN_ROOT, { recursive: true })

let checks = 0
let failures = 0

async function check(label, run) {
  checks += 1
  try {
    await run()
    console.log(`  ok    ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL  ${label}`)
    const text = error !== null && error !== undefined && typeof error.stack === 'string' ? error.stack : String(error)
    for (const line of text.split('\n').slice(0, 8)) console.log(`        ${line}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

/** SHA-256 of bytes as lowercase hex. */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** `true` when `child` is inside `parent` (both resolved). */
function isInside(parent, child) {
  const prefix = resolve(parent)
  const target = resolve(child)
  return target === prefix || target.startsWith(`${prefix}${process.platform === 'win32' ? '\\' : '/'}`)
}

// ── the loopback "remote": a mutable set of served bytes ────────────────────────────────────────────

const state = {
  /** Body of `/update-manifest.json`. */
  manifest: '',
  /** Status of `/update-manifest.json`. */
  manifestStatus: 200,
  /** Location header; when set the manifest route answers 302. */
  redirectTo: null,
  /** pathname → {status, body}; wins over files on disk. */
  overrides: new Map(),
  /** Artificial latency, so a concurrent call is guaranteed to observe an in-flight apply. */
  delayMs: 0,
  /** Every request the server saw, as `METHOD path`. */
  requests: [],
}

const server = createServer((request, response) => {
  response.on('error', () => {})
  let pathname = '/'
  try {
    pathname = new URL(request.url, 'http://127.0.0.1').pathname
  } catch {
    pathname = '/'
  }
  state.requests.push(`${request.method ?? 'GET'} ${pathname}`)
  void respond(pathname, response)
})

function sendBuffer(response, status, body) {
  try {
    response.writeHead(status, { 'content-length': String(body.length), 'content-type': 'application/octet-stream' })
    response.end(body)
  } catch {
    /* the client may have gone away after cancelling an oversized read */
  }
}

async function respond(pathname, response) {
  try {
    if (state.delayMs > 0) await new Promise((done) => setTimeout(done, state.delayMs))
    if (state.redirectTo !== null) {
      response.writeHead(302, { location: state.redirectTo })
      response.end()
      return
    }
    const override = state.overrides.get(pathname)
    if (override !== undefined) {
      sendBuffer(response, override.status, override.body)
      return
    }
    if (pathname === '/update-manifest.json') {
      sendBuffer(response, state.manifestStatus, Buffer.from(state.manifest, 'utf8'))
      return
    }
    const relativePath = decodeURIComponent(pathname.replace(/^\/+/, ''))
    const filePath = resolve(REMOTE_DIR, relativePath)
    if (!isInside(REMOTE_DIR, filePath)) {
      sendBuffer(response, 404, Buffer.from('not found'))
      return
    }
    let bytes
    try {
      bytes = readFileSync(filePath)
    } catch {
      sendBuffer(response, 404, Buffer.from('not found'))
      return
    }
    sendBuffer(response, 200, bytes)
  } catch {
    try {
      response.destroy()
    } catch {
      /* nothing left to do */
    }
  }
}

server.on('clientError', (error, socket) => {
  try {
    socket.destroy()
  } catch {
    /* the socket is already gone */
  }
})

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const ORIGIN = `http://127.0.0.1:${server.address().port}`
const MANIFEST_URL = `${ORIGIN}/update-manifest.json`

/** Reset the remote between checks: no files, no manifest, no overrides, no recorded requests. */
function resetRemote() {
  rmSync(REMOTE_DIR, { recursive: true, force: true })
  mkdirSync(REMOTE_DIR, { recursive: true })
  state.manifest = ''
  state.manifestStatus = 200
  state.redirectTo = null
  state.overrides.clear()
  state.delayMs = 0
  state.requests.length = 0
}

// ── temporary plugin directories ───────────────────────────────────────────────────────────────────

let pluginCounter = 0

/** Write one file (creating parents) under `root`. */
function writeFileAt(root, relativePath, data) {
  const target = join(root, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, data)
  return Buffer.isBuffer(data) ? data : Buffer.from(data)
}

/** Create a fake plugin directory with a `package.json` at `version` and the given files. */
function pluginDir({ version = '1.0.0', files = {} } = {}) {
  pluginCounter += 1
  const directory = join(PLUGIN_ROOT, `plugin-${pluginCounter}`)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'package.json'),
    `${JSON.stringify({ name: '@local/dsh-session-log-upload', version, private: true, type: 'module' }, null, 2)}\n`,
  )
  for (const [relativePath, data] of Object.entries(files)) writeFileAt(directory, relativePath, data)
  return directory
}

/** Every file under `root`, relative, in sorted order. */
function walkFiles(root, base = '') {
  const output = []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return output
  }
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    const relativePath = base.length === 0 ? entry.name : `${base}/${entry.name}`
    if (entry.isDirectory()) output.push(...walkFiles(join(root, entry.name), relativePath))
    else if (entry.isFile()) output.push(relativePath)
  }
  return output
}

/** A content snapshot of a directory tree: path + hash per file, sorted. */
function snapshot(root) {
  return walkFiles(root)
    .map((relativePath) => `${relativePath} ${sha256(readFileSync(join(root, relativePath)))}`)
    .join('\n')
}

/** The `.update-*` entries directly under a directory. */
function updateLeftovers(root) {
  return readdirSync(root).filter((name) => name.startsWith('.update-'))
}

/** The package.json text this plugin would carry at `version`. */
function packageJsonFor(version) {
  return `${JSON.stringify({ name: '@local/dsh-session-log-upload', version, private: true, type: 'module' }, null, 2)}\n`
}

/** One manifest file entry from bytes. */
function fileEntry(path, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
  return { path, bytes: bytes.length, sha256: sha256(bytes) }
}

/** A valid manifest object for `version` and `[path, data]` pairs. */
function manifestFor({ version = '1.1.0', notes = 'test release', files = [['index.js', 'index']] } = {}) {
  return {
    schema: UPDATE_MANIFEST_SCHEMA,
    version,
    notes,
    files: files.map(([path, data]) => fileEntry(path, data)),
  }
}

/** Serve `manifest` (object or string) and write the remote copies of `[path, data]` pairs. */
function publish(manifest, files = []) {
  for (const [relativePath, data] of files) {
    if (!isInside(REMOTE_DIR, resolve(REMOTE_DIR, relativePath))) continue
    writeFileAt(REMOTE_DIR, relativePath, data)
  }
  state.manifest = typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
  return typeof manifest === 'string' ? null : manifest
}

/** Serve a raw body for one pathname, overriding whatever is on disk. */
function serveBody(pathname, data, status = 200) {
  state.overrides.set(pathname, { status, body: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') })
}

/**
 * A minimal `Response`-shaped object for the fake `fetch` used by the fallback checks.
 *
 * The module reads `{ok, status, headers, body, arrayBuffer}` and nothing else, so this exercises the
 * real code path without a socket. Used only to force the default address to fail: the fallback rule is
 * keyed on the address string, and there is no way to make raw.githubusercontent.com fail on demand.
 */
function fakeResponse(bytes) {
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: null,
    arrayBuffer: async () => copy.buffer,
  }
}

const VALID_SHA = sha256(Buffer.from('x'))

/** A structurally valid envelope with one file entry. */
function envelope(overrides = {}) {
  return JSON.stringify({
    schema: UPDATE_MANIFEST_SCHEMA,
    version: '1.1.0',
    files: [{ path: 'index.js', bytes: 1, sha256: VALID_SHA }],
    ...overrides,
  })
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
section('1. frozen surface and the version comparator')
// ─────────────────────────────────────────────────────────────────────────────────────────────────

await check('the contract constants are the frozen values', () => {
  assert.equal(UPDATE_MANIFEST_SCHEMA, 1)
  assert.equal(MAX_MANIFEST_BYTES, 256 * 1024)
  assert.equal(MAX_FILE_BYTES, 4 * 1024 * 1024)
  assert.equal(MAX_TOTAL_BYTES, 16 * 1024 * 1024)
  assert.equal(typeof readCurrentVersion, 'function')
  assert.equal(typeof compareVersions, 'function')
  assert.equal(typeof parseManifest, 'function')
  assert.equal(typeof checkUpdate, 'function')
  assert.equal(typeof applyUpdate, 'function')
})

await check('the trust-root address is shared with host/config.js, not copied', () => {
  assert.match(DEFAULT_UPDATE_URL, /^https:\/\/raw\.githubusercontent\.com\/guguzea\/dsh-zcode-like\/main\/update-manifest\.json$/)
  assert.match(FALLBACK_UPDATE_URL, /^https:\/\/cdn\.jsdelivr\.net\/gh\/guguzea\/dsh-zcode-like@main\/update-manifest\.json$/)
  // Two different strings in the two modules would mean the page shows a different trust root than the
  // updater uses. config.js owns it; update.js re-exports the same binding.
  assert.equal(DEFAULT_UPDATE_URL, CONFIG_DEFAULT_UPDATE_URL, 'update.js and config.js disagree about the manifest address')
})

await check('compareVersions orders numerically, not as strings', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1)
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1)
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1)
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1)
  assert.equal(compareVersions('10.0.0', '9.0.0'), 1)
})

await check('compareVersions treats a missing segment as zero', () => {
  assert.equal(compareVersions('1.0', '1.0.0'), 0)
  assert.equal(compareVersions('1', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.0.1', '1.0.0'), 1)
  assert.equal(compareVersions('1.0.0.0', '1.0.0'), 0)
})

await check('compareVersions orders prereleases below releases and compares them per SemVer', () => {
  assert.equal(compareVersions('1.1.0-beta.1', '1.1.0'), -1)
  assert.equal(compareVersions('1.1.0', '1.1.0-beta.1'), 1)
  assert.equal(compareVersions('1.1.0-alpha', '1.1.0-beta'), -1)
  assert.equal(compareVersions('1.1.0-beta.2', '1.1.0-beta.10'), -1)
  assert.equal(compareVersions('1.1.0-beta.10', '1.1.0-beta.2'), 1)
  assert.equal(compareVersions('1.1.0-beta', '1.1.0-beta.1'), -1)
  assert.equal(compareVersions('1.1.0-1', '1.1.0-alpha'), -1)
  assert.equal(compareVersions('1.1.0-beta', '1.1.0-beta'), 0)
})

await check('compareVersions ignores build metadata', () => {
  assert.equal(compareVersions('1.1.0+build.1', '1.1.0'), 0)
  assert.equal(compareVersions('1.1.0+aaa', '1.1.0+zzz'), 0)
  assert.equal(compareVersions('1.1.0-beta+x', '1.1.0-beta+y'), 0)
})

await check('compareVersions returns null, never throws, for unrecognised shapes', () => {
  for (const bad of ['', 'v1.0.0', '1.0.0.0.0', '1..0', '1.0.0-', '1.0.0+', ' 1.0.0', '1.0.0 ', 'latest', '1.0.x', 'one.two.three']) {
    assert.equal(compareVersions(bad, '1.0.0'), null, `left ${JSON.stringify(bad)}`)
    assert.equal(compareVersions('1.0.0', bad), null, `right ${JSON.stringify(bad)}`)
  }
  for (const bad of [undefined, null, 42, 1.5, true, {}, [], () => {}]) {
    assert.equal(compareVersions(bad, '1.0.0'), null, `left ${String(bad)}`)
  }
  assert.equal(compareVersions('1.0.0'), null)
})

await check('readCurrentVersion reads package.json and reports honest nulls', () => {
  assert.equal(readCurrentVersion(pluginDir({ version: '2.3.4' })), '2.3.4')
  assert.equal(readCurrentVersion(pluginDir({ version: '1.0.0-beta.1' })), '1.0.0-beta.1')

  const brokenVersion = join(PLUGIN_ROOT, 'broken-version')
  mkdirSync(brokenVersion, { recursive: true })
  writeFileSync(join(brokenVersion, 'package.json'), '{"version":"not a version"}\n')
  assert.equal(readCurrentVersion(brokenVersion), null)

  const brokenJson = join(PLUGIN_ROOT, 'broken-json')
  mkdirSync(brokenJson, { recursive: true })
  writeFileSync(join(brokenJson, 'package.json'), '{"version":\n')
  assert.equal(readCurrentVersion(brokenJson), null)

  const noVersion = join(PLUGIN_ROOT, 'no-version')
  mkdirSync(noVersion, { recursive: true })
  writeFileSync(join(noVersion, 'package.json'), '{"name":"x"}\n')
  assert.equal(readCurrentVersion(noVersion), null)

  const noPackage = join(PLUGIN_ROOT, 'no-package')
  mkdirSync(noPackage, { recursive: true })
  assert.equal(readCurrentVersion(noPackage), null)
  assert.equal(readCurrentVersion(join(PLUGIN_ROOT, 'does-not-exist')), null)
  for (const value of [undefined, null, 42, true, {}, []]) assert.equal(readCurrentVersion(value), null)
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
section('2. parseManifest: schema, version, path safety, hashes, bounds')
// ─────────────────────────────────────────────────────────────────────────────────────────────────

await check('a valid manifest is accepted with normalized paths and defaults', () => {
  const text = JSON.stringify({
    schema: 1,
    version: '1.1.0',
    notes: 'one line',
    files: [
      { path: './host/./a.js', bytes: 1, sha256: VALID_SHA },
      { path: 'host/foreign/b.js', bytes: 2, sha256: VALID_SHA },
    ],
  })
  const result = parseManifest(text, MANIFEST_URL)
  assert.equal(result.ok, true)
  assert.deepEqual(result.manifest, {
    schema: 1,
    version: '1.1.0',
    notes: 'one line',
    files: [
      { path: 'host/a.js', bytes: 1, sha256: VALID_SHA },
      { path: 'host/foreign/b.js', bytes: 2, sha256: VALID_SHA },
    ],
  })
  // A missing `notes` is the empty string, not undefined: the page always renders a string.
  const bare = parseManifest(envelope(), MANIFEST_URL)
  assert.equal(bare.ok, true)
  assert.equal(bare.manifest.notes, '')
  // A leading UTF-8 BOM is stripped rather than failing the whole manifest.
  const bom = parseManifest(`\uFEFF${envelope()}`, MANIFEST_URL)
  assert.equal(bom.ok, true)
  for (const notText of [undefined, null, 42, {}, [], () => {}]) {
    const resultOf = parseManifest(notText, MANIFEST_URL)
    assert.equal(resultOf.ok, false)
    assert.equal(typeof resultOf.error, 'string')
  }
})

await check('malformed envelopes are rejected with a stable code', () => {
  const cases = [
    ['empty text', '', /manifest-empty/],
    ['not JSON', 'this is not json', /manifest-not-json/],
    ['a JSON array', '[]', /manifest-not-object/],
    ['JSON null', 'null', /manifest-not-object/],
    ['a JSON string', '"manifest"', /manifest-not-object/],
    ['schema 2', envelope({ schema: 2 }), /manifest-schema/],
    ['schema as a string', envelope({ schema: '1' }), /manifest-schema/],
    ['missing schema', JSON.stringify({ version: '1.1.0', files: [{ path: 'index.js', bytes: 1, sha256: VALID_SHA }] }), /manifest-schema/],
    ['missing version', envelope({ version: undefined }), /manifest-version/],
    ['uncomparable version', envelope({ version: 'v1.1.0' }), /manifest-version/],
    ['version object', envelope({ version: {} }), /manifest-version/],
    ['notes object', envelope({ notes: {} }), /manifest-notes/],
    ['empty files', envelope({ files: [] }), /manifest-files/],
    ['files missing', JSON.stringify({ schema: 1, version: '1.1.0' }), /manifest-files/],
    ['files object', envelope({ files: {} }), /manifest-files/],
  ]
  for (const [label, text, pattern] of cases) {
    const result = parseManifest(text, MANIFEST_URL)
    assert.equal(result.ok, false, label)
    assert.match(result.error, pattern, label)
  }
})

await check('paths that are absolute, traversing or non-normalized are refused', () => {
  const unsafe = [
    '',
    '/etc/passwd',
    '/',
    '../evil.js',
    'a/../../evil.js',
    '..',
    'a//b.js',
    'a/',
    'a\\b.js',
    'C:/windows/system32',
    '\\\\server\\share\\x.js',
    'a b.js',
    'a:b.js',
    'a.js.',
    'host/.js/',
    '.',
    './',
    'file\u0000.js',
    'a'.repeat(600) + '.js',
  ]
  for (const path of unsafe) {
    const text = JSON.stringify({ schema: 1, version: '1.1.0', files: [{ path, bytes: 1, sha256: VALID_SHA }] })
    const result = parseManifest(text, MANIFEST_URL)
    assert.equal(result.ok, false, `path ${JSON.stringify(path)} must be refused`)
    assert.match(result.error, /manifest-path/, `path ${JSON.stringify(path)}: ${result.error}`)
  }
})

await check('malformed file entries are refused', () => {
  const base = { path: 'index.js', bytes: 1, sha256: VALID_SHA }
  const cases = [
    ['entry null', [null]],
    ['entry array', [[]]],
    ['entry string', ['index.js']],
    ['missing path', [{ bytes: 1, sha256: VALID_SHA }]],
    ['path number', [{ path: 42, bytes: 1, sha256: VALID_SHA }]],
    ['negative bytes', [{ ...base, bytes: -1 }]],
    ['fractional bytes', [{ ...base, bytes: 1.5 }]],
    ['string bytes', [{ ...base, bytes: '1' }]],
    ['missing bytes', [{ path: 'index.js', sha256: VALID_SHA }]],
    ['uppercase sha256', [{ ...base, sha256: VALID_SHA.toUpperCase() }]],
    ['short sha256', [{ ...base, sha256: VALID_SHA.slice(0, 63) }]],
    ['long sha256', [{ ...base, sha256: `${VALID_SHA}0` }]],
    ['non-hex sha256', [{ ...base, sha256: 'z'.repeat(64) }]],
    ['missing sha256', [{ path: 'index.js', bytes: 1 }]],
  ]
  for (const [label, files] of cases) {
    const result = parseManifest(JSON.stringify({ schema: 1, version: '1.1.0', files }), MANIFEST_URL)
    assert.equal(result.ok, false, label)
  }
})

await check('duplicate paths are refused, including case-insensitive collisions', () => {
  const duplicate = JSON.stringify({
    schema: 1,
    version: '1.1.0',
    files: [
      { path: 'host/a.js', bytes: 1, sha256: VALID_SHA },
      { path: 'host/./a.js', bytes: 2, sha256: VALID_SHA },
    ],
  })
  assert.match(parseManifest(duplicate, MANIFEST_URL).error, /manifest-duplicate-path/)
  const caseCollision = JSON.stringify({
    schema: 1,
    version: '1.1.0',
    files: [
      { path: 'host/A.js', bytes: 1, sha256: VALID_SHA },
      { path: 'host/a.js', bytes: 2, sha256: VALID_SHA },
    ],
  })
  assert.match(parseManifest(caseCollision, MANIFEST_URL).error, /manifest-duplicate-path/)
})

await check('declared per-file and total byte caps are enforced at parse time', () => {
  const tooBig = JSON.stringify({
    schema: 1,
    version: '1.1.0',
    files: [{ path: 'index.js', bytes: MAX_FILE_BYTES + 1, sha256: VALID_SHA }],
  })
  assert.match(parseManifest(tooBig, MANIFEST_URL).error, /manifest-file-too-large/)

  const many = Array.from({ length: 5 }, (_, index) => ({ path: `file-${index}.bin`, bytes: MAX_FILE_BYTES, sha256: VALID_SHA }))
  const tooMuchTotal = JSON.stringify({ schema: 1, version: '1.1.0', files: many })
  assert.match(parseManifest(tooMuchTotal, MANIFEST_URL).error, /manifest-total-too-large/)

  // Exactly at both caps is allowed: the boundary must not be off by one.
  const atLimit = JSON.stringify({
    schema: 1,
    version: '1.1.0',
    files: [{ path: 'index.js', bytes: MAX_FILE_BYTES, sha256: VALID_SHA }],
  })
  assert.equal(parseManifest(atLimit, MANIFEST_URL).ok, true)
})

await check('an oversized manifest body is refused before JSON parsing', () => {
  const text = 'x'.repeat(MAX_MANIFEST_BYTES + 1)
  const result = parseManifest(text, MANIFEST_URL)
  assert.equal(result.ok, false)
  assert.match(result.error, /manifest-too-large/)
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
section('3. checkUpdate: read-only, fallback rules, bounds')
// ─────────────────────────────────────────────────────────────────────────────────────────────────

await check('checkUpdate reports an available update and writes nothing', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0', files: { 'index.js': 'old index', 'notes.txt': 'mine' } })
  const before = snapshot(directory)
  const manifest = manifestFor({ version: '1.1.0', notes: 'fix the thing', files: [['index.js', 'new index']] })
  publish(manifest, [['index.js', 'new index']])
  const result = await checkUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(result.ok, true)
  assert.equal(result.current, '1.0.0')
  assert.equal(result.latest, '1.1.0')
  assert.equal(result.available, true)
  assert.equal(result.notes, 'fix the thing')
  assert.equal(result.manifestUrl, MANIFEST_URL)
  assert.equal(result.source, 'custom')
  assert.equal(result.error, null)
  assert.deepEqual(result.files, manifest.files)
  assert.equal(snapshot(directory), before)
  assert.deepEqual(state.requests, ['GET /update-manifest.json'])
})

await check('checkUpdate says up to date for an equal or older manifest', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.1.0' })
  publish(manifestFor({ version: '1.1.0' }), [['index.js', 'index']])
  let result = await checkUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(result.ok, true)
  assert.equal(result.available, false)

  publish(manifestFor({ version: '1.0.9' }), [['index.js', 'index']])
  result = await checkUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(result.ok, true)
  assert.equal(result.available, false)
  assert.equal(result.latest, '1.0.9')
})

await check('checkUpdate refuses an install with no readable package.json, before any request', async () => {
  resetRemote()
  const directory = join(PLUGIN_ROOT, 'check-no-package')
  mkdirSync(directory, { recursive: true })
  const result = await checkUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(result.ok, false)
  assert.match(result.error, /current-version-unavailable/)
  assert.equal(result.current, null)
  assert.deepEqual(state.requests, [])
})

await check('checkUpdate rejects a malformed served manifest', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0' })
  publish({ schema: 2, version: '1.1.0', files: [{ path: 'index.js', bytes: 1, sha256: VALID_SHA }] })
  const result = await checkUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(result.ok, false)
  assert.match(result.error, /manifest-schema/)
  assert.equal(result.available, false)
})

await check('a failing custom address is NOT replaced by the fallback', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0' })
  state.manifestStatus = 500
  state.manifest = 'boom'
  const result = await checkUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(result.ok, false)
  assert.match(result.error, /http-error: status 500/)
  assert.equal(result.source, 'custom')
  // Exactly one request: a custom address gets no jsDelivr retry.
  assert.equal(state.requests.length, 1)
})

await check('the default address is reported as source primary when it works', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0' })
  const manifestBytes = Buffer.from(JSON.stringify(manifestFor({ version: '1.1.0', files: [['index.js', 'new index']] })))
  const calls = []
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      if (String(url) === DEFAULT_UPDATE_URL) return fakeResponse(manifestBytes)
      throw new Error(`unexpected request ${String(url)}`)
    }
    const result = await checkUpdate({ directory })
    assert.equal(result.ok, true)
    assert.equal(result.source, 'primary')
    assert.equal(result.manifestUrl, DEFAULT_UPDATE_URL)
    assert.deepEqual(calls, [DEFAULT_UPDATE_URL])
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('the default address falls back to jsDelivr when raw fails', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0' })
  const manifestBytes = Buffer.from(JSON.stringify(manifestFor({ version: '1.1.0', files: [['index.js', 'new index']] })))
  const calls = []
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      if (String(url) === DEFAULT_UPDATE_URL) throw new Error('raw is down')
      if (String(url) === FALLBACK_UPDATE_URL) return fakeResponse(manifestBytes)
      throw new Error(`unexpected request ${String(url)}`)
    }
    // No `manifestUrl`: the default address is the ONLY case allowed to fall back.
    const result = await checkUpdate({ directory })
    assert.equal(result.ok, true)
    assert.equal(result.source, 'fallback')
    assert.equal(result.manifestUrl, FALLBACK_UPDATE_URL)
    assert.equal(result.latest, '1.1.0')
    assert.deepEqual(calls, [DEFAULT_UPDATE_URL, FALLBACK_UPDATE_URL])
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('both default addresses failing reports that the fallback was tried', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0' })
  const calls = []
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      throw new Error('offline')
    }
    const result = await checkUpdate({ directory })
    assert.equal(result.ok, false)
    assert.match(result.error, /transport-error/)
    assert.match(result.error, /fallback:/)
    assert.equal(calls.length, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('a fallback manifest resolves its files against the fallback address', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0', files: { 'index.js': 'old index' } })
  const fileBytes = Buffer.from('new index', 'utf8')
  const manifestBytes = Buffer.from(
    JSON.stringify({
      schema: 1,
      version: '1.1.0',
      notes: '',
      files: [{ path: 'index.js', bytes: fileBytes.length, sha256: sha256(fileBytes) }],
    }),
  )
  const fallbackFileUrl = new URL('index.js', FALLBACK_UPDATE_URL).href
  const calls = []
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (url) => {
      const text = String(url)
      calls.push(text)
      if (text === DEFAULT_UPDATE_URL) throw new Error('raw is down')
      if (text === FALLBACK_UPDATE_URL) return fakeResponse(manifestBytes)
      if (text === fallbackFileUrl) return fakeResponse(fileBytes)
      throw new Error(`unexpected request ${text}`)
    }
    const result = await applyUpdate({ directory })
    assert.equal(result.ok, true)
    assert.equal(readFileSync(join(directory, 'index.js'), 'utf8'), 'new index')
    // Manifest from the fallback, then the file resolved with `new URL(path, manifestUrl)` — i.e. the
    // mirror, not the primary address.
    assert.deepEqual(calls, [DEFAULT_UPDATE_URL, FALLBACK_UPDATE_URL, fallbackFileUrl])
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('a non-HTTP(S) manifest address is refused before any request', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0' })
  for (const manifestUrl of ['ftp://x/y', 'file:///etc/passwd', 'javascript:alert(1)', '//evil.example/x', 'https:/bad', '', 42, {}]) {
    const result = await checkUpdate({ manifestUrl, directory })
    assert.equal(result.ok, false, String(manifestUrl))
    assert.match(result.error, /manifest-url-refused/, String(manifestUrl))
  }
  assert.equal(state.requests.length, 0)
})

await check('an oversized served manifest is refused without being parsed', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0' })
  state.manifest = JSON.stringify({ schema: 1, version: '1.1.0', notes: 'x'.repeat(MAX_MANIFEST_BYTES), files: [] })
  assert.ok(Buffer.byteLength(state.manifest, 'utf8') > MAX_MANIFEST_BYTES)
  const result = await checkUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(result.ok, false)
  assert.match(result.error, /too-large/)
})

await check('a redirect is refused instead of followed', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0' })
  publish(manifestFor(), [['index.js', 'index']])
  state.redirectTo = `${ORIGIN}/elsewhere.json`
  const result = await checkUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(result.ok, false)
  assert.equal(typeof result.error, 'string')
  // The manifest request was made once; the 302 was not followed to a second request.
  assert.equal(state.requests.length, 1)
})

await check('an already-aborted signal stops the check before any request', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0' })
  const controller = new AbortController()
  controller.abort()
  const result = await checkUpdate({ manifestUrl: MANIFEST_URL, directory, signal: controller.signal })
  assert.equal(result.ok, false)
  assert.match(result.error, /aborted/)
  assert.deepEqual(state.requests, [])
})

await check('checkUpdate is total on garbage options', async () => {
  resetRemote()
  for (const options of [undefined, null, 42, 'x', {}, { directory: 42 }, { fetchImpl: 42 }]) {
    const result = await checkUpdate(options)
    assert.equal(result.ok, false)
    assert.equal(typeof result.error, 'string')
  }
  assert.deepEqual(state.requests, [])
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
section('4. applyUpdate: download/verify failures leave the disk untouched')
// ─────────────────────────────────────────────────────────────────────────────────────────────────

await check('a byte-count mismatch is refused and nothing changes', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0', files: { 'index.js': 'old index' } })
  const before = snapshot(directory)
  const manifest = manifestFor({ files: [['index.js', 'new index']] })
  manifest.files[0].bytes += 1
  publish(manifest, [['index.js', 'new index']])
  const result = await applyUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(result.ok, false)
  assert.match(result.error, /byte-count-mismatch/)
  assert.equal(snapshot(directory), before)
  assert.deepEqual(updateLeftovers(directory), [])
})

await check('a sha256 mismatch is refused and nothing changes', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0', files: { 'index.js': 'old index' } })
  const before = snapshot(directory)
  const manifest = manifestFor({ files: [['index.js', 'new index']] })
  manifest.files[0].sha256 = sha256(Buffer.from('something else'))
  publish(manifest, [['index.js', 'new index']])
  const result = await applyUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(result.ok, false)
  assert.match(result.error, /sha256-mismatch/)
  assert.equal(snapshot(directory), before)
  assert.deepEqual(updateLeftovers(directory), [])
})

await check('one good file plus one bad file writes neither', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0', files: { 'index.js': 'old index' } })
  const before = snapshot(directory)
  const manifest = manifestFor({
    files: [
      ['index.js', 'good replacement'],
      ['host/new.js', 'declared bytes'],
    ],
  })
  publish(manifest, [['index.js', 'good replacement']])
  // The second file is tampered with after the manifest was built.
  serveBody('/host/new.js', 'tampered bytes')
  const result = await applyUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(result.ok, false)
  assert.match(result.error, /sha256-mismatch/)
  // Both files were downloaded before any write: manifest + two files.
  assert.equal(state.requests.length, 3)
  assert.equal(snapshot(directory), before)
  assert.deepEqual(updateLeftovers(directory), [])
})

await check('a manifest whose paths escape the plugin directory is refused', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0', files: { 'index.js': 'old index' } })
  const before = snapshot(directory)
  for (const path of ['../evil.js', '/etc/passwd', 'a/../../evil.js', 'C:/evil.js', 'a//b.js', 'a\\b.js']) {
    state.requests.length = 0
    publish(manifestFor({ files: [[path, 'evil']] }))
    const result = await applyUpdate({ manifestUrl: MANIFEST_URL, directory })
    assert.equal(result.ok, false, path)
    assert.match(result.error, /manifest-path/, path)
    // Only the manifest is fetched: the unsafe path never becomes a file URL.
    assert.equal(state.requests.length, 1, path)
  }
  assert.equal(snapshot(directory), before)
  assert.deepEqual(updateLeftovers(directory), [])
})

await check('an oversized file body is refused while it is still streaming', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0', files: { 'index.js': 'old index' } })
  const before = snapshot(directory)
  // The manifest lies about the size so parse-time caps cannot catch it.
  publish(manifestFor({ files: [['index.js', 'x']] }))
  serveBody('/index.js', Buffer.alloc(MAX_FILE_BYTES + 1, 0x61))
  const result = await applyUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(result.ok, false)
  assert.match(result.error, /too-large/)
  assert.equal(snapshot(directory), before)
  assert.deepEqual(updateLeftovers(directory), [])
})

await check('the total-download cap stops a manifest that under-declares every size', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0', files: { 'index.js': 'old index' } })
  const before = snapshot(directory)
  const body = Buffer.alloc(MAX_FILE_BYTES, 0x61)
  const manifest = {
    schema: 1,
    version: '1.1.0',
    notes: '',
    // Each declared size is 1 byte, so parse-time caps pass; each real body is the per-file maximum.
    files: Array.from({ length: 5 }, (_, index) => ({
      path: `file-${index}.bin`,
      bytes: 1,
      sha256: sha256(Buffer.from('x')),
    })),
  }
  publish(manifest)
  for (let index = 0; index < 5; index += 1) serveBody(`/file-${index}.bin`, body)
  const result = await applyUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(result.ok, false)
  assert.match(result.error, /total-too-large/)
  assert.equal(snapshot(directory), before)
  assert.deepEqual(updateLeftovers(directory), [])
})

await check('a directory with no package.json is refused before any request', async () => {
  resetRemote()
  const directory = join(PLUGIN_ROOT, 'apply-no-package')
  mkdirSync(directory, { recursive: true })
  const result = await applyUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(result.ok, false)
  assert.match(result.error, /no-package\.json/)
  assert.deepEqual(state.requests, [])
})

await check('a manifest that is not strictly newer is refused', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.1.0' })
  publish(manifestFor({ version: '1.1.0' }), [['index.js', 'index']])
  let result = await applyUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(result.ok, false)
  assert.match(result.error, /not-newer/)
  // Only the manifest was requested: the version gate runs before any file download.
  assert.equal(state.requests.length, 1)

  publish(manifestFor({ version: '1.0.0' }), [['index.js', 'index']])
  result = await applyUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(result.ok, false)
  assert.match(result.error, /not-newer/)
})

await check('a failing manifest fetch is reported and nothing changes', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0', files: { 'index.js': 'old index' } })
  const before = snapshot(directory)
  state.manifestStatus = 503
  state.manifest = 'unavailable'
  const result = await applyUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(result.ok, false)
  assert.match(result.error, /http-error: status 503/)
  assert.equal(snapshot(directory), before)
  assert.deepEqual(updateLeftovers(directory), [])
})

await check('a second concurrent apply is refused with already-running', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0', files: { 'index.js': 'old index' } })
  publish(manifestFor({ files: [['index.js', 'new index']] }), [['index.js', 'new index']])
  state.delayMs = 25
  const first = applyUpdate({ manifestUrl: MANIFEST_URL, directory })
  const second = await applyUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(second.ok, false)
  assert.equal(second.error, 'already-running')
  const result = await first
  assert.equal(result.ok, true)
  assert.equal(readFileSync(join(directory, 'index.js'), 'utf8'), 'new index')
})

await check('an already-aborted apply changes nothing', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0', files: { 'index.js': 'old index' } })
  const before = snapshot(directory)
  publish(manifestFor({ files: [['index.js', 'new index']] }), [['index.js', 'new index']])
  const controller = new AbortController()
  controller.abort()
  const result = await applyUpdate({ manifestUrl: MANIFEST_URL, directory, signal: controller.signal })
  assert.equal(result.ok, false)
  assert.match(result.error, /aborted/)
  assert.deepEqual(state.requests, [])
  assert.equal(snapshot(directory), before)
})

await check('applyUpdate is total on garbage options', async () => {
  resetRemote()
  for (const options of [
    undefined,
    null,
    42,
    'x',
    {},
    { directory: 42 },
    { directory: join(PLUGIN_ROOT, 'does-not-exist') },
  ]) {
    const result = await applyUpdate(options)
    assert.equal(result.ok, false)
    assert.equal(typeof result.error, 'string')
  }
  assert.deepEqual(state.requests, [])
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
section('5. applyUpdate: the success path and the rollback path')
// ─────────────────────────────────────────────────────────────────────────────────────────────────

await check('a successful apply installs new bytes, keeps backups, and reports restart-required', async () => {
  resetRemote()
  const directory = pluginDir({
    version: '1.0.0',
    files: { 'index.js': 'old index', 'host/keep.js': 'keep me', 'notes.txt': 'my own notes' },
  })
  const originalPackageJson = readFileSync(join(directory, 'package.json'), 'utf8')
  const newPackageJson = packageJsonFor('1.1.0')
  const manifest = manifestFor({
    version: '1.1.0',
    notes: 'the release notes',
    files: [
      ['index.js', 'new index'],
      ['host/new.js', 'a brand new file'],
      ['package.json', newPackageJson],
    ],
  })
  publish(manifest, [
    ['index.js', 'new index'],
    ['host/new.js', 'a brand new file'],
    ['package.json', newPackageJson],
  ])

  const result = await applyUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(result.ok, true)
  assert.equal(result.from, '1.0.0')
  assert.equal(result.to, '1.1.0')
  assert.deepEqual(result.files, manifest.files.map((file) => file.path))
  assert.equal(result.reload, 'restart-required')
  assert.equal(result.error, null)
  assert.equal(typeof result.backupDir, 'string')
  assert.ok(
    result.backupDir.startsWith(join(directory, '.update-backup-1.0.0-')),
    `backupDir ${result.backupDir} must be named after the replaced version`,
  )

  // New bytes, including a file whose parent directory did not exist.
  assert.equal(readFileSync(join(directory, 'index.js'), 'utf8'), 'new index')
  assert.equal(readFileSync(join(directory, 'host/new.js'), 'utf8'), 'a brand new file')
  // Version truth moves with the update, because package.json is one of the listed files. (Without
  // that, the next check would see the old version and offer the same update forever.)
  assert.equal(readCurrentVersion(directory), '1.1.0')
  // Files the manifest does not mention are never touched.
  assert.equal(readFileSync(join(directory, 'host/keep.js'), 'utf8'), 'keep me')
  assert.equal(readFileSync(join(directory, 'notes.txt'), 'utf8'), 'my own notes')

  // Backups: originals only; a file that did not exist has nothing to back up.
  assert.equal(readFileSync(join(result.backupDir, 'index.js'), 'utf8'), 'old index')
  assert.equal(readFileSync(join(result.backupDir, 'package.json'), 'utf8'), originalPackageJson)
  assert.equal(existsSync(join(result.backupDir, 'host/new.js')), false)
  assert.equal(existsSync(join(result.backupDir, 'host/keep.js')), false)

  // Staging is gone; the backup is the one documented remainder.
  assert.deepEqual(
    updateLeftovers(directory).filter((name) => name.startsWith('.update-staging-')),
    [],
  )
  assert.equal(updateLeftovers(directory).filter((name) => name.startsWith('.update-backup-')).length, 1)

  // A second apply against the same manifest is now "not newer".
  const again = await applyUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(again.ok, false)
  assert.match(again.error, /not-newer/)
})

await check('a replace-phase failure rolls every original back byte-for-byte', async () => {
  resetRemote()
  const directory = pluginDir({
    version: '1.0.0',
    files: { 'index.js': 'original index', blocked: 'this is a file, not a directory' },
  })
  const before = snapshot(directory)
  const manifest = manifestFor({
    files: [
      // Replaced first, so the failure has something to roll back.
      ['index.js', 'replacement index'],
      // Its parent `blocked` is a regular file in the target, so placing it must fail mid-replace.
      ['blocked/nested.txt', 'never lands'],
    ],
  })
  publish(manifest, [
    ['index.js', 'replacement index'],
    ['blocked/nested.txt', 'never lands'],
  ])
  const result = await applyUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(result.ok, false)
  assert.match(result.error, /replace-failed/)
  // Byte-identical, including the unlisted files: this is the all-or-nothing promise.
  assert.equal(snapshot(directory), before, 'the originals must be byte-identical after a failed apply')
  assert.equal(readFileSync(join(directory, 'index.js'), 'utf8'), 'original index')
  assert.equal(readCurrentVersion(directory), '1.0.0')
  // No staging or backup left behind: the rollback was complete.
  assert.deepEqual(updateLeftovers(directory), [])
})

await check('a successful apply is repeatable after the module refuses a concurrent one', async () => {
  resetRemote()
  const directory = pluginDir({ version: '1.0.0', files: { 'index.js': 'old index' } })
  publish(manifestFor({ version: '1.1.0', files: [['index.js', 'first update'], ['package.json', packageJsonFor('1.1.0')]] }), [
    ['index.js', 'first update'],
    ['package.json', packageJsonFor('1.1.0')],
  ])
  const first = await applyUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(first.ok, true)
  // Not stuck in "applying": a later, newer manifest is accepted.
  publish(manifestFor({ version: '1.2.0', files: [['index.js', 'second update'], ['package.json', packageJsonFor('1.2.0')]] }), [
    ['index.js', 'second update'],
    ['package.json', packageJsonFor('1.2.0')],
  ])
  const second = await applyUpdate({ manifestUrl: MANIFEST_URL, directory })
  assert.equal(second.ok, true)
  assert.equal(second.from, '1.1.0')
  assert.equal(second.to, '1.2.0')
  assert.equal(readFileSync(join(directory, 'index.js'), 'utf8'), 'second update')
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// verdict
// ─────────────────────────────────────────────────────────────────────────────────────────────────

console.log(`\nchecks: ${checks}   failures: ${failures}`)
console.log(failures === 0 ? 'UPDATE MODULE: ALL CHECKS PASS' : `UPDATE MODULE: ${failures} CHECK(S) FAILED`)

try {
  server.closeAllConnections?.()
} catch {
  /* old Node without closeAllConnections */
}
await new Promise((done) => {
  const timer = setTimeout(done, 500)
  server.close(() => {
    clearTimeout(timer)
    done()
  })
})
rmSync(TEMP_ROOT, { recursive: true, force: true })

process.exitCode = failures === 0 ? 0 : 1
