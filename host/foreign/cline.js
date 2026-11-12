/**
 * Cline adapter: `<home>/.cline/data/db/sessions.db`, a small SQLite database.
 *
 * This adapter reports `available: true` with `error: 'unsupported-schema'`, and that is a
 * deliberate, honest answer rather than a gap:
 *
 *   - on this machine the database holds one `sessions` table of harness metadata (`session_id`,
 *     `provider`, `model`, `cwd`, `started_at`, `messages_path`, ...) and a handful of scheduling
 *     tables, but **no message content at all** — 0 rows in every table, and no table that carries
 *     user/assistant turns;
 *   - the transcript is referenced by `sessions.messages_path` and lives outside the database. That
 *     file format could not be observed here (there are no sessions), so mapping it would be an
 *     invented mapping, which `docs/foreign-import.md` explicitly forbids.
 *
 * Guessing would produce sessions that look importable and then upload garbage, so `scan` lists the
 * harness (the database exists, so it is installed) but yields no rows, and `readSession` reports
 * the same reason. The moment a real message table is observed, this module is the only file that
 * has to change.
 *
 * `node:sqlite` is imported lazily: a runtime without it degrades to `available: false`.
 *
 * @module session-log-upload/foreign/cline
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { emptyScan, emptySession, homeOf, isAborted, isSafeSessionId, messageOf, signalOf } from './shared.js'

/** Stable harness id; part of every composite id and of the forged session id. */
export const harness = 'cline'

/** Display name. */
export const label = 'Cline'

/** The reason both functions report when the store exists but cannot yield turns. */
export const UNSUPPORTED_SCHEMA = 'unsupported-schema'

/** The `.cline` directory: present when Cline is installed. */
function installationDirectory(home) {
  return join(home, '.cline')
}

/** The database path inside a home directory. */
function databasePath(home) {
  return join(installationDirectory(home), 'data', 'db', 'sessions.db')
}

/**
 * Open the Cline database read-only.
 * @param dbPath absolute database path.
 * @returns `{db, error, sqliteMissing}`; `db` must be closed by the caller.
 */
async function openDatabase(dbPath) {
  let sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch {
    return { db: null, error: null, sqliteMissing: true }
  }
  try {
    return { db: new sqlite.DatabaseSync(dbPath, { readOnly: true }), error: null, sqliteMissing: false }
  } catch (error) {
    return { db: null, error: messageOf(error), sqliteMissing: false }
  }
}

/** Close a database, swallowing a close failure. */
function closeDatabase(db) {
  try {
    db.close()
  } catch {
    /* nothing to recover */
  }
}

/**
 * Report the harness without pretending its turns are readable.
 * @param options `{home, signal?}`.
 * @returns the contract's `scan` result; never throws.
 */
export async function scan(options) {
  try {
    const home = homeOf(options)
    const signal = signalOf(options)
    if (home.length === 0) return emptyScan(false, null)
    if (isAborted(signal)) return emptyScan(true, 'aborted')
    if (!existsSync(installationDirectory(home))) return emptyScan(false, null)
    const dbPath = databasePath(home)
    if (!existsSync(dbPath)) return emptyScan(true, null)
    const opened = await openDatabase(dbPath)
    if (opened.db === null) {
      if (opened.sqliteMissing) return emptyScan(false, null)
      return emptyScan(true, opened.error ?? 'database-unreadable')
    }
    try {
      // Prove the database is really openable read-only before reporting the schema limitation: a
      // locked or corrupt file is a different problem and must not be hidden behind "unsupported".
      opened.db.prepare('SELECT count(*) FROM sqlite_master').get()
      return emptyScan(true, UNSUPPORTED_SCHEMA)
    } catch (error) {
      return emptyScan(true, messageOf(error))
    } finally {
      closeDatabase(opened.db)
    }
  } catch (error) {
    return emptyScan(true, messageOf(error))
  }
}

/**
 * Read one Cline conversation; the observed schema has no turns to read.
 * @param id the raw Cline session id (without the `cline/` prefix).
 * @param options `{home, signal?}`.
 * @returns the contract's `readSession` result; never throws.
 */
export async function readSession(id, options) {
  try {
    if (!isSafeSessionId(id)) return emptySession('invalid-id')
    const home = homeOf(options)
    if (home.length === 0) return emptySession('not-found')
    if (!existsSync(installationDirectory(home))) return emptySession('not-found')
    const dbPath = databasePath(home)
    if (!existsSync(dbPath)) return emptySession('not-found')
    if (isAborted(signalOf(options))) return emptySession('aborted')
    const opened = await openDatabase(dbPath)
    if (opened.db === null) {
      if (opened.sqliteMissing) return emptySession('sqlite-unavailable')
      return emptySession(opened.error ?? 'database-unreadable')
    }
    closeDatabase(opened.db)
    return emptySession(UNSUPPORTED_SCHEMA)
  } catch (error) {
    return emptySession(messageOf(error))
  }
}
