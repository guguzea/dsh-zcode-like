/**
 * The durable record of the **last failed upload attempt**.
 *
 * Why it exists: a Session log can silently stop arriving. `uploadModel`, `credentialRef`, `endpoint`
 * and the byte cap are all values a user can get wrong, and until now the only evidence was a `log()`
 * line that a user never sees; a persistent failure showed up in the detailed log as *nothing new*,
 * indistinguishable from having nothing to send. This file is what the detailed log and the Settings
 * page read, so the failure is visible where the user is already looking.
 *
 * The record is written to `$DSH_HOME/session-log-upload/last-failure.json` — the same directory the
 * watermark store uses — because the natural investigation is "reload the row and look", which would
 * wipe an in-memory value.
 *
 * Two invariants this module must never break:
 *
 *   1. **Best-effort.** Nothing here throws: a missing, unreadable, empty or malformed file reads as
 *      an honest state, a failed write is swallowed, and the upload path is never affected.
 *   2. **Metadata only.** A record holds this plugin's own bookkeeping and a diagnostic string. It must
 *      never carry the request body, Session content, a prompt or a message — see {@link singleLineDetail}.
 *
 * `readable: false` is not "clean": an unreadable record is reported as a failure of kind `unknown`,
 * never as "no failure", because absence of evidence is not evidence of success.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** File name inside the plugin-owned directory. */
export const FAILURE_FILE_NAME = 'last-failure.json'

/** Format generation of the file; a future shape change bumps this. */
export const FAILURE_FORMAT_VERSION = 1

/**
 * The closed set of failure kinds. Anything else is narrowed to `unknown` on the way in, so the file
 * and the ledger payload can never carry a kind a renderer does not know.
 */
export const FAILURE_KINDS = Object.freeze([
  'no-credential',
  'endpoint-refused',
  'http-error',
  'transport-error',
  'payload-too-large',
  'unknown',
])

/**
 * Longest `detail` retained. Equal to the transport's `ERROR_DETAIL_LIMIT` (asserted in
 * `verify/host-unit.mjs`, so the two cannot drift apart silently).
 */
export const FAILURE_DETAIL_LIMIT = 400

/**
 * One single-line diagnostic from untrusted text.
 *
 * The transport's own messages are ours, but a provider error string is not, and Session ids or
 * endpoints can contain anything. Every control character (`Cc`), format character (`Cf`, e.g. an RTL
 * override), unpaired surrogate (`Cs`), line/paragraph separator (`Zl`/`Zp`) and whitespace run
 * collapses to a single space, so one record can never forge extra lines in the command output or on
 * the page, and the result is then truncated hard by code points.
 *
 * @param value the diagnostic, of any type.
 * @param limit maximum code points retained.
 * @returns a single-line string, possibly empty.
 */
export function singleLineDetail(value, limit = FAILURE_DETAIL_LIMIT) {
  const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
  let flattened
  try {
    flattened = text.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\s]+/gu, ' ').trim()
  } catch {
    return ''
  }
  const points = [...flattened]
  const capped = Number.isSafeInteger(limit) && limit > 0 ? limit : FAILURE_DETAIL_LIMIT
  return points.length > capped ? points.slice(0, capped).join('') : flattened
}

/**
 * Narrow one recorded attempt to the frozen shape.
 *
 * `status` is kept only for `http-error` (where it is the HTTP status) and is `null` otherwise, and an
 * unusable `at` becomes "now" rather than a fabricated past.
 *
 * @param entry `{at, sessionId, retryable, kind, status, detail}`; anything is tolerated.
 * @returns the normalized record, never throws.
 */
export function normaliseFailure(entry) {
  const source = entry === null || entry === undefined || typeof entry !== 'object' || Array.isArray(entry) ? {} : entry
  let kind = 'unknown'
  try {
    if (typeof source.kind === 'string' && FAILURE_KINDS.includes(source.kind)) kind = source.kind
  } catch {
    kind = 'unknown'
  }
  const status = Number.isSafeInteger(source.status) && source.status >= 100 && source.status <= 599 ? source.status : null
  const sessionId =
    typeof source.sessionId === 'string' && source.sessionId.length > 0 ? singleLineDetail(source.sessionId, 200) || null : null
  const at = Number.isSafeInteger(source.at) && source.at > 0 ? source.at : Date.now()
  return {
    at,
    sessionId,
    retryable: source.retryable === true,
    kind,
    status: kind === 'http-error' ? status : null,
    detail: singleLineDetail(source.detail),
  }
}

/** The clean state: no failure recorded, no run of failures. */
function emptyState() {
  return { lastFailure: null, consecutiveFailures: 0 }
}

/** A record that says "the stored record cannot be trusted", which is not the same as "no record". */
function unreadableRecord(detail) {
  return { at: Date.now(), sessionId: null, retryable: false, kind: 'unknown', status: null, detail: singleLineDetail(detail) }
}

/** A message from any thrown value, single-lined. */
function messageOf(error) {
  const text =
    error !== null && error !== undefined && typeof error.message === 'string' && error.message.length > 0
      ? error.message
      : String(error)
  return singleLineDetail(text, 160)
}

/**
 * The last-failure record on disk.
 *
 * Reads are synchronous and go to the file every time — the point of the record is that a reload shows
 * the truth, and it is a few hundred bytes. Writes are synchronous too (temp file + rename), so a
 * caller can read back immediately after recording.
 */
export class FailureStore {
  /**
   * @param directory plugin-owned directory; same resolution as the watermark store.
   * @param options optional extensions: `fileName` and `log(message)` for diagnostics.
   */
  constructor(directory, options = {}) {
    this.directory = typeof directory === 'string' && directory.length > 0 ? directory : ''
    this.fileName =
      options !== null && options !== undefined && typeof options.fileName === 'string' && options.fileName.length > 0
        ? options.fileName
        : FAILURE_FILE_NAME
    this.log = options !== null && options !== undefined && typeof options.log === 'function' ? options.log : undefined
    this._lastError = undefined
  }

  /** Absolute path of the JSON file. */
  get path() {
    return join(this.directory, this.fileName)
  }

  /** Most recent read/write failure, if any; diagnostics only. */
  get lastError() {
    return this._lastError
  }

  /**
   * Read the record without ever throwing.
   *
   * @returns `{lastFailure, consecutiveFailures, readable}`. An absent file is `null`/`0`/`true` (there
   *   genuinely is nothing recorded); a file that exists but cannot be read, parsed or understood is a
   *   `kind: 'unknown'` record with `readable: false`, never `null`.
   */
  snapshot() {
    let text
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error) {
      if (error !== null && error !== undefined && error.code === 'ENOENT') return { ...emptyState(), readable: true }
      this._fail(error)
      return { lastFailure: unreadableRecord(`the failure record could not be read: ${messageOf(error)}`), consecutiveFailures: 0, readable: false }
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this._fail(error)
      return { lastFailure: unreadableRecord(`the failure record is not valid JSON: ${messageOf(error)}`), consecutiveFailures: 0, readable: false }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { lastFailure: unreadableRecord('the failure record is not a JSON object'), consecutiveFailures: 0, readable: false }
    }
    const count = Number.isSafeInteger(parsed.consecutiveFailures) && parsed.consecutiveFailures > 0 ? parsed.consecutiveFailures : 0
    const raw = parsed.lastFailure
    if (raw === undefined || raw === null) return { lastFailure: null, consecutiveFailures: count, readable: true }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return { lastFailure: unreadableRecord('the recorded failure is not a JSON object'), consecutiveFailures: count, readable: false }
    }
    return { lastFailure: normaliseFailure(raw), consecutiveFailures: count, readable: true }
  }

  /**
   * Record one failed attempt, incrementing the consecutive counter.
   * @param entry the attempt `{kind, status, retryable, sessionId, detail}`; `at` defaults to now.
   * @returns the state that was written (whether or not the write succeeded).
   */
  record(entry) {
    const current = this.snapshot()
    const lastFailure = normaliseFailure(entry)
    const state = { lastFailure, consecutiveFailures: current.consecutiveFailures + 1 }
    this._write(state)
    return state
  }

  /**
   * Forget the failure. An accepted upload is proof the path works, and a stale failure outliving a
   * success would be a new false reassurance.
   * @returns the clean state.
   */
  clear() {
    const state = emptyState()
    this._write(state)
    return state
  }

  /** Write atomically, swallowing every failure. */
  _write(state) {
    try {
      mkdirSync(this.directory, { recursive: true })
      const text = `${JSON.stringify({ version: FAILURE_FORMAT_VERSION, ...state }, null, 2)}\n`
      const temporary = `${this.path}.tmp`
      writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.path)
      return true
    } catch (error) {
      this._fail(error)
      return false
    }
  }

  /** Record a diagnostic without ever letting it escape. */
  _fail(error) {
    this._lastError = error
    if (this.log === undefined) return
    try {
      this.log(`session-log-upload: failure record at ${this.path}: ${messageOf(error)}`)
    } catch {
      /* a diagnostic must never break the caller */
    }
  }
}
