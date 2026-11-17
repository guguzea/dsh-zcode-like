/**
 * Google Antigravity adapter. Store: `<home>/.gemini/antigravity/`.
 *
 * Two databases matter, and the split is the whole design:
 *
 *   conversation_summaries.db   ONE index for every conversation: id, title, step count, timestamp,
 *                               workspace URIs, parent link, nesting depth. This is what `scan` reads,
 *                               so listing does not open a file per conversation.
 *   conversations/<id>.db       per-conversation SQLite whose `steps.step_payload` column is
 *                               **protobuf** (`step_format = 0`). The schema is private and the bytes
 *                               are not self-describing, so this adapter does NOT decode them.
 *
 * Instead the transcript text comes from the index's own full-text table `conversations_fts`, which
 * stores plain UTF-8 `user_body` / `agent_body` per chunk. That is the vendor's own extraction of the
 * conversation, not a guess: it is what Antigravity's search feature indexes, and it is why the text
 * quality matches what the UI shows. `user_step_byte_offsets` / `agent_step_byte_offsets` are
 * `[[newlineIndex, byteOffset], ...]`, one pair per step, and they are used to recover per-message
 * boundaries instead of dumping one blob into a single message.
 *
 * Reading real data on this machine: a 76-step conversation yields 27 user characters and 1338 agent
 * characters — the assistant's prose is complete, the user side is short because the user typed one
 * line. That asymmetry is the data, not truncation, and it is reported honestly via `truncated`.
 *
 * `node:sqlite` is imported lazily, so a runtime without it degrades to `available: false`.
 *
 * @module session-log-upload/foreign/antigravity
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { emptyScan, emptySession, homeOf, isAborted, messageOf, signalOf, textOf, titleOf, toMillis } from './shared.js'

/** Stable harness id; part of every composite id and of the forged session id. */
export const harness = 'antigravity'

/** Display name. */
export const label = 'Antigravity'

/** Directory that holds the whole Antigravity state. */
function installationDirectory(home) {
  return join(home, '.gemini', 'antigravity')
}

/** The index database: one row per conversation. */
function summaryDatabasePath(home) {
  return join(installationDirectory(home), 'conversation_summaries.db')
}

/** The per-conversation database directory. */
function conversationsDirectory(home) {
  return join(installationDirectory(home), 'conversations')
}

/** Per-conversation database path for one id. The id is validated before this is called. */
function conversationDatabasePath(home, id) {
  return join(conversationsDirectory(home), `${id}.db`)
}

/** Longest accepted raw id. Antigravity ids are UUID-shaped. */
const MAX_ID_LENGTH = 120

/**
 * Open one SQLite database read-only.
 *
 * `readOnly` is honoured by `node:sqlite`; every failure is returned, never thrown, because a locked
 * or half-written database must degrade to "unreadable" rather than fail the whole scan.
 *
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
 * Whether an id is safe to use as a file name.
 *
 * Antigravity ids are UUIDs, so the accepted shape is deliberately narrow: it must not be able to
 * address a path outside `conversations/`.
 *
 * @param value candidate raw id.
 * @returns `true` when it is a plain file stem.
 */
function isSafeId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value !== '.' &&
    value !== '..' &&
    /^[A-Za-z0-9._-]+$/.test(value)
  )
}

/**
 * Turn the stored `workspace_uris` JSON into one working directory.
 *
 * The column holds a JSON array of `file:///` URIs, percent-encoded (`file:///f%3A/TEST` is
 * `f:/TEST`). Only the first entry is used: the import contract has one `cwd` per conversation, and a
 * multi-root conversation is better represented by its first root than by a synthetic path.
 *
 * @param value the raw column value.
 * @returns an absolute-looking path, or `''`.
 */
export function workspacePath(value) {
  try {
    const text = textOf(value)
    if (text.length === 0) return ''
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed) || parsed.length === 0) return ''
    const first = typeof parsed[0] === 'string' ? parsed[0] : ''
    if (first.length === 0) return ''
    const withoutScheme = first.replace(/^file:\/\/\/?/i, '')
    if (withoutScheme.length === 0) return ''
    const decoded = decodeURIComponent(withoutScheme)
    // A Windows drive arrives as `f:/TEST`; keep forward slashes, they are valid on every platform.
    return decoded
  } catch {
    return ''
  }
}

/**
 * Read the step offsets column into message boundaries.
 *
 * The column is a JSON array of `[index, ordinal]` pairs stored as a BLOB. Measured against a real
 * 76-step conversation on this machine, the **first** value is the boundary: a line index into the
 * body, ascending, ending at the last line. The **second** value is NOT a byte offset and NOT a line
 * number — it is the step's ordinal within Antigravity's own corpus (0..19, then 170..179, then
 * 288..290 in that sample), so it is carried through untouched and never used for slicing.
 *
 * Slicing by the second value was tried first and collapsed a 33-message conversation into one blob:
 * those numbers run past the body's byte length. Only the first value is meaningful here.
 *
 * A malformed value yields `[]`, which means "one message" rather than a lost conversation.
 *
 * @param value the raw column value.
 * @returns ascending line indices, one per step.
 */
export function stepBoundaries(value) {
  try {
    // `node:sqlite` hands BLOBs back as `Uint8Array`, not `Buffer`, so the type test covers both (a
    // `Buffer.isBuffer`-only check silently produced zero boundaries).
    const text =
      value instanceof Uint8Array
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8')
        : textOf(value)
    if (text.length === 0) return []
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    const indices = []
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length === 0) continue
      const index = Number(entry[0])
      if (!Number.isFinite(index) || index < 0) continue
      indices.push(Math.trunc(index))
    }
    return indices
  } catch {
    return []
  }
}

/**
 * Split one body into per-step slices using the line boundaries.
 *
 * Each boundary closes the step that started at the previous one; text between boundaries belongs to
 * one step. A step whose output was only a tool call contributes an empty slice, and empty slices are
 * dropped: they carry no words to import, and the step count is already reported as `messageCount`.
 *
 * @param body the body text (one conversation chunk).
 * @param boundaries ascending line indices, one per step.
 * @returns the non-empty slices, in order.
 */
export function splitByBoundaries(body, boundaries) {
  const text = textOf(body)
  if (text.length === 0) return []
  if (!Array.isArray(boundaries) || boundaries.length === 0) {
    const whole = text.trim()
    return whole.length === 0 ? [] : [whole]
  }
  const lines = text.split('\n')
  const slices = []
  let previous = 0
  for (const boundary of boundaries) {
    const end = Math.min(Math.max(boundary, previous), lines.length)
    const slice = lines.slice(previous, end).join('\n').trim()
    if (slice.length > 0) slices.push(slice)
    previous = end
  }
  const tail = lines.slice(previous).join('\n').trim()
  if (tail.length > 0) slices.push(tail)
  return slices
}

/**
 * One `conversation_summaries` row, as the contract's summary shape.
 *
 * @param row the raw row object.
 * @param sizeBytes the conversation database size, when known.
 * @param titleById map used to name a parent that the row itself does not describe.
 * @returns the session summary.
 */
function summaryOf(row, sizeBytes, titleById) {
  const id = textOf(row.conversation_id)
  const title = titleOf(row.title) ?? titleOf(row.preview) ?? ''
  const workspace = workspacePath(row.workspace_uris)
  const parentId = textOf(row.parent_conversation_id)
  const stepCount = Number(row.step_count)
  return {
    id,
    // The parent is a bare id; the registry prefixes it. An empty parent means top level.
    parentId: parentId.length > 0 && parentId !== id ? parentId : '',
    title: title.length > 0 ? title : '',
    cwd: workspace,
    createdAt: toMillis(row.first_modified_time ?? row.last_modified_time) ?? 0,
    updatedAt: toMillis(row.last_modified_time) ?? 0,
    // Every step is one user or assistant turn in this store, so the step count IS the message count.
    messageCount: Number.isSafeInteger(stepCount) && stepCount > 0 ? stepCount : 0,
    // Antigravity does not record the serving model per conversation in the index, and inventing one
    // would put a lie into the source marker. Reported empty.
    provider: '',
    model: '',
    bytes: Number.isSafeInteger(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0,
  }
}

/**
 * List every conversation Antigravity recorded, metadata only.
 *
 * @param options `{home, signal?, cache?, maxBytes?}`.
 * @returns the contract's `scan` result; never throws.
 */
export async function scan(options) {
  try {
    const home = homeOf(options)
    const signal = signalOf(options)
    if (home.length === 0) return emptyScan(false, null)
    if (isAborted(signal)) return emptyScan(true, 'aborted')
    if (!existsSync(installationDirectory(home))) return emptyScan(false, null)
    const dbPath = summaryDatabasePath(home)
    if (!existsSync(dbPath)) return emptyScan(true, null)
    const opened = await openDatabase(dbPath)
    if (opened.db === null) {
      if (opened.sqliteMissing) return emptyScan(false, null)
      return emptyScan(true, opened.error ?? 'database-unreadable')
    }
    const db = opened.db
    try {
      const rows = db
        .prepare(
          `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
                  parent_conversation_id, nesting_depth
             FROM conversation_summaries
            ORDER BY last_modified_time DESC`,
        )
        .all()
      if (isAborted(signal)) return emptyScan(true, 'aborted')

      // Sizes come from the per-conversation files; a missing file is not an error, it only means the
      // size hint is unknown.
      const sizes = new Map()
      for (const row of rows) {
        const id = textOf(row.conversation_id)
        if (!isSafeId(id)) continue
        const file = conversationDatabasePath(home, id)
        try {
          if (existsSync(file)) sizes.set(id, statSync(file).size)
        } catch {
          /* a size hint is optional */
        }
      }

      const sessions = []
      for (const row of rows) {
        const id = textOf(row.conversation_id)
        if (!isSafeId(id)) continue
        sessions.push(summaryOf(row, sizes.get(id), null))
      }
      if (sessions.length === 0) return { available: true, error: null, sessions: [] }
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
 * Read one Antigravity conversation as user/assistant messages.
 *
 * The text is the index's own `conversations_fts` extraction, split per step by the byte offsets the
 * same row carries. Nothing is decoded out of the per-conversation protobuf.
 *
 * @param id the raw Antigravity conversation id (without the `antigravity/` prefix).
 * @param options `{home, signal?, maxBytes?}`.
 * @returns the contract's `readSession` result; never throws.
 */
export async function readSession(id, options) {
  try {
    if (!isSafeId(id)) return emptySession('invalid-id')
    const home = homeOf(options)
    if (home.length === 0) return emptySession('not-found')
    if (!existsSync(installationDirectory(home))) return emptySession('not-found')
    const summaryPath = summaryDatabasePath(home)
    if (!existsSync(summaryPath)) return emptySession('not-found')
    if (isAborted(signalOf(options))) return emptySession('aborted')
    const opened = await openDatabase(summaryPath)
    if (opened.db === null) {
      if (opened.sqliteMissing) return emptySession('sqlite-unavailable')
      return emptySession(opened.error ?? 'database-unreadable')
    }
    const db = opened.db
    try {
      const summary = db
        .prepare(
          `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris
             FROM conversation_summaries WHERE conversation_id = ? LIMIT 1`,
        )
        .get(id)
      if (summary === null || summary === undefined) return emptySession('not-found')

      let chunks
      try {
        chunks = db
          .prepare(
            `SELECT chunk_index, user_body, agent_body, user_step_byte_offsets, agent_step_byte_offsets
               FROM conversations_fts WHERE conversation_id = ? ORDER BY chunk_index`,
          )
          .all(id)
      } catch (error) {
        // The full-text table is an index, not the conversation: a store whose search index has not
        // been built yields a conversation with no readable turns, which is said out loud.
        chunks = []
        if (messageOf(error).length > 0) chunks = []
      }

      const result = {
        id,
        error: null,
        title: titleOf(summary.title) ?? titleOf(summary.preview) ?? '',
        cwd: workspacePath(summary.workspace_uris),
        createdAt: toMillis(summary.last_modified_time) ?? 0,
        provider: '',
        model: '',
        truncated: false,
        messages: [],
      }

      for (const chunk of chunks) {
        if (isAborted(signalOf(options))) {
          result.error = 'aborted'
          result.truncated = true
          break
        }
        const userSlices = splitByBoundaries(chunk.user_body, stepBoundaries(chunk.user_step_byte_offsets))
        const agentSlices = splitByBoundaries(chunk.agent_body, stepBoundaries(chunk.agent_step_byte_offsets))
        for (const text of userSlices) {
          result.messages.push({ role: 'user', time: result.createdAt, blocks: [{ type: 'text', text }] })
        }
        for (const text of agentSlices) {
          result.messages.push({ role: 'assistant', time: result.createdAt, blocks: [{ type: 'text', text }] })
        }
      }

      if (result.messages.length === 0) result.error = 'no-readable-turns'
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
