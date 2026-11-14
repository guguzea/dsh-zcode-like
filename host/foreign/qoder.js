/**
 * Qoder adapter: one JSONL transcript per session, `<home>/.qoder-cn/projects/<project>/<id>.jsonl`.
 *
 * The project directory name is Qoder's lossy encoding of the working directory, so the real cwd
 * is taken from the transcript's own `workspace-directories` record, and the session id from the
 * `sessionId` field of its metadata records rather than from the file name.
 *
 * A transcript is a mixed stream of typed records: `workspace-directories`, `runtime-config`,
 * `worktree-state`, `attachment`, `active-leaf` and `file-history-snapshot` are metadata, while
 * `user` and `assistant` carry a Claude-style `message.content` array (`text`, `thinking`,
 * `tool_use`, `tool_result`) or, for some prompts, a bare string. Only human-visible turns are
 * imported: a user record that is only a `tool_result` is a tool answer, not something the user
 * wrote, so it becomes no message at all. Tool calls keep their place as a one-line placeholder.
 *
 * A conversation can also be delegated: Qoder records the sub-agent's turns as
 * `<project>/<sessionId>/subagents/agent-<agentId>.jsonl`, next to a small
 * `agent-<agentId>.meta.json` holding `{agentType, description, invocationName, color}`. Those are
 * listed as their own rows with `parentId = <sessionId>` and addressed by the raw id
 * `<sessionId>/subagents/<fileStem>`; the meta description is the best title Qoder stores, so it
 * wins over `agentType`, which wins over the first user text.
 *
 * The 264 MB transcript on this machine is why nothing here reads a file whole: metadata comes from
 * a capped head read, message counting is a bytes-only pass, and `readSession` streams to a byte
 * budget and reports `truncated`. The byte count of a whole-file pass is cached per file version.
 *
 * @module session-log-upload/foreign/qoder
 */

import { dirname, join } from 'node:path'

import {
  HEAD_BYTES,
  SUBAGENTS_DIRECTORY,
  baseNameWithoutExtension,
  countJsonlMessages,
  emptyScan,
  emptySession,
  findChildFile,
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
  toMillis,
  toolPlaceholder,
  writeScanCache,
} from './shared.js'

/** Stable harness id; part of every composite id and of the forged session id. */
export const harness = 'qoder'

/** Display name. */
export const label = 'Qoder'

/** The `.qoder-cn` directory: present when Qoder is installed. */
function installationDirectory(home) {
  return join(home, '.qoder-cn')
}

/** The `.../projects` directory. */
function projectsDirectory(home) {
  return join(installationDirectory(home), 'projects')
}

/**
 * Whether one JSONL line is a conversation message, decided from its prefix only.
 *
 * Counting is a whole-file pass over 3 GB, so it must not JSON-parse: every record starts with its
 * top-level `"type"`, and a user record whose content is a `tool_result` is not an imported turn
 * (it is the tool answering, not the human), so it is excluded the same way `readSession` excludes
 * it.
 *
 * @param prefix the first characters of a line.
 * @returns `true` for an imported user or assistant message.
 */
function isMessageLine(prefix) {
  if (prefix.startsWith('{"type":"assistant"')) return true
  if (!prefix.startsWith('{"type":"user"')) return false
  return prefix.includes('"type":"tool_result"') === false
}

/**
 * Translate one `message.content` value into the contract's blocks.
 *
 * @param content a string, or an array of typed blocks.
 * @param role the record's role, which decides whether a `tool_result` is dropped.
 * @returns the blocks; `[]` when the record carries no imported content.
 */
function contentBlocks(content, role) {
  const blocks = []
  const push = (block) => {
    if (block !== null) blocks.push(block)
  }
  if (typeof content === 'string') {
    if (content.length > 0) push({ type: 'text', text: content })
    return blocks
  }
  if (!Array.isArray(content)) return blocks
  for (const block of content) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    if (block.type === 'text') {
      const text = textOf(block.text)
      if (text.length > 0) push({ type: 'text', text })
    } else if (block.type === 'thinking' || block.type === 'reasoning') {
      const text = textOf(block.thinking ?? block.text)
      if (text.length > 0) push({ type: 'reasoning', text })
    } else if (block.type === 'tool_use' && role === 'assistant') {
      push({ type: 'text', text: toolPlaceholder(block.name) })
    }
    // `tool_result` is deliberately not represented: it is a tool answer, not a human turn.
  }
  return blocks
}

/**
 * Recover the metadata a scan row needs from the transcript's leading records.
 *
 * @param head the first {@link HEAD_BYTES} of the file.
 * @param options `{preferRecordCwd?}`: a delegated transcript carries `cwd` on every turn instead of
 *   a `workspace-directories` record, so its reader takes the first `cwd` it sees on any record.
 * @returns `{id, title, cwd, createdAt, model}`; every field is `''`/`0` when unobserved.
 */
function describeHead(head, { preferRecordCwd = false } = {}) {
  const described = { id: '', title: '', cwd: '', createdAt: 0, model: '' }
  for (const line of head.split('\n')) {
    if (line.length === 0) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
    if (described.id.length === 0) described.id = textOf(record.sessionId)
    if (preferRecordCwd && described.cwd.length === 0) described.cwd = textOf(record.cwd)
    if (record.type === 'workspace-directories') {
      if (described.cwd.length === 0 && Array.isArray(record.directories)) {
        for (const directory of record.directories) {
          if (typeof directory === 'string' && directory.length > 0) {
            described.cwd = directory
            break
          }
        }
      }
    } else if (record.type === 'runtime-config') {
      if (described.createdAt === 0) described.createdAt = toMillis(record.timestamp)
      if (described.model.length === 0) described.model = textOf(record.model)
    } else if (record.type === 'file-history-snapshot') {
      if (described.cwd.length === 0) described.cwd = textOf(record.cwd)
      if (described.createdAt === 0) described.createdAt = toMillis(record.timestamp)
    } else if (record.type === 'user') {
      if (described.createdAt === 0) described.createdAt = toMillis(record.timestamp)
      if (described.title.length === 0) described.title = titleOf(firstText(record.message?.content))
    } else if (record.type === 'assistant') {
      if (described.createdAt === 0) described.createdAt = toMillis(record.timestamp)
      if (described.model.length === 0) described.model = textOf(record.message?.model)
    }
  }
  return described
}

/** How much of an `agent-*.meta.json` is read; the real files are a few hundred bytes. */
const META_BYTES = 64 * 1024

/**
 * Read one delegated transcript's `.meta.json`, which Qoder writes beside the JSONL.
 *
 * The file is tiny and is never a transcript; it is read capped and parsed as one object. A missing,
 * truncated or malformed meta file is simply no metadata, never an error for the whole scan.
 *
 * @param metaPath the sibling `.meta.json` path.
 * @returns the parsed object, or `{}`.
 */
async function readAgentMeta(metaPath) {
  const head = await readHead(metaPath, META_BYTES)
  if (head === null) return {}
  try {
    const parsed = JSON.parse(head)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

/**
 * Build one scan row for a transcript, top-level or delegated.
 *
 * @param filePath transcript path.
 * @param fileName transcript file name, used for the id fallback.
 * @param info the file's `Stats`.
 * @param lineage `null` for a top-level transcript, `{parentId}` for a delegated one.
 * @param options the contract's options object; `options.cache` makes the summary durable.
 * @returns a contract session summary, or `null` when the file name cannot produce a safe id.
 */
async function describeTranscript(filePath, fileName, info, lineage, options) {
  const cached = readScanCache(harness, filePath, info, options)
  if (cached !== null) {
    return { ...cached, updatedAt: Math.trunc(info.mtimeMs) || 0, bytes: Math.trunc(info.size) || 0 }
  }
  const delegated = lineage !== null
  const head = await readHead(filePath, HEAD_BYTES)
  const described = describeHead(head ?? '', { preferRecordCwd: delegated })
  const stem = baseNameWithoutExtension(fileName)
  let title = described.title
  if (delegated) {
    // Qoder's own agent label beats anything derived from the turns: description first, then type.
    const meta = await readAgentMeta(join(dirname(filePath), `${stem}.meta.json`))
    title = titleOf(meta.description) || titleOf(meta.agentType) || title
  }
  // `readSession` resolves a row back through its id, so an id that is not a safe raw id is not a row.
  const id = delegated ? formatSubagentId(lineage.parentId, stem) : stem || described.id
  if (delegated ? !isSafeIdSegment(stem) : !isSafeSessionId(id)) return null
  const summary = {
    id,
    title,
    cwd: described.cwd,
    createdAt: described.createdAt,
    provider: '',
    model: described.model,
    messageCount: await countJsonlMessages(filePath, isMessageLine),
  }
  if (delegated) summary.parentId = lineage.parentId
  writeScanCache(harness, filePath, info, summary, options)
  return { ...summary, updatedAt: Math.trunc(info.mtimeMs) || 0, bytes: Math.trunc(info.size) || 0 }
}

/**
 * List every Qoder conversation, top-level and delegated, metadata only.
 * @param options `{home, signal?}`.
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
    const sessions = []
    for (const project of await listProjects(home)) {
      if (isAborted(signal)) return { available: true, error: 'aborted', sessions }
      const projectPath = join(projectsDirectory(home), project)
      for (const entry of await listDirSafe(projectPath)) {
        if (isAborted(signal)) return { available: true, error: 'aborted', sessions }
        if (entry.isFile() === true) {
          if (entry.name.endsWith('.jsonl') !== true) continue
          const filePath = join(projectPath, entry.name)
          const info = await statSafe(filePath)
          if (info === null || info.isFile() !== true) continue
          const row = await describeTranscript(filePath, entry.name, info, null, options)
          if (row !== null) sessions.push(row)
          continue
        }
        if (entry.isDirectory() !== true) continue
        // `<sessionId>/subagents/agent-<agentId>.jsonl`: the directory name is the parent session.
        const parentId = entry.name
        if (!isSafeIdSegment(parentId)) continue
        const subagentsDirectory = join(projectPath, parentId, SUBAGENTS_DIRECTORY)
        for (const subagentFile of await listDirSafe(subagentsDirectory)) {
          if (isAborted(signal)) return { available: true, error: 'aborted', sessions }
          if (subagentFile.isFile() !== true || subagentFile.name.endsWith('.jsonl') !== true) continue
          const subagentPath = join(subagentsDirectory, subagentFile.name)
          const info = await statSafe(subagentPath)
          if (info === null || info.isFile() !== true) continue
          const row = await describeTranscript(subagentPath, subagentFile.name, info, { parentId }, options)
          if (row !== null) sessions.push(row)
        }
      }
    }
    sessions.sort((left, right) => right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    return { available: true, error: null, sessions }
  } catch (error) {
    return emptyScan(true, messageOf(error))
  }
}

/** The project directory names, or `[]`. */
async function listProjects(home) {
  const names = []
  for (const entry of await listDirSafe(projectsDirectory(home))) {
    if (entry.isDirectory() === true) names.push(entry.name)
  }
  return names
}

/**
 * Locate one delegated transcript: `<project>/<parentId>/subagents/<subagentId>.jsonl`, across the
 * project directories (the project name is a lossy encoding of the cwd, so it is not known here).
 * @param home the home directory.
 * @param parentId the validated parent session id.
 * @param subagentId the validated sub-agent id.
 * @returns the file path, or `null`.
 */
async function findSubagentFile(home, parentId, subagentId) {
  for (const project of await listProjects(home)) {
    const candidate = join(projectsDirectory(home), project, parentId, SUBAGENTS_DIRECTORY, `${subagentId}.jsonl`)
    if (await isFile(candidate)) return candidate
  }
  return null
}

/**
 * The raw id's shape: one top-level session id, or a delegated `<parentId>/subagents/<delegate>`.
 * @param id caller-supplied raw id.
 * @returns `{kind:'top', id}` / `{kind:'delegated', parentId, subagentId}` / `null`.
 */
function resolveRawId(id) {
  const delegated = parseSubagentId(id)
  if (delegated !== null) return { kind: 'delegated', parentId: delegated.parentId, subagentId: delegated.subagentId }
  if (isSafeSessionId(id)) return { kind: 'top', id }
  return null
}

/**
 * Read one Qoder conversation, top-level or delegated.
 * @param id the raw Qoder id (without the `qoder/` prefix): a session id, or
 *   `<sessionId>/subagents/<fileStem>`.
 * @param options `{home, signal?, maxBytes?}`.
 * @returns the contract's `readSession` result; never throws.
 */
export async function readSession(id, options) {
  try {
    const target = resolveRawId(id)
    if (target === null) return emptySession('invalid-id')
    const home = homeOf(options)
    if (home.length === 0) return emptySession('not-found')
    const filePath =
      target.kind === 'delegated'
        ? await findSubagentFile(home, target.parentId, target.subagentId)
        : await findChildFile(projectsDirectory(home), `${target.id}.jsonl`)
    if (filePath === null) return emptySession('not-found')
    const info = await statSafe(filePath)
    const result = {
      id,
      error: null,
      title: '',
      cwd: '',
      createdAt: info !== null ? Math.trunc(info.birthtimeMs) || 0 : 0,
      provider: '',
      model: '',
      truncated: false,
      messages: [],
    }
    const read = await readJsonl(filePath, { maxBytes: maxBytesOf(options), signal: signalOf(options) }, (line) => {
      let record
      try {
        record = JSON.parse(line)
      } catch {
        return
      }
      if (record === null || typeof record !== 'object' || Array.isArray(record)) return
      const type = record.type
      if (target.kind === 'delegated' && result.cwd.length === 0) result.cwd = textOf(record.cwd)
      if (type === 'workspace-directories') {
        if (result.cwd.length === 0 && Array.isArray(record.directories)) {
          for (const directory of record.directories) {
            if (typeof directory === 'string' && directory.length > 0) {
              result.cwd = directory
              break
            }
          }
        }
        return
      }
      if (type === 'runtime-config') {
        if (result.createdAt === 0) result.createdAt = toMillis(record.timestamp)
        if (result.model.length === 0) result.model = textOf(record.model)
        return
      }
      if (type === 'file-history-snapshot') {
        if (result.cwd.length === 0) result.cwd = textOf(record.cwd)
        return
      }
      const role = type === 'user' ? 'user' : type === 'assistant' ? 'assistant' : null
      if (role === null) return
      const time = toMillis(record.timestamp)
      if (result.createdAt === 0) result.createdAt = time
      if (role === 'assistant' && result.model.length === 0) result.model = textOf(record.message?.model)
      if (role === 'user' && result.title.length === 0) result.title = titleOf(firstText(record.message?.content))
      const blocks = contentBlocks(record.message?.content, role)
      if (blocks.length === 0) return
      result.messages.push({ role, time, blocks })
    })
    result.truncated = read.truncated
    if (read.error !== null) result.error = read.error
    if (read.aborted) result.error = 'aborted'
    if (target.kind === 'delegated') {
      // Match the scan row's title priority: meta description, then agent type, then the first turn.
      const meta = await readAgentMeta(join(dirname(filePath), `${target.subagentId}.meta.json`))
      const metaTitle = titleOf(meta.description) || titleOf(meta.agentType)
      if (metaTitle.length > 0) result.title = metaTitle
    }
    return result
  } catch (error) {
    return emptySession(messageOf(error))
  }
}
