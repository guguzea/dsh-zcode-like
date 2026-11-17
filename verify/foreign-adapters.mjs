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
 *      the message/byte cap, the not-found path, delegated child sessions (`parentId` lineage), and
 *      that the database is untouched
 *   3. Qoder: metadata recovery, sidechain-style tool results, string vs typed content, truncation,
 *      delegated `subagents/agent-*.jsonl` rows, the `.meta.json` title priority, and reading them
 *   4. Cursor: title from the first user text, the lossy-cwd decision (`''`), tool placeholders,
 *      delegated `subagents/<subagentId>.jsonl` rows and reads
 *   5. WorkBuddy: metadata records, ai-title preference, reasoning folding, tool placeholder,
 *      delegated `subagents/agent-*.jsonl` rows (with the non-transcript files in the same tree)
 *   6. Cline: `available: true` with `unsupported-schema` instead of a guessed mapping
 *   7. the registry: adapter order, composite-id parsing, scanAll/get-by-composite-id, caching
 *   8. total behaviour: hostile options, missing ids, aborted signals, contract key sets, unsafe
 *      and over-deep raw-id rejection for every JSONL adapter
 *   9. the persistent scan cache: `ScanCache` round-trip, dirty-only flush, prune by age/entries/
 *      bytes, never-throw on bad input or corrupt files, a stub cache proving an adapter returns a
 *      cached row instead of reading the transcript, a simulated restart serving a disk row, and a
 *      changed transcript invalidating it; the ZCode row set cached against db + `-wal` identity
 *  10. Cursor metadata: real cwd/model recovered from its own `state.vscdb` fixture (composerHeaders
 *      + composerData), the workspaceStorage folder-URI fallback, subagent inheritance, a corrupt
 *      database degrading to empty values, `readSession` matching its scan row (own and inherited)
 *      and staying empty when the store is missing, a main-DB change invalidating cached rows while
 *      a `-wal`-only change keeps them (new conversations still get fresh metadata), and the stamp
 *      recorded in the cache key
 *
 * The only writes are inside `verify/.tmp-foreign-adapters/`; the suite removes that directory in
 * a `finally` and exits non-zero when any check failed.
 */

import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ScanCache, memoryScanCache } from '../host/foreign/cache.js'
import * as antigravity from '../host/foreign/antigravity.js'
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
// One delegated Qoder transcript per title source: meta description, meta agentType, first user text.
const QODER_CHILD_DESCRIBED = 'agent-qoder-child-described'
const QODER_CHILD_TYPED = 'agent-qoder-child-typed'
const QODER_CHILD_PLAIN = 'agent-qoder-child-plain'
const QODER_CHILD_DESCRIBED_ID = `${QODER_ID}/subagents/${QODER_CHILD_DESCRIBED}`
const QODER_CHILD_TYPED_ID = `${QODER_ID}/subagents/${QODER_CHILD_TYPED}`
const QODER_CHILD_PLAIN_ID = `${QODER_ID}/subagents/${QODER_CHILD_PLAIN}`
const QODER_CHILD_DESCRIBED_TITLE = 'Audit the Qoder delegation'
const CURSOR_ID = 'cursor-session-1'
const CURSOR_CHILD = 'cursor-subagent-1'
const CURSOR_CHILD_ID = `${CURSOR_ID}/subagents/${CURSOR_CHILD}`
const CURSOR_CHILD_TITLE = 'Ask the Cursor subagent'
const WORKBUDDY_ID = 'workbuddy-session-1'
const WORKBUDDY_CHILD = 'agent-workbuddy-child'
const WORKBUDDY_CHILD_ID = `${WORKBUDDY_ID}/subagents/${WORKBUDDY_CHILD}`
const WORKBUDDY_CHILD_TITLE = 'Work the WorkBuddy child'
const WORKBUDDY_CHILD_TIME = 1720000010000
// The persistent-cache fixtures: a dedicated home with one Qoder transcript, so a row can be
// prepopulated/tampered with without touching the fixtures the other checks assert on.
const CACHE_SESSION = 'cache-session-1'
const CACHE_HOME = join(tmp, 'cache-home')
const CACHE_TRANSCRIPT = join(CACHE_HOME, '.qoder-cn', 'projects', 'H--cache-work', `${CACHE_SESSION}.jsonl`)
// Cursor's cwd/model fixture: its own state database with headers + composerData rows.
const CURSOR_META_HOME = join(tmp, 'cursor-meta-home')
const CURSOR_META_ID = 'cursor-meta-1'
const CURSOR_META_PARENT = 'cursor-meta-parent'
const CURSOR_META_CHILD_INHERIT = 'cursor-meta-child-inherit'
const CURSOR_META_CHILD_OWN = 'cursor-meta-child-own'
const CURSOR_META_NOHEADER = 'cursor-meta-noheader'
const CURSOR_META_WORKSPACE = 'cursor-meta-workspace'
const CURSOR_META_CHILD_INHERIT_ID = `${CURSOR_META_PARENT}/subagents/${CURSOR_META_CHILD_INHERIT}`
const CURSOR_META_CHILD_OWN_ID = `${CURSOR_META_PARENT}/subagents/${CURSOR_META_CHILD_OWN}`
const CURSOR_META_ID_CWD = 'c:\\Users\\fixture\\涓枃鐩綍'
const CURSOR_META_PARENT_CWD = 'c:\\Users\\fixture\\parent-dir'
const CURSOR_META_CHILD_CWD = 'c:\\Users\\fixture\\child-own-dir'
const CURSOR_META_WORKSPACE_CWD = 'c:/Users/fixture/from-workspace-json'
const CURSOR_META_ID_MODEL = 'claude-fixture-model'
const CURSOR_META_PARENT_MODEL = 'parent-fixture-model'
const CURSOR_META_CHILD_MODEL = 'child-own-model'
const CURSOR_META_WORKSPACE_MODEL = 'workspace-model'
const CURSOR_BROKEN_HOME = join(tmp, 'cursor-broken-home')
// A Cursor home whose state DB runs in WAL mode with a live writer, to separate -wal writes from
// main-DB writes (the case where Cursor runs while the user scans).
const CURSOR_WAL_HOME = join(tmp, 'cursor-wal-home')
const CURSOR_WAL_OLD = 'cursor-wal-old'
const CURSOR_WAL_NEW = 'cursor-wal-new'
const CURSOR_WAL_OLD_CWD = 'c:\\fixture\\wal-old-dir'
const CURSOR_WAL_OLD_MODEL = 'wal-old-model'
const CURSOR_WAL_NEW_CWD = 'c:\\fixture\\wal-new-dir'
const CURSOR_WAL_NEW_MODEL = 'wal-new-model'

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
  // `parentId` is optional in the contract: only a harness that records lineage reports it, and an
  // absent one means "top level", not "unknown". Every other key is mandatory and fixed.
  const keys = Object.keys(session).sort()
  const withoutParent = keys.filter((key) => key === 'parentId' ? false : true)
  assert.deepEqual(withoutParent, SESSION_KEYS)
  if (keys.includes('parentId')) assert.equal(typeof session.parentId, 'string')
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

// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
// fixtures
// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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

  // Delegated Qoder conversations: `<sessionId>/subagents/agent-<id>.jsonl` plus `.meta.json`.
  const subagents = join(project, QODER_ID, 'subagents')
  writeFixture(
    join(subagents, `${QODER_CHILD_DESCRIBED}.jsonl`),
    jsonl([
      {
        type: 'user',
        uuid: 'q-child-user-1',
        timestamp: '2024-03-09T16:05:00.000Z',
        message: { role: 'user', content: 'Delegated Qoder prompt' },
        sessionId: QODER_ID,
        agentId: 'ageneral-purpose-fixture',
        isSidechain: true,
        cwd: 'H:\\qoder-work',
      },
      {
        type: 'assistant',
        uuid: 'q-child-assistant-1',
        timestamp: '2024-03-09T16:05:30.000Z',
        message: {
          role: 'assistant',
          model: 'qchildmodel',
          content: [{ type: 'thinking', thinking: 'child plan' }, { type: 'text', text: 'child answer' }, { type: 'tool_use', name: 'Grep', input: {} }],
        },
        sessionId: QODER_ID,
        agentId: 'ageneral-purpose-fixture',
        isSidechain: true,
        cwd: 'H:\\qoder-work',
      },
    ]),
  )
  writeFixture(
    join(subagents, `${QODER_CHILD_DESCRIBED}.meta.json`),
    JSON.stringify({ agentType: 'general-purpose', toolUseId: 'call_fixture', description: QODER_CHILD_DESCRIBED_TITLE, invocationName: 'fixture-leg', color: '#123456' }),
  )
  writeFixture(
    join(subagents, `${QODER_CHILD_TYPED}.jsonl`),
    jsonl([
      {
        type: 'user',
        uuid: 'q-child-typed-1',
        timestamp: '2024-03-09T16:06:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'typed child prompt' }] },
        cwd: 'H:\\qoder-work',
      },
    ]),
  )
  // Only an agentType: it wins over the turn text, which is a worse title.
  writeFixture(join(subagents, `${QODER_CHILD_TYPED}.meta.json`), JSON.stringify({ agentType: 'explore' }))
  writeFixture(
    join(subagents, `${QODER_CHILD_PLAIN}.jsonl`),
    jsonl([
      {
        type: 'user',
        uuid: 'q-child-plain-1',
        timestamp: '2024-03-09T16:07:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'plain child question' }] },
        cwd: 'H:\\qoder-work',
      },
    ]),
  )
  // Real Qoder `subagents/` dirs mix transcripts with task JSON; only `.jsonl` files are conversations.
  writeFixture(join(subagents, 'task-a003469dc70e6464d.json'), JSON.stringify({ type: 'task' }))
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
  // Delegated Cursor conversations use the same line shape, one directory down.
  writeFixture(
    join(directory, 'subagents', `${CURSOR_CHILD}.jsonl`),
    jsonl([
      { role: 'user', message: { content: [{ type: 'text', text: `<user_query>${CURSOR_CHILD_TITLE}</user_query>` }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'child ok' }, { type: 'tool_use', name: 'Grep', input: {} }] } },
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
  // Delegated WorkBuddy conversations: `<sessionId>/subagents/agent-<id>.jsonl`. The parent session
  // directory also holds `call_*.txt` tool output and `agent-*` working directories, none of which
  // is a transcript; the record `sessionId` there names the sub-agent itself, not the parent.
  const sessionDirectory = join(home, '.workbuddy', 'projects', 'wb-project', WORKBUDDY_ID)
  writeFixture(join(sessionDirectory, 'call_1.txt'), 'tool output\n')
  writeFixture(join(sessionDirectory, 'subagents', `agent-${WORKBUDDY_CHILD.slice('agent-'.length)}`), 'not a transcript')
  writeFixture(
    join(sessionDirectory, 'subagents', `${WORKBUDDY_CHILD}.jsonl`),
    jsonl([
      {
        id: 'wb-child-user',
        timestamp: WORKBUDDY_CHILD_TIME,
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: WORKBUDDY_CHILD_TITLE }],
        sessionId: 'child-own-session',
        cwd: 'G:\\wb',
      },
      {
        id: 'wb-child-reasoning',
        timestamp: WORKBUDDY_CHILD_TIME + 100,
        type: 'reasoning',
        providerData: {},
        content: [],
        rawContent: [{ type: 'reasoning_text', text: 'child thinking' }],
        sessionId: 'child-own-session',
        cwd: 'G:\\wb',
      },
      {
        id: 'wb-child-assistant',
        timestamp: WORKBUDDY_CHILD_TIME + 200,
        type: 'message',
        role: 'assistant',
        providerData: { requestModelId: 'wb-child-model', model: 'wb-child-model' },
        content: [{ type: 'output_text', text: 'child answer' }],
        sessionId: 'child-own-session',
        cwd: 'G:\\wb',
      },
      { id: 'wb-child-call', timestamp: WORKBUDDY_CHILD_TIME + 300, type: 'function_call', name: 'Write', callId: 'call_2', arguments: '{}', cwd: 'G:\\wb' },
      { id: 'wb-child-result', timestamp: WORKBUDDY_CHILD_TIME + 400, type: 'function_call_result', name: 'Write', callId: 'call_2', output: 'ok', cwd: 'G:\\wb' },
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

/**
 * The Antigravity store, in the shape measured on a real installation.
 *
 * Two databases: one index (`conversation_summaries.db`) describing every conversation, and one
 * per-conversation database. The transcript text lives in the index's full-text table as plain text,
 * and the step boundary column is a BLOB of `[lineIndex, corpusOrdinal]` pairs. The second value is
 * carried through untouched by the adapter, so the fixture deliberately makes it irregular (0,1 then
 * 170,171) to catch an implementation that slices by it.
 */
function buildAntigravityStore() {
  const base = join(home, '.gemini', 'antigravity')
  const conversations = join(base, 'conversations')
  mkdirSync(conversations, { recursive: true })
  if (SQLITE === null) return

  const userBody = 'first question\n'
  const agentBody = ['answer one', '', '', 'answer two', '', 'answer three', ''].join('\n')

  const index = new SQLITE.DatabaseSync(join(base, 'conversation_summaries.db'))
  try {
    index.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        preview TEXT,
        step_count INTEGER,
        last_modified_time TEXT,
        workspace_uris TEXT,
        parent_conversation_id TEXT,
        nesting_depth INTEGER
      );
      CREATE TABLE conversations_fts (
        conversation_id TEXT,
        chunk_index INTEGER,
        chunk_first_step INTEGER,
        chunk_last_step INTEGER,
        user_body TEXT,
        agent_body TEXT,
        user_step_byte_offsets BLOB,
        agent_step_byte_offsets BLOB
      );
    `)
    const insertSummary = index.prepare(
      'INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, parent_conversation_id, nesting_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    insertSummary.run(
      'ag-parent-0001',
      'Fixture conversation',
      'Fixture conversation',
      6,
      '2026-11-16 15:40:19.859236+00:00',
      '["file:///f%3A/AGTEST"]',
      '',
      0,
    )
    insertSummary.run(
      'ag-child-0002',
      '',
      '',
      4,
      '2026-11-16 15:40:06.314654+00:00',
      '["file:///f%3A/AGTEST"]',
      'ag-parent-0001',
      1,
    )
    const insertChunk = index.prepare(
      'INSERT INTO conversations_fts (conversation_id, chunk_index, chunk_first_step, chunk_last_step, user_body, agent_body, user_step_byte_offsets, agent_step_byte_offsets) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    // Boundaries are line indices into the bodies: one user step, three assistant steps.
    insertChunk.run(
      'ag-parent-0001',
      0,
      0,
      5,
      userBody,
      agentBody,
      Buffer.from('[[1,0]]', 'utf8'),
      Buffer.from('[[1,0],[4,170],[6,171]]', 'utf8'),
    )
  } finally {
    index.close()
  }

  // The per-conversation database: its own schema is protobuf-bearing and is deliberately NOT read,
  // so the fixture only needs to exist with the right name and a plausible size.
  const conversation = new SQLITE.DatabaseSync(join(conversations, 'ag-parent-0001.db'))
  try {
    conversation.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_payload BLOB);')
    conversation.exec("INSERT INTO steps (idx, step_payload) VALUES (0, x'080e2003');")
  } finally {
    conversation.close()
  }
}

/**
 * The bare home: every harness directory exists but holds no store.
 *
 * Antigravity gets `.gemini/antigravity` rather than `.gemini`, because `.gemini` alone can belong to
 * the Gemini CLI — the adapter treats the inner directory as the installation marker, and this fixture
 * has to match that judgement or the "installed but empty" contract means nothing.
 */
function buildBareHome() {
  for (const directory of ['.zcode', '.qoder-cn', join('.gemini', 'antigravity'), '.cursor', '.workbuddy', '.cline']) {
    mkdirSync(join(bare, directory), { recursive: true })
  }
}

/** The persistent-cache home: one ordinary Qoder session, used only by the scan-cache checks. */
function buildCacheHome() {
  writeFixture(
    CACHE_TRANSCRIPT,
    jsonl([
      { type: 'workspace-directories', sessionId: CACHE_SESSION, directories: ['H:\\cache-work'] },
      { type: 'runtime-config', sessionId: CACHE_SESSION, model: 'cache-model', timestamp: 1730000000000 },
      {
        type: 'user',
        uuid: 'cache-user-1',
        timestamp: '2024-05-01T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'cache question' }] },
      },
      {
        type: 'assistant',
        uuid: 'cache-assistant-1',
        timestamp: '2024-05-01T00:00:05.000Z',
        message: { role: 'assistant', model: 'cache-model', content: [{ type: 'text', text: 'cache answer' }] },
      },
    ]),
  )
}

/** One minimal Cursor transcript: a user turn (the title) and an assistant turn. */
function cursorTranscript(question) {
  return jsonl([
    { role: 'user', message: { content: [{ type: 'text', text: question }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } },
  ])
}

/**
 * Cursor's own state database fixture: the transcript files carry no metadata, so the cwd/model
 * must come from `composerHeaders` + `cursorDiskKV` exactly as on a real machine. Also builds the
 * `workspaceStorage/<workspaceId>/workspace.json` fallback file.
 */
function buildCursorMetaStore() {
  const transcripts = join(CURSOR_META_HOME, '.cursor', 'projects', 'h-meta', 'agent-transcripts')
  writeFixture(join(transcripts, CURSOR_META_ID, `${CURSOR_META_ID}.jsonl`), cursorTranscript('cursor metadata question'))
  writeFixture(join(transcripts, CURSOR_META_PARENT, `${CURSOR_META_PARENT}.jsonl`), cursorTranscript('parent question'))
  writeFixture(join(transcripts, CURSOR_META_NOHEADER, `${CURSOR_META_NOHEADER}.jsonl`), cursorTranscript('no header question'))
  writeFixture(join(transcripts, CURSOR_META_WORKSPACE, `${CURSOR_META_WORKSPACE}.jsonl`), cursorTranscript('workspace fallback question'))
  writeFixture(join(transcripts, CURSOR_META_PARENT, 'subagents', `${CURSOR_META_CHILD_INHERIT}.jsonl`), cursorTranscript('child inherit question'))
  writeFixture(join(transcripts, CURSOR_META_PARENT, 'subagents', `${CURSOR_META_CHILD_OWN}.jsonl`), cursorTranscript('child own question'))
  if (SQLITE === null) return
  const globalStorage = join(CURSOR_META_HOME, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage')
  mkdirSync(globalStorage, { recursive: true })
  const db = new SQLITE.DatabaseSync(join(globalStorage, 'state.vscdb'))
  try {
    db.exec(`
      CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, value TEXT);
      CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);
    `)
    const insertHeader = db.prepare('INSERT INTO composerHeaders (composerId, workspaceId, value) VALUES (?,?,?)')
    const insertData = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?,?)')
    const header = (id, workspaceId, cwd) =>
      insertHeader.run(
        id,
        workspaceId,
        JSON.stringify({
          type: 'head',
          composerId: id,
          workspaceIdentifier: cwd === '' ? { id: workspaceId } : { id: workspaceId, uri: { fsPath: cwd, scheme: 'file' } },
        }),
      )
    const composerData = (id, model) =>
      insertData.run(`composerData:${id}`, JSON.stringify({ composerId: id, modelConfig: { modelName: model, selectedModels: [{ modelId: model }] } }))

    header(CURSOR_META_ID, '', CURSOR_META_ID_CWD)
    header(CURSOR_META_PARENT, '', CURSOR_META_PARENT_CWD)
    header(CURSOR_META_CHILD_OWN, '', CURSOR_META_CHILD_CWD)
    // A header that names only a workspaceId: the real cwd comes from workspaceStorage.
    header(CURSOR_META_WORKSPACE, 'ws-fixture-1', '')
    composerData(CURSOR_META_ID, CURSOR_META_ID_MODEL)
    composerData(CURSOR_META_PARENT, CURSOR_META_PARENT_MODEL)
    composerData(CURSOR_META_CHILD_OWN, CURSOR_META_CHILD_MODEL)
    composerData(CURSOR_META_WORKSPACE, CURSOR_META_WORKSPACE_MODEL)
    // Even a composerData row must not give a model to a conversation with no header row.
    composerData(CURSOR_META_NOHEADER, 'no-header-model-that-must-be-ignored')
  } finally {
    db.close()
  }
  writeFixture(
    join(CURSOR_META_HOME, 'AppData', 'Roaming', 'Cursor', 'User', 'workspaceStorage', 'ws-fixture-1', 'workspace.json'),
    JSON.stringify({ folder: 'file:///c%3A/Users/fixture/from-workspace-json' }),
  )
}

/** A Cursor home whose state database is corrupt text, to prove the scan degrades. */
function buildCursorBrokenHome() {
  writeFixture(
    join(CURSOR_BROKEN_HOME, '.cursor', 'projects', 'h-broken', 'agent-transcripts', 'cursor-broken-1', 'cursor-broken-1.jsonl'),
    cursorTranscript('broken db question'),
  )
  writeFixture(join(CURSOR_BROKEN_HOME, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'), 'this is not a sqlite database')
}

// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
// the fixtures are built once, then every check reads them
// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

mkdirSync(empty, { recursive: true })
mkdirSync(home, { recursive: true })
await buildZcodeStore()
buildQoderStore()
buildCursorStore()
buildWorkbuddyStore()
buildClineStore()
buildAntigravityStore()
buildBareHome()
buildCacheHome()
buildCursorMetaStore()
buildCursorBrokenHome()

const ZCODE_DB = join(home, '.zcode', 'cli', 'db', 'db.sqlite')
const CLINE_DB = join(home, '.cline', 'data', 'db', 'sessions.db')
const zcodeModifiedAt = existsSync(ZCODE_DB) ? statSync(ZCODE_DB).mtimeMs : 0
const clineModifiedAt = existsSync(CLINE_DB) ? statSync(CLINE_DB).mtimeMs : 0

try {
  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // 1. missing installation, bare installations, missing ids: the contract shapes
  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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

  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // 2. ZCode (SQLite)
  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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

    await check('ZCode lists delegated child sessions with parentId and reads them by id', async () => {
      const result = await zcode.scan({ home })
      const sessions = new Map(result.sessions.map((session) => [session.id, session]))
      assert.equal(sessions.get(ZCODE_ROOT).parentId, '', 'a top-level session has no parent')
      assert.equal(sessions.get(ZCODE_CHILD).parentId, ZCODE_ROOT, 'the child points at its parent session')
      const child = await zcode.readSession(ZCODE_CHILD, { home })
      assertRawShape(child)
      assert.equal(child.error, null)
      assert.equal(child.id, ZCODE_CHILD)
      assert.deepEqual(child.messages, [
        { role: 'user', time: 1700000007000, blocks: [{ type: 'text', text: 'child ask' }] },
        { role: 'assistant', time: 1700000008000, blocks: [{ type: 'text', text: 'child answer' }] },
      ])
      const viaRegistry = await readForeignSession(`zcode/${ZCODE_CHILD}`, { home })
      assert.equal(viaRegistry.error, null)
      assert.equal(viaRegistry.raw.id, ZCODE_CHILD)
    })

    await check('the ZCode database is opened read-only and left untouched', () => {
      assert.equal(existsSync(`${ZCODE_DB}-journal`), false, 'a read must not leave a rollback journal')
      assert.equal(existsSync(`${ZCODE_DB}-wal`), false, 'a read must not leave a WAL')
      assert.equal(existsSync(`${ZCODE_DB}-shm`), false, 'a read must not leave shared memory')
      assert.equal(statSync(ZCODE_DB).mtimeMs, zcodeModifiedAt, 'the database file must not be written')
    })

    // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    // 6. Cline (SQLite, unsupported schema)
    // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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

  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // 3. Qoder (JSONL)
  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  await check('Qoder scan recovers id, cwd, model and title from the transcript records', async () => {
    const result = await qoder.scan({ home })
    assertScanShape(result)
    assert.equal(result.available, true)
    assert.equal(result.error, null)
    const sessions = new Map(result.sessions.map((session) => [session.id, session]))
    assert.deepEqual(
      [...sessions.keys()].sort(),
      [QODER_BIG, QODER_ID, QODER_CHILD_DESCRIBED_ID, QODER_CHILD_PLAIN_ID, QODER_CHILD_TYPED_ID].sort(),
    )
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

  await check('Qoder lists delegated subagent rows with parentId and the meta title priority', async () => {
    const result = await qoder.scan({ home })
    const sessions = new Map(result.sessions.map((session) => [session.id, session]))
    assert.equal(sessions.size, 5)
    for (const session of result.sessions) assertSessionShape(session)

    const described = sessions.get(QODER_CHILD_DESCRIBED_ID)
    assertSessionShape(described)
    assert.equal(described.parentId, QODER_ID)
    assert.equal(described.title, QODER_CHILD_DESCRIBED_TITLE, 'meta.description is the best title')
    assert.equal(described.cwd, 'H:\\qoder-work', 'a delegated transcript carries cwd on its turns')
    assert.equal(described.model, 'qchildmodel')
    assert.equal(described.provider, '')
    assert.equal(described.messageCount, 2)
    const describedPath = join(home, '.qoder-cn', 'projects', 'H--qoder-work', QODER_ID, 'subagents', `${QODER_CHILD_DESCRIBED}.jsonl`)
    assert.equal(described.bytes, statSync(describedPath).size)

    const typed = sessions.get(QODER_CHILD_TYPED_ID)
    assert.equal(typed.parentId, QODER_ID)
    assert.equal(typed.title, 'explore', 'meta.agentType beats the first user text')
    assert.equal(typed.messageCount, 1)

    const plain = sessions.get(QODER_CHILD_PLAIN_ID)
    assert.equal(plain.parentId, QODER_ID)
    assert.equal(plain.title, 'plain child question', 'with no meta the first user text is the title')
    assert.equal(plain.messageCount, 1)

    // The `task-*.json` file in the same directory is not a conversation; only the three JSONL files are rows.
    assert.deepEqual(
      [...sessions.keys()].filter((id) => id.includes('/')).sort(),
      [QODER_CHILD_DESCRIBED_ID, QODER_CHILD_PLAIN_ID, QODER_CHILD_TYPED_ID].sort(),
    )
  })

  await check('Qoder readSession resolves <parent>/subagents/<child> and maps its messages', async () => {
    const raw = await qoder.readSession(QODER_CHILD_DESCRIBED_ID, { home })
    assertRawShape(raw)
    assert.equal(raw.error, null)
    assert.equal(raw.id, QODER_CHILD_DESCRIBED_ID)
    assert.equal(raw.title, QODER_CHILD_DESCRIBED_TITLE, 'the read matches the scan row title')
    assert.equal(raw.cwd, 'H:\\qoder-work')
    assert.equal(raw.model, 'qchildmodel')
    assert.equal(raw.provider, '')
    assert.equal(raw.truncated, false)
    assert.deepEqual(raw.messages, [
      { role: 'user', time: Date.parse('2024-03-09T16:05:00.000Z'), blocks: [{ type: 'text', text: 'Delegated Qoder prompt' }] },
      {
        role: 'assistant',
        time: Date.parse('2024-03-09T16:05:30.000Z'),
        blocks: [
          { type: 'reasoning', text: 'child plan' },
          { type: 'text', text: 'child answer' },
          { type: 'text', text: '[tool: Grep]' },
        ],
      },
    ])
    const truncated = await qoder.readSession(QODER_CHILD_DESCRIBED_ID, { home, maxBytes: 1 })
    assert.equal(truncated.truncated, true, 'a delegated read honours the byte budget too')
    assert.equal(truncated.error, null)
    const viaRegistry = await readForeignSession(`qoder/${QODER_CHILD_DESCRIBED_ID}`, { home })
    assert.equal(viaRegistry.error, null)
    assert.equal(viaRegistry.raw.id, QODER_CHILD_DESCRIBED_ID)
  })

  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // 4. Cursor (JSONL)
  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  await check('Cursor scan derives the title from the first user text and keeps cwd empty', async () => {
    const result = await cursor.scan({ home })
    assertScanShape(result)
    assert.equal(result.available, true)
    assert.equal(result.error, null)
    assert.equal(result.sessions.length, 2)
    const sessions = new Map(result.sessions.map((session) => [session.id, session]))
    const session = sessions.get(CURSOR_ID)
    assertSessionShape(session)
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

  await check('Cursor lists the delegated subagent row with parentId, and reads it by composite id', async () => {
    const result = await cursor.scan({ home })
    const sessions = new Map(result.sessions.map((session) => [session.id, session]))
    const child = sessions.get(CURSOR_CHILD_ID)
    assertSessionShape(child)
    assert.equal(child.parentId, CURSOR_ID)
    assert.equal(child.title, CURSOR_CHILD_TITLE, 'the first user text, with the user_query wrapper removed')
    assert.equal(child.cwd, '')
    assert.equal(child.provider, '')
    assert.equal(child.model, '')
    assert.equal(child.messageCount, 2)
    const childPath = join(home, '.cursor', 'projects', 'h-work', 'agent-transcripts', CURSOR_ID, 'subagents', `${CURSOR_CHILD}.jsonl`)
    assert.equal(child.bytes, statSync(childPath).size)
    assert.equal(child.createdAt, Math.trunc(statSync(childPath).birthtimeMs) || 0)

    const raw = await cursor.readSession(CURSOR_CHILD_ID, { home })
    assertRawShape(raw)
    assert.equal(raw.error, null)
    assert.equal(raw.id, CURSOR_CHILD_ID)
    assert.equal(raw.title, CURSOR_CHILD_TITLE)
    assert.equal(raw.truncated, false)
    assert.deepEqual(raw.messages, [
      { role: 'user', time: 0, blocks: [{ type: 'text', text: `<user_query>${CURSOR_CHILD_TITLE}</user_query>` }] },
      {
        role: 'assistant',
        time: 0,
        blocks: [
          { type: 'text', text: 'child ok' },
          { type: 'text', text: '[tool: Grep]' },
        ],
      },
    ])
    const truncated = await cursor.readSession(CURSOR_CHILD_ID, { home, maxBytes: 100 })
    assert.equal(truncated.truncated, true)
    const viaRegistry = await readForeignSession(`cursor/${CURSOR_CHILD_ID}`, { home })
    assert.equal(viaRegistry.error, null)
    assert.equal(viaRegistry.raw.id, CURSOR_CHILD_ID)
  })

  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // 5. WorkBuddy (JSONL)
  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  await check('WorkBuddy scan prefers the generated title and reads cwd/model from the records', async () => {
    const result = await workbuddy.scan({ home })
    assertScanShape(result)
    assert.equal(result.available, true)
    assert.equal(result.error, null)
    assert.equal(result.sessions.length, 2)
    const sessions = new Map(result.sessions.map((session) => [session.id, session]))
    const session = sessions.get(WORKBUDDY_ID)
    assertSessionShape(session)
    assert.equal(session.title, 'Fix the WorkBuddy bug title')
    assert.equal(session.cwd, 'G:\\wb')
    assert.equal(session.model, 'wb-model')
    assert.equal(session.provider, '')
    assert.equal(session.createdAt, 1720000000000)
    assert.equal(session.messageCount, 2, 'reasoning and tool records are not messages')
    const filePath = join(home, '.workbuddy', 'projects', 'wb-project', `${WORKBUDDY_ID}.jsonl`)
    assert.equal(session.bytes, statSync(filePath).size)
  })

  await check('WorkBuddy lists the delegated subagent row and ignores non-transcript files', async () => {
    const result = await workbuddy.scan({ home })
    const sessions = new Map(result.sessions.map((session) => [session.id, session]))
    // `call_1.txt` and the extensionless `agent-*` entry in the same tree are not conversations.
    assert.deepEqual([...sessions.keys()].sort(), [WORKBUDDY_ID, WORKBUDDY_CHILD_ID].sort())
    const child = sessions.get(WORKBUDDY_CHILD_ID)
    assertSessionShape(child)
    assert.equal(child.parentId, WORKBUDDY_ID)
    assert.equal(child.title, WORKBUDDY_CHILD_TITLE, 'the first user text')
    assert.equal(child.cwd, 'G:\\wb')
    assert.equal(child.model, 'wb-child-model')
    assert.equal(child.provider, '')
    assert.equal(child.createdAt, WORKBUDDY_CHILD_TIME)
    assert.equal(child.messageCount, 2, 'reasoning and tool records are not messages')
    const childPath = join(home, '.workbuddy', 'projects', 'wb-project', WORKBUDDY_ID, 'subagents', `${WORKBUDDY_CHILD}.jsonl`)
    assert.equal(child.bytes, statSync(childPath).size)

    const raw = await workbuddy.readSession(WORKBUDDY_CHILD_ID, { home })
    assertRawShape(raw)
    assert.equal(raw.error, null)
    assert.equal(raw.id, WORKBUDDY_CHILD_ID)
    assert.equal(raw.title, WORKBUDDY_CHILD_TITLE)
    assert.equal(raw.cwd, 'G:\\wb')
    assert.equal(raw.model, 'wb-child-model')
    assert.equal(raw.truncated, false)
    assert.deepEqual(raw.messages, [
      { role: 'user', time: WORKBUDDY_CHILD_TIME, blocks: [{ type: 'text', text: WORKBUDDY_CHILD_TITLE }] },
      {
        role: 'assistant',
        time: WORKBUDDY_CHILD_TIME + 200,
        blocks: [
          { type: 'reasoning', text: 'child thinking' },
          { type: 'text', text: 'child answer' },
          { type: 'text', text: '[tool: Write]' },
        ],
      },
    ])
    const truncated = await workbuddy.readSession(WORKBUDDY_CHILD_ID, { home, maxBytes: 1 })
    assert.equal(truncated.truncated, true)
    const viaRegistry = await readForeignSession(`workbuddy/${WORKBUDDY_CHILD_ID}`, { home })
    assert.equal(viaRegistry.error, null)
    assert.equal(viaRegistry.raw.id, WORKBUDDY_CHILD_ID)
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

  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // 6b. Antigravity (SQLite index + plain-text FTS extraction)
await check('antigravity scans the index and reports both conversations', async () => {
  const scanned = await antigravity.scan({ home })
  assert.equal(scanned.available, true)
  assert.equal(scanned.error, null)
  assert.equal(scanned.sessions.length, 2)
  const parent = scanned.sessions.find((entry) => entry.id === 'ag-parent-0001')
  const child = scanned.sessions.find((entry) => entry.id === 'ag-child-0002')
  assert.ok(parent !== undefined, 'the parent row is missing')
  assert.ok(child !== undefined, 'the child row is missing')
  // The index row carries the title, the decoded workspace and the step count; the model is NOT in
  // the store, so the adapter reports it empty rather than inventing one.
  assert.equal(parent.title, 'Fixture conversation')
  assert.equal(parent.cwd, 'f:/AGTEST')
  assert.equal(parent.messageCount, 6)
  assert.equal(parent.provider, '')
  assert.equal(parent.model, '')
  // The parent link is a bare id; the registry adds the harness prefix.
  assert.equal(child.parentId, 'ag-parent-0001')
  assert.equal(child.title, '')
})

await check('antigravity reads the transcript from the plain-text extraction', async () => {
  const read = await antigravity.readSession('ag-parent-0001', { home })
  assert.equal(read.error, null)
  assert.equal(read.cwd, 'f:/AGTEST')
  assert.equal(read.messages.length, 4)
  assert.equal(read.messages[0].role, 'user')
  assert.equal(read.messages[0].blocks[0].text, 'first question')
  // The boundary column's SECOND value (0,170,171) is a corpus ordinal, not an offset: an adapter
  // that sliced by it would collapse these three turns into one. The first value drives the split.
  const assistantTexts = read.messages.filter((message) => message.role === 'assistant').map((message) => message.blocks[0].text)
  assert.deepEqual(assistantTexts, ['answer one', 'answer two', 'answer three'])
})

await check('antigravity refuses unknown and unsafe ids without throwing', async () => {
  assert.equal((await antigravity.readSession('nope-9999', { home })).error, 'not-found')
  assert.equal((await antigravity.readSession('../escape', { home })).error, 'invalid-id')
  assert.equal((await antigravity.readSession('', { home })).error, 'invalid-id')
  assert.equal((await antigravity.scan({ home: bare })).available, true)
  assert.deepEqual((await antigravity.scan({ home: empty })).sessions, [])
})

// 7. the registry
  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  await check('ADAPTERS is the six harnesses in presentation order, each with a label', () => {
    assert.deepEqual(
      ADAPTERS.map((adapter) => [adapter.harness, adapter.label]),
      [
        ['zcode', 'ZCode'],
        ['qoder', 'Qoder'],
        ['antigravity', 'Antigravity'],
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

  await check('scanAll returns one group per harness, in order, with the six-time shape', async () => {
    const result = await scanAll({ home })
    assert.equal(Array.isArray(result.harnesses), true)
    assert.deepEqual(
      result.harnesses.map((group) => group.harness),
      ['zcode', 'qoder', 'antigravity', 'cursor', 'workbuddy', 'cline'],
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
      [true, true, true, true, true, true],
    )
    const clineGroup = result.harnesses.find((group) => group.harness === 'cline')
    assert.equal(clineGroup.error, 'unsupported-schema')
    const zcodeGroup = result.harnesses.find((group) => group.harness === 'zcode')
    if (SQLITE !== null) assert.equal(zcodeGroup.sessions.length, 2)
    assert.equal(result.harnesses.find((group) => group.harness === 'qoder').sessions.length, 5)
    assert.equal(result.harnesses.find((group) => group.harness === 'cursor').sessions.length, 2)
    assert.equal(result.harnesses.find((group) => group.harness === 'workbuddy').sessions.length, 2)
    // Every delegated row reaches the page with the lineage it needs to indent under its parent.
    const delegated = result.harnesses.flatMap((group) => group.sessions.filter((session) => session.id.includes('/subagents/')).map((session) => [group.harness, session]))
    assert.deepEqual(
      delegated.map(([harnessName, session]) => `${harnessName}:${session.id}`).sort(),
      [
        `qoder:${QODER_CHILD_DESCRIBED_ID}`,
        `qoder:${QODER_CHILD_PLAIN_ID}`,
        `qoder:${QODER_CHILD_TYPED_ID}`,
        `cursor:${CURSOR_CHILD_ID}`,
        `workbuddy:${WORKBUDDY_CHILD_ID}`,
      ].sort(),
    )
    for (const [, session] of delegated) assert.equal(typeof session.parentId, 'string')
  })

  await check('a second scanAll reports the same rows (the per-file count cache is consistent)', async () => {
    const first = await scanAll({ home })
    const second = await scanAll({ home })
    assert.deepEqual(second, first)
  })

  await check('a changed delegated transcript invalidates its cached message count', async () => {
    const before = (await qoder.scan({ home })).sessions.find((session) => session.id === QODER_CHILD_PLAIN_ID)
    assert.equal(before.messageCount, 1)
    const childPath = join(home, '.qoder-cn', 'projects', 'H--qoder-work', QODER_ID, 'subagents', `${QODER_CHILD_PLAIN}.jsonl`)
    appendFileSync(
      childPath,
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'q-child-plain-2',
        timestamp: '2024-03-09T16:07:30.000Z',
        message: { role: 'assistant', model: 'qchildmodel', content: [{ type: 'text', text: 'plain child answer' }] },
      })}\n`,
      'utf8',
    )
    const after = (await qoder.scan({ home })).sessions.find((session) => session.id === QODER_CHILD_PLAIN_ID)
    assert.equal(after.messageCount, 2, 'a rescan must count the new turn, not reuse the old cache entry')
    const raw = await qoder.readSession(QODER_CHILD_PLAIN_ID, { home })
    assert.equal(raw.messages.length, 2)
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
    assert.equal(result.harnesses.length, 6)
    for (const group of result.harnesses) {
      assert.equal(group.error, 'aborted', group.harness)
      assert.deepEqual(group.sessions, [], group.harness)
    }
  })

  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // 8. total behaviour: hostile options and no-throw guarantees
  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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

  await check('the JSONL adapters reject unsafe, composite-shaped and over-deep raw ids', async () => {
    const adapters = [
      [qoder, QODER_ID],
      [cursor, CURSOR_ID],
      [workbuddy, WORKBUDDY_ID],
    ]
    for (const [adapter, parentId] of adapters) {
      for (const id of [
        // traversal
        '..',
        '../escape',
        `${parentId}/subagents/..`,
        `${parentId}/subagents/../../escape`,
        '../subagents/child',
        // absolute (POSIX and Windows forms)
        '/absolute/path',
        'C:\\Users\\secret',
        // wrong shape: not a delegated id, an empty segment, or a deeper path than the contract allows
        `${parentId}/subagents`,
        `${parentId}/other/child`,
        `${parentId}//child`,
        `${parentId}/subagents/`,
        `${parentId}/subagents/child/extra`,
        'a/b/c/d/e',
      ]) {
        const raw = await adapter.readSession(id, { home })
        assertRawShape(raw)
        assert.equal(raw.error, 'invalid-id', `${adapter.harness}/${id} must be rejected as an invalid id`)
        assert.deepEqual(raw.messages, [])
      }
    }
    // The well-formed shape is not over-rejected: a missing child is `not-found`, never `invalid-id`.
    for (const [adapter, parentId] of adapters) {
      const raw = await adapter.readSession(`${parentId}/subagents/does-not-exist`, { home })
      assertRawShape(raw)
      assert.equal(raw.error, 'not-found', `${adapter.harness}: a well-formed but missing child is not-found`)
    }
  })

  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // 9. the persistent scan cache (host/foreign/cache.js + options.cache)
  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  const cacheFileIn = (directory) => join(directory, 'foreign-scan-cache.json')

  await check('ScanCache round-trips rows through disk and writes only when dirty', async () => {
    const directory = join(tmp, 'cache-roundtrip')
    const cache = new ScanCache(directory)
    assert.equal(cache.size(), 0, 'construction must not create entries')
    assert.equal(cache.get('alpha'), undefined)
    cache.set('alpha', { title: 'alpha title', messageCount: 2 })
    cache.set('beta', { title: 'beta title', messageCount: 3 })
    assert.equal(cache.size(), 2)
    cache.flush()
    const filePath = cacheFileIn(directory)
    assert.equal(existsSync(filePath), true, 'flush must create the documented file')
    const firstText = readFileSync(filePath, 'utf8')
    const stored = JSON.parse(firstText)
    assert.equal(stored.version, 1)
    assert.equal(typeof stored.entries.alpha.at, 'number')
    assert.deepEqual(stored.entries.alpha.value, { title: 'alpha title', messageCount: 2 })

    const reloaded = new ScanCache(directory)
    assert.deepEqual(reloaded.get('alpha'), { title: 'alpha title', messageCount: 2 })
    assert.deepEqual(reloaded.get('beta'), { title: 'beta title', messageCount: 3 })
    assert.equal(reloaded.size(), 2)
    assert.equal(reloaded.get('missing'), undefined, 'an unknown key is not a hit')

    // A flush with nothing changed must not rewrite the file: a scan that changed nothing is free.
    const beforeMtime = statSync(filePath).mtimeMs
    reloaded.flush()
    assert.equal(readFileSync(filePath, 'utf8'), firstText)
    assert.equal(statSync(filePath).mtimeMs, beforeMtime)
  })

  await check('ScanCache prunes by age, by entry count and by byte budget', async () => {
    const ageDirectory = join(tmp, 'cache-prune-age')
    const aged = new ScanCache(ageDirectory, { maxAgeMs: 40 })
    aged.set('stale', { title: 'stale' })
    await sleep(60)
    aged.set('fresh', { title: 'fresh' })
    aged.flush()
    const ageReloaded = new ScanCache(ageDirectory, { maxAgeMs: 40 })
    assert.equal(ageReloaded.get('stale'), undefined, 'an entry older than maxAgeMs is pruned on flush')
    assert.deepEqual(ageReloaded.get('fresh'), { title: 'fresh' })

    const countDirectory = join(tmp, 'cache-prune-count')
    const counted = new ScanCache(countDirectory, { maxEntries: 2 })
    counted.set('one', { n: 1 })
    await sleep(3)
    counted.set('two', { n: 2 })
    await sleep(3)
    counted.set('three', { n: 3 })
    counted.flush()
    const countReloaded = new ScanCache(countDirectory, { maxEntries: 2 })
    assert.equal(countReloaded.size(), 2, 'maxEntries bounds the flushed file')
    assert.equal(countReloaded.get('one'), undefined, 'the oldest entries are the ones dropped')
    assert.deepEqual(countReloaded.get('three'), { n: 3 })

    const sizeDirectory = join(tmp, 'cache-prune-size')
    const sized = new ScanCache(sizeDirectory, { maxBytes: 420 })
    for (let index = 0; index < 8; index += 1) {
      sized.set(`key-${index}`, { title: 'x'.repeat(80), n: index })
      await sleep(2)
    }
    sized.flush()
    const sizeFilePath = cacheFileIn(sizeDirectory)
    assert.ok(statSync(sizeFilePath).size <= 420, 'the flushed file stays within maxBytes')
    const sizeReloaded = new ScanCache(sizeDirectory, { maxBytes: 420 })
    assert.ok(sizeReloaded.size() > 0 && sizeReloaded.size() < 8, `expected a size-pruned cache, got ${sizeReloaded.size()}`)
    assert.deepEqual(sizeReloaded.get('key-7'), { title: 'x'.repeat(80), n: 7 }, 'newest rows survive')
    assert.equal(sizeReloaded.get('key-0'), undefined)
  })

  await check('ScanCache never throws on bad input, corrupt files, a foreign version or an oversized file', async () => {
    // Unusable constructor input and unusable method input: the contract is total.
    for (const directory of [undefined, null, 42, '', {}, []]) {
      const cache = new ScanCache(directory)
      cache.get('key')
      cache.get(undefined)
      cache.get(null)
      cache.set('key', { ok: true })
      cache.set(undefined, { ok: true })
      cache.set('other', undefined)
      cache.flush()
      cache.size()
    }
    const hostileOptions = {
      get maxEntries() {
        throw new Error('boom')
      },
      get maxBytes() {
        throw new Error('boom')
      },
      get maxAgeMs() {
        throw new Error('boom')
      },
    }
    const hostile = new ScanCache(join(tmp, 'cache-hostile-options'), hostileOptions)
    hostile.set('key', { ok: true })
    hostile.flush()

    // The directory path may not be creatable at all (a file sits where the directory should be).
    writeFixture(join(tmp, 'cache-not-a-directory'), 'x')
    const blocked = new ScanCache(join(tmp, 'cache-not-a-directory', 'nested'))
    blocked.set('key', { ok: true })
    blocked.flush()

    // A value JSON cannot represent must not make flush throw.
    const circular = {}
    circular.self = circular
    const circularCache = new ScanCache(join(tmp, 'cache-circular'))
    circularCache.set('loop', circular)
    circularCache.flush()

    // Missing / corrupt / wrong-shape / foreign-version files all load as empty and keep working.
    const corruptContents = [
      '{ definitely not json',
      '[]',
      'null',
      '{"version":2,"entries":{}}',
      '{"version":1,"entries":[]}',
      '{"version":1,"entries":{"k":"nope"}}',
      '',
    ]
    for (let index = 0; index < corruptContents.length; index += 1) {
      const directory = join(tmp, `cache-broken-${index}`)
      writeFixture(cacheFileIn(directory), corruptContents[index])
      const cache = new ScanCache(directory)
      assert.equal(cache.size(), 0, `corrupt cache ${index} must load empty`)
      cache.set('fresh', { ok: true })
      cache.flush()
      assert.deepEqual(new ScanCache(directory).get('fresh'), { ok: true }, `cache ${index} must recover`)
    }

    // A file larger than the budget loads as empty rather than being parsed.
    const oversizedDirectory = join(tmp, 'cache-oversized')
    writeFixture(
      cacheFileIn(oversizedDirectory),
      JSON.stringify({ version: 1, entries: { big: { at: Date.now(), value: { text: 'x'.repeat(400) } } } }),
    )
    const oversized = new ScanCache(oversizedDirectory, { maxBytes: 200 })
    assert.equal(oversized.size(), 0, 'an oversized cache file loads empty')
    oversized.set('fresh', { ok: true })
    oversized.flush()
    assert.deepEqual(new ScanCache(oversizedDirectory, { maxBytes: 200 }).get('fresh'), { ok: true })
  })

  await check('memoryScanCache is a working zero-disk cache with the same surface', async () => {
    const memory = memoryScanCache()
    assert.equal(memory.get('alpha'), undefined)
    memory.set('alpha', { title: 'alpha' })
    assert.deepEqual(memory.get('alpha'), { title: 'alpha' })
    assert.equal(memory.size(), 1)
    memory.flush()
    assert.deepEqual(memory.get('alpha'), { title: 'alpha' }, 'flush must not clear an in-memory cache')
    const first = await qoder.scan({ home, cache: memory })
    const second = await qoder.scan({ home, cache: memory })
    assert.deepEqual(second, first, 'a memory cache is accepted as options.cache and never stale here')
  })

  await check('a stub cache serves a scan row without the adapter reading the transcript', async () => {
    const cases = [
      [qoder, join(home, '.qoder-cn', 'projects', 'H--qoder-work', `${QODER_ID}.jsonl`), QODER_ID, 'Build a Qoder thing'],
      [cursor, join(home, '.cursor', 'projects', 'h-work', 'agent-transcripts', CURSOR_ID, `${CURSOR_ID}.jsonl`), CURSOR_ID, 'Add a Cursor button'],
      [workbuddy, join(home, '.workbuddy', 'projects', 'wb-project', `${WORKBUDDY_ID}.jsonl`), WORKBUDDY_ID, 'Fix the WorkBuddy bug title'],
    ]
    for (const [adapter, transcriptPath, sessionId, liveTitle] of cases) {
      const keys = []
      const writes = []
      const cachedRow = {
        id: sessionId,
        title: `CACHED ONLY ${adapter.harness}`,
        cwd: 'C:\\cached',
        createdAt: 111,
        provider: 'cached-provider',
        model: 'cached-model',
        messageCount: 4242,
      }
      const stub = {
        get(key) {
          keys.push(key)
          return typeof key === 'string' && key.includes(transcriptPath) ? cachedRow : undefined
        },
        set(key) {
          writes.push(key)
        },
      }
      const result = await adapter.scan({ home, cache: stub })
      const row = result.sessions.find((session) => session.id === sessionId)
      assert.ok(row !== undefined, `${adapter.harness}: the cached row must be listed`)
      assert.equal(row.title, cachedRow.title, `${adapter.harness}: the title must come from the cache`)
      assert.notEqual(row.title, liveTitle, `${adapter.harness}: a hit must not re-derive the title from the file`)
      assert.equal(row.messageCount, 4242, `${adapter.harness}: the count must come from the cache`)
      assert.equal(row.cwd, 'C:\\cached')
      assert.equal(row.provider, 'cached-provider')
      assert.equal(row.model, 'cached-model')
      assert.equal(row.createdAt, 111)

      // The key must be honest: harness + absolute path + size + mtime + ctime of the file.
      // Cursor's cwd/model come from its state database, so its key also carries that store's stamp
      // (this fixture home has no state database: `absent`, for the current runtime).
      const info = statSync(transcriptPath)
      const fileKey = `${adapter.harness}\u0000${transcriptPath}\u0000${info.size}\u0000${info.mtimeMs}\u0000${info.ctimeMs}`
      const expectedKey =
        adapter.harness === 'cursor' ? `${fileKey}\u0000cursor-state-v2:node:${process.versions.node}:absent` : fileKey
      assert.ok(keys.includes(expectedKey), `${adapter.harness}: get() received the honest key`)
      assert.equal(writes.includes(expectedKey), false, `${adapter.harness}: a hit must not rewrite the entry`)
    }
  })

  await check('a persisted cache row is served after a simulated restart, and a changed file misses it', async () => {
    const cacheDirectory = join(tmp, 'cache-persist')
    const cacheFile = cacheFileIn(cacheDirectory)

    // Cold process: the scan fills the cache and flush persists it.
    const coldCache = new ScanCache(cacheDirectory)
    const coldRows = await qoder.scan({ home: CACHE_HOME, cache: coldCache })
    assert.equal(coldRows.sessions.length, 1)
    assert.equal(coldRows.sessions[0].id, CACHE_SESSION)
    assert.equal(coldRows.sessions[0].messageCount, 2)
    coldCache.flush()

    // A "restart" is a new ScanCache over the same directory. Tamper the persisted row so only a
    // real cache hit can produce it, then scan with a fresh instance.
    const stored = JSON.parse(readFileSync(cacheFile, 'utf8'))
    assert.equal(stored.version, 1)
    const cacheKeyForTranscript = Object.keys(stored.entries).find((key) => key.includes(CACHE_TRANSCRIPT))
    assert.ok(cacheKeyForTranscript !== undefined, 'the scan must have persisted a row keyed by the transcript')
    stored.entries[cacheKeyForTranscript].value = {
      ...stored.entries[cacheKeyForTranscript].value,
      title: 'DISK SENTINEL TITLE',
      messageCount: 999,
    }
    writeFileSync(cacheFile, JSON.stringify(stored), 'utf8')
    const warmRows = await qoder.scan({ home: CACHE_HOME, cache: new ScanCache(cacheDirectory) })
    assert.equal(warmRows.sessions[0].title, 'DISK SENTINEL TITLE', 'the row came from disk, not the transcript')
    assert.equal(warmRows.sessions[0].messageCount, 999)

    // Any change to the transcript (size/mtime/ctime) must miss and recompute.
    appendFileSync(
      CACHE_TRANSCRIPT,
      `\n${JSON.stringify({
        type: 'user',
        uuid: 'cache-user-2',
        timestamp: '2024-05-01T00:00:10.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'second cache question' }] },
      })}`,
      'utf8',
    )
    const changedRows = await qoder.scan({ home: CACHE_HOME, cache: new ScanCache(cacheDirectory) })
    assert.equal(changedRows.sessions[0].messageCount, 3, 'a changed file must be recounted')
    assert.notEqual(changedRows.sessions[0].title, 'DISK SENTINEL TITLE', 'a changed file must not reuse the old row')
    assert.equal(changedRows.sessions[0].title, 'cache question')
  })

  await check('a corrupt or absent cache file still yields a working cold scan', async () => {
    const corruptDirectory = join(tmp, 'cache-corrupt-adapter')
    writeFixture(cacheFileIn(corruptDirectory), '{ definitely not json')
    const corruptCache = new ScanCache(corruptDirectory)
    assert.equal(corruptCache.size(), 0)
    const corruptRows = await qoder.scan({ home: CACHE_HOME, cache: corruptCache })
    assert.equal(corruptRows.available, true)
    assert.equal(corruptRows.error, null)
    assert.equal(corruptRows.sessions[0].messageCount, 3)
    corruptCache.set('fresh', { ok: true })
    corruptCache.flush()
    assert.deepEqual(new ScanCache(corruptDirectory).get('fresh'), { ok: true })

    const absentCache = new ScanCache(join(tmp, 'cache-absent-directory'))
    assert.equal(absentCache.size(), 0)
    const absentRows = await cursor.scan({ home, cache: absentCache })
    assert.equal(absentRows.sessions.length, 2, 'a cold scan works with an absent cache file')
  })

  if (SQLITE === null) {
    await check('ZCode scan-cache check skipped: node:sqlite is not available on this runtime', () => {
      assert.ok(true)
    })
  } else {
    await check('ZCode caches its SQLite row set against the db and -wal identity', async () => {
      const cacheDirectory = join(tmp, 'cache-zcode')
      const cacheFile = cacheFileIn(cacheDirectory)
      const coldCache = new ScanCache(cacheDirectory)
      const coldRows = await zcode.scan({ home, cache: coldCache })
      assert.equal(coldRows.sessions.length, 2)
      coldCache.flush()

      const stored = JSON.parse(readFileSync(cacheFile, 'utf8'))
      const keys = Object.keys(stored.entries)
      assert.equal(keys.length, 1, 'one store version, one cached row set')
      const storeKey = keys[0]
      assert.ok(storeKey.startsWith('zcode\u0000'))
      assert.ok(storeKey.includes(ZCODE_DB))
      assert.ok(storeKey.includes('\u0000wal:missing'), 'a missing -wal is part of the key')
      stored.entries[storeKey].value = {
        sessions: [
          {
            id: 'sess_cached_only',
            parentId: '',
            title: 'CACHED SQL ROWS',
            cwd: '',
            createdAt: 0,
            updatedAt: 0,
            messageCount: 7,
            provider: '',
            model: '',
            bytes: 1,
          },
        ],
      }
      writeFileSync(cacheFile, JSON.stringify(stored), 'utf8')

      // A fresh instance over the same directory ("restart") returns the tampered row set: the SQL
      // statements did not run.
      const warmRows = await zcode.scan({ home, cache: new ScanCache(cacheDirectory) })
      assert.equal(warmRows.error, null)
      assert.deepEqual(warmRows.sessions.map((session) => session.id), ['sess_cached_only'])
      assert.equal(warmRows.sessions[0].title, 'CACHED SQL ROWS')

      // The -wal file appearing makes the cached row set stale, so the scan must run SQL again.
      writeFileSync(`${ZCODE_DB}-wal`, '', 'utf8')
      try {
        const walRows = await zcode.scan({ home, cache: new ScanCache(cacheDirectory) })
        assert.equal(walRows.error, null)
        assert.equal(walRows.sessions.length, 2, 'a new -wal file invalidates the cached SQL rows')
        assert.deepEqual(walRows.sessions.map((session) => session.id), [ZCODE_CHILD, ZCODE_ROOT])
      } finally {
        rmSync(`${ZCODE_DB}-wal`, { force: true })
      }
    })
  }

  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // 10. Cursor metadata (cwd/model come from Cursor's own state database)
  // 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  await check('a corrupt or absent Cursor state database still scans with empty cwd/model', async () => {
    const broken = await cursor.scan({ home: CURSOR_BROKEN_HOME })
    assertScanShape(broken)
    assert.equal(broken.available, true)
    assert.equal(broken.error, null)
    assert.equal(broken.sessions.length, 1)
    assert.equal(broken.sessions[0].id, 'cursor-broken-1')
    assert.equal(broken.sessions[0].title, 'broken db question')
    assert.equal(broken.sessions[0].cwd, '', 'a corrupt database cannot yield a cwd')
    assert.equal(broken.sessions[0].model, '', 'a corrupt database cannot yield a model')
    assert.equal(broken.sessions[0].provider, '')

    // An absent database (the main fixture home has none) keeps exactly the old behaviour.
    const absent = await cursor.scan({ home })
    const absentRow = absent.sessions.find((session) => session.id === CURSOR_ID)
    assert.equal(absentRow.cwd, '')
    assert.equal(absentRow.model, '')
  })

  await check('Cursor readSession keeps empty cwd/model when the state database is absent or corrupt', async () => {
    const brokenRaw = await cursor.readSession('cursor-broken-1', { home: CURSOR_BROKEN_HOME })
    assertRawShape(brokenRaw)
    assert.equal(brokenRaw.error, null)
    assert.equal(brokenRaw.cwd, '', 'a corrupt database cannot yield a cwd')
    assert.equal(brokenRaw.model, '', 'a corrupt database cannot yield a model')
    assert.ok(brokenRaw.messages.length > 0, 'the transcript itself still reads')

    // No state database at all: the raw read behaves exactly as it did before the metadata existed.
    const absentRaw = await cursor.readSession(CURSOR_ID, { home })
    assertRawShape(absentRaw)
    assert.equal(absentRaw.error, null)
    assert.equal(absentRaw.cwd, '')
    assert.equal(absentRaw.model, '')
  })

  await check('the Cursor adapter only touches cursorDiskKV by primary key (never a LIKE scan)', () => {
    // Strip comments: the module doc explains the ban on `LIKE`, and prose cannot query SQLite.
    const source = readFileSync(join(here, '..', 'host', 'foreign', 'cursor.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    // A `LIKE 'composerData:%'` scan was measured at >180 s on an 11.6 GB store; the adapter must
    // always use batched `key IN (...)` primary-key lookups instead.
    assert.doesNotMatch(source, /LIKE\s+['"]%?composerData/i)
    assert.match(source, /FROM cursorDiskKV WHERE key IN \(/)
    assert.match(source, /COMPOSER_LOOKUP_CHUNK/, 'the lookup batch size must stay bounded')
  })

  if (SQLITE === null) {
    await check('Cursor metadata checks skipped: node:sqlite is not available on this runtime', () => {
      assert.ok(true)
    })
  } else {
    await check('Cursor recovers cwd/model from its state database, inheriting for delegated rows', async () => {
      const result = await cursor.scan({ home: CURSOR_META_HOME })
      assertScanShape(result)
      assert.equal(result.available, true)
      assert.equal(result.error, null)
      assert.equal(result.sessions.length, 6)
      for (const session of result.sessions) assertSessionShape(session)
      const sessions = new Map(result.sessions.map((session) => [session.id, session]))

      const top = sessions.get(CURSOR_META_ID)
      assert.equal(top.cwd, CURSOR_META_ID_CWD, 'the exact workspace path from composerHeaders (non-ASCII preserved)')
      assert.equal(top.model, CURSOR_META_ID_MODEL, 'modelConfig.selectedModels[0].modelId from composerData')
      assert.equal(top.provider, '', 'the serving vendor is not recorded, so it is not invented')

      const noHeader = sessions.get(CURSOR_META_NOHEADER)
      assert.equal(noHeader.cwd, '', 'no header row means no cwd')
      assert.equal(noHeader.model, '', 'no header row means no model, even when composerData exists')

      const workspace = sessions.get(CURSOR_META_WORKSPACE)
      assert.equal(workspace.cwd, CURSOR_META_WORKSPACE_CWD, 'the workspace.json file URI is decoded')
      assert.equal(workspace.model, CURSOR_META_WORKSPACE_MODEL)

      const parent = sessions.get(CURSOR_META_PARENT)
      assert.equal(parent.cwd, CURSOR_META_PARENT_CWD)
      assert.equal(parent.model, CURSOR_META_PARENT_MODEL)

      const inherited = sessions.get(CURSOR_META_CHILD_INHERIT_ID)
      assert.equal(inherited.parentId, CURSOR_META_PARENT)
      assert.equal(inherited.cwd, CURSOR_META_PARENT_CWD, 'a delegated row with no header inherits the parent cwd')
      assert.equal(inherited.model, CURSOR_META_PARENT_MODEL, 'and the parent model')
      assert.equal(inherited.title, 'child inherit question')

      const own = sessions.get(CURSOR_META_CHILD_OWN_ID)
      assert.equal(own.parentId, CURSOR_META_PARENT)
      assert.equal(own.cwd, CURSOR_META_CHILD_CWD, 'its own header row beats the parent')
      assert.equal(own.model, CURSOR_META_CHILD_MODEL)
    })

    await check('Cursor readSession returns the same cwd/model as the scan row (own and inherited)', async () => {
      const scanned = await cursor.scan({ home: CURSOR_META_HOME })
      const rows = new Map(scanned.sessions.map((session) => [session.id, session]))

      const topRaw = await cursor.readSession(CURSOR_META_ID, { home: CURSOR_META_HOME })
      assertRawShape(topRaw)
      assert.equal(topRaw.error, null)
      assert.equal(topRaw.cwd, rows.get(CURSOR_META_ID).cwd, 'the raw read must match the row cwd')
      assert.equal(topRaw.cwd, CURSOR_META_ID_CWD)
      assert.equal(topRaw.model, rows.get(CURSOR_META_ID).model, 'the raw read must match the row model')
      assert.equal(topRaw.model, CURSOR_META_ID_MODEL)
      assert.equal(topRaw.provider, '')

      const inheritedRaw = await cursor.readSession(CURSOR_META_CHILD_INHERIT_ID, { home: CURSOR_META_HOME })
      assertRawShape(inheritedRaw)
      assert.equal(inheritedRaw.error, null)
      assert.equal(
        inheritedRaw.cwd,
        rows.get(CURSOR_META_CHILD_INHERIT_ID).cwd,
        'an inherited subagent read must match its scan row',
      )
      assert.equal(inheritedRaw.model, rows.get(CURSOR_META_CHILD_INHERIT_ID).model)
      assert.equal(inheritedRaw.cwd, CURSOR_META_PARENT_CWD)
      assert.equal(inheritedRaw.model, CURSOR_META_PARENT_MODEL)

      const ownChildRaw = await cursor.readSession(CURSOR_META_CHILD_OWN_ID, { home: CURSOR_META_HOME })
      assert.equal(ownChildRaw.cwd, CURSOR_META_CHILD_CWD, 'a subagent with its own header uses its own cwd')
      assert.equal(ownChildRaw.model, CURSOR_META_CHILD_MODEL)
    })

    await check('a changed main Cursor database invalidates cached cwd/model (metadata stamp)', async () => {
      const cacheDirectory = join(tmp, 'cache-cursor-metadata')
      const cacheFile = cacheFileIn(cacheDirectory)

      // Cold scan persists rows keyed by the transcript plus this store version.
      const coldCache = new ScanCache(cacheDirectory)
      const coldRow = (await cursor.scan({ home: CURSOR_META_HOME, cache: coldCache })).sessions.find(
        (session) => session.id === CURSOR_META_ID,
      )
      assert.equal(coldRow.cwd, CURSOR_META_ID_CWD)
      assert.equal(coldRow.model, CURSOR_META_ID_MODEL)
      coldCache.flush()
      const stored = JSON.parse(readFileSync(cacheFile, 'utf8'))
      const cursorKeys = Object.keys(stored.entries).filter((key) => key.startsWith('cursor\u0000'))
      assert.ok(cursorKeys.length > 0)
      assert.ok(
        cursorKeys.every((key) => key.includes('\u0000cursor-state-v2:')),
        'every cursor row key records the metadata stamp',
      )

      // Tamper the cached row: a warm hit must return it, proving the cache is what answers.
      const transcriptPath = join(
        CURSOR_META_HOME,
        '.cursor',
        'projects',
        'h-meta',
        'agent-transcripts',
        CURSOR_META_ID,
        `${CURSOR_META_ID}.jsonl`,
      )
      const rowKey = cursorKeys.find((key) => key.includes(transcriptPath))
      assert.ok(rowKey !== undefined)
      stored.entries[rowKey].value = { ...stored.entries[rowKey].value, cwd: 'CACHED-ONLY-CWD', model: 'cached-only-model' }
      writeFileSync(cacheFile, JSON.stringify(stored), 'utf8')
      const warmRow = (await cursor.scan({ home: CURSOR_META_HOME, cache: new ScanCache(cacheDirectory) })).sessions.find(
        (session) => session.id === CURSOR_META_ID,
      )
      assert.equal(warmRow.cwd, 'CACHED-ONLY-CWD')
      assert.equal(warmRow.model, 'cached-only-model')

      // Change Cursor's own store: the stamp must change, so the stale cached row is not served.
      const databasePath = join(CURSOR_META_HOME, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
      const db = new SQLITE.DatabaseSync(databasePath)
      try {
        db.prepare('UPDATE composerHeaders SET value = ? WHERE composerId = ?').run(
          JSON.stringify({
            type: 'head',
            composerId: CURSOR_META_ID,
            workspaceIdentifier: { uri: { fsPath: 'c:\\Users\\fixture\\updated-dir' } },
          }),
          CURSOR_META_ID,
        )
      } finally {
        db.close()
      }
      const changedRow = (await cursor.scan({ home: CURSOR_META_HOME, cache: new ScanCache(cacheDirectory) })).sessions.find(
        (session) => session.id === CURSOR_META_ID,
      )
      assert.equal(changedRow.cwd, 'c:\\Users\\fixture\\updated-dir', 'a changed metadata store must not serve the old cwd')
      assert.notEqual(changedRow.cwd, 'CACHED-ONLY-CWD')
      assert.equal(changedRow.model, CURSOR_META_ID_MODEL)
    })

    await check('a -wal-only change keeps cached rows, and a new conversation still gets fresh metadata', async () => {
      // Fixture home: one conversation, its state DB in WAL mode with a live writer, so commits
      // touch only the -wal file — the state a running Cursor leaves behind while the user scans.
      const oldTranscriptPath = join(
        CURSOR_WAL_HOME,
        '.cursor',
        'projects',
        'h-wal',
        'agent-transcripts',
        CURSOR_WAL_OLD,
        `${CURSOR_WAL_OLD}.jsonl`,
      )
      writeFixture(oldTranscriptPath, cursorTranscript('wal old question'))
      const globalStorage = join(CURSOR_WAL_HOME, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage')
      mkdirSync(globalStorage, { recursive: true })
      const databasePath = join(globalStorage, 'state.vscdb')
      const writer = new SQLITE.DatabaseSync(databasePath)
      try {
        writer.exec('CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, value TEXT)')
        writer.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)')
        writer.exec('CREATE TABLE walProbe (id TEXT)')
        writer
          .prepare('INSERT INTO composerHeaders VALUES (?,?,?)')
          .run(CURSOR_WAL_OLD, '', JSON.stringify({ workspaceIdentifier: { uri: { fsPath: CURSOR_WAL_OLD_CWD } } }))
        writer
          .prepare('INSERT INTO cursorDiskKV VALUES (?,?)')
          .run(`composerData:${CURSOR_WAL_OLD}`, JSON.stringify({ modelConfig: { selectedModels: [{ modelId: CURSOR_WAL_OLD_MODEL }] } }))
        writer.exec('PRAGMA journal_mode = WAL')
        writer.prepare('INSERT INTO walProbe VALUES (?)').run('start')
        const mainIdentity = () => {
          const info = statSync(databasePath)
          return `${info.size}:${info.mtimeMs}:${info.ctimeMs}`
        }
        const mainIdentityBeforeWalWrites = mainIdentity()

        // Cold scan + flush caches the old conversation's row under the main DB's identity.
        const cacheDirectory = join(tmp, 'cache-cursor-wal')
        const cacheFile = cacheFileIn(cacheDirectory)
        const coldCache = new ScanCache(cacheDirectory)
        const coldRow = (await cursor.scan({ home: CURSOR_WAL_HOME, cache: coldCache })).sessions.find(
          (session) => session.id === CURSOR_WAL_OLD,
        )
        assert.equal(coldRow.cwd, CURSOR_WAL_OLD_CWD)
        assert.equal(coldRow.model, CURSOR_WAL_OLD_MODEL)
        coldCache.flush()

        // Tamper the cached row so a cache hit is unmistakable.
        const stored = JSON.parse(readFileSync(cacheFile, 'utf8'))
        const rowKey = Object.keys(stored.entries).find((key) => key.includes(oldTranscriptPath))
        assert.ok(rowKey !== undefined)
        stored.entries[rowKey].value = { ...stored.entries[rowKey].value, cwd: 'WAL-CACHED-CWD', model: 'wal-cached-model' }
        writeFileSync(cacheFile, JSON.stringify(stored), 'utf8')

        // A write that only touches the -wal must not invalidate the cached row.
        writer.prepare('INSERT INTO walProbe VALUES (?)').run('wal-only-change')
        assert.equal(mainIdentity(), mainIdentityBeforeWalWrites, 'the write must only have touched the -wal file')
        const walRows = await cursor.scan({ home: CURSOR_WAL_HOME, cache: new ScanCache(cacheDirectory) })
        const cachedAgain = walRows.sessions.find((session) => session.id === CURSOR_WAL_OLD)
        assert.equal(cachedAgain.cwd, 'WAL-CACHED-CWD', 'a -wal-only change must not invalidate the cached row')
        assert.equal(cachedAgain.model, 'wal-cached-model')

        // A NEW conversation is a transcript cache miss: the state DB is opened for that miss and
        // the fresh composerHeaders/composerData rows (committed through the WAL) are used.
        writer
          .prepare('INSERT INTO composerHeaders VALUES (?,?,?)')
          .run(CURSOR_WAL_NEW, '', JSON.stringify({ workspaceIdentifier: { uri: { fsPath: CURSOR_WAL_NEW_CWD } } }))
        writer
          .prepare('INSERT INTO cursorDiskKV VALUES (?,?)')
          .run(`composerData:${CURSOR_WAL_NEW}`, JSON.stringify({ modelConfig: { selectedModels: [{ modelId: CURSOR_WAL_NEW_MODEL }] } }))
        writeFixture(
          join(CURSOR_WAL_HOME, '.cursor', 'projects', 'h-wal', 'agent-transcripts', CURSOR_WAL_NEW, `${CURSOR_WAL_NEW}.jsonl`),
          cursorTranscript('wal new question'),
        )
        assert.equal(mainIdentity(), mainIdentityBeforeWalWrites, 'the new rows must only have touched the -wal file')
        const mixedRows = await cursor.scan({ home: CURSOR_WAL_HOME, cache: new ScanCache(cacheDirectory) })
        const stillCached = mixedRows.sessions.find((session) => session.id === CURSOR_WAL_OLD)
        const newRow = mixedRows.sessions.find((session) => session.id === CURSOR_WAL_NEW)
        assert.equal(stillCached.cwd, 'WAL-CACHED-CWD', 'the old row is still served from cache')
        assert.equal(stillCached.model, 'wal-cached-model')
        assert.equal(newRow.cwd, CURSOR_WAL_NEW_CWD, 'a new conversation gets its fresh cwd from the opened database')
        assert.equal(newRow.model, CURSOR_WAL_NEW_MODEL, 'and its fresh model')
      } finally {
        writer.close()
      }
    })
  }
} finally {
  rmSync(tmp, REMOVE_OPTIONS)
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
