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
 * @module session-log-upload/foreign/workbuddy
 */

import { join } from 'node:path'

import {
  HEAD_BYTES,
  countJsonlMessages,
  emptyScan,
  emptySession,
  findChildFile,
  firstText,
  homeOf,
  isAborted,
  isSafeSessionId,
  listDirSafe,
  maxBytesOf,
  messageOf,
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
 * @returns `{id, title, cwd, createdAt, model}`; every field is `''`/`0` when unobserved.
 */
function describeHead(head) {
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
  if (generatedTitle.length > 0) described.title = generatedTitle
  return described
}

/** The model WorkBuddy recorded on one assistant record, or `''`. */
function assistantModel(record) {
  const data = record.providerData
  if (data === null || data === undefined || typeof data !== 'object') return ''
  return textOf(data.requestModelId) || textOf(data.model)
}

/**
 * Build one scan row for a transcript.
 * @param filePath transcript path.
 * @param fileName transcript file name, used for the id fallback.
 * @param info the file's `Stats`.
 * @returns a contract session summary; never throws.
 */
async function describeFile(filePath, fileName, info) {
  const cached = readScanCache(filePath, info)
  if (cached !== null) {
    return { ...cached, updatedAt: Math.trunc(info.mtimeMs) || 0, bytes: Math.trunc(info.size) || 0 }
  }
  const head = await readHead(filePath, HEAD_BYTES)
  const described = describeHead(head ?? '')
  const summary = {
    // The file name is what `readSession` resolves, so it is the session id the page can round-trip.
    id: fileName.slice(0, -'.jsonl'.length) || described.id,
    title: described.title,
    cwd: described.cwd,
    createdAt: described.createdAt,
    provider: '',
    model: described.model,
    messageCount: await countJsonlMessages(filePath, isMessageLine),
  }
  writeScanCache(filePath, info, summary)
  return { ...summary, updatedAt: Math.trunc(info.mtimeMs) || 0, bytes: Math.trunc(info.size) || 0 }
}

/**
 * List every WorkBuddy conversation, metadata only.
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
        if (entry.isFile() !== true || entry.name.endsWith('.jsonl') !== true) continue
        const filePath = join(projectPath, entry.name)
        const info = await statSafe(filePath)
        if (info === null) continue
        sessions.push(await describeFile(filePath, entry.name, info))
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
 * Read one WorkBuddy conversation.
 * @param id the raw WorkBuddy session id (without the `workbuddy/` prefix).
 * @param options `{home, signal?, maxBytes?}`.
 * @returns the contract's `readSession` result; never throws.
 */
export async function readSession(id, options) {
  try {
    if (!isSafeSessionId(id)) return emptySession('invalid-id')
    const home = homeOf(options)
    if (home.length === 0) return emptySession('not-found')
    const filePath = await findChildFile(projectsDirectory(home), `${id}.jsonl`)
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
        if (title.length > 0) result.title = title
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
