#!/usr/bin/env node
/**
 * Release step: build (or verify) the update manifest the in-app updater reads.
 *
 * Usage:
 *
 *   node verify/build-update-manifest.mjs                 # write update-manifest.json
 *   node verify/build-update-manifest.mjs --notes "..."   # write it with one line of release notes
 *   node verify/build-update-manifest.mjs --check         # verify the committed manifest against disk
 *
 * What it ships: every file matched by `package.json`'s `files` globs, plus `package.json` itself.
 *
 * WHY package.json IS INCLUDED even though no `files` glob names it: npm always puts package.json in a
 * published package, and more importantly the updater's notion of "the installed version" is
 * `package.json.version` (`readCurrentVersion`). If an update replaced index.js and host/*.js but left
 * package.json at the old version, the next check would see the old version and offer the very same
 * update forever. Listing package.json makes the version move with the update, and the manifest's own
 * `version` (which must equal package.json's) stays honest afterwards.
 *
 * The glob expansion is implemented here on purpose: no npm dependency, and the exact matching rules
 * are part of the release artefact. Supported syntax is the subset `package.json.files` actually uses:
 * `*` (within one path segment), `?` (one character within a segment) and `**` (zero or more segments).
 * A pattern that matches nothing FAILS the build: a silently typo'd glob would ship a bundle missing a
 * file, and an update that deletes nothing but never installs that file is worse than a failed release.
 *
 * Skipped everywhere: `.git`, `node_modules`, `verify/`, `docs/`, the manifest itself, and the updater's
 * own scratch/backup directories (`update-manifest.json`, `.update-*`, `update-backup*`,
 * `update-staging*`). Symlinks are skipped: the bundle is a set of regular files, and a link's target
 * may not be part of it.
 *
 * Exit codes: 0 = wrote the manifest / committed manifest matches; 1 = mismatch or build failure;
 * 2 = bad command line.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MAX_MANIFEST_BYTES, UPDATE_MANIFEST_SCHEMA, parseManifest } from '../host/update.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const MANIFEST_FILE = 'update-manifest.json'

/** Names skipped wherever they appear in the tree. */
const SKIPPED_NAMES = new Set(['.git', 'node_modules', 'verify', 'docs', MANIFEST_FILE])

/** Prefixes skipped wherever they appear: the updater's staging/backup directories, dotted or not. */
const SKIPPED_PREFIXES = ['.update-', 'update-backup', 'update-staging']

/**
 * Files that are always part of the published bundle even though no `files` glob names them.
 * See the module header for why package.json must be here.
 */
const ALWAYS_INCLUDED = ['package.json']

const USAGE = [
  'usage: node verify/build-update-manifest.mjs [--check] [--notes <text>]',
  '',
  '  (no flags)        write update-manifest.json from package.json version + files list',
  '  --check           verify the committed manifest matches the files on disk and package.json version',
  '  --notes <text>    one line of release notes for the manifest (default: empty)',
  '  --help            print this message',
].join('\n')

/** SHA-256 of bytes as lowercase hex. */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Whether a directory entry name is excluded from the bundle. */
function isSkipped(name) {
  if (SKIPPED_NAMES.has(name)) return true
  return SKIPPED_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * Every regular file under `directory`, as sorted relative POSIX paths.
 * @throws when a directory cannot be read (a release must not silently ship a partial tree).
 */
function listBundleFiles(directory, prefix = '') {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    throw new Error(`cannot read ${directory}: ${errorMessage(error)}`)
  }
  const files = []
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    if (isSkipped(entry.name)) continue
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) files.push(...listBundleFiles(join(directory, entry.name), relativePath))
    else if (entry.isFile()) files.push(relativePath)
    // Symlinks are deliberately ignored: their target may lie outside the bundle.
  }
  return files
}

/** Compile one `package.json` glob into an anchored RegExp over POSIX relative paths. */
function globToRegExp(pattern) {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          // `**/` is zero or more complete path segments, so `host/**/x.js` also matches `host/x.js`.
          source += '(?:[^/]+/)*'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (character === '?') {
      source += '[^/]'
    } else if ('\\^$.*+?()[]{}|'.includes(character)) {
      source += `\\${character}`
    } else {
      source += character
    }
  }
  source += '$'
  return new RegExp(source)
}

/** Read package.json and its `files` patterns; throws when the release inputs are unusable. */
function readPackageJson() {
  const path = join(ROOT, 'package.json')
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read package.json: ${errorMessage(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('package.json is not an object')
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) throw new Error('package.json has no version string')
  const patterns = Array.isArray(parsed.files) ? parsed.files.filter((pattern) => typeof pattern === 'string' && pattern.length > 0) : []
  if (patterns.length === 0) throw new Error('package.json has no usable "files" list, so there is nothing to publish')
  return { version: parsed.version, patterns }
}

/**
 * Build the manifest from disk.
 * @param notes manifest `notes` string (editorial; not verifiable from disk).
 * @returns `{manifest, text, totalBytes}` where `text` is exactly what will be written.
 */
function buildManifest(notes) {
  const { version, patterns } = readPackageJson()
  const allFiles = listBundleFiles(ROOT)
  const matchers = patterns.map((pattern) => ({ pattern, regex: globToRegExp(pattern), matches: 0 }))
  const selected = new Set(ALWAYS_INCLUDED)
  for (const relativePath of allFiles) {
    for (const matcher of matchers) {
      if (!matcher.regex.test(relativePath)) continue
      matcher.matches += 1
      selected.add(relativePath)
    }
  }
  const unmatched = matchers.filter((matcher) => matcher.matches === 0).map((matcher) => JSON.stringify(matcher.pattern))
  if (unmatched.length > 0) {
    // A typo'd glob silently omitting a shipped file is exactly the kind of release bug this step
    // exists to catch, so it is fatal rather than a warning.
    throw new Error(`package.json "files" pattern(s) matched no file: ${unmatched.join(', ')}`)
  }
  if (selected.size === 0) throw new Error('the manifest would be empty')
  const files = [...selected].sort().map((relativePath) => {
    const bytes = readFileSync(join(ROOT, relativePath))
    return { path: relativePath, bytes: bytes.length, sha256: sha256(bytes) }
  })
  const manifest = { schema: UPDATE_MANIFEST_SCHEMA, version, files, notes: typeof notes === 'string' ? notes : '' }
  const text = `${JSON.stringify(manifest, null, 2)}\n`
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  // Validate with the updater's own parser before writing: a release artefact the runtime rejects is
  // not a release artefact.
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new Error(`the manifest would be ${Buffer.byteLength(text, 'utf8')} bytes (max ${MAX_MANIFEST_BYTES})`)
  }
  const validated = parseManifest(text, MANIFEST_FILE)
  if (!validated.ok) throw new Error(`the generated manifest fails the updater's validator: ${validated.error}`)
  return { manifest, text, totalBytes }
}

/** Human-facing summary of one manifest. */
function summarize(manifest, totalBytes) {
  return `${manifest.files.length} files, ${totalBytes} bytes, version ${manifest.version}`
}

/**
 * Recompute the manifest and compare it with the committed one.
 * @returns an array of human-readable problems; empty means "matches".
 */
function compareWithDisk(notes) {
  const committedPath = join(ROOT, MANIFEST_FILE)
  if (!existsSync(committedPath)) return [`${MANIFEST_FILE} is missing; run this script without --check to generate it`]
  const committedText = readFileSync(committedPath, 'utf8')
  const committed = parseManifest(committedText, MANIFEST_FILE)
  if (!committed.ok) return [`${MANIFEST_FILE} is not a valid manifest: ${committed.error}`]
  const expected = buildManifest(notes)
  const problems = []
  if (committed.manifest.version !== expected.manifest.version) {
    problems.push(`version: manifest says ${JSON.stringify(committed.manifest.version)}, package.json says ${JSON.stringify(expected.manifest.version)}`)
  }
  const expectedFiles = new Map(expected.manifest.files.map((file) => [file.path, file]))
  const committedFiles = new Map(committed.manifest.files.map((file) => [file.path, file]))
  for (const [path, expectedFile] of expectedFiles) {
    const committedFile = committedFiles.get(path)
    if (committedFile === undefined) {
      problems.push(`missing from the manifest: ${path}`)
      continue
    }
    if (committedFile.bytes !== expectedFile.bytes || committedFile.sha256 !== expectedFile.sha256) {
      problems.push(
        `changed on disk: ${path} (manifest ${committedFile.bytes} bytes ${committedFile.sha256.slice(0, 12)}…, ` +
          `disk ${expectedFile.bytes} bytes ${expectedFile.sha256.slice(0, 12)}…)`,
      )
    }
  }
  for (const path of committedFiles.keys()) {
    if (!expectedFiles.has(path)) problems.push(`in the manifest but not in the bundle: ${path}`)
  }
  return problems
}

/** Describe an arbitrary thrown value. */
function errorMessage(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

/** Thrown for a bad command line, so the exit code can be 2 rather than a build failure's 1. */
class UsageError extends Error {}

/** Parse the command line. Throws {@link UsageError} on anything that is not a known flag. */
function parseArgs(argv) {
  const options = { check: false, notes: '', help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--check') options.check = true
    else if (argument === '--notes') {
      index += 1
      options.notes = argv[index] ?? ''
    } else if (argument.startsWith('--notes=')) options.notes = argument.slice('--notes='.length)
    else if (argument === '--help' || argument === '-h') options.help = true
    else throw new UsageError(`unknown argument ${JSON.stringify(argument)}\n\n${USAGE}`)
  }
  return options
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────

try {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
  } else if (options.check) {
    const problems = compareWithDisk(options.notes)
    if (problems.length > 0) {
      console.error(`FAIL ${MANIFEST_FILE}: ${problems.length} mismatch(es) against the files on disk`)
      for (const problem of problems) console.error(`  ${problem}`)
      process.exitCode = 1
    } else {
      const { manifest, totalBytes } = buildManifest(options.notes)
      console.log(`ok   ${MANIFEST_FILE}: ${summarize(manifest, totalBytes)}`)
    }
  } else {
    const { manifest, text, totalBytes } = buildManifest(options.notes)
    writeFileSync(join(ROOT, MANIFEST_FILE), text)
    console.log(`wrote ${MANIFEST_FILE}: ${summarize(manifest, totalBytes)} (manifest ${Buffer.byteLength(text, 'utf8')} bytes)`)
    if (options.notes.length === 0) {
      console.log('note: no --notes given; the manifest carries an empty release note')
    }
  }
} catch (error) {
  console.error(error instanceof UsageError ? error.message : `FAIL ${MANIFEST_FILE}: ${errorMessage(error)}`)
  process.exitCode = error instanceof UsageError ? 2 : 1
}
