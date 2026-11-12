/**
 * Cursor adapter: one JSONL transcript per conversation,
 * `<home>/.cursor/projects/<workspace>/agent-transcripts/<id>/<id>.jsonl`.
 *
 * Cursor's format is the simplest of the five: each line is `{role, message: {content: [...]}}`
 * with `text`, `tool_use` and occasionally `thinking` blocks, in the same shape for user and
 * assistant. There is no session metadata record at all, so the title is derived from the first
 * user text and the timestamps are the file's own (creation and modification) times.
 *
 * `cwd` is deliberately left `''`: the workspace directory name is Cursor's lossy encoding of the
 * path (separators, underscores and real dashes all become `-`), so decoding it would be a guess,
 * and the contract says a value that cannot be recovered is an empty string, not an invention.
 *
 * @module session-log-upload/foreign/cursor
 */

import { join } from 'node:path'

import {
  HEAD_BYTES,
  countJsonlMessages,
  emptyScan,
  emptySession,
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

/**
 * Build one scan row for a transcript.
 * @param filePath transcript path.
 * @param id the conversation directory name, which is the id `readSession` resolves again.
 * @param info the file's `Stats`.
 * @returns a contract session summary; never throws.
 */
async function describeFile(filePath, id, info) {
  const cached = readScanCache(filePath, info)
  if (cached !== null) {
    return { ...cached, updatedAt: Math.trunc(info.mtimeMs) || 0, bytes: Math.trunc(info.size) || 0 }
  }
  const head = await readHead(filePath, HEAD_BYTES)
  const summary = {
    id,
    title: describeHead(head ?? ''),
    cwd: '',
    createdAt: Math.trunc(info.birthtimeMs) || 0,
    provider: '',
    model: '',
    messageCount: await countJsonlMessages(filePath, isMessageLine),
  }
  writeScanCache(filePath, info, summary)
  return { ...summary, updatedAt: Math.trunc(info.mtimeMs) || 0, bytes: Math.trunc(info.size) || 0 }
}

/**
 * List every Cursor conversation, metadata only.
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
      const transcripts = transcriptsDirectory(join(projectsDirectory(home), project.name))
      for (const conversation of await listDirSafe(transcripts)) {
        if (conversation.isDirectory() !== true) continue
        const directory = join(transcripts, conversation.name)
        const filePath = await transcriptFile(directory, conversation.name)
        if (filePath === null) continue
        const info = await statSafe(filePath)
        if (info === null || info.isFile() !== true) continue
        sessions.push(await describeFile(filePath, conversation.name, info))
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
 * Read one Cursor conversation.
 * @param id the raw Cursor conversation id (without the `cursor/` prefix).
 * @param options `{home, signal?, maxBytes?}`.
 * @returns the contract's `readSession` result; never throws.
 */
export async function readSession(id, options) {
  try {
    if (!isSafeSessionId(id)) return emptySession('invalid-id')
    const home = homeOf(options)
    if (home.length === 0) return emptySession('not-found')
    const filePath = await findTranscript(home, id)
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
