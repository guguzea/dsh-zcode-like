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
 * The 264 MB transcript on this machine is why nothing here reads a file whole: metadata comes from
 * a capped head read, message counting is a bytes-only pass, and `readSession` streams to a byte
 * budget and reports `truncated`. The byte count of a whole-file pass is cached per file version.
 *
 * @module session-log-upload/foreign/qoder
 */

import { join } from 'node:path'

import {
  HEAD_BYTES,
  baseNameWithoutExtension,
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
 * @param head the first {@link HEAD_BYTES} of the file.
 * @returns `{id, title, cwd, createdAt, model}`; every field is `''`/`0` when unobserved.
 */
function describeHead(head) {
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
    // The file name is what `readSession` can resolve back to this conversation, so it is the id;
    // the record's own `sessionId` is only a fallback for a strangely named file.
    id: baseNameWithoutExtension(fileName) || described.id,
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
 * List every Qoder conversation, metadata only.
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
      for (const entry of await listTranscripts(projectPath)) {
        if (isAborted(signal)) return { available: true, error: 'aborted', sessions }
        const filePath = join(projectPath, entry)
        const info = await statSafe(filePath)
        if (info === null || info.isFile() !== true) continue
        sessions.push(await describeFile(filePath, entry, info))
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

/** The `*.jsonl` file names directly inside one project directory, or `[]`. */
async function listTranscripts(projectPath) {
  const names = []
  for (const entry of await listDirSafe(projectPath)) {
    if (entry.isFile() === true && entry.name.endsWith('.jsonl')) names.push(entry.name)
  }
  return names
}

/**
 * Read one Qoder conversation.
 * @param id the raw Qoder session id (without the `qoder/` prefix).
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
    const read = await readJsonl(filePath, { maxBytes: maxBytesOf(options), signal: signalOf(options) }, (line) => {
      let record
      try {
        record = JSON.parse(line)
      } catch {
        return
      }
      if (record === null || typeof record !== 'object' || Array.isArray(record)) return
      const type = record.type
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
    return result
  } catch (error) {
    return emptySession(messageOf(error))
  }
}
