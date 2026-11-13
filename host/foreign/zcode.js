/**
 * ZCode adapter: one SQLite database, `<home>/.zcode/cli/db/db.sqlite`.
 *
 * The database on this machine is 2 GB and holds 366 sessions, 107k messages and 402k parts, so
 * every statement here is deliberately bounded:
 *
 *   - columns are listed explicitly (never `SELECT *`), and `part` is only ever read for the
 *     message ids the caller asked for;
 *   - `readSession` caps the message count and stops at the caller's byte budget, reporting
 *     `truncated: true`;
 *   - the database is opened `readOnly`, so a scan can never write to (or recover) the live store;
 *   - `node:sqlite` is imported inside the function bodies, so a host Node without that module
 *     degrades to `available: false` instead of failing the plugin's import graph.
 *
 * Message semantics matter for a faithful import. ZCode stores *synthetic* user rows as well
 * (`todo_reminder`, `system_reminder`, `background_notification`, ...) and synthetic assistant rows
 * (`timeline_event`); importing them would make the user appear to have written harness boilerplate.
 * Only `semantics.origin === 'real_user'` (the human's prompts) and
 * `semantics.kind === 'assistant_response'` (the model's replies) are conversation turns. Part types
 * `step-start`, `step-finish`, `timeline` and `compaction` are likewise plumbing and are skipped;
 * `text` and `reasoning` are kept, and a `tool` part becomes a one-line placeholder block because
 * the contract has no tool block type.
 *
 * @module session-log-upload/foreign/zcode
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  emptyScan,
  emptySession,
  homeOf,
  isAborted,
  isSafeSessionId,
  maxBytesOf,
  messageOf,
  signalOf,
  textOf,
  toolPlaceholder,
} from './shared.js'

/** Stable harness id; part of every composite id and of the forged session id. */
export const harness = 'zcode'

/** Display name. */
export const label = 'ZCode'

/** Parts are fetched for at most this many messages per statement, keeping each result set small. */
const MESSAGE_CHUNK = 100

/** `readSession` never returns more than this many messages; a longer session reports `truncated`. */
const MAX_MESSAGES = 10000

/**
 * Rough bytes per `part` row, used for the scan row's `bytes` hint.
 *
 * The contract calls `bytes` a rough estimate ("粗估"). Summing `length(data)` over the whole
 * `part` table would read the entire 2 GB database on every scan (2.2 s warm, several seconds
 * cold), so the part contribution is estimated from the index-only part count instead. Message
 * data is still summed exactly: that table is small enough to read (about 0.3 s).
 */
const ESTIMATED_PART_BYTES = 4096

/** Conversation-turn predicate: the human's prompts plus the model's replies, nothing synthetic. */
const TURN_FILTER =
  "(json_extract(data,'$.semantics.kind') = 'assistant_response' OR json_extract(data,'$.semantics.origin') = 'real_user')"

/**
 * Open the ZCode database read-only, returning `null` on every expected failure.
 *
 * The import of `node:sqlite` is inside this function so a runtime without that module is one
 * caught import failure, not an exception through every call site.
 *
 * @param dbPath absolute database path.
 * @returns `{db, error, sqliteMissing}`; `db` is closed by the caller.
 */
async function openDatabase(dbPath) {
  let sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch {
    // No `node:sqlite` on this runtime: the harness cannot be read at all, so `scan` reports it as
    // unavailable rather than as an error the user could not act on.
    return { db: null, error: null, sqliteMissing: true }
  }
  try {
    // `readOnly` is what makes the 2 GB live store safe to touch: SQLite refuses every write, and
    // no journal or WAL recovery can run against the user's running ZCode instance.
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
    /* a close failure changes nothing the caller can act on */
  }
}

/** The database path inside a home directory. */
function databasePath(home) {
  return join(home, '.zcode', 'cli', 'db', 'db.sqlite')
}

/** A row's timestamp as the contract's millisecond number. */
function rowMillis(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

/** A row's count/sum as a plain number (node:sqlite may hand back a BigInt for large integers). */
function rowNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.trunc(value)
  if (typeof value === 'bigint' && value > 0n) return Number(value)
  return 0
}

/**
 * The provider/model last observed for one session.
 *
 * `model_usage` covers only 24 of the 366 sessions here, so the model actually recorded on the
 * newest assistant message is the dependable source. The adapter reports it verbatim: the source
 * marker is the one place the original provider/model is meant to survive.
 *
 * @param db open database.
 * @param sessionId the session's id.
 * @returns `{provider, model}`; both `''` when nothing was recorded.
 */
function sessionModel(db, sessionId) {
  try {
    const row = db
      .prepare(
        `SELECT json_extract(data,'$.providerId') AS provider, json_extract(data,'$.modelId') AS model
           FROM message
          WHERE session_id = ?
            AND json_extract(data,'$.role') = 'assistant'
            AND json_extract(data,'$.providerId') IS NOT NULL
          ORDER BY sequence DESC
          LIMIT 1`,
      )
      .get(sessionId)
    if (row === null || row === undefined) return { provider: '', model: '' }
    return { provider: textOf(row.provider), model: textOf(row.model) }
  } catch {
    return { provider: '', model: '' }
  }
}

/**
 * List every session ZCode stored, metadata only.
 * @param options `{home, signal?}`; `home` is the user profile directory.
 * @returns the contract's `scan` result; never throws.
 */
export async function scan(options) {
  try {
    const home = homeOf(options)
    const signal = signalOf(options)
    if (home.length === 0) return emptyScan(false, null)
    if (isAborted(signal)) return emptyScan(true, 'aborted')
    if (!existsSync(join(home, '.zcode'))) return emptyScan(false, null)
    const dbPath = databasePath(home)
    // Installed but never run: there is no database yet, which is an empty store, not a failure.
    if (!existsSync(dbPath)) return emptyScan(true, null)
    const opened = await openDatabase(dbPath)
    if (opened.db === null) {
      if (opened.sqliteMissing) return emptyScan(false, null)
      if (opened.error !== null) return emptyScan(true, opened.error)
      return emptyScan(true, null)
    }
    const db = opened.db
    try {
      const rows = db
        .prepare(
          'SELECT id, parent_id, title, directory, time_created, time_updated FROM session ORDER BY time_updated DESC, id',
        )
        .all()
      if (isAborted(signal)) return emptyScan(true, 'aborted')

      // One grouped statement parses each message's JSON twice, not four times: the four-call
      // spelling takes 4.7 s on this database, this one 0.4 s.
      const counts = new Map()
      for (const row of db
        .prepare(`SELECT session_id, count(*) AS n FROM message WHERE ${TURN_FILTER} GROUP BY session_id`)
        .all()) {
        counts.set(textOf(row.session_id), rowNumber(row.n))
      }
      const messageBytes = new Map()
      for (const row of db
        .prepare('SELECT session_id, sum(length(data)) AS b FROM message GROUP BY session_id')
        .all()) {
        messageBytes.set(textOf(row.session_id), rowNumber(row.b))
      }
      const partCounts = new Map()
      for (const row of db.prepare('SELECT session_id, count(*) AS n FROM part GROUP BY session_id').all()) {
        partCounts.set(textOf(row.session_id), rowNumber(row.n))
      }

      const sessions = []
      for (const row of rows) {
        const sessionId = textOf(row.id)
        if (sessionId.length === 0) continue
        const model = sessionModel(db, sessionId)
        sessions.push({
          id: sessionId,
          // ZCode marks a delegated child with a parent id. The page uses it only to indent the row under
          // its parent, so a user can tell a conversation they started from one an agent spawned; it never
          // changes what is sent or how it is addressed.
          parentId: textOf(row.parent_id),
          title: textOf(row.title),
          cwd: textOf(row.directory),
          createdAt: rowMillis(row.time_created),
          updatedAt: rowMillis(row.time_updated),
          messageCount: counts.get(sessionId) ?? 0,
          provider: model.provider,
          model: model.model,
          bytes: (messageBytes.get(sessionId) ?? 0) + (partCounts.get(sessionId) ?? 0) * ESTIMATED_PART_BYTES,
        })
      }
      return { available: true, error: null, sessions }
    } catch (error) {
      return emptyScan(true, messageOf(error))
    } finally {
      closeDatabase(db)
    }
  } catch (error) {
    return emptyScan(true, messageOf(error))
  }
}

/**
 * Translate one ZCode `part` row into the contract's block, or `null` for plumbing parts.
 *
 * @param partType `data.type` of the part.
 * @param textValue `data.text` of the part (text and reasoning parts only).
 * @param toolName `data.tool` of a tool part.
 * @returns `{type,text}` or `null`.
 */
function partBlock(partType, textValue, toolName) {
  if (partType === 'text') {
    const text = textOf(textValue)
    return text.length > 0 ? { type: 'text', text } : null
  }
  if (partType === 'reasoning') {
    const text = textOf(textValue)
    return text.length > 0 ? { type: 'reasoning', text } : null
  }
  if (partType === 'tool') return { type: 'text', text: toolPlaceholder(toolName) }
  // step-start / step-finish / timeline / compaction and anything unknown are not conversation content.
  return null
}

/**
 * Read one ZCode session as the contract's conversation shape.
 *
 * Statements are bounded three ways: messages by `LIMIT` and {@link MAX_MESSAGES}, parts by the
 * selected message ids only (fetched {@link MESSAGE_CHUNK} messages at a time), and total original
 * part data by the caller's byte budget. Only the columns a block needs are selected, so a 40 MB
 * tool-output session does not become a 40 MB JavaScript string.
 *
 * @param id the raw ZCode session id (without the `zcode/` prefix).
 * @param options `{home, signal?, maxBytes?}`.
 * @returns the contract's `readSession` result; never throws.
 */
export async function readSession(id, options) {
  try {
    if (!isSafeSessionId(id)) return emptySession('invalid-id')
    const home = homeOf(options)
    const signal = signalOf(options)
    if (home.length === 0) return emptySession('not-found')
    if (!existsSync(join(home, '.zcode'))) return emptySession('not-found')
    const dbPath = databasePath(home)
    if (!existsSync(dbPath)) return emptySession('not-found')
    if (isAborted(signal)) return emptySession('aborted')
    const opened = await openDatabase(dbPath)
    if (opened.db === null) return emptySession(opened.sqliteMissing ? 'sqlite-unavailable' : opened.error ?? 'database-unreadable')
    const db = opened.db
    try {
      const session = db
        .prepare('SELECT id, title, directory, time_created FROM session WHERE id = ? LIMIT 1')
        .get(id)
      if (session === null || session === undefined) return emptySession('not-found')

      const model = sessionModel(db, id)
      const result = {
        id,
        error: null,
        title: textOf(session.title),
        cwd: textOf(session.directory),
        createdAt: rowMillis(session.time_created),
        provider: model.provider,
        model: model.model,
        truncated: false,
        messages: [],
      }

      const rows = db
        .prepare(
          `SELECT id, time_created, data FROM message
            WHERE session_id = ? AND ${TURN_FILTER}
            ORDER BY sequence
            LIMIT ?`,
        )
        .all(id, MAX_MESSAGES + 1)
      if (rows.length > MAX_MESSAGES) result.truncated = true
      const selected = rows.length > MAX_MESSAGES ? rows.slice(0, MAX_MESSAGES) : rows

      // Pre-parse the role and timing; a malformed row is skipped rather than aborting the read.
      const messages = []
      for (const row of selected) {
        let data
        try {
          data = JSON.parse(textOf(row.data))
        } catch {
          continue
        }
        if (data === null || typeof data !== 'object' || Array.isArray(data)) continue
        const role = data.role === 'user' ? 'user' : data.role === 'assistant' ? 'assistant' : null
        if (role === null) continue
        messages.push({ id: textOf(row.id), role, time: rowMillis(row.time_created), blocks: [] })
      }

      // The byte budget counts the original `part` data, so a session whose content would exceed the
      // upload cap stops cleanly with `truncated: true` instead of being read to the end.
      const budget = maxBytesOf(options)
      let consumed = 0
      for (let start = 0; start < messages.length; start += MESSAGE_CHUNK) {
        if (isAborted(signal)) {
          result.error = 'aborted'
          result.truncated = true
          break
        }
        const chunk = messages.slice(start, start + MESSAGE_CHUNK)
        const ids = chunk.map((message) => message.id)
        const placeholders = ids.map(() => '?').join(',')
        let partRows
        try {
          partRows = db
            .prepare(
              `SELECT message_id,
                      length(data) AS data_length,
                      json_extract(data,'$.type') AS part_type,
                      json_extract(data,'$.text') AS text_value,
                      json_extract(data,'$.tool') AS tool_name
                 FROM part
                WHERE message_id IN (${placeholders})
                ORDER BY message_id, sequence`,
            )
            .all(...ids)
        } catch (error) {
          result.error = messageOf(error)
          result.truncated = true
          break
        }
        const byMessage = new Map()
        for (const partRow of partRows) {
          const messageId = textOf(partRow.message_id)
          const block = partBlock(textOf(partRow.part_type), partRow.text_value, partRow.tool_name)
          consumed += Math.max(0, rowNumber(partRow.data_length))
          if (block !== null) {
            const list = byMessage.get(messageId)
            if (list === undefined) byMessage.set(messageId, [block])
            else list.push(block)
          }
        }
        for (const message of chunk) {
          message.blocks = byMessage.get(message.id) ?? []
          if (message.blocks.length > 0) result.messages.push({ role: message.role, time: message.time, blocks: message.blocks })
        }
        if (consumed > budget) {
          result.truncated = true
          break
        }
      }
      return result
    } catch (error) {
      return emptySession(messageOf(error))
    } finally {
      closeDatabase(db)
    }
  } catch (error) {
    return emptySession(messageOf(error))
  }
}
