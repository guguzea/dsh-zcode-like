/**
 * Durable, plugin-owned per-Session acceptance watermark.
 *
 * `INTERFACES.md` §0 forbids both a `Config` schema and the `ctx.storageDomain` value schema, so the
 * watermark is plain JSON written by this module through `node:fs` — never a Session event
 * (`docs/api-dossier.md` §3.4 forbids appending one).
 *
 * File layout (`<directory>/watermarks.json`):
 *
 *   { "version": 1, "sessions": { "<sessionId>": { "afterSeq": 12, "sessionFormatVersion": 4,
 *                                                  "updatedAt": 1730000000000 } } }
 *
 * One file keyed by Session id (never one file per id) keeps a hostile or unusual Session id from
 * becoming a path. Writes are atomic (temp file + rename) and best-effort: `read`, `list` and `write`
 * never throw, and a corrupt or unreadable file degrades to "no stored watermark", which resends rather
 * than silently skipping.
 *
 * The store is also the host-side data source for the upload ledger the Settings page reads:
 * {@link WatermarkStore.list} exposes the same records as metadata only (Session id and acceptance
 * position), never conversation content.
 *
 * The directory defaults to `$DSH_HOME/session-log-upload` (or `~/.dsh/session-log-upload`), the
 * same precedence `@deepseek-ai/dsh-home-paths` uses: a non-blank `$DSH_HOME` wins, otherwise the
 * harness home is `~/.dsh`.
 */

import { mkdirSync, readFileSync, promises as fsPromises } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** File name inside the plugin-owned directory. */
export const WATERMARK_FILE_NAME = 'watermarks.json'

/** On-disk format marker. */
export const WATERMARK_FORMAT_VERSION = 1

/** Soft cap on retained records, oldest `updatedAt` dropped first. */
export const MAX_WATERMARK_RECORDS = 512

/** Expand the `~`, `~/`, `~\` prefixes the harness path helpers accept. */
function expandHomePath(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * The plugin-owned watermark directory.
 * @param env environment mapping read for `DSH_HOME` (defaults to `process.env`).
 * @returns an absolute directory path.
 */
export function defaultWatermarkDirectory(env = process.env) {
  const configured = env !== null && env !== undefined && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  const home = configured.length > 0 ? resolve(expandHomePath(configured)) : resolve(join(homedir(), '.dsh'))
  return join(home, 'session-log-upload')
}

/** Read one record's two numeric fields, or `undefined` when either is unusable. */
function readRecord(value) {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { afterSeq, sessionFormatVersion } = value
  if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) return undefined
  if (!Number.isSafeInteger(sessionFormatVersion) || sessionFormatVersion < 0) return undefined
  const updatedAt = Number.isSafeInteger(value.updatedAt) ? value.updatedAt : undefined
  return updatedAt === undefined ? { afterSeq, sessionFormatVersion } : { afterSeq, sessionFormatVersion, updatedAt }
}

/**
 * Per-Session acceptance watermark store.
 *
 * `read` is synchronous from an in-memory table loaded once from disk; `write` mutates that table
 * and schedules an atomic flush that never rejects.
 */
export class WatermarkStore {
  /**
   * @param directory plugin-owned directory; created on demand. Empty/absent falls back to
   *   {@link defaultWatermarkDirectory}.
   * @param options optional extensions: `fileName` and `log(message)` for diagnostics.
   */
  constructor(directory, options = {}) {
    this.directory = typeof directory === 'string' && directory.length > 0 ? directory : defaultWatermarkDirectory()
    this.fileName =
      options !== null && options !== undefined && typeof options.fileName === 'string' && options.fileName.length > 0
        ? options.fileName
        : WATERMARK_FILE_NAME
    this.log = options !== null && options !== undefined && typeof options.log === 'function' ? options.log : undefined
    this._records = undefined
    this._lastError = undefined
    this._queue = Promise.resolve()
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
   * Read the watermark for one Session.
   * @param sessionId the Session id.
   * @returns `{afterSeq, sessionFormatVersion}` or `undefined` when nothing usable is stored.
   */
  read(sessionId) {
    try {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
      const records = this._ensureLoaded()
      if (!Object.prototype.hasOwnProperty.call(records, sessionId)) return undefined
      const record = readRecord(records[sessionId])
      return record === undefined ? undefined : { afterSeq: record.afterSeq, sessionFormatVersion: record.sessionFormatVersion }
    } catch (error) {
      this._fail(error)
      return undefined
    }
  }

  /**
   * List every stored watermark, for the upload ledger.
   *
   * **Metadata only.** The store holds the Session id and this plugin's own acceptance bookkeeping,
   * and this method adds nothing else — no prompts, no titles, no working directory, no file paths.
   * The ledger is a second view of state the user already owns, not a second copy of user data.
   *
   * Deterministic: newest first by `updatedAt` (records without one sort last), ties broken by
   * ascending Session id. Never throws: a missing, unreadable, empty or malformed file lists as `[]`.
   *
   * @returns a fresh array of fresh `{sessionId, afterSeq, sessionFormatVersion, updatedAt}` objects,
   *   where `updatedAt` is `null` when the stored record carries none.
   */
  list() {
    try {
      const records = this._ensureLoaded()
      const entries = []
      for (const sessionId of Object.keys(records)) {
        const record = readRecord(records[sessionId])
        if (record === undefined) continue
        entries.push({
          sessionId,
          afterSeq: record.afterSeq,
          sessionFormatVersion: record.sessionFormatVersion,
          updatedAt: record.updatedAt === undefined ? null : record.updatedAt,
        })
      }
      entries.sort((left, right) => {
        const leftAt = left.updatedAt === null ? Number.NEGATIVE_INFINITY : left.updatedAt
        const rightAt = right.updatedAt === null ? Number.NEGATIVE_INFINITY : right.updatedAt
        if (leftAt !== rightAt) return rightAt - leftAt
        if (left.sessionId === right.sessionId) return 0
        return left.sessionId < right.sessionId ? -1 : 1
      })
      return entries
    } catch (error) {
      this._fail(error)
      return []
    }
  }

  /**
   * Advance the watermark for one Session. Best-effort: never throws, never rejects.
   * @param sessionId the Session id.
   * @param value `{afterSeq, sessionFormatVersion}`; an unusable value is ignored.
   */
  write(sessionId, value) {
    try {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      const record = readRecord(value)
      if (record === undefined) return
      const records = this._ensureLoaded()
      records[sessionId] = { afterSeq: record.afterSeq, sessionFormatVersion: record.sessionFormatVersion, updatedAt: Date.now() }
      this._prune(records)
      this._scheduleFlush()
    } catch (error) {
      this._fail(error)
    }
  }

  /** Await the pending flush; diagnostics/tests only. Never rejects. */
  flush() {
    return this._queue
  }

  /** In-memory table, loaded once from disk. */
  _ensureLoaded() {
    if (this._records !== undefined) return this._records
    const records = Object.create(null)
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      const table = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.sessions : undefined
      if (table !== null && table !== undefined && typeof table === 'object' && !Array.isArray(table)) {
        for (const key of Object.keys(table)) {
          if (key.length === 0) continue
          const record = readRecord(table[key])
          if (record !== undefined) records[key] = record
        }
      }
    } catch (error) {
      if (error === null || error === undefined || error.code !== 'ENOENT') this._lastError = error
    }
    this._records = records
    return records
  }

  /** Drop the oldest records once the soft cap is exceeded. */
  _prune(records) {
    const keys = Object.keys(records)
    if (keys.length <= MAX_WATERMARK_RECORDS) return
    keys.sort((left, right) => (records[left].updatedAt ?? 0) - (records[right].updatedAt ?? 0))
    for (const key of keys.slice(0, keys.length - MAX_WATERMARK_RECORDS)) delete records[key]
  }

  /** Serialize one atomic flush behind the previous one; failures are recorded, not thrown. */
  _scheduleFlush() {
    this._queue = this._queue
      .then(async () => {
        const text = `${JSON.stringify({ version: WATERMARK_FORMAT_VERSION, sessions: this._records ?? {} }, null, 2)}\n`
        mkdirSync(this.directory, { recursive: true })
        const temporary = `${this.path}.tmp`
        await fsPromises.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
        await fsPromises.rename(temporary, this.path)
      })
      .catch((error) => {
        this._fail(error)
      })
  }

  /** Record a diagnostic without ever letting it escape. */
  _fail(error) {
    this._lastError = error
    if (this.log === undefined) return
    try {
      const message = error !== null && error !== undefined && typeof error.message === 'string' ? error.message : String(error)
      this.log(`session-log-upload: watermark store at ${this.path}: ${message}`)
    } catch {
      /* a diagnostic must never break the caller */
    }
  }
}
