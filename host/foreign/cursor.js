/**
 * Cursor adapter: one JSONL transcript per conversation,
 * `<home>/.cursor/projects/<workspace>/agent-transcripts/<id>/<id>.jsonl`.
 *
 * Cursor's format is the simplest of the five: each line is `{role, message: {content: [...]}}`
 * with `text`, `tool_use` and occasionally `thinking` blocks, in the same shape for user and
 * assistant. There is no session metadata record at all, so the title is derived from the first
 * user text and the timestamps are the file's own (creation and modification) times.
 *
 * The working directory and the model are not in the transcript, and the project directory name is
 * Cursor's *lossy* encoding of the path (separators, underscores and **every non-ASCII character**
 * become `-`), so decoding it would be a guess. Cursor keeps the real values in its own state
 * database instead:
 *
 *   `<home>/AppData/Roaming/Cursor/User/globalStorage/state.vscdb` (Windows; macOS/Linux have their
 *   own candidate paths below — the first existing one is used, read-only):
 *   - `composerHeaders.value.workspaceIdentifier.fsPath` (or `.uri.fsPath`) is the exact cwd, and
 *     a header without it may still name a `workspaceId` whose
 *     `workspaceStorage/<workspaceId>/workspace.json` holds a `file:///` `.folder` URI;
 *   - `cursorDiskKV` key `composerData:<composerId>` → `modelConfig.selectedModels[0].modelId` is
 *     the model actually used.
 *
 * Only primary-key lookups are used: `composerHeaders` is read once (a few hundred small rows) and
 * the `composerData:` rows are fetched in batched `key IN (...)` chunks for the conversations being
 * listed. A `LIKE 'composerData:%'` scan was measured at more than 180 s on an 11.6 GB store and is
 * never used here. The database is opened `readOnly`, and a missing, unreadable or corrupt one is
 * one caught failure: the scan then reports empty cwd/model exactly as before.
 *
 * Because this metadata lives in a different file, the scan cache key carries a stamp of the main
 * database file's identity. The stamp exists to keep a *cached* row honest, not to notice new
 * conversations: cached rows are existing conversations, whose workspace and model do not change,
 * while a new conversation is a transcript-file cache miss anyway — the adapter opens the database
 * for that miss and reads its metadata fresh. Cursor's `-wal` file is deliberately *not* part of the
 * stamp: Cursor writes it constantly whenever it runs, so including it would throw away every
 * Cursor row between "use Cursor" and "click scan" and pay the cold metadata read again each time.
 * When every transcript row is already cached the database is not opened at all during `scan`.
 * `readSession` resolves the same cwd/model (same rules, same inheritance) so the record that is
 * sent agrees with the row the page listed; it does one header and one composerData primary-key
 * lookup per conversation, and only when the store actually exists.
 *
 * Cursor also records delegated conversations one level down:
 * `<project>/agent-transcripts/<sessionId>/subagents/<subagentId>.jsonl`, in exactly the same line
 * shape as a top-level transcript. Those are listed with `parentId = <sessionId>` and addressed by
 * the raw id `<sessionId>/subagents/<subagentId>`; the title is the first user text, and they take
 * their own metadata row when one exists, otherwise their parent's cwd/model.
 *
 * @module session-log-upload/foreign/cursor
 */

import { dirname, join } from 'node:path'

import {
  HEAD_BYTES,
  SUBAGENTS_DIRECTORY,
  baseNameWithoutExtension,
  countJsonlMessages,
  emptyScan,
  emptySession,
  firstText,
  formatSubagentId,
  homeOf,
  isAborted,
  isFile,
  isSafeIdSegment,
  isSafeSessionId,
  listDirSafe,
  maxBytesOf,
  messageOf,
  parseSubagentId,
  readHead,
  readJsonl,
  readScanCache,
  signalOf,
  statSafe,
  textOf,
  titleOf,
  toolPlaceholder,
  writeScanCache,
} from './shared.js'

/** Stable harness id; part of every composite id and of the forged session id. */
export const harness = 'cursor'

/** Display name. */
export const label = 'Cursor'

/** The `.cursor` directory: present when Cursor is installed. */
function installationDirectory(home) {
  return join(home, '.cursor')
}

/** The `.../projects` directory. */
function projectsDirectory(home) {
  return join(installationDirectory(home), 'projects')
}

/** The `agent-transcripts` directory of one workspace. */
function transcriptsDirectory(projectPath) {
  return join(projectPath, 'agent-transcripts')
}

/**
 * Whether one JSONL line is a conversation message, decided from its prefix only.
 * @param prefix the first characters of a line.
 * @returns `true` for a user or assistant line.
 */
function isMessageLine(prefix) {
  return prefix.startsWith('{"role":"user"') || prefix.startsWith('{"role":"assistant"')
}

/**
 * Recover the title from the transcript's leading lines.
 * @param head the first {@link HEAD_BYTES} of the file.
 * @returns the first user text reduced to a title, or `''`.
 */
function describeHead(head) {
  for (const line of head.split('\n')) {
    if (line.length === 0) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
    if (record.role !== 'user') continue
    const title = titleOf(firstText(record.message?.content))
    if (title.length > 0) return title
  }
  return ''
}

/**
 * The transcript file of one conversation inside its directory, or `null`.
 * @param directory the conversation directory (named by the id).
 * @param id the conversation id.
 * @returns the file path, or `null`.
 */
async function transcriptFile(directory, id) {
  const preferred = join(directory, `${id}.jsonl`)
  if (await statSafe(preferred)) return preferred
  for (const entry of await listDirSafe(directory)) {
    if (entry.isFile() === true && entry.name.endsWith('.jsonl')) return join(directory, entry.name)
  }
  return null
}

/** Most composer ids one SQLite `IN (...)` statement addresses; keeps each statement small. */
const COMPOSER_LOOKUP_CHUNK = 200

/** The JSON path of the model id Cursor records for one composer. */
const MODEL_PATH = '$.modelConfig.selectedModels[0].modelId'

/**
 * Candidate locations of Cursor's global state database, most likely first.
 * @param home the home directory.
 * @returns absolute candidate paths.
 */
function stateDatabaseCandidates(home) {
  return [
    join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'), // Windows
    join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'), // macOS
    join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'), // Linux
  ]
}

/**
 * Locate Cursor's state database.
 * @param home the home directory.
 * @returns `{path, info}` for the first existing database, or `null`.
 */
async function locateStateDatabase(home) {
  for (const candidate of stateDatabaseCandidates(home)) {
    const info = await statSafe(candidate)
    if (info === null || info.isFile() !== true) continue
    return { path: candidate, info }
  }
  return null
}

/** The cached dynamic import of `node:sqlite`: imported at most once, its failure caught once. */
let sqlitePromise

/**
 * One shared `node:sqlite` import for this module.
 *
 * The import is dynamic because a runtime without that module must degrade to "no metadata"
 * instead of failing the plugin's import graph. The promise is cached, so there is exactly one
 * import site and a missing module is one caught failure for every caller.
 * @returns the `node:sqlite` module, or `null` when it is unavailable.
 */
function loadSqlite() {
  sqlitePromise ??= import('node:sqlite').catch(() => null)
  return sqlitePromise
}

/**
 * Open Cursor's state database read-only.
 *
 * The one place that opens the store: `readOnly` is what makes an 11.6 GB live database safe to
 * touch, and every expected failure (no module, missing/corrupt file, permissions) is one caught
 * `null`. A caller that receives `null` simply reports no metadata.
 *
 * @param path the located database path.
 * @returns the open `DatabaseSync`, or `null`.
 */
async function openReadOnlyDatabase(path) {
  const sqlite = await loadSqlite()
  if (sqlite === null) return null
  try {
    return new sqlite.DatabaseSync(path, { readOnly: true })
  } catch {
    return null
  }
}

/**
 * The scan-cache stamp of the current Cursor metadata: the main state database's file identity.
 *
 * Only the main DB file is part of it. The stamp keeps a *cached* row honest — an existing
 * conversation's workspace and model do not change — and a new conversation never needs the stamp
 * to change: its transcript has no cache entry, so the scan misses, opens the database and reads
 * `composerHeaders`/`composerData` fresh. Cursor's `-wal` is deliberately excluded: Cursor rewrites
 * it constantly while running, and including it would invalidate every cached Cursor row on every
 * scan in the ordinary "used Cursor, then clicked scan" case, forcing the cold metadata read again.
 * A missing store is its own stamp (`absent`), so the store appearing later invalidates the cached
 * empty rows. The Node runtime is part of the stamp too: a runtime without `node:sqlite` (or a
 * different bundled version) can recover different metadata from the same store.
 *
 * @param found the result of {@link locateStateDatabase}.
 * @returns the stamp string.
 */
function metadataStampOf(found) {
  const runtime = textOf(process.versions?.node)
  const head = `cursor-state-v2:node:${runtime}`
  if (found === null) return `${head}:absent`
  return `${head}:db:${String(found.info.size)}:${String(found.info.mtimeMs)}:${String(found.info.ctimeMs)}`
}

/**
 * Decode the `file:///...` folder URI Cursor stores in `workspace.json`.
 * @param value the `.folder` value.
 * @returns the decoded path, or `''`.
 */
function folderUriToPath(value) {
  const text = textOf(value).trim()
  if (text.length === 0) return ''
  try {
    const url = new URL(text)
    if (url.protocol !== 'file:') return ''
    let path = decodeURIComponent(url.pathname)
    // `file:///c%3A/...` decodes to `/c:/...`; a Windows path does not keep the leading slash.
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
    return path
  } catch {
    return ''
  }
}

/**
 * Read `<User>/workspaceStorage/<workspaceId>/workspace.json` and recover its `.folder` path.
 * @param statePath the state database path (its grandparent is `.../User`).
 * @param workspaceId the workspace id from `composerHeaders`.
 * @returns the decoded folder path, or `''`.
 */
async function readWorkspaceFolder(statePath, workspaceId) {
  if (!isSafeIdSegment(workspaceId)) return ''
  const workspaceFile = join(dirname(dirname(statePath)), 'workspaceStorage', workspaceId, 'workspace.json')
  const head = await readHead(workspaceFile, 64 * 1024)
  if (head === null) return ''
  try {
    const parsed = JSON.parse(head)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
    return folderUriToPath(parsed.folder)
  } catch {
    return ''
  }
}

/** The exact cwd recorded on one `composerHeaders` value, or `''`. */
function headerCwd(value) {
  try {
    const parsed = JSON.parse(value)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
    const identifier = parsed.workspaceIdentifier
    if (identifier === null || typeof identifier !== 'object' || Array.isArray(identifier)) return ''
    // The store has used both a flat `fsPath` and a nested `uri.fsPath`; either one is exact.
    return textOf(identifier.fsPath) || textOf(identifier.uri?.fsPath)
  } catch {
    return ''
  }
}

/**
 * Load cwd/model for the conversations a scan has to describe, from Cursor's own state database.
 *
 * Nothing here throws: a missing database, a runtime without `node:sqlite`, an unreadable or
 * corrupt file, or a malformed row all degrade to empty maps — exactly the adapter's behaviour
 * before this metadata existed. Memory stays bounded (one query for the few hundred header rows,
 * then batched primary-key lookups of only the ids the scan needs), and no `LIKE` scan of the
 * multi-GB key/value table is ever issued.
 *
 * @param found the located state database, or `null`.
 * @param composerIds the composer ids of the rows about to be described.
 * @param signal the caller's abort signal.
 * @returns `{cwdById, modelById}`.
 */
async function loadCursorMetadata(found, composerIds, signal) {
  const cwdById = new Map()
  const modelById = new Map()
  if (found === null || composerIds.size === 0) return { cwdById, modelById }
  const db = await openReadOnlyDatabase(found.path)
  if (db === null) return { cwdById, modelById }
  try {
    const workspaceIds = new Map()
    try {
      for (const row of db.prepare('SELECT composerId, workspaceId, value FROM composerHeaders').all()) {
        const id = textOf(row.composerId)
        if (id.length === 0) continue
        cwdById.set(id, headerCwd(textOf(row.value)))
        const workspaceId = textOf(row.workspaceId)
        if (workspaceId.length > 0) workspaceIds.set(id, workspaceId)
      }
    } catch {
      /* no usable header table: no cwd, but the model lookup may still work */
    }
    // Fallback cwd: a header can name only a workspaceId, whose workspace.json holds the exact
    // folder as a file URI.
    const folders = new Map()
    for (const id of composerIds) {
      const cwd = cwdById.get(id)
      if (cwd === undefined || cwd.length > 0) continue
      const workspaceId = workspaceIds.get(id) ?? ''
      if (workspaceId.length === 0) continue
      let folder = folders.get(workspaceId)
      if (folder === undefined) {
        folder = await readWorkspaceFolder(found.path, workspaceId)
        folders.set(workspaceId, folder)
      }
      if (folder.length > 0) cwdById.set(id, folder)
    }
    // Models: primary-key lookups only, in bounded chunks, and only for ids the headers know about
    // (a conversation with no header row keeps the empty model it always had).
    const lookupIds = [...composerIds].filter((id) => cwdById.has(id))
    for (let start = 0; start < lookupIds.length; start += COMPOSER_LOOKUP_CHUNK) {
      if (isAborted(signal)) break
      const chunk = lookupIds.slice(start, start + COMPOSER_LOOKUP_CHUNK)
      const placeholders = chunk.map(() => '?').join(',')
      let rows
      try {
        rows = db
          .prepare(`SELECT key, json_extract(value,'${MODEL_PATH}') AS model FROM cursorDiskKV WHERE key IN (${placeholders})`)
          .all(...chunk.map((id) => `composerData:${id}`))
      } catch {
        continue
      }
      for (const row of rows) {
        const key = textOf(row.key)
        if (!key.startsWith('composerData:')) continue
        const model = textOf(row.model)
        if (model.length > 0) modelById.set(key.slice('composerData:'.length), model)
      }
    }
  } catch {
    /* any metadata failure simply means "no cwd/model known" */
  } finally {
    try {
      db.close()
    } catch {
      /* a failed close must not fail the scan */
    }
  }
  return { cwdById, modelById }
}

/** No metadata: the maps a scan uses when the state database is absent or unusable. */
function emptyMetadata() {
  return { cwdById: new Map(), modelById: new Map() }
}

/**
 * Load one conversation's header row and its composerData model into the metadata maps.
 *
 * A read is about exactly one conversation, so this uses primary-key lookups rather than the scan's
 * one-shot headers query + batched IN lookup. The rules are the scan's rules: the header's exact
 * `fsPath` (or its workspace's `workspace.json` fallback) is the cwd, and only a conversation with
 * a header row can have a model (a `composerData` row alone keeps the empty model).
 *
 * @param db the open read-only state database.
 * @param statePath the database path, used to find `workspaceStorage`.
 * @param metadata the maps to fill.
 * @param composerId the conversation's composer id.
 */
async function loadOneComposer(db, statePath, metadata, composerId) {
  let header
  try {
    header = db.prepare('SELECT composerId, workspaceId, value FROM composerHeaders WHERE composerId = ? LIMIT 1').get(composerId)
  } catch {
    return
  }
  if (header === null || header === undefined) return
  let cwd = headerCwd(textOf(header.value))
  const workspaceId = textOf(header.workspaceId)
  if (cwd.length === 0 && workspaceId.length > 0) cwd = await readWorkspaceFolder(statePath, workspaceId)
  metadata.cwdById.set(composerId, cwd)
  try {
    const row = db
      .prepare(`SELECT json_extract(value,'${MODEL_PATH}') AS model FROM cursorDiskKV WHERE key = ? LIMIT 1`)
      .get(`composerData:${composerId}`)
    const model = textOf(row?.model)
    if (model.length > 0) metadata.modelById.set(composerId, model)
  } catch {
    /* no model known */
  }
}

/**
 * The cwd/model of one conversation for `readSession`, from the same state database and with the
 * same rules (and inheritance) as `scan`, so the row a person sees and the record that leaves the
 * machine agree.
 *
 * Bounded and total: one `composerHeaders` primary-key lookup and one `composerData` primary-key
 * lookup per conversation (the subagent and its parent for a delegated read), opening the database
 * read-only only when it exists. A missing, unreadable or corrupt store returns empty maps, which
 * leaves the raw read's cwd/model empty exactly as before this metadata existed.
 *
 * @param home the home directory.
 * @param rawId the validated raw conversation id.
 * @param parentId the parent conversation id for a delegated read, or `''`.
 * @param signal the caller's abort signal.
 * @returns `{cwdById, modelById}`.
 */
async function readConversationMetadata(home, rawId, parentId, signal) {
  const metadata = emptyMetadata()
  const found = await locateStateDatabase(home)
  if (found === null) return metadata
  const db = await openReadOnlyDatabase(found.path)
  if (db === null) return metadata
  try {
    const composerIds = [composerIdOf(rawId)]
    if (parentId.length > 0 && parentId !== composerIds[0]) composerIds.push(parentId)
    for (const composerId of composerIds) {
      if (isAborted(signal)) break
      await loadOneComposer(db, found.path, metadata, composerId)
    }
  } catch {
    /* no metadata known */
  } finally {
    try {
      db.close()
    } catch {
      /* a failed close must not fail the read */
    }
  }
  return metadata
}

/**
 * The composer id encoded in a raw transcript id: the id itself at top level, the file stem for a
 * delegated transcript.
 * @param rawId a validated raw id.
 * @returns the composer id.
 */
function composerIdOf(rawId) {
  const delegated = parseSubagentId(rawId)
  return delegated === null ? rawId : delegated.subagentId
}

/**
 * Resolve one conversation's cwd/model, inheriting from the parent for a delegated transcript.
 * @param composerId the conversation's own composer id.
 * @param parentId the parent conversation id, or `''`.
 * @param metadata the maps from {@link loadCursorMetadata}.
 * @returns `{cwd, model}`; both `''` when nothing is known.
 */
function metadataFor(composerId, parentId, metadata) {
  const delegated = parentId.length > 0
  const ownCwd = metadata.cwdById.get(composerId)
  const ownModel = metadata.modelById.get(composerId)
  let cwd = ownCwd ?? ''
  if (delegated && ownCwd === undefined) cwd = metadata.cwdById.get(parentId) ?? ''
  const model = ownModel ?? (delegated ? metadata.modelById.get(parentId) : undefined) ?? ''
  return { cwd, model }
}

/**
 * Build one scan row for a transcript, top-level or delegated.
 * @param filePath transcript path.
 * @param id the raw id `readSession` resolves again (one segment, or `parent/subagents/child`).
 * @param info the file's `Stats`.
 * @param parentId the parent conversation id for a delegated transcript, `''` for a top-level one.
 * @param options the contract's options object; `options.cache` makes the summary durable.
 * @param stamp the Cursor metadata identity that invalidates the row when the main state database
 *   file changes.
 * @param metadata the cwd/model maps for the conversations being described.
 * @returns a contract session summary; never throws.
 */
async function describeFile(filePath, id, info, parentId, options, stamp, metadata) {
  const cached = readScanCache(harness, filePath, info, options, stamp)
  if (cached !== null) {
    return { ...cached, updatedAt: Math.trunc(info.mtimeMs) || 0, bytes: Math.trunc(info.size) || 0 }
  }
  const head = await readHead(filePath, HEAD_BYTES)
  const resolved = metadataFor(composerIdOf(id), parentId, metadata)
  const summary = {
    id,
    title: describeHead(head ?? ''),
    cwd: resolved.cwd,
    createdAt: Math.trunc(info.birthtimeMs) || 0,
    // Cursor never records the serving vendor, and this adapter does not invent one.
    provider: '',
    model: resolved.model,
    messageCount: await countJsonlMessages(filePath, isMessageLine),
  }
  if (parentId.length > 0) summary.parentId = parentId
  writeScanCache(harness, filePath, info, summary, options, stamp)
  return { ...summary, updatedAt: Math.trunc(info.mtimeMs) || 0, bytes: Math.trunc(info.size) || 0 }
}

/**
 * List every Cursor conversation, top-level and delegated, metadata only.
 *
 * The state database is only opened when at least one transcript row misses the cache: with a warm
 * cache the metadata stamp costs one stat and the metadata read is skipped entirely.
 *
 * @param options `{home, signal?, cache?}`.
 * @returns the contract's `scan` result; never throws.
 */
export async function scan(options) {
  try {
    const home = homeOf(options)
    const signal = signalOf(options)
    if (home.length === 0) return emptyScan(false, null)
    if (isAborted(signal)) return emptyScan(true, 'aborted')
    const installed = await statSafe(installationDirectory(home))
    if (installed === null || installed.isDirectory() !== true) return emptyScan(false, null)

    // One stat per candidate store; the database itself is read only if a row misses the cache.
    const found = await locateStateDatabase(home)
    const stamp = metadataStampOf(found)
    const sessions = []
    /** Rows the cache did not have; described together after the metadata is loaded once. */
    const pending = []
    /** Record a row from cache, or queue it for the metadata-backed describe pass. */
    const addRow = (filePath, id, info, parentId) => {
      const cached = readScanCache(harness, filePath, info, options, stamp)
      if (cached !== null) {
        sessions.push({ ...cached, updatedAt: Math.trunc(info.mtimeMs) || 0, bytes: Math.trunc(info.size) || 0 })
        return
      }
      pending.push({ filePath, id, info, parentId })
    }
    for (const project of await listDirSafe(projectsDirectory(home))) {
      if (project.isDirectory() !== true) continue
      if (isAborted(signal)) return { available: true, error: 'aborted', sessions }
      const transcripts = transcriptsDirectory(join(projectsDirectory(home), project.name))
      for (const conversation of await listDirSafe(transcripts)) {
        if (conversation.isDirectory() !== true) continue
        if (isAborted(signal)) return { available: true, error: 'aborted', sessions }
        const directory = join(transcripts, conversation.name)
        const filePath = await transcriptFile(directory, conversation.name)
        if (filePath !== null) {
          const info = await statSafe(filePath)
          if (info !== null && info.isFile() === true) addRow(filePath, conversation.name, info, '')
        }
        // Delegated transcripts live one level down and are listed even when the parent transcript
        // itself has already been pruned; the parentId is the directory name either way.
        if (!isSafeIdSegment(conversation.name)) continue
        const subagentsDirectory = join(directory, SUBAGENTS_DIRECTORY)
        for (const subagentFile of await listDirSafe(subagentsDirectory)) {
          if (isAborted(signal)) return { available: true, error: 'aborted', sessions }
          if (subagentFile.isFile() !== true || subagentFile.name.endsWith('.jsonl') !== true) continue
          const subagentId = baseNameWithoutExtension(subagentFile.name)
          if (!isSafeIdSegment(subagentId)) continue
          const subagentPath = join(subagentsDirectory, subagentFile.name)
          const info = await statSafe(subagentPath)
          if (info === null || info.isFile() !== true) continue
          addRow(subagentPath, formatSubagentId(conversation.name, subagentId), info, conversation.name)
        }
      }
    }
    if (pending.length > 0) {
      const composerIds = new Set()
      for (const row of pending) {
        composerIds.add(composerIdOf(row.id))
        if (row.parentId.length > 0) composerIds.add(row.parentId)
      }
      const metadata = found === null ? emptyMetadata() : await loadCursorMetadata(found, composerIds, signal)
      for (const row of pending) {
        if (isAborted(signal)) return { available: true, error: 'aborted', sessions }
        sessions.push(await describeFile(row.filePath, row.id, row.info, row.parentId, options, stamp, metadata))
      }
    }
    sessions.sort((left, right) => right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    return { available: true, error: null, sessions }
  } catch (error) {
    return emptyScan(true, messageOf(error))
  }
}

/**
 * Translate one `message.content` value into the contract's blocks.
 * @param content the value Cursor stored.
 * @returns the blocks; `[]` when nothing importable is present.
 */
function contentBlocks(content) {
  const blocks = []
  if (!Array.isArray(content)) return blocks
  for (const block of content) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    if (block.type === 'text') {
      const text = textOf(block.text)
      if (text.length > 0) blocks.push({ type: 'text', text })
    } else if (block.type === 'thinking' || block.type === 'reasoning') {
      const text = textOf(block.thinking ?? block.text)
      if (text.length > 0) blocks.push({ type: 'reasoning', text })
    } else if (block.type === 'tool_use') {
      blocks.push({ type: 'text', text: toolPlaceholder(block.name) })
    }
    // `tool_result` is stored as its own record type elsewhere; anything unknown is not guessed at.
  }
  return blocks
}

/**
 * Locate one conversation's transcript file.
 * @param home the home directory.
 * @param id the conversation id (already validated as one path component).
 * @returns the file path, or `null`.
 */
async function findTranscript(home, id) {
  for (const project of await listDirSafe(projectsDirectory(home))) {
    if (project.isDirectory() !== true) continue
    const directory = join(transcriptsDirectory(join(projectsDirectory(home), project.name)), id)
    const info = await statSafe(directory)
    if (info === null || info.isDirectory() !== true) continue
    const found = await transcriptFile(directory, id)
    if (found !== null) return found
  }
  return null
}

/**
 * Locate one delegated transcript, `<conversation>/subagents/<subagentId>.jsonl`, across projects.
 * @param home the home directory.
 * @param parentId the validated parent conversation id.
 * @param subagentId the validated sub-agent id.
 * @returns the file path, or `null`.
 */
async function findSubagentTranscript(home, parentId, subagentId) {
  for (const project of await listDirSafe(projectsDirectory(home))) {
    if (project.isDirectory() !== true) continue
    const directory = join(transcriptsDirectory(join(projectsDirectory(home), project.name)), parentId)
    const candidate = join(directory, SUBAGENTS_DIRECTORY, `${subagentId}.jsonl`)
    if (await isFile(candidate)) return candidate
  }
  return null
}

/**
 * Read one Cursor conversation, top-level or delegated.
 *
 * The cwd/model are resolved from the same state database, with the same rules and inheritance, as
 * the scan row, so the record that is sent agrees with the row the settings page showed. The
 * transcript itself is still the only source of messages; a missing or corrupt database leaves
 * cwd/model `''` exactly as before.
 *
 * @param id the raw Cursor id (without the `cursor/` prefix): a conversation id, or
 *   `<sessionId>/subagents/<subagentId>`.
 * @param options `{home, signal?, maxBytes?}`.
 * @returns the contract's `readSession` result; never throws.
 */
export async function readSession(id, options) {
  try {
    const delegated = parseSubagentId(id)
    if (delegated === null && !isSafeSessionId(id)) return emptySession('invalid-id')
    const home = homeOf(options)
    if (home.length === 0) return emptySession('not-found')
    const filePath =
      delegated === null ? await findTranscript(home, id) : await findSubagentTranscript(home, delegated.parentId, delegated.subagentId)
    if (filePath === null) return emptySession('not-found')
    const info = await statSafe(filePath)
    const signal = signalOf(options)
    const parentId = delegated === null ? '' : delegated.parentId
    // The visible row and the record that leaves the machine must agree, so the raw read resolves
    // the same cwd/model from the same state database (empty when it cannot be recovered).
    const metadata = await readConversationMetadata(home, id, parentId, signal)
    const resolved = metadataFor(composerIdOf(id), parentId, metadata)
    const result = {
      id,
      error: null,
      title: '',
      cwd: resolved.cwd,
      createdAt: info !== null ? Math.trunc(info.birthtimeMs) || 0 : 0,
      provider: '',
      model: resolved.model,
      truncated: false,
      messages: [],
    }
    const read = await readJsonl(filePath, { maxBytes: maxBytesOf(options), signal }, (line) => {
      let record
      try {
        record = JSON.parse(line)
      } catch {
        return
      }
      if (record === null || typeof record !== 'object' || Array.isArray(record)) return
      const role = record.role === 'user' ? 'user' : record.role === 'assistant' ? 'assistant' : null
      if (role === null) return
      if (role === 'user' && result.title.length === 0) result.title = titleOf(firstText(record.message?.content))
      const blocks = contentBlocks(record.message?.content)
      if (blocks.length === 0) return
      // Cursor's transcript carries no per-message timestamp; the contract uses 0 for "not recorded".
      result.messages.push({ role, time: 0, blocks })
    })
    result.truncated = read.truncated
    if (read.error !== null) result.error = read.error
    if (read.aborted) result.error = 'aborted'
    return result
  } catch (error) {
    return emptySession(messageOf(error))
  }
}
