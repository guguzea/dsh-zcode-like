#!/usr/bin/env node
/**
 * Foreign-harness adapter checks: run `node verify/foreign-adapters.mjs` from the bundle root.
 *
 * Plain `node`, no test runner, no network. Every fixture is created under
 * `verify/.tmp-foreign-adapters/` by this script and removed again, so the suite never reads the
 * live ZCode/Qoder/Cursor/WorkBuddy/Cline stores and never depends on what happens to be in them.
 *
 * Coverage:
 *   1. missing installation / empty store / malformed rows for all five harnesses
 *   2. ZCode: SQLite read-only open, session listing, synthetic records excluded, part mapping,
 *      the message/byte cap, the not-found path, and that the database is untouched
 *   3. Qoder: metadata recovery, sidechain-style tool results, string vs typed content, truncation
 *   4. Cursor: title from the first user text, the lossy-cwd decision (`''`), tool placeholders
 *   5. WorkBuddy: metadata records, ai-title preference, reasoning folding, tool placeholder
 *   6. Cline: `available: true` with `unsupported-schema` instead of a guessed mapping
 *   7. the registry: adapter order, composite-id parsing, scanAll/get-by-composite-id, caching
 *   8. total behaviour: hostile options, missing ids, aborted signals, contract key sets
 *
 * The only writes are inside `verify/.tmp-foreign-adapters/`; the suite removes that directory in
 * a `finally` and exits non-zero when any check failed.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as cline from '../host/foreign/cline.js'
import * as cursor from '../host/foreign/cursor.js'
import { ADAPTERS, adapterFor, readForeignSession, scanAll } from '../host/foreign/index.js'
import * as qoder from '../host/foreign/qoder.js'
import * as workbuddy from '../host/foreign/workbuddy.js'
import * as zcode from '../host/foreign/zcode.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const tmp = join(here, '.tmp-foreign-adapters')
const home = join(tmp, 'home')
const bare = join(tmp, 'bare')
const empty = join(tmp, 'empty')

const ZCODE_ROOT = 'sess_zcode_root'
const ZCODE_CHILD = 'sess_zcode_child'
const QODER_ID = 'qoder-session-1'
const QODER_BIG = 'qoder-session-big'
const QODER_USER_TIME = Date.parse('2024-03-09T16:00:00.000Z')
const QODER_ASSISTANT_TIME = Date.parse('2024-03-09T16:00:05.000Z')
const CURSOR_ID = 'cursor-session-1'
const WORKBUDDY_ID = 'workbuddy-session-1'

const SESSION_KEYS = ['bytes', 'createdAt', 'cwd', 'id', 'messageCount', 'model', 'provider', 'title', 'updatedAt']
const RAW_KEYS = ['createdAt', 'cwd', 'error', 'id', 'messages', 'model', 'provider', 'title', 'truncated']

let checks = 0
let failures = 0

async function check(label, run) {
  checks += 1
  try {
    await run()
    console.log(`  ok    ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL  ${label}`)
    const text = error !== null && error !== undefined && typeof error.message === 'string' ? error.message : String(error)
    for (const line of text.split('\n')) console.log(`        ${line}`)
  }
}

/** `node:sqlite` is imported lazily by the adapters; the two SQLite fixtures need it too. */
async function loadSqlite() {
  try {
    return await import('node:sqlite')
  } catch {
    return null
  }
}

const SQLITE = await loadSqlite()

/** Write one file, creating parent directories. */
function writeFixture(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
}

/** Serialize JSONL records; a string is written verbatim so a malformed row can be planted. */
function jsonl(records) {
  return `${records.map((record) => (typeof record === 'string' ? record : JSON.stringify(record))).join('\n')}\n`
}

/** The contract's session-summary key set, asserted for every scan row. */
function assertSessionShape(session) {
  assert.deepEqual(Object.keys(session).sort(), SESSION_KEYS)
  assert.equal(typeof session.id, 'string')
  assert.equal(typeof session.title, 'string')
  assert.equal(typeof session.cwd, 'string')
  assert.equal(typeof session.provider, 'string')
  assert.equal(typeof session.model, 'string')
  for (const field of ['createdAt', 'updatedAt', 'messageCount', 'bytes']) {
    assert.equal(Number.isSafeInteger(session[field]), true, `${field} must be a safe integer`)
    assert.ok(session[field] >= 0, `${field} must not be negative`)
  }
}

/** The contract's readSession key set plus the optional original id (which fixes the forged id). */
function assertRawShape(raw) {
  assert.deepEqual(Object.keys(raw).sort(), RAW_KEYS)
  assert.equal(typeof raw.error === 'string' || raw.error === null, true)
  assert.equal(typeof raw.title, 'string')
  assert.equal(typeof raw.cwd, 'string')
  assert.equal(typeof raw.provider, 'string')
  assert.equal(typeof raw.model, 'string')
  assert.equal(typeof raw.truncated, 'boolean')
  assert.equal(Array.isArray(raw.messages), true)
  for (const message of raw.messages) {
    assert.deepEqual(Object.keys(message).sort(), ['blocks', 'role', 'time'])
    assert.equal(message.role === 'user' || message.role === 'assistant', true)
    assert.equal(Number.isSafeInteger(message.time), true)
    for (const block of message.blocks) {
      assert.deepEqual(Object.keys(block).sort(), ['text', 'type'])
      assert.equal(block.type === 'text' || block.type === 'reasoning', true)
      assert.equal(typeof block.text, 'string')
    }
  }
}

/** The contract's scan key set. */
function assertScanShape(result) {
  assert.deepEqual(Object.keys(result).sort(), ['available', 'error', 'sessions'])
  assert.equal(typeof result.available, 'boolean')
  assert.equal(typeof result.error === 'string' || result.error === null, true)
  assert.equal(Array.isArray(result.sessions), true)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// fixtures
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// A freshly closed SQLite file can be held for a few milliseconds by Windows (indexer, antivirus),
// so the temporary tree is removed with retries rather than failing the suite on a transient lock.
const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }

rmSync(tmp, REMOVE_OPTIONS)

/** The ZCode database: the three tables the adapter reads, with one synthetic-record trap per kind. */
async function buildZcodeStore() {
  const databaseDirectory = join(home, '.zcode', 'cli', 'db')
  mkdirSync(databaseDirectory, { recursive: true })
  if (SQLITE === null) return
  const db = new SQLITE.DatabaseSync(join(databaseDirectory, 'db.sqlite'))
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL,
        sequence INTEGER
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL,
        sequence INTEGER
      );
    `)
    const insertSession = db.prepare(
      'INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    insertSession.run(ZCODE_ROOT, 'proj', null, ZCODE_ROOT, 'F:\\work', 'Build the widget', '0.16.9', 1700000000000, 1700000005000)
    insertSession.run(ZCODE_CHILD, 'proj', ZCODE_ROOT, ZCODE_CHILD, 'F:\\work', 'Child agent', '0.16.9', 1700000006000, 1700000009000)

    const insertMessage = db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)',
    )
    const insertPart = db.prepare(
      'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)',
    )
    const message = (id, sessionId, time, data, sequence) =>
      insertMessage.run(id, sessionId, time, time, JSON.stringify(data), sequence)
    const part = (id, messageId, sessionId, data, sequence) =>
      insertPart.run(id, messageId, sessionId, 1700000000000, 1700000000000, JSON.stringify(data), sequence)

    message('msg_root_user', ZCODE_ROOT, 1700000001000, { role: 'user', semantics: { origin: 'real_user', kind: 'user_prompt' } }, 0)
    message(
      'msg_root_assistant',
      ZCODE_ROOT,
      1700000002000,
      {
        role: 'assistant',
        providerId: 'fixture-provider',
        modelId: 'fixture-model',
        semantics: { origin: 'agent_runtime', kind: 'assistant_response' },
      },
      1,
    )
    // Synthetic turns: these are exactly what must not reach the upload as if the user wrote them.
    message('msg_root_todo', ZCODE_ROOT, 1700000002500, { role: 'user', semantics: { origin: 'agent_runtime', kind: 'todo_reminder' } }, 2)
    message('msg_root_timeline', ZCODE_ROOT, 1700000002600, { role: 'assistant', semantics: { origin: 'system', kind: 'timeline_event' } }, 3)
    message(
      'msg_root_assistant2',
      ZCODE_ROOT,
      1700000004000,
      {
        role: 'assistant',
        providerId: 'fixture-provider',
        modelId: 'fixture-model',
        semantics: { origin: 'agent_runtime', kind: 'assistant_response' },
      },
      4,
    )
    message('msg_root_broken', ZCODE_ROOT, 1700000004500, '{not json', 5)

    message('msg_child_user', ZCODE_CHILD, 1700000007000, { role: 'user', semantics: { origin: 'real_user', kind: 'user_prompt' } }, 0)
    message(
      'msg_child_assistant',
      ZCODE_CHILD,
      1700000008000,
      { role: 'assistant', providerId: 'fixture-provider', modelId: 'fixture-model', semantics: { origin: 'agent_runtime', kind: 'assistant_response' } },
      1,
    )

    part('part_root_user_text', 'msg_root_user', ZCODE_ROOT, { type: 'text', text: 'How do I build the widget?' }, 0)
    part('part_root_step_start', 'msg_root_assistant', ZCODE_ROOT, { type: 'step-start' }, 0)
    part('part_root_reasoning', 'msg_root_assistant', ZCODE_ROOT, { type: 'reasoning', text: 'Think about it' }, 1)
    part('part_root_text', 'msg_root_assistant', ZCODE_ROOT, { type: 'text', text: 'Here is the plan' }, 2)
    part('part_root_tool', 'msg_root_assistant', ZCODE_ROOT, { type: 'tool', tool: 'Bash', state: { status: 'completed' } }, 3)
    part('part_root_step_finish', 'msg_root_assistant', ZCODE_ROOT, { type: 'step-finish', reason: 'tool-calls' }, 4)
    part('part_root_timeline', 'msg_root_assistant', ZCODE_ROOT, { type: 'timeline' }, 5)
    part('part_root_broken', 'msg_root_assistant', ZCODE_ROOT, '{broken part', 6)
    part('part_root_assistant2_text', 'msg_root_assistant2', ZCODE_ROOT, { type: 'text', text: 'Second answer' }, 0)
    part('part_root_todo_text', 'msg_root_todo', ZCODE_ROOT, { type: 'text', text: 'todo reminder text' }, 0)
    part('part_child_user_text', 'msg_child_user', ZCODE_CHILD, { type: 'text', text: 'child ask' }, 0)
    part('part_child_assistant_text', 'msg_child_assistant', ZCODE_CHILD, { type: 'text', text: 'child answer' }, 0)
  } finally {
    db.close()
  }
}

/** The Qoder project tree: one ordinary transcript and one big enough to hit a small byte budget. */
function buildQoderStore() {
  const project = join(home, '.qoder-cn', 'projects', 'H--qoder-work')
  const userPrompt = {
    type: 'user',
    uuid: 'q-user-1',
    timestamp: '2024-03-09T16:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>noise</system-reminder>Build a Qoder thing' }] },
  }
  writeFixture(
    join(project, `${QODER_ID}.jsonl`),
    jsonl([
      { type: 'workspace-directories', sessionId: QODER_ID, directories: ['H:\\qoder-work'] },
      { type: 'runtime-config', sessionId: QODER_ID, model: 'qfmodel', timestamp: 1710000000000 },
      { type: 'worktree-state', sessionId: QODER_ID, worktreeSession: null },
      userPrompt,
      {
        type: 'assistant',
        uuid: 'q-assistant-1',
        timestamp: '2024-03-09T16:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'qfmodel',
          content: [{ type: 'thinking', thinking: 'plan it' }, { type: 'text', text: 'done' }, { type: 'tool_use', name: 'Bash', input: {} }],
        },
      },
      // A tool answer is a user-role record, but it is not something the human wrote.
      { type: 'user', uuid: 'q-user-2', timestamp: '2024-03-09T16:00:06.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'output' }] } },
      { type: 'attachment', attachment: { type: 'skill_listing', content: '- a skill' } },
      '{not json',
    ]),
  )
  const bigLines = [
    { type: 'workspace-directories', sessionId: QODER_BIG, directories: ['H:\\qoder-work'] },
    { type: 'runtime-config', sessionId: QODER_BIG, model: 'qfmodel', timestamp: 1710000000000 },
  ]
  for (let index = 0; index < 200; index += 1) {
    bigLines.push({
      type: 'user',
      uuid: `q-big-${index}`,
      timestamp: '2024-03-09T16:10:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: `big question number ${index} `.repeat(6) }] },
    })
  }
  writeFixture(join(project, `${QODER_BIG}.jsonl`), jsonl(bigLines))
}

/** The Cursor workspace tree. */
function buildCursorStore() {
  const directory = join(home, '.cursor', 'projects', 'h-work', 'agent-transcripts', CURSOR_ID)
  writeFixture(
    join(directory, `${CURSOR_ID}.jsonl`),
    jsonl([
      {
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<git_diff_from_branch_to_main>a whole diff</git_diff_from_branch_to_main><user_query>Add a Cursor button</user_query>',
            },
          ],
        },
      },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Read', input: { path: 'x' } }] } },
      '{not json',
    ]),
  )
}

/** The WorkBuddy project tree. */
function buildWorkbuddyStore() {
  writeFixture(
    join(home, '.workbuddy', 'projects', 'wb-project', `${WORKBUDDY_ID}.jsonl`),
    jsonl([
      { type: 'session-meta', id: 'meta-1', sessionId: WORKBUDDY_ID, timestamp: 1720000000000, meta: {} },
      {
        id: 'wb-user-1',
        timestamp: 1720000000100,
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Fix the WorkBuddy bug' }],
        sessionId: WORKBUDDY_ID,
        cwd: 'G:\\wb',
      },
      {
        id: 'wb-reasoning-1',
        timestamp: 1720000000200,
        type: 'reasoning',
        providerData: {},
        content: [],
        rawContent: [{ type: 'reasoning_text', text: 'need a plan' }],
        sessionId: WORKBUDDY_ID,
        cwd: 'G:\\wb',
      },
      {
        id: 'wb-assistant-1',
        timestamp: 1720000000300,
        type: 'message',
        role: 'assistant',
        providerData: { requestModelId: 'wb-model', model: 'wb-model' },
        content: [{ type: 'output_text', text: 'fixed' }],
        sessionId: WORKBUDDY_ID,
        cwd: 'G:\\wb',
      },
      { id: 'wb-call-1', timestamp: 1720000000400, type: 'function_call', name: 'Bash', callId: 'call_1', arguments: '{}' },
      { id: 'wb-result-1', timestamp: 1720000000500, type: 'function_call_result', name: 'Bash', callId: 'call_1', output: 'ok' },
      { id: 'wb-title-1', timestamp: 1720000000600, type: 'ai-title', aiTitle: 'Fix the WorkBuddy bug title', sessionId: WORKBUDDY_ID, cwd: 'G:\\wb' },
      '{not json',
    ]),
  )
}

/** The Cline database: the observed schema, which has session metadata and no message rows. */
function buildClineStore() {
  const databaseDirectory = join(home, '.cline', 'data', 'db')
  mkdirSync(databaseDirectory, { recursive: true })
  if (SQLITE === null) return
  const db = new SQLITE.DatabaseSync(join(databaseDirectory, 'sessions.db'))
  try {
    db.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        cwd TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        messages_path TEXT
      );
    `)
  } finally {
    db.close()
  }
}

/** The bare home: every harness directory exists but holds no store. */
function buildBareHome() {
  for (const directory of ['.zcode', '.qoder-cn', '.cursor', '.workbuddy', '.cline']) {
    mkdirSync(join(bare, directory), { recursive: true })
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// the fixtures are built once, then every check reads them
// ─────────────────────────────────────────────────────────────────────────────────────────────────

mkdirSync(empty, { recursive: true })
mkdirSync(home, { recursive: true })
await buildZcodeStore()
buildQoderStore()
buildCursorStore()
buildWorkbuddyStore()
buildClineStore()
buildBareHome()

const ZCODE_DB = join(home, '.zcode', 'cli', 'db', 'db.sqlite')
const CLINE_DB = join(home, '.cline', 'data', 'db', 'sessions.db')
const zcodeModifiedAt = existsSync(ZCODE_DB) ? statSync(ZCODE_DB).mtimeMs : 0
const clineModifiedAt = existsSync(CLINE_DB) ? statSync(CLINE_DB).mtimeMs : 0

try {
  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // 1. missing installation, bare installations, missing ids: the contract shapes
  // ───────────────────────────────────────────────────────────────────────────────────────────────

  await check('a missing home leaves every harness unavailable, with no error and no sessions', async () => {
    for (const adapter of ADAPTERS) {
      const result = await adapter.scan({ home: empty })
      assertScanShape(result)
      assert.equal(result.available, false, `${adapter.harness}: an absent installation is not available`)
      assert.equal(result.error, null)
      assert.deepEqual(result.sessions, [])
    }
  })

  await check('an installed but empty harness is available, empty and error-free', async () => {
    for (const adapter of ADAPTERS) {
      const result = await adapter.scan({ home: bare })
      assertScanShape(result)
      assert.equal(result.available, true, `${adapter.harness}: the directory means installed`)
      assert.equal(result.error, null, `${adapter.harness}: an empty store is not an error`)
      assert.deepEqual(result.sessions, [], adapter.harness)
    }
  })

  await check('an unknown id returns a shaped error, never a throw, for every adapter', async () => {
    for (const adapter of ADAPTERS) {
      for (const id of ['does-not-exist', '..', '../escape']) {
        const raw = await adapter.readSession(id, { home })
        assertRawShape(raw)
        assert.equal(typeof raw.error, 'string', `${adapter.harness}/${id} must report an error`)
        assert.ok(raw.error.length > 0)
        assert.deepEqual(raw.messages, [])
      }
    }
  })

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // 2. ZCode (SQLite)
  // ───────────────────────────────────────────────────────────────────────────────────────────────

  if (SQLITE === null) {
    await check('ZCode and Cline SQLite checks skipped: node:sqlite is not available on this runtime', () => {
      assert.ok(true)
    })
  } else {
    await check('ZCode scan lists every session, newest first, with the summary fields', async () => {
      const result = await zcode.scan({ home })
      assertScanShape(result)
      assert.equal(result.available, true)
      assert.equal(result.error, null)
      assert.equal(result.sessions.length, 2)
      for (const session of result.sessions) assertSessionShape(session)
      assert.deepEqual(result.sessions.map((session) => session.id), [ZCODE_CHILD, ZCODE_ROOT])
      const newest = result.sessions[0]
      assert.equal(newest.title, 'Child agent')
      assert.equal(newest.cwd, 'F:\\work')
      assert.equal(newest.createdAt, 1700000006000)
      assert.equal(newest.updatedAt, 1700000009000)
      assert.equal(newest.messageCount, 2)
      assert.equal(newest.provider, 'fixture-provider')
      assert.equal(newest.model, 'fixture-model')
      assert.ok(newest.bytes > 0)
      const rootSession = result.sessions[1]
      assert.equal(rootSession.messageCount, 3, 'two assistant responses plus one human prompt, synthetic rows excluded')
      assert.equal(rootSession.title, 'Build the widget')
    })

    await check('ZCode readSession maps text/reasoning/tool parts and skips plumbing parts', async () => {
      const raw = await zcode.readSession(ZCODE_ROOT, { home })
      assertRawShape(raw)
      assert.equal(raw.error, null)
      assert.equal(raw.id, ZCODE_ROOT)
      assert.equal(raw.title, 'Build the widget')
      assert.equal(raw.cwd, 'F:\\work')
      assert.equal(raw.createdAt, 1700000000000)
      assert.equal(raw.provider, 'fixture-provider')
      assert.equal(raw.model, 'fixture-model')
      assert.equal(raw.truncated, false)
      assert.deepEqual(raw.messages, [
        { role: 'user', time: 1700000001000, blocks: [{ type: 'text', text: 'How do I build the widget?' }] },
        {
          role: 'assistant',
          time: 1700000002000,
          blocks: [
            { type: 'reasoning', text: 'Think about it' },
            { type: 'text', text: 'Here is the plan' },
            { type: 'text', text: '[tool: Bash]' },
          ],
        },
        { role: 'assistant', time: 1700000004000, blocks: [{ type: 'text', text: 'Second answer' }] },
      ])
    })

    await check('ZCode readSession reports truncation at a byte budget instead of reading everything', async () => {
      const raw = await zcode.readSession(ZCODE_ROOT, { home, maxBytes: 1 })
      assertRawShape(raw)
      assert.equal(raw.error, null)
      assert.equal(raw.truncated, true)
    })

    await check('ZCode readSession reports not-found for an unknown session id', async () => {
      const raw = await zcode.readSession('sess_missing', { home })
      assertRawShape(raw)
      assert.equal(raw.error, 'not-found')
    })

    await check('the ZCode database is opened read-only and left untouched', () => {
      assert.equal(existsSync(`${ZCODE_DB}-journal`), false, 'a read must not leave a rollback journal')
      assert.equal(existsSync(`${ZCODE_DB}-wal`), false, 'a read must not leave a WAL')
      assert.equal(existsSync(`${ZCODE_DB}-shm`), false, 'a read must not leave shared memory')
      assert.equal(statSync(ZCODE_DB).mtimeMs, zcodeModifiedAt, 'the database file must not be written')
    })

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // 6. Cline (SQLite, unsupported schema)
    // ─────────────────────────────────────────────────────────────────────────────────────────────

    await check('Cline reports available:true with unsupported-schema rather than inventing a mapping', async () => {
      const result = await cline.scan({ home })
      assertScanShape(result)
      assert.equal(result.available, true)
      assert.equal(result.error, 'unsupported-schema')
      assert.deepEqual(result.sessions, [])
      const raw = await cline.readSession('some-session', { home })
      assertRawShape(raw)
      assert.equal(raw.error, 'unsupported-schema')
      assert.deepEqual(raw.messages, [])
    })

    await check('the Cline database is opened read-only and left untouched', () => {
      assert.equal(existsSync(`${CLINE_DB}-journal`), false)
      assert.equal(statSync(CLINE_DB).mtimeMs, clineModifiedAt)
    })
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // 3. Qoder (JSONL)
  // ───────────────────────────────────────────────────────────────────────────────────────────────

  await check('Qoder scan recovers id, cwd, model and title from the transcript records', async () => {
    const result = await qoder.scan({ home })
    assertScanShape(result)
    assert.equal(result.available, true)
    assert.equal(result.error, null)
    const sessions = new Map(result.sessions.map((session) => [session.id, session]))
    assert.deepEqual([...sessions.keys()].sort(), [QODER_BIG, QODER_ID].sort())
    for (const session of result.sessions) assertSessionShape(session)
    const session = sessions.get(QODER_ID)
    assert.equal(session.title, 'Build a Qoder thing')
    assert.equal(session.cwd, 'H:\\qoder-work')
    assert.equal(session.model, 'qfmodel')
    assert.equal(session.provider, '')
    assert.equal(session.createdAt, 1710000000000)
    assert.equal(session.messageCount, 2, 'the tool_result user record is not an imported turn')
    assert.equal(session.bytes, statSync(join(home, '.qoder-cn', 'projects', 'H--qoder-work', `${QODER_ID}.jsonl`)).size)
    assert.equal(session.updatedAt, Math.trunc(statSync(join(home, '.qoder-cn', 'projects', 'H--qoder-work', `${QODER_ID}.jsonl`)).mtimeMs))
    const big = sessions.get(QODER_BIG)
    assert.equal(big.messageCount, 200)
  })

  await check('Qoder readSession imports only visible turns and keeps tool calls as placeholders', async () => {
    const raw = await qoder.readSession(QODER_ID, { home })
    assertRawShape(raw)
    assert.equal(raw.error, null)
    assert.equal(raw.id, QODER_ID)
    assert.equal(raw.title, 'Build a Qoder thing')
    assert.equal(raw.cwd, 'H:\\qoder-work')
    assert.equal(raw.model, 'qfmodel')
    assert.equal(raw.truncated, false)
    assert.equal(raw.messages.length, 2)
    assert.equal(raw.messages[0].role, 'user')
    assert.equal(raw.messages[0].time, QODER_USER_TIME)
    assert.equal(raw.messages[0].blocks.length, 1)
    assert.equal(raw.messages[0].blocks[0].type, 'text')
    assert.ok(raw.messages[0].blocks[0].text.includes('Build a Qoder thing'))
    assert.deepEqual(raw.messages[1], {
      role: 'assistant',
      time: QODER_ASSISTANT_TIME,
      blocks: [
        { type: 'reasoning', text: 'plan it' },
        { type: 'text', text: 'done' },
        { type: 'text', text: '[tool: Bash]' },
      ],
    })
  })

  await check('Qoder readSession truncates at the caller byte budget and says so', async () => {
    const raw = await qoder.readSession(QODER_BIG, { home, maxBytes: 400 })
    assertRawShape(raw)
    assert.equal(raw.error, null)
    assert.equal(raw.truncated, true)
    assert.ok(raw.messages.length < 200, `expected a partial read, got ${raw.messages.length} messages`)
  })

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // 4. Cursor (JSONL)
  // ───────────────────────────────────────────────────────────────────────────────────────────────

  await check('Cursor scan derives the title from the first user text and keeps cwd empty', async () => {
    const result = await cursor.scan({ home })
    assertScanShape(result)
    assert.equal(result.available, true)
    assert.equal(result.error, null)
    assert.equal(result.sessions.length, 1)
    const session = result.sessions[0]
    assertSessionShape(session)
    assert.equal(session.id, CURSOR_ID)
    assert.equal(session.title, 'Add a Cursor button')
    assert.equal(session.cwd, '', 'the encoded workspace directory name is not a path to report')
    assert.equal(session.provider, '')
    assert.equal(session.model, '')
    assert.equal(session.messageCount, 2)
    const filePath = join(home, '.cursor', 'projects', 'h-work', 'agent-transcripts', CURSOR_ID, `${CURSOR_ID}.jsonl`)
    assert.equal(session.bytes, statSync(filePath).size)
    assert.equal(session.createdAt, Math.trunc(statSync(filePath).birthtimeMs) || 0)
  })

  await check('Cursor readSession maps text and tool_use, with the transcript having no timestamps', async () => {
    const raw = await cursor.readSession(CURSOR_ID, { home })
    assertRawShape(raw)
    assert.equal(raw.error, null)
    assert.equal(raw.title, 'Add a Cursor button')
    assert.equal(raw.truncated, false)
    assert.equal(raw.messages.length, 2)
    assert.equal(raw.messages[0].role, 'user')
    assert.equal(raw.messages[0].time, 0)
    assert.ok(raw.messages[0].blocks[0].text.includes('Add a Cursor button'))
    assert.deepEqual(raw.messages[1], {
      role: 'assistant',
      time: 0,
      blocks: [
        { type: 'text', text: 'ok' },
        { type: 'text', text: '[tool: Read]' },
      ],
    })
  })

  await check('Cursor readSession truncates when the budget cuts inside the transcript', async () => {
    const raw = await cursor.readSession(CURSOR_ID, { home, maxBytes: 100 })
    assertRawShape(raw)
    assert.equal(raw.truncated, true)
  })

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // 5. WorkBuddy (JSONL)
  // ───────────────────────────────────────────────────────────────────────────────────────────────

  await check('WorkBuddy scan prefers the generated title and reads cwd/model from the records', async () => {
    const result = await workbuddy.scan({ home })
    assertScanShape(result)
    assert.equal(result.available, true)
    assert.equal(result.error, null)
    assert.equal(result.sessions.length, 1)
    const session = result.sessions[0]
    assertSessionShape(session)
    assert.equal(session.id, WORKBUDDY_ID)
    assert.equal(session.title, 'Fix the WorkBuddy bug title')
    assert.equal(session.cwd, 'G:\\wb')
    assert.equal(session.model, 'wb-model')
    assert.equal(session.provider, '')
    assert.equal(session.createdAt, 1720000000000)
    assert.equal(session.messageCount, 2, 'reasoning and tool records are not messages')
    const filePath = join(home, '.workbuddy', 'projects', 'wb-project', `${WORKBUDDY_ID}.jsonl`)
    assert.equal(session.bytes, statSync(filePath).size)
  })

  await check('WorkBuddy readSession folds reasoning into the following assistant message', async () => {
    const raw = await workbuddy.readSession(WORKBUDDY_ID, { home })
    assertRawShape(raw)
    assert.equal(raw.error, null)
    assert.equal(raw.title, 'Fix the WorkBuddy bug title')
    assert.equal(raw.cwd, 'G:\\wb')
    assert.equal(raw.model, 'wb-model')
    assert.equal(raw.truncated, false)
    assert.deepEqual(raw.messages, [
      { role: 'user', time: 1720000000100, blocks: [{ type: 'text', text: 'Fix the WorkBuddy bug' }] },
      {
        role: 'assistant',
        time: 1720000000300,
        blocks: [
          { type: 'reasoning', text: 'need a plan' },
          { type: 'text', text: 'fixed' },
          { type: 'text', text: '[tool: Bash]' },
        ],
      },
    ])
  })

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // 7. the registry
  // ───────────────────────────────────────────────────────────────────────────────────────────────

  await check('ADAPTERS is the five harnesses in presentation order, each with a label', () => {
    assert.deepEqual(
      ADAPTERS.map((adapter) => [adapter.harness, adapter.label]),
      [
        ['zcode', 'ZCode'],
        ['qoder', 'Qoder'],
        ['cursor', 'Cursor'],
        ['workbuddy', 'WorkBuddy'],
        ['cline', 'Cline'],
      ],
    )
    for (const adapter of ADAPTERS) {
      assert.equal(typeof adapter.scan, 'function')
      assert.equal(typeof adapter.readSession, 'function')
    }
  })

  await check('adapterFor finds by stable id, and returns undefined for anything else', () => {
    assert.equal(adapterFor('zcode'), zcode)
    assert.equal(adapterFor('qoder'), qoder)
    assert.equal(adapterFor('cursor'), cursor)
    assert.equal(adapterFor('workbuddy'), workbuddy)
    assert.equal(adapterFor('cline'), cline)
    for (const value of ['ZCode', 'nope', '', undefined, null, 42, {}, []]) {
      assert.equal(adapterFor(value), undefined, `adapterFor(${String(value)})`)
    }
  })

  await check('scanAll returns one group per harness, in order, with the five-time shape', async () => {
    const result = await scanAll({ home })
    assert.equal(Array.isArray(result.harnesses), true)
    assert.deepEqual(
      result.harnesses.map((group) => group.harness),
      ['zcode', 'qoder', 'cursor', 'workbuddy', 'cline'],
    )
    for (const group of result.harnesses) {
      assert.deepEqual(Object.keys(group).sort(), ['available', 'error', 'harness', 'label', 'sessions'])
      assert.equal(typeof group.label, 'string')
      assert.equal(typeof group.available, 'boolean')
      assert.equal(typeof group.error === 'string' || group.error === null, true)
      for (const session of group.sessions) assertSessionShape(session)
    }
    assert.deepEqual(
      result.harnesses.map((group) => group.available),
      [true, true, true, true, true],
    )
    const clineGroup = result.harnesses.find((group) => group.harness === 'cline')
    assert.equal(clineGroup.error, 'unsupported-schema')
    const zcodeGroup = result.harnesses.find((group) => group.harness === 'zcode')
    if (SQLITE !== null) assert.equal(zcodeGroup.sessions.length, 2)
    assert.equal(result.harnesses.find((group) => group.harness === 'qoder').sessions.length, 2)
    assert.equal(result.harnesses.find((group) => group.harness === 'cursor').sessions.length, 1)
    assert.equal(result.harnesses.find((group) => group.harness === 'workbuddy').sessions.length, 1)
  })

  await check('a second scanAll reports the same rows (the per-file count cache is consistent)', async () => {
    const first = await scanAll({ home })
    const second = await scanAll({ home })
    assert.deepEqual(second, first)
  })

  await check('readForeignSession splits the composite id and returns the adapter plus the raw read', async () => {
    const zcodeRead = await readForeignSession(`zcode/${ZCODE_ROOT}`, { home })
    assert.equal(zcodeRead.adapter, zcode)
    assert.equal(zcodeRead.error, null)
    assertRawShape(zcodeRead.raw)
    assert.equal(zcodeRead.raw.id, ZCODE_ROOT)

    const qoderRead = await readForeignSession(`qoder/${QODER_ID}`, { home })
    assert.equal(qoderRead.adapter, qoder)
    assert.equal(qoderRead.error, null)
    assert.equal(qoderRead.raw.messages.length, 2)

    const cursorRead = await readForeignSession(`cursor/${CURSOR_ID}`, { home })
    assert.equal(cursorRead.adapter, cursor)
    assert.equal(cursorRead.error, null)

    const workbuddyRead = await readForeignSession(`workbuddy/${WORKBUDDY_ID}`, { home })
    assert.equal(workbuddyRead.adapter, workbuddy)
    assert.equal(workbuddyRead.error, null)
  })

  await check('readForeignSession rejects unknown harnesses, malformed and unsafe composite ids', async () => {
    for (const [compositeId, expected] of [
      ['bogus/id', 'unknown-harness'],
      ['noharness', 'invalid-id'],
      ['zcode/', 'invalid-id'],
      ['/id', 'invalid-id'],
      ['zcode/../escape', 'invalid-id'],
      ['zcode/a/b', 'invalid-id'],
      ['', 'invalid-id'],
    ]) {
      const result = await readForeignSession(compositeId, { home })
      assert.equal(result.raw, null, `${compositeId} must not produce a raw session`)
      assert.equal(result.error, expected, compositeId)
    }
    for (const value of [undefined, null, 42, {}, []]) {
      const result = await readForeignSession(value, { home })
      assert.equal(result.raw, null)
      assert.equal(result.error, 'invalid-id')
    }
  })

  await check('an aborted signal makes the scan stop with a named error, not a throw', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await scanAll({ home, signal: controller.signal })
    assert.equal(result.harnesses.length, 5)
    for (const group of result.harnesses) {
      assert.equal(group.error, 'aborted', group.harness)
      assert.deepEqual(group.sessions, [], group.harness)
    }
  })

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // 8. total behaviour: hostile options and no-throw guarantees
  // ───────────────────────────────────────────────────────────────────────────────────────────────

  await check('every adapters scan never throws on unusable options', async () => {
    const hostile = {
      get home() {
        throw new Error('boom')
      },
    }
    const cases = [undefined, null, 42, 'nope', {}, { home: 42 }, { home: null }, { home }, hostile]
    for (const adapter of ADAPTERS) {
      for (const options of cases) {
        let result
        try {
          result = await adapter.scan(options)
        } catch (error) {
          assert.fail(`${adapter.harness}.scan threw: ${error.message}`)
        }
        assert.ok(result !== null && typeof result === 'object', `${adapter.harness}: a shape must come back`)
        assert.equal(Array.isArray(result.sessions), true)
        assert.equal(typeof result.available, 'boolean')
        assert.equal(typeof result.error === 'string' || result.error === null, true)
      }
    }
  })

  await check('every adapters readSession never throws on unusable input', async () => {
    const hostile = {
      get home() {
        throw new Error('boom')
      },
      get maxBytes() {
        throw new Error('boom')
      },
      get signal() {
        throw new Error('boom')
      },
    }
    const options = [undefined, null, 42, {}, { home }, { home, maxBytes: 'x' }, hostile]
    for (const adapter of ADAPTERS) {
      for (const id of [undefined, null, 42, '', 'missing-session']) {
        for (const option of options) {
          let raw
          try {
            raw = await adapter.readSession(id, option)
          } catch (error) {
            assert.fail(`${adapter.harness}.readSession threw: ${error.message}`)
          }
          assert.ok(raw !== null && typeof raw === 'object', `${adapter.harness}: a shape must come back`)
          assert.equal(Array.isArray(raw.messages), true)
          assert.equal(typeof raw.truncated, 'boolean')
          assert.equal(typeof raw.error === 'string' || raw.error === null, true)
        }
      }
    }
  })

  await check('every adapter result carries exactly the contract keys', async () => {
    for (const adapter of ADAPTERS) {
      const result = await adapter.scan({ home: empty })
      assertScanShape(result)
      const missing = await adapter.readSession('missing-session', { home })
      assertRawShape(missing)
    }
  })
} finally {
  rmSync(tmp, REMOVE_OPTIONS)
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
