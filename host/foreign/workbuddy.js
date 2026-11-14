/**
 * WorkBuddy adapter: one JSONL transcript per session,
 * `<home>/.workbuddy/projects/<workspace>/<id>.jsonl`.
 *
 * WorkBuddy writes a flat, append-only table of typed records rather than a message list:
 *
 *   session-meta        the session id and a creation timestamp (sometimes repeated);
 *   ai-title            the conversation title WorkBuddy generated, plus the real cwd;
 *   message             a user (`input_text`) or assistant (`output_text`) turn;
 *   reasoning           a separate record holding the model's thinking (`rawContent`);
 *   function_call       a tool call, and `function_call_result` its answer (both separate records);
 *   file-history-snapshot  a checkpoint, not a message.
 *
 * A tool call therefore belongs to the assistant turn that precedes it, and a `reasoning` record
 * usually precedes the assistant `message` it belongs to. `readSession` folds those records back
 * into the contract's messages: reasoning is buffered until the assistant message arrives, then
 * becomes a `reasoning` block; each `function_call` becomes a one-line text placeholder; tool
 * results and snapshots are not conversation content.
 *
 * WorkBuddy also records delegated conversations at
 * `<project>/<sessionId>/subagents/agent-<agentId>.jsonl`, with the same record stream as a
 * top-level session (the record's own `sessionId` there names the sub-agent, not the parent). Those
 * are listed with `parentId = <sessionId>` and addressed by the raw id
 * `<sessionId>/subagents/<fileStem>`; their title is the first user text. The `subagents` directory
 * also holds `agent-<id>` working directories and non-JSONL files, which are never transcripts.
 *
 * @module session-log-upload/foreign/workbuddy
 */

import { join } from 'node:path'

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
export const harness = 'workbuddy'

/** Display name. */
export const label = 'WorkBuddy'

/** The `.workbuddy` directory: present when WorkBuddy is installed. */
function installationDirectory(home) {
  return join(home, '.workbuddy')
}

/** The `.../projects` directory. */
function projectsDirectory(home) {
  return join(installationDirectory(home), 'projects')
}

/**
 * Whether one JSONL line is a conversation message, decided from its prefix only.
 *
 * The record's `type` and `role` are both near the front of the line (`id`, `timestamp`, `type`,
 * `role`, ...); the prefix is inspected instead of parsing 100 MB of JSON per scan.
 *
 * @param prefix the first characters of a line.
 * @returns `true` for a user or assistant `message` record.
 */
function isMessageLine(prefix) {
  if (!prefix.includes('"type":"message"')) return false
  return prefix.includes('"role":"user"') || prefix.includes('"role":"assistant"')
}

/**
 * Recover the metadata a scan row needs from the transcript's leading records.
 * @param head the first {@link HEAD_BYTES} of the file.
 * @param options `{ignoreGeneratedTitle?}`: a delegated transcript is titled by its first user text,
 *   so the generated-title preference is not applied there.
 * @returns `{id, title, cwd, createdAt, model}`; every field is `''`/`0` when unobserved.
 */
function describeHead(head, { ignoreGeneratedTitle = false } = {}) {
  const described = { id: '', title: '', cwd: '', createdAt: 0, model: '' }
  // WorkBuddy's own title is a better name than the first user prompt, but it is written a few
  // records after the message it summarises, so it is remembered and wins at the end.
  let generatedTitle = ''
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
    if (record.type === 'session-meta') {
      if (described.createdAt === 0) described.createdAt = toMillis(record.timestamp)
    } else if (record.type === 'ai-title') {
      if (generatedTitle.length === 0) generatedTitle = titleOf(record.aiTitle)
      if (described.cwd.length === 0) described.cwd = textOf(record.cwd)
      if (described.createdAt === 0) described.createdAt = toMillis(record.timestamp)
    } else if (record.type === 'message') {
      if (described.cwd.length === 0) described.cwd = textOf(record.cwd)
      if (described.createdAt === 0) described.createdAt = toMillis(record.timestamp)
      if (record.role === 'user' && described.title.length === 0) {
        described.title = titleOf(firstText(record.content))
      }
      if (record.role === 'assistant' && described.model.length === 0) {
        described.model = assistantModel(record)
      }
    } else if (record.type === 'file-history-snapshot') {
      if (described.cwd.length === 0) described.cwd = textOf(record.cwd)
    }
  }
  if (!ignoreGeneratedTitle && generatedTitle.length > 0) described.title = generatedTitle
  return described
}

/** The model WorkBuddy recorded on one assistant record, or `''`. */
function assistantModel(record) {
  const data = record.providerData
  if (data === null || data === undefined || typeof data !== 'object') return ''
  return textOf(data.requestModelId) || textOf(data.model)
}

/**
 * Build one scan row for a transcript, top-level or delegated.
 * @param filePath transcript path.
 * @param fileName transcript file name, used for the id fallback.
 * @param info the file's `Stats`.
 * @param lineage `null` for a top-level transcript, `{parentId}` for a delegated one.
 * @param options the contract's options object; `options.cache` makes the summary durable.
 * @returns a contract session summary, or `null` when the file name cannot produce a safe id.
 */
async function describeFile(filePath, fileName, info, lineage, options) {
  const cached = readScanCache(harness, filePath, info, options)
  if (cached !== null) {
    return { ...cached, updatedAt: Math.trunc(info.mtimeMs) || 0, bytes: Math.trunc(info.size) || 0 }
  }
  const delegated = lineage !== null
  const head = await readHead(filePath, HEAD_BYTES)
  const described = describeHead(head ?? '', { ignoreGeneratedTitle: delegated })
  const stem = baseNameWithoutExtension(fileName)
  // The file name is what `readSession` resolves, so it is the session id the page can round-trip;
  // a delegated transcript is addressed by `<parent>/subagents/<fileStem>` instead.
  const id = delegated ? formatSubagentId(lineage.parentId, stem) : stem || described.id
  if (delegated ? !isSafeIdSegment(stem) : !isSafeSessionId(id)) return null
  const summary = {
    id,
    title: described.title,
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
 * List every WorkBuddy conversation, top-level and delegated, metadata only.
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
    for (const project of await listDirSafe(projectsDirectory(home))) {
      if (project.isDirectory() !== true) continue
      if (isAborted(signal)) return { available: true, error: 'aborted', sessions }
      const projectPath = join(projectsDirectory(home), project.name)
      for (const entry of await listDirSafe(projectPath)) {
        if (isAborted(signal)) return { available: true, error: 'aborted', sessions }
        if (entry.isFile() === true) {
          if (entry.name.endsWith('.jsonl') !== true) continue
          const filePath = join(projectPath, entry.name)
          const info = await statSafe(filePath)
          if (info === null || info.isFile() !== true) continue
          const row = await describeFile(filePath, entry.name, info, null, options)
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
          // This directory also holds `agent-<id>` working directories and tool output; only a
          // regular `.jsonl` file is a transcript.
          if (subagentFile.isFile() !== true || subagentFile.name.endsWith('.jsonl') !== true) continue
          const subagentPath = join(subagentsDirectory, subagentFile.name)
          const info = await statSafe(subagentPath)
          if (info === null || info.isFile() !== true) continue
          const row = await describeFile(subagentPath, subagentFile.name, info, { parentId }, options)
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

/**
 * Translate a WorkBuddy `message.content` value into the contract's blocks.
 * @param content the record's content array.
 * @param role the record's role.
 * @returns the blocks; `[]` when the record carries no text.
 */
function contentBlocks(content, role) {
  const blocks = []
  if (!Array.isArray(content)) return blocks
  for (const block of content) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    if (block.type !== 'input_text' && block.type !== 'output_text' && block.type !== 'text') continue
    if (role === 'user' && block.type === 'output_text') continue
    if (role === 'assistant' && block.type === 'input_text') continue
    const text = textOf(block.text)
    if (text.length > 0) blocks.push({ type: 'text', text })
  }
  return blocks
}

/**
 * Translate a WorkBuddy `reasoning` record's content into one or more reasoning blocks.
 * @param value `rawContent` (preferred) or `content`.
 * @returns the blocks; `[]` when the record carries no thinking.
 */
function reasoningBlocks(value) {
  if (typeof value === 'string') return value.length > 0 ? [{ type: 'reasoning', text: value }] : []
  const blocks = []
  if (!Array.isArray(value)) return blocks
  for (const block of value) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    if (block.type !== 'reasoning_text' && block.type !== 'thinking' && block.type !== 'text') continue
    const text = textOf(block.text)
    if (text.length > 0) blocks.push({ type: 'reasoning', text })
  }
  return blocks
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
  for (const project of await listDirSafe(projectsDirectory(home))) {
    if (project.isDirectory() !== true) continue
    const candidate = join(projectsDirectory(home), project.name, parentId, SUBAGENTS_DIRECTORY, `${subagentId}.jsonl`)
    if (await isFile(candidate)) return candidate
  }
  return null
}

/**
 * Read one WorkBuddy conversation, top-level or delegated.
 * @param id the raw WorkBuddy id (without the `workbuddy/` prefix): a session id, or
 *   `<sessionId>/subagents/<fileStem>`.
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
      delegated === null
        ? await findChildFile(projectsDirectory(home), `${id}.jsonl`)
        : await findSubagentFile(home, delegated.parentId, delegated.subagentId)
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
    /** The message record currently being assembled; a reasoning record attaches to it. */
    let current = null
    /** Reasoning seen before its assistant message: buffered, then prepended to that message. */
    let pending = []
    const flush = () => {
      if (current === null) return
      if (current.blocks.length > 0) result.messages.push(current)
      current = null
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
      if (type === 'session-meta') {
        if (result.createdAt === 0) result.createdAt = toMillis(record.timestamp)
        return
      }
      if (type === 'ai-title') {
        const title = titleOf(record.aiTitle)
        // A delegated conversation is titled by its first user text, matching its scan row, so a
        // generated title must not replace it; an ordinary session keeps the better generated title.
        if (!delegated && title.length > 0) result.title = title
        if (result.cwd.length === 0) result.cwd = textOf(record.cwd)
        if (result.createdAt === 0) result.createdAt = toMillis(record.timestamp)
        return
      }
      if (type === 'file-history-snapshot') {
        if (result.cwd.length === 0) result.cwd = textOf(record.cwd)
        return
      }
      if (type === 'reasoning') {
        if (result.cwd.length === 0) result.cwd = textOf(record.cwd)
        if (result.createdAt === 0) result.createdAt = toMillis(record.timestamp)
        const blocks = reasoningBlocks(record.rawContent ?? record.content)
        if (blocks.length === 0) return
        if (current !== null && current.role === 'assistant') current.blocks.push(...blocks)
        else pending.push(...blocks)
        return
      }
      if (type === 'function_call') {
        // Tool calls follow the assistant text they belong to; the result record is not content.
        if (current !== null && current.role === 'assistant') {
          current.blocks.push({ type: 'text', text: toolPlaceholder(record.name) })
        }
        return
      }
      if (type !== 'message') return
      const role = record.role === 'user' ? 'user' : record.role === 'assistant' ? 'assistant' : null
      if (role === null) return
      const time = toMillis(record.timestamp)
      if (result.createdAt === 0) result.createdAt = time
      if (result.cwd.length === 0) result.cwd = textOf(record.cwd)
      if (role === 'user' && result.title.length === 0) result.title = titleOf(firstText(record.content))
      if (role === 'assistant') {
        const model = assistantModel(record)
        if (model.length > 0) result.model = model
      }
      const blocks = contentBlocks(record.content, role)
      flush()
      const pendingForAssistant = role === 'assistant' ? pending : []
      // Reasoning that never reached an assistant message belongs to a truncated/broken turn; a new
      // user message starts a new turn, so a stale buffer must not leak into it.
      pending = []
      current = { role, time, blocks: [...pendingForAssistant, ...blocks] }
    })
    flush()
    result.truncated = read.truncated
    if (read.error !== null) result.error = read.error
    if (read.aborted) result.error = 'aborted'
    return result
  } catch (error) {
    return emptySession(messageOf(error))
  }
}
