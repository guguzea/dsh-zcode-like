/**
 * Disk-backed scan cache for the other-harness adapters (`host/foreign/`).
 *
 * A scan is metadata-only but not cheap: the message count of one conversation is a bytes-only walk
 * over its whole JSONL file, and this machine's Qoder store alone is 2.36 GB of delegated
 * transcripts, so a cold scan costs about 23 s. The adapters already remember what they learned per
 * file version, but only in module state — every DSH restart pays the 23 s again. This module is the
 * piece that makes that memory survive a restart: the adapter hands `scan` a `ScanCache`, and a file
 * whose identity (harness + path + size + mtime + ctime) is unchanged is answered from disk without
 * opening the transcript at all.
 *
 * The cache is an optimisation and nothing else. Every operation is total: a missing, corrupt,
 * oversized or foreign-version file loads as an empty cache and the scan runs cold; a write that
 * cannot happen is dropped. Losing the cache can only cost time, never a scan result.
 *
 * @module session-log-upload/foreign/cache
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** File name inside the plugin-owned state directory. */
export const SCAN_CACHE_FILE_NAME = 'foreign-scan-cache.json'

/** On-disk format version. A file with any other version is ignored rather than interpreted. */
export const SCAN_CACHE_VERSION = 1

/** Default cap on remembered rows. */
export const DEFAULT_MAX_ENTRIES = 20000

/** Default cap on the cache file size (and on what is read back). */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/** Default entry lifetime: one month without being re-observed means the file is probably gone. */
export const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** `Buffer.byteLength` of `{"version":1,"entries":{` plus the closing `}}`. */
const HEADER_BYTES = 25

/** A string usable as a cache key: non-empty and bounded. */
function isKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4000
}

/** A positive integer option, or the fallback. */
function positiveInteger(value, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : fallback
}

/** A positive finite number option, or the fallback. */
function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? value : fallback
}

/** Read one constructor option without letting a hostile getter escape. */
function optionOf(options, name) {
  try {
    if (options === null || options === undefined || typeof options !== 'object') return undefined
    return options[name]
  } catch {
    return undefined
  }
}

/**
 * The approximate on-disk cost of one entry: its JSON key, the colon/comma between entries and its
 * serialized value. Deliberately an over-estimate, so pruning to maxBytes never writes a file that
 * is larger than the budget.
 */
function entryBytes(key, entry) {
  try {
    return Buffer.byteLength(JSON.stringify(key)) + 2 + Buffer.byteLength(JSON.stringify(entry))
  } catch {
    // A value JSON cannot represent can never be persisted; treating it as "too expensive" drops it.
    return Number.POSITIVE_INFINITY
  }
}

/**
 * The on-disk scan cache.
 *
 * Construction never touches disk; the first `get`/`set`/`flush` loads
 * `<directory>/foreign-scan-cache.json` once. `flush()` is the only writer: it prunes and writes
 * atomically (temp file in the same directory, then rename, mode 0600) and only when something
 * changed, so a scan that changed nothing does not touch the disk.
 */
export class ScanCache {
  /**
   * @param directory the plugin-owned state directory (created on first flush), or anything else
   *   (then the cache simply never persists).
   * @param options `{maxEntries?, maxBytes?, maxAgeMs?}`.
   */
  constructor(directory, options) {
    try {
      this.directory = typeof directory === 'string' ? directory : ''
    } catch {
      this.directory = ''
    }
    this.maxEntries = positiveInteger(optionOf(options, 'maxEntries'), DEFAULT_MAX_ENTRIES)
    this.maxBytes = positiveInteger(optionOf(options, 'maxBytes'), DEFAULT_MAX_BYTES)
    this.maxAgeMs = positiveNumber(optionOf(options, 'maxAgeMs'), DEFAULT_MAX_AGE_MS)
    this.entries = new Map()
    this.loaded = false
    this.dirty = false
  }

  /** The cache file path, or `''` when the cache was constructed without a usable directory. */
  filePath() {
    try {
      return this.directory.length > 0 ? join(this.directory, SCAN_CACHE_FILE_NAME) : ''
    } catch {
      return ''
    }
  }

  /** Load the file once. A missing/corrupt/oversized/foreign-version file loads as empty. */
  load() {
    if (this.loaded === true) return
    this.loaded = true
    const filePath = this.filePath()
    if (filePath.length === 0) return
    let text
    try {
      const info = statSync(filePath)
      if (info.isFile() !== true || info.size > this.maxBytes) return
      text = readFileSync(filePath, 'utf8')
    } catch {
      return
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
    if (parsed.version !== SCAN_CACHE_VERSION) return
    const entries = parsed.entries
    if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return
    for (const key of Object.keys(entries)) {
      const entry = entries[key]
      if (!isKey(key)) continue
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      if (typeof entry.at !== 'number' || Number.isFinite(entry.at) !== true) continue
      if (entry.value === undefined) continue
      this.entries.set(key, { at: entry.at, value: entry.value })
    }
  }

  /**
   * The cached value for one key, or `undefined`.
   * @param key the honest identity of the cached observation.
   */
  get(key) {
    try {
      if (!isKey(key)) return undefined
      this.load()
      const entry = this.entries.get(key)
      return entry === undefined ? undefined : entry.value
    } catch {
      return undefined
    }
  }

  /**
   * Remember one value. `flush()` is what makes it durable.
   * @param key the honest identity of the observation.
   * @param value the scan summary row; `undefined` is ignored.
   */
  set(key, value) {
    try {
      if (!isKey(key) || value === undefined) return
      this.load()
      this.entries.set(key, { at: Date.now(), value })
      this.dirty = true
    } catch {
      /* the cache is an optimisation; a lost row only costs a rescan */
    }
  }

  /** The number of remembered entries. */
  size() {
    try {
      this.load()
      return this.entries.size
    } catch {
      return 0
    }
  }

  /**
   * Prune and, when anything changed since the last flush, write the cache atomically.
   *
   * Pruning drops entries older than `maxAgeMs`, then the oldest entries until the entry count and
   * the serialized size are within `maxEntries`/`maxBytes`. Writes go to a temporary file in the
   * same directory and are renamed over the real one, so a reader never sees a half-written cache.
   * A failure leaves the in-memory cache intact and the file untouched; it never throws.
   */
  flush() {
    try {
      this.load()
      if (this.dirty !== true) return
      const filePath = this.filePath()
      if (filePath.length === 0) {
        this.dirty = false
        return
      }
      const text = this.serialize()
      if (text === null) return
      const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
      try {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 })
        writeFileSync(temporaryPath, text, { encoding: 'utf8', mode: 0o600 })
        renameSync(temporaryPath, filePath)
      } catch {
        try {
          rmSync(temporaryPath, { force: true })
        } catch {
          /* a leftover temp file is not worth failing the caller over */
        }
        return
      }
      this.dirty = false
    } catch {
      /* persistence is best-effort by contract */
    }
  }

  /**
   * Prune the in-memory entries and render them, or `null` when nothing can be rendered.
   * @returns the file text, or `null`.
   */
  serialize() {
    try {
      const now = Date.now()
      // 1. A row that has not been re-observed for a month is not evidence about a live store.
      for (const [key, entry] of this.entries) {
        if (now - entry.at > this.maxAgeMs) this.entries.delete(key)
      }
      // 2. Newest first: when the budget is exceeded, the oldest rows are the ones to drop.
      const ordered = [...this.entries.entries()].sort((left, right) => right[1].at - left[1].at)
      const kept = new Map()
      let bytes = HEADER_BYTES
      for (const [key, entry] of ordered) {
        if (kept.size >= this.maxEntries) break
        const cost = entryBytes(key, entry)
        if (Number.isFinite(cost) !== true) continue
        // A row that cannot fit on its own, or after the newer rows, is not persisted; older (and
        // usually smaller) rows still get their chance because the budget is checked per row.
        if (bytes + cost > this.maxBytes) continue
        kept.set(key, entry)
        bytes += cost
      }
      this.entries = kept
      const rendered = { version: SCAN_CACHE_VERSION, entries: {} }
      for (const [key, entry] of kept) rendered.entries[key] = entry
      const text = JSON.stringify(rendered)
      // The estimate above is conservative; this guards against a rounding surprise anyway.
      return Buffer.byteLength(text) <= this.maxBytes ? text : null
    } catch {
      return null
    }
  }
}

/**
 * The zero-disk cache with the same surface as {@link ScanCache}.
 *
 * Adapters and tests use it when a persistent cache is not wired: everything stays in a `Map`, so
 * behaviour matches the module-local fallback in `shared.js` without touching the filesystem.
 * @returns `{{get, set, flush, size}}`
 */
export function memoryScanCache() {
  const entries = new Map()
  return {
    get(key) {
      try {
        if (!isKey(key)) return undefined
        const entry = entries.get(key)
        return entry === undefined ? undefined : entry.value
      } catch {
        return undefined
      }
    },
    set(key, value) {
      try {
        if (!isKey(key) || value === undefined) return
        entries.set(key, { at: Date.now(), value })
      } catch {
        /* a lost row only costs a rescan */
      }
    },
    flush() {
      /* nothing to persist */
    },
    size() {
      return entries.size
    },
  }
}
