/**
 * Shared plumbing for the other-harness adapters (`host/foreign/`).
 *
 * Five harnesses, five storage formats, one set of safety rules. Every adapter is a host module
 * that runs on the user's own machine against multi-gigabyte stores, so the rules cannot be
 * re-derived per file without drifting:
 *
 *   - never throw: every failure is reported through the contract's `error` field, because the
 *     settings page calls these functions from an HTTP route and one escaped exception would turn
 *     a readable row into a failed request;
 *   - never read a store unboundedly: a Qoder transcript on this machine is 264 MB and the Qoder
 *     project tree is 3 GB, so metadata reads are capped (`readHead`), message reads stop at a byte
 *     budget (`readJsonl`) and the only whole-file pass is a bytes-only line count that keeps at
 *     most one line prefix in memory (`countJsonlMessages`);
 *   - never read `process.env`: the caller passes `home`, so tests point every adapter at a fixture
 *     directory instead of the live profile;
 *   - never guess a value: a missing title/cwd/model is `''` and a missing time is `0`, exactly as
 *     `docs/foreign-import.md` states.
 *
 * The scan cache is the one piece of module state. It exists because counting messages means one
 * whole-file pass per session (3 GB on this machine); keyed by path + size + mtime + ctime it can
 * never return a count for a file that changed, and the map is bounded so a huge store cannot grow
 * memory without limit.
 *
 * @module session-log-upload/foreign/shared
 */

import { createReadStream } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/** Default byte budget of one JSONL transcript read (docs/foreign-import.md allows the caller to override). */
export const DEFAULT_JSONL_MAX_BYTES = 24 * 1024 * 1024

/** How many leading bytes are read to recover a JSONL session's metadata (title, cwd, model, times). */
export const HEAD_BYTES = 512 * 1024

/** Longest derived title, in UTF-16 code units. The page row has room for far less, but a title must stay a title. */
export const MAX_TITLE_LENGTH = 160

/** Most of a line inspected while counting messages; JSON keys sit at the front of every line these stores write. */
const PREFIX_LIMIT = 512

/** Upper bound on cached scan entries; past this the cache is dropped, never grown. */
const SCAN_CACHE_LIMIT = 20000

/** path + identity of the file it describes. A changed file has a different key, so a stale count cannot match. */
const scanCache = new Map()

/**
 * A thrown value as one line of text.
 * @param error anything thrown.
 * @returns `error.message` when it is a non-empty string, otherwise `String(error)`.
 */
export function messageOf(error) {
  if (error !== null && error !== undefined && typeof error.message === 'string' && error.message.length > 0) {
    return error.message
  }
  return String(error)
}

/**
 * The contract's string fallback: only a genuine non-empty string is kept.
 * @param value candidate.
 * @returns the string, or `''`.
 */
export function textOf(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * A non-negative integer, or `0`.
 *
 * Timestamps arrive as milliseconds, seconds, ISO strings and occasionally nothing at all; every
 * adapter normalizes through here so the page can trust `createdAt`/`updatedAt` to be numbers.
 *
 * @param value candidate.
 * @returns milliseconds since the epoch, or `0`.
 */
export function toMillis(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0
    // These harnesses write milliseconds; a value that large is not a sensible date.
    if (value >= 1e15) return 0
    // >= 1e12 is already milliseconds (years after 2001); 1e9..1e12 is a seconds timestamp.
    if (value >= 1e12) return Math.trunc(value)
    if (value >= 1e9) return Math.trunc(value * 1000)
    return Math.trunc(value)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length === 0) return 0
    if (/^\d+$/.test(trimmed)) return toMillis(Number(trimmed))
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }
  return 0
}

/**
 * A session id that is safe to use as one file-name component.
 *
 * Adapters that look sessions up by path (Qoder, Cursor, WorkBuddy) must not let a URL-supplied id
 * escape the harness directory, and the adapters that use SQL still reject a nonsense id up front
 * rather than querying for it. These stores only ever name sessions with `[A-Za-z0-9_.-]`.
 *
 * This is the *top-level* form: one path component. A delegated conversation is addressed by the
 * composite raw id `<parentId>/subagents/<subagentId>` instead, which {@link parseSubagentId}
 * validates segment by segment.
 *
 * @param value candidate id.
 * @returns `true` when the id can be used verbatim.
 */
export function isSafeSessionId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 300 &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)
  )
}

/** The directory every harness stores delegated transcripts under, inside the parent session's dir. */
export const SUBAGENTS_DIRECTORY = 'subagents'

/** Longest raw id worth inspecting. The registry caps a whole composite id at 400 characters. */
export const MAX_RAW_ID_LENGTH = 400

/** Most segments a raw id may have. A delegated id has exactly three; the cap also bounds hostile input. */
export const MAX_RAW_ID_SEGMENTS = 4

/** One whole path segment of a raw id. `..`/`.` are rejected separately by {@link isSafeIdSegment}. */
const ID_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/

/**
 * One segment of a delegated-conversation raw id: `[A-Za-z0-9._-]+`, never `.` or `..`.
 *
 * The composite contract lets an id contain `/`, so every segment is validated on its own before it
 * is used as a path component. A segment that is exactly `..` would escape the harness tree, and an
 * empty segment (a leading, trailing or doubled slash) would silently address the current directory,
 * so both are rejected here rather than left to the filesystem.
 *
 * @param value candidate segment.
 * @returns `true` when the segment can be used as exactly one path component.
 */
export function isSafeIdSegment(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 300 &&
    value !== '.' &&
    value !== '..' &&
    ID_SEGMENT_PATTERN.test(value)
  )
}

/**
 * Split a raw id on `/` and validate every segment, or return `null`.
 *
 * `null` covers every rejection: a non-string, an empty id, an over-long id, more than
 * {@link MAX_RAW_ID_SEGMENTS} segments, an empty segment (leading/trailing/doubled slash, which also
 * catches absolute POSIX paths), and a segment that is not `[A-Za-z0-9._-]+` (which catches a Windows
 * drive letter or a backslash). Callers only pass the result to `path.join` after this returns.
 *
 * @param value candidate raw id.
 * @returns the validated segments, or `null`.
 */
export function splitRawId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RAW_ID_LENGTH) return null
  const segments = value.split('/')
  if (segments.length > MAX_RAW_ID_SEGMENTS) return null
  for (const segment of segments) if (!isSafeIdSegment(segment)) return null
  return segments
}

/**
 * Parse a delegated-conversation raw id: `<parentId>/subagents/<subagentId>`.
 *
 * Exactly three segments are accepted, and the middle one must literally be `subagents`. Anything
 * else — a top-level id (one segment), a two-segment fragment, a four-segment path trying to walk
 * deeper — is not a delegated id and returns `null`. The adapter then falls back to its top-level
 * resolution (or reports `invalid-id`), so an over-deep id can never be joined onto a path.
 *
 * @param value candidate raw id, without the harness prefix.
 * @returns `{parentId, subagentId}` or `null`.
 */
export function parseSubagentId(value) {
  const segments = splitRawId(value)
  if (segments === null || segments.length !== 3) return null
  if (segments[1] !== SUBAGENTS_DIRECTORY) return null
  return { parentId: segments[0], subagentId: segments[2] }
}

/**
 * The raw id of one delegated conversation, in the contract's fixed form.
 * @param parentId the parent conversation's raw id.
 * @param subagentId the delegated transcript's own id (the file name without `.jsonl`).
 * @returns `<parentId>/subagents/<subagentId>`.
 */
export function formatSubagentId(parentId, subagentId) {
  return `${textOf(parentId)}/${SUBAGENTS_DIRECTORY}/${textOf(subagentId)}`
}

/**
 * A session-id-safe placeholder for one tool call, e.g. `[tool: Bash]`.
 *
 * The contract's message blocks are only `text` and `reasoning`, so a tool call is represented by a
 * short text block instead of a made-up block type.
 *
 * @param name the tool's own name, or anything else.
 * @returns a one-line placeholder.
 */
export function toolPlaceholder(name) {
  const cleaned = textOf(name)
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 60)
  return cleaned.length > 0 ? `[tool: ${cleaned}]` : '[tool]'
}

/**
 * The first text of a content value that may be a string or an array of typed blocks.
 *
 * Used to derive a title from the first user message of stores that record no title. Only blocks
 * whose own type says "text" count; a tool result or attachment never becomes a title.
 *
 * @param content a message's `content` value.
 * @returns the first text, or `''`.
 */
export function firstText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (typeof block === 'string') return block
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    if (block.type !== 'text' && block.type !== 'input_text' && block.type !== 'output_text') continue
    if (typeof block.text === 'string' && block.text.length > 0) return block.text
  }
  return ''
}

/** Wrapper elements whose whole content is harness-injected noise, not a title. */
const NOISE_ELEMENTS =
  /<(system-reminder|user_info|git_diff[a-zA-Z_]*|workspace_context|environment_details|attached_files|timestamp)[^>]*>[\s\S]*?<\/\1>/gi

/**
 * Reduce a raw user message to a single-line title.
 *
 * Harnesses prepend `<system-reminder>`, `<user_info>` and `<git_diff>` blocks to the first prompt;
 * a title taken verbatim would be the harness's boilerplate rather than what the user asked. A
 * `<user_query>` wrapper, when present, is unwrapped first because that is the actual question.
 *
 * @param value raw text.
 * @returns whitespace-collapsed text, at most {@link MAX_TITLE_LENGTH} characters.
 */
export function titleOf(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  let text = value
  const query = /<user_query>([\s\S]*?)<\/user_query>/i.exec(text)
  if (query !== null) text = query[1]
  text = text.replace(NOISE_ELEMENTS, ' ')
  text = text.replace(/<[^<>\n]{1,200}>/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > MAX_TITLE_LENGTH ? text.slice(0, MAX_TITLE_LENGTH) : text
}

/**
 * The caller's `home`, or `''`.
 *
 * The adapters never consult `process.env`: tests pass a fixture directory, the host passes
 * `homedir()`. An unusable value degrades to "not installed", never to a read of the real profile.
 *
 * @param options the contract's options object, or anything else.
 * @returns the home directory string, or `''`.
 */
export function homeOf(options) {
  if (options === null || options === undefined || typeof options !== 'object') return ''
  return textOf(options.home)
}

/**
 * The caller's abort signal, or `undefined`.
 * @param options the contract's options object, or anything else.
 * @returns the signal, or `undefined`.
 */
export function signalOf(options) {
  if (options === null || options === undefined || typeof options !== 'object') return undefined
  const signal = options.signal
  return signal === null || signal === undefined ? undefined : signal
}

/** Whether a signal is already aborted, without ever throwing on a hostile object. */
export function isAborted(signal) {
  try {
    return signal !== null && signal !== undefined && signal.aborted === true
  } catch {
    return false
  }
}

/**
 * The JSONL byte budget: the caller's `maxBytes` when it is a positive integer, otherwise 24 MiB.
 *
 * The host passes the plugin's own upload cap here, so an import never reads more transcript than
 * the resulting envelope could carry. A malformed value can only fall back to the smaller default.
 *
 * @param options the contract's options object, or anything else.
 * @returns a positive integer number of bytes.
 */
export function maxBytesOf(options) {
  if (options === null || options === undefined || typeof options !== 'object') return DEFAULT_JSONL_MAX_BYTES
  const value = options.maxBytes
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value
  return DEFAULT_JSONL_MAX_BYTES
}

/** The canonical empty `scan` result. */
export function emptyScan(available, error) {
  return { available: available === true, error: typeof error === 'string' ? error : null, sessions: [] }
}

/** The canonical empty `readSession` result. */
export function emptySession(error) {
  return {
    id: '',
    error: typeof error === 'string' && error.length > 0 ? error : 'unknown-error',
    title: '',
    cwd: '',
    createdAt: 0,
    provider: '',
    model: '',
    truncated: false,
    messages: [],
  }
}

/**
 * `stat` that never throws.
 * @param path file or directory path.
 * @returns the `Stats`, or `null`.
 */
export async function statSafe(path) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

/**
 * `readdir` that never throws.
 * @param path directory path.
 * @returns the entries (with `Dirent` methods), or `[]`.
 */
export async function listDirSafe(path) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * Whether a path is an existing regular file.
 * @param path candidate.
 * @returns `true` only for a regular file.
 */
export async function isFile(path) {
  const info = await statSafe(path)
  return info !== null && info.isFile() === true
}

/**
 * Read at most `maxBytes` from the front of a file, as UTF-8 text.
 *
 * The last line may be cut mid-JSON and mid-character; callers parse line by line and skip the
 * line that does not parse, which is exactly why metadata recovery is tolerant of a partial line.
 *
 * @param path file path.
 * @param maxBytes read cap.
 * @returns the text, or `null` when the file cannot be read.
 */
export async function readHead(path, maxBytes = HEAD_BYTES) {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.allocUnsafe(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.toString('utf8', 0, bytesRead)
  } catch {
    return null
  } finally {
    try {
      await handle.close()
    } catch {
      /* a failed close must not fail the caller */
    }
  }
}

/**
 * Find `<root>/<child>/<fileName>` for the first child directory that has it.
 *
 * Qoder and WorkBuddy name their session directories only by an encoded working directory, so the
 * id is recovered from the file itself; the lookup walks the project directories instead of
 * guessing the encoding.
 *
 * @param root the `.../projects` directory.
 * @param fileName the expected file name (already validated as one component).
 * @returns the absolute path, or `null`.
 */
export async function findChildFile(root, fileName) {
  for (const entry of await listDirSafe(root)) {
    if (entry.isDirectory() !== true) continue
    const candidate = join(root, entry.name, fileName)
    if (await isFile(candidate)) return candidate
  }
  return null
}

/** The inspected prefix of a (possibly enormous) line: only JSON keys are needed, never the payload. */
function classifyPrefix(line) {
  return line.length > PREFIX_LIMIT ? line.slice(0, PREFIX_LIMIT) : line
}

/**
 * Count whole-file lines matching a classifier, without parsing any JSON.
 *
 * This is the only pass that reads a complete JSONL transcript during `scan()`, and it has to be
 * cheap: the Qoder store alone is 3 GB. Decoding as latin1 keeps the pass to a byte copy (every
 * key being matched is ASCII), a line longer than one chunk is reduced to its prefix so a giant
 * tool output cannot grow memory, and only the current partial line is kept between chunks.
 *
 * @param filePath transcript path.
 * @param classifyLine receives the first {@link PREFIX_LIMIT} characters of one line; returns true
 *   when the line is a user or assistant message.
 * @returns the count of matching lines; a read failure returns the partial count rather than throwing.
 */
export async function countJsonlMessages(filePath, classifyLine) {
  let count = 0
  let carry = ''
  try {
    const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 })
    for await (const chunk of stream) {
      const text = carry + chunk.toString('latin1')
      const lines = text.split('\n')
      carry = lines.pop() ?? ''
      for (const line of lines) {
        if (line.length === 0) continue
        try {
          if (classifyLine(classifyPrefix(line)) === true) count += 1
        } catch {
          /* one malformed line must not end the count */
        }
      }
      if (carry.length > PREFIX_LIMIT) carry = carry.slice(0, PREFIX_LIMIT)
    }
    if (carry.length > 0) {
      try {
        if (classifyLine(classifyPrefix(carry)) === true) count += 1
      } catch {
        /* ignore */
      }
    }
  } catch {
    return count
  }
  return count
}

/** Call one line handler without letting a record end the read. */
function feedLine(onLine, line) {
  if (line.length === 0) return
  try {
    onLine(line)
  } catch {
    /* one record's parser must not abort the file */
  }
}

/**
 * Stream a JSONL file line by line up to a byte budget.
 *
 * A 264 MB transcript must never be read with `readFileSync` or parsed whole: the read stops after
 * `maxBytes` (the caller's budget, at most the plugin's upload cap by default), reports
 * `truncated: true`, and hands each complete line to `onLine` as it arrives. The line at the cut is
 * dropped rather than half-parsed.
 *
 * @param filePath transcript path.
 * @param options the contract's options object (`maxBytes`, `signal`).
 * @param onLine receives one complete line; its exceptions are contained.
 * @returns `{truncated, aborted, error}`; never throws.
 */
export async function readJsonl(filePath, options, onLine) {
  const budget = maxBytesOf(options)
  const signal = signalOf(options)
  const decoder = new StringDecoder('utf8')
  let truncated = false
  let aborted = false
  let carry = ''
  let consumed = 0
  try {
    const stream = createReadStream(filePath, { highWaterMark: 256 * 1024 })
    for await (const chunk of stream) {
      if (isAborted(signal)) {
        aborted = true
        truncated = true
        break
      }
      consumed += chunk.length
      if (consumed > budget) {
        const allowed = chunk.length - (consumed - budget)
        if (allowed > 0) {
          const text = carry + decoder.write(chunk.subarray(0, allowed))
          carry = ''
          const lines = text.split('\n')
          lines.pop()
          for (const line of lines) feedLine(onLine, line)
        }
        truncated = true
        break
      }
      const text = carry + decoder.write(chunk)
      const lines = text.split('\n')
      carry = lines.pop() ?? ''
      for (const line of lines) feedLine(onLine, line)
    }
    if (!truncated) {
      const tail = carry + decoder.end()
      if (tail.trim().length > 0) feedLine(onLine, tail)
    }
  } catch (error) {
    return { truncated, aborted, error: messageOf(error) }
  }
  return { truncated, aborted, error: null }
}

/** Identity of one file version, used as the scan-cache key. */
function cacheKey(filePath, info) {
  return `${filePath}\u0000${String(info.size)}\u0000${String(info.mtimeMs)}\u0000${String(info.ctimeMs)}`
}

/**
 * The cached scan metadata for exactly this file version, or `null`.
 * @param filePath transcript path.
 * @param info the file's current `Stats`.
 * @returns the cached `{id,title,cwd,createdAt,provider,model,messageCount}` or `null`.
 */
export function readScanCache(filePath, info) {
  try {
    return scanCache.get(cacheKey(filePath, info)) ?? null
  } catch {
    return null
  }
}

/**
 * Remember scan metadata for exactly this file version.
 * @param filePath transcript path.
 * @param info the file's current `Stats`.
 * @param value `{id,title,cwd,createdAt,provider,model,messageCount}`.
 */
export function writeScanCache(filePath, info, value) {
  try {
    if (scanCache.size >= SCAN_CACHE_LIMIT) scanCache.clear()
    scanCache.set(cacheKey(filePath, info), value)
  } catch {
    /* the cache is an optimisation; losing it only costs a recount */
  }
}

/** The file name without its `.jsonl` suffix, or the name itself. */
export function baseNameWithoutExtension(name) {
  const text = textOf(name)
  return text.endsWith('.jsonl') ? text.slice(0, -'.jsonl'.length) : text
}
