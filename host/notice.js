/**
 * The "I have read this" acknowledgement for the liability notice.
 *
 * The notice itself is consent copy, not configuration: it has to survive every process restart until
 * the user actually ticks the box, so it lives beside the watermark as a small owned file rather than
 * in the row's config. Keeping it out of `Config` also means it cannot be flipped by a settings write,
 * and it adds no volatile field to a schema whose coupling we already have to weigh carefully.
 *
 * Metadata only: one boolean and the time it was set. No identity, no Session data.
 *
 * @module session-log-upload/notice
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** File name inside the plugin directory. */
export const NOTICE_FILE_NAME = 'notice-acknowledged.json'

/** Version of the record shape, so a future change can migrate rather than guess. */
export const NOTICE_FORMAT_VERSION = 1

/** Longest accepted timestamp string, to bound what a hand-edited file can inject. */
const MAX_TIMESTAMP_LENGTH = 40

/**
 * The acknowledgement record on disk.
 *
 * Reads go to the file every time: the point of the record is that the next page load shows the truth,
 * and it is a few dozen bytes. Writes are atomic (temp file + rename) so a crash mid-write cannot leave
 * a half-read file that looks unacknowledged forever.
 */
export class NoticeStore {
  /**
   * @param directory plugin-owned directory; same resolution as the watermark store.
   * @param options optional `fileName` and `log(message)` for diagnostics.
   */
  constructor(directory, options = {}) {
    this.directory = typeof directory === 'string' && directory.length > 0 ? directory : ''
    this.fileName =
      options !== null && options !== undefined && typeof options.fileName === 'string' && options.fileName.length > 0
        ? options.fileName
        : NOTICE_FILE_NAME
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
   * Read the acknowledgement, without ever throwing.
   *
   * An absent file means "not acknowledged": the notice appears until the user says otherwise. A file
   * that exists but cannot be read is also treated as NOT acknowledged — the safe direction, because
   * the cost of showing the notice twice is a click, while the cost of skipping it is a user who never
   * saw the terms.
   *
   * @returns `{acknowledged, at}`; `at` is the recorded time or `null`.
   */
  snapshot() {
    let text
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error) {
      if (error !== null && error !== undefined && error.code === 'ENOENT') return { acknowledged: false, at: null }
      this._fail(error)
      return { acknowledged: false, at: null }
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this._fail(error)
      return { acknowledged: false, at: null }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { acknowledged: false, at: null }
    // Only a literal `true` counts. A hand-edited file cannot fake consent with a truthy string.
    if (parsed.acknowledged !== true) return { acknowledged: false, at: null }
    const at = typeof parsed.at === 'string' && parsed.at.length > 0 && parsed.at.length <= MAX_TIMESTAMP_LENGTH ? parsed.at : null
    return { acknowledged: true, at }
  }

  /**
   * Record the acknowledgement.
   * @param at the timestamp to store; defaults to now as an ISO string.
   * @returns the state that was written, whether or not the write succeeded.
   */
  acknowledge(at) {
    const record = {
      version: NOTICE_FORMAT_VERSION,
      acknowledged: true,
      at: typeof at === 'string' && at.length > 0 && at.length <= MAX_TIMESTAMP_LENGTH ? at : new Date().toISOString(),
    }
    this._write(record)
    return { acknowledged: true, at: record.at }
  }

  /** Write atomically, swallowing every failure. */
  _write(record) {
    try {
      mkdirSync(this.directory, { recursive: true })
      const temporary = `${this.path}.tmp`
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
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
    const message = error !== null && error !== undefined && typeof error.message === 'string' ? error.message : String(error)
    try {
      this.log(`session-log-upload: notice record at ${this.path}: ${message}`)
    } catch {
      /* a diagnostic must never break the caller */
    }
  }
}
