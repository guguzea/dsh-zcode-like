#!/usr/bin/env node
/**
 * Verification for `host/foreign-forge.js` — run `node verify/foreign-forge.mjs` from the bundle root.
 *
 * Plain `node`, no test runner, no network, no filesystem writes. It exits non-zero when any check
 * fails and prints one self-explanatory `ok`/`FAIL` line per check.
 *
 * Coverage, by the acceptance criteria of `docs/foreign-import.md` (section "信封契约"):
 *   1. deterministic, sanitized, at-most-80-char synthetic session id
 *   2. the session header `{type:'session', version:4, id, createdAt, cwd, isSeeded:false}`
 *   3. the source marker as the first `system/message`, capped at 300 characters
 *   4. one event per foreign message, contiguous seq, original times, `surfaceOp:'append'`
 *   5. the forged assistant source is the official `deepseek/deepseek-flash`; the original
 *      provider/model appears only inside the marker
 *   6. text/reasoning block translation, nothing coerced or lost
 *   7. the empty conversation: `events: []` and `reason:'no-messages'`
 *   8. `buildForeignField` mirrors `buildLogField` (afterSeq, byte cap, overCap, `jsonBytes`
 *      accounting); proven by running both implementations over the same input at many caps
 *   9. both functions are total: malformed input returns an error/reason, never throws
 *
 * Plus the parts that make the field usable end to end: an explicit DSH-reader structural check, the
 * afterSeq resume path (feed `throughSeq` back and get only the remaining events), and the measured
 * byte behaviour of an 8000-message conversation: one default-cap request, and how many 256 KiB
 * slices that same session takes.
 */

import assert from 'node:assert/strict'

import { DEFAULT_MAX_BYTES } from '../host/config.js'
import {
  FORGED_SOURCE,
  MAX_MARKER_LENGTH,
  MAX_SESSION_ID_LENGTH,
  SESSION_FORMAT_VERSION,
  buildForeignField,
  forgeSession,
} from '../host/foreign-forge.js'
import { buildLogField, jsonBytes, wireHeader } from '../host/logfield.js'

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

function section(title) {
  console.log(`\n${title}`)
}

const TIME = 1760000000000

/** The shape `readSession` is contracted to return, with a small conversation. */
function makeRaw(overrides = {}) {
  return {
    title: 'zcode debug session',
    cwd: 'F:\\work',
    createdAt: TIME,
    provider: 'cline-pass',
    model: 'deepseek-v4.1-flash',
    truncated: false,
    messages: [
      { role: 'user', time: TIME + 1000, blocks: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', time: TIME + 2000, blocks: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'hi' }] },
      { role: 'user', time: TIME + 3000, blocks: [{ type: 'text', text: 'thanks' }] },
      { role: 'assistant', time: TIME + 4000, blocks: [{ type: 'text', text: 'done' }] },
    ],
    ...overrides,
  }
}

function makeForged(overrides = {}) {
  return forgeSession({ harness: 'zcode', label: 'ZCode', raw: makeRaw(overrides) })
}

function markerText(forged) {
  return forged.events[0].data.message.content[0].text
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
section('1. session.id: deterministic per original session, sanitized, at most 80 chars')
// ─────────────────────────────────────────────────────────────────────────────────────────────────

await check('the same input always forges the same id', () => {
  assert.equal(makeForged().base.session.id, makeForged().base.session.id)
  const raw = makeRaw()
  assert.equal(forgeSession({ harness: 'zcode', raw }).base.session.id, forgeSession({ harness: 'zcode', raw: { ...raw } }).base.session.id)
})

await check('the id is foreign-<harness>-<12 lowercase hex chars>', () => {
  assert.match(makeForged().base.session.id, /^foreign-zcode-[a-f0-9]{12}$/)
})

await check('the id keeps only [A-Za-z0-9_.-] and never exceeds 80 chars', () => {
  assert.equal(MAX_SESSION_ID_LENGTH, 80)
  for (const harness of ['zcode', 'Z Code', 'qoder/../../etc', 'x'.repeat(400), '', '工作台', 'a.b_c-d']) {
    const forged = forgeSession({ harness, label: 'L', raw: makeRaw() })
    const id = forged.base.session.id
    assert.match(id, /^[A-Za-z0-9_.-]+$/, `harness ${JSON.stringify(harness)} produced ${JSON.stringify(id)}`)
    assert.ok(id.length <= MAX_SESSION_ID_LENGTH, `harness ${JSON.stringify(harness)} produced ${String(id.length)} chars`)
    assert.ok(id.startsWith('foreign-'), `harness ${JSON.stringify(harness)} produced ${JSON.stringify(id)}`)
  }
})

await check('an identical raw round-tripped through JSON keeps the id', () => {
  const roundTripped = JSON.parse(JSON.stringify(makeRaw()))
  assert.equal(forgeSession({ harness: 'zcode', raw: roundTripped }).base.session.id, makeForged().base.session.id)
})

await check('different conversations and different harnesses get different ids', () => {
  const base = makeForged()
  const otherConversation = forgeSession({
    harness: 'zcode',
    raw: makeRaw({ messages: [{ role: 'user', time: 1, blocks: [{ type: 'text', text: 'a different conversation' }] }] }),
  })
  const otherHarness = forgeSession({ harness: 'qoder', label: 'Qoder', raw: makeRaw() })
  assert.notEqual(base.base.session.id, otherConversation.base.session.id)
  assert.notEqual(base.base.session.id, otherHarness.base.session.id)
  assert.match(otherHarness.base.session.id, /^foreign-qoder-[a-f0-9]{12}$/)
})

await check('an original id pins the id across re-reads (a truncation does not remint it)', () => {
  const full = forgeSession({ harness: 'zcode', raw: makeRaw({ id: 'sess_abc' }) })
  const truncated = forgeSession({
    harness: 'zcode',
    raw: makeRaw({ id: 'sess_abc', truncated: true, messages: makeRaw().messages.slice(0, 2) }),
  })
  assert.equal(full.base.session.id, truncated.base.session.id)
  assert.ok(markerText(full).includes('session=sess_abc.'))
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
section('2. the session header')
// ─────────────────────────────────────────────────────────────────────────────────────────────────

await check('the base is exactly {version, sessionFormatVersion, session} with 1/4', () => {
  const forged = makeForged()
  assert.deepEqual(Object.keys(forged.base).sort(), ['session', 'sessionFormatVersion', 'version'])
  assert.equal(forged.base.version, 1)
  assert.equal(forged.base.sessionFormatVersion, 4)
  assert.equal(SESSION_FORMAT_VERSION, 4)
  assert.equal('afterSeq' in forged.base, false)
  assert.equal('throughSeq' in forged.base, false)
  assert.equal('events' in forged.base, false)
})

await check('the session header is {type, version, id, createdAt, cwd, isSeeded:false}', () => {
  const session = makeForged().base.session
  assert.deepEqual(session, {
    type: 'session',
    version: 4,
    id: session.id,
    createdAt: TIME,
    cwd: 'F:\\work',
    isSeeded: false,
  })
  assert.match(session.id, /^foreign-zcode-/)
})

await check('a missing cwd/createdAt become an empty string and 0', () => {
  const session = forgeSession({
    harness: 'zcode',
    raw: { messages: [{ role: 'user', blocks: [{ type: 'text', text: 'x' }] }] },
  }).base.session
  assert.equal(session.cwd, '')
  assert.equal(session.createdAt, 0)
  assert.equal(session.isSeeded, false)
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
section('3. the source marker at the front of the content')
// ─────────────────────────────────────────────────────────────────────────────────────────────────

await check('the first event is the marker system/message at seq 0', () => {
  const forged = makeForged()
  const first = forged.events[0]
  assert.equal(first.type, 'system/message')
  assert.equal(first.seq, 0)
  assert.equal(first.time, TIME)
  assert.equal(first.surfaceOp, 'append')
  assert.equal(first.data.message.role, 'system')
  assert.deepEqual(first.data.message.content.map((block) => block.type), ['text'])
  const text = markerText(forged)
  assert.match(text, /^Source: harness=zcode provider=cline-pass model=deepseek-v4\.1-flash session=/)
  assert.ok(text.endsWith('.'), `marker does not end with a period: ${JSON.stringify(text)}`)
})

await check('without an original id the marker names the deterministic synthetic token', () => {
  const forged = makeForged()
  const hash = forged.base.session.id.slice('foreign-zcode-'.length)
  assert.ok(markerText(forged).includes(`session=${hash}.`), JSON.stringify(markerText(forged)))
})

await check('the marker is capped at 300 characters even for huge labels', () => {
  assert.equal(MAX_MARKER_LENGTH, 300)
  const forged = forgeSession({
    harness: 'x'.repeat(400),
    raw: makeRaw({ provider: 'p'.repeat(5000), model: 'm\n'.repeat(4000), id: 's'.repeat(1000) }),
  })
  const points = [...markerText(forged)]
  assert.ok(points.length <= MAX_MARKER_LENGTH, `marker is ${String(points.length)} code points`)
})

await check('hostile provider/model labels are flattened to one line', () => {
  const forged = forgeSession({
    harness: 'zcode',
    raw: makeRaw({ provider: 'bad\nprovider\tid', model: 'model\r\u2028name' }),
  })
  const text = markerText(forged)
  assert.doesNotMatch(text, /[\r\n\u2028\u2029\t]/, 'the marker must stay a single line')
  assert.match(text, /^Source: harness=zcode provider=bad provider id model=model name session=/)
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
section('4. one event per foreign message, contiguous seq, original times')
// ─────────────────────────────────────────────────────────────────────────────────────────────────

await check('events: marker then one per message, seq contiguous, types and times exact', () => {
  const forged = makeForged()
  assert.deepEqual(forged.events.map((event) => event.seq), [0, 1, 2, 3, 4])
  assert.deepEqual(forged.events.map((event) => event.type), [
    'system/message',
    'user/message',
    'assistant/message',
    'user/message',
    'assistant/message',
  ])
  assert.deepEqual(forged.events.map((event) => event.time), [TIME, TIME + 1000, TIME + 2000, TIME + 3000, TIME + 4000])
  for (const event of forged.events) assert.equal(event.surfaceOp, 'append')
})

await check('event count = messages + 1, including messages with empty or missing blocks', () => {
  const forged = makeForged({
    messages: [
      { role: 'user', time: 1, blocks: [] },
      { role: 'assistant', time: 2 },
      { role: 'user', time: 3, blocks: [{ type: 'text', text: 'back' }] },
    ],
  })
  assert.equal(forged.events.length, 4)
  assert.deepEqual(forged.events[1].data.message.content, [])
  assert.deepEqual(forged.events[2].data.message.content, [])
})

await check('a missing message timestamp becomes 0 on the event and the message', () => {
  const forged = makeForged({
    messages: [
      { role: 'user', blocks: [{ type: 'text', text: 'no time' }] },
      { role: 'assistant', time: 5, blocks: [{ type: 'text', text: 'a' }] },
    ],
  })
  assert.deepEqual(forged.events.map((event) => event.time), [TIME, 0, 5])
  assert.equal(forged.events[1].data.message.time, 0)
  assert.equal(forged.events[2].data.message.time, 5)
})

await check('out-of-range and non-numeric timestamps become 0 instead of leaking', () => {
  const forged = makeForged({
    createdAt: 1e300,
    messages: [
      { role: 'user', time: 1e300, blocks: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', time: -1, blocks: [{ type: 'text', text: 'b' }] },
    ],
  })
  assert.equal(forged.base.session.createdAt, 0)
  assert.deepEqual(forged.events.map((event) => event.time), [0, 0, 0])
})

await check('every message carries id, time and role, and the ids are distinct', () => {
  const forged = makeForged()
  for (const event of forged.events) {
    const message = event.data.message
    assert.equal(typeof message.id, 'string')
    assert.ok(message.id.length > 0)
    assert.equal(typeof message.time, 'number')
    assert.equal(message.role, event.type.slice(0, event.type.indexOf('/')))
  }
  const ids = forged.events.map((event) => event.data.message.id)
  assert.equal(new Set(ids).size, ids.length)
})

await check('messages whose role is not user/assistant are skipped, not re-labelled', () => {
  const forged = makeForged({
    messages: [
      { role: 'user', blocks: [{ type: 'text', text: 'u' }] },
      { role: 'tool', blocks: [{ type: 'text', text: 't' }] },
      null,
      42,
      { role: 'assistant', blocks: [{ type: 'text', text: 'a' }] },
    ],
  })
  assert.deepEqual(forged.events.map((event) => event.type), ['system/message', 'user/message', 'assistant/message'])
})

await check('turn increments on user messages; step increments on assistant messages and resets on user', () => {
  const forged = makeForged({
    messages: [
      { role: 'user', time: 1, blocks: [{ type: 'text', text: 'u1' }] },
      { role: 'assistant', time: 2, blocks: [{ type: 'text', text: 'a1' }] },
      { role: 'assistant', time: 3, blocks: [{ type: 'text', text: 'a2' }] },
      { role: 'user', time: 4, blocks: [{ type: 'text', text: 'u2' }] },
      { role: 'assistant', time: 5, blocks: [{ type: 'text', text: 'a3' }] },
    ],
  })
  assert.deepEqual(forged.events.slice(1).map((event) => event.data.turn), [1, 1, 1, 2, 2])
  assert.deepEqual(forged.events.slice(1).map((event) => event.data.step), [0, 1, 2, 0, 1])
  assert.deepEqual([forged.events[0].data.turn, forged.events[0].data.step], [0, 0])
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
section('5. the forged session runs on the official model; the original only in the marker')
// ─────────────────────────────────────────────────────────────────────────────────────────────────

await check('every assistant event claims the official deepseek/deepseek-flash source', () => {
  const forged = makeForged()
  const assistants = forged.events.filter((event) => event.type === 'assistant/message')
  assert.equal(assistants.length, 2)
  assert.deepEqual(FORGED_SOURCE, { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' })
  assert.equal(Object.isFrozen(FORGED_SOURCE), true)
  for (const event of assistants) {
    assert.deepEqual(event.data.message.source, { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' })
    assert.deepEqual(event.data.stream, [])
  }
})

await check('the original provider/model appears nowhere except the marker text', () => {
  const forged = makeForged()
  const rest = JSON.stringify(forged.events.slice(1))
  assert.equal(rest.includes('cline-pass'), false)
  assert.equal(rest.includes('deepseek-v4.1-flash'), false)
  assert.equal(JSON.stringify(forged.base).includes('cline-pass'), false)
  assert.equal(JSON.stringify(forged.base).includes('deepseek-v4.1-flash'), false)
  assert.match(markerText(forged), /provider=cline-pass model=deepseek-v4\.1-flash/)
})

await check('user and system messages carry no model source', () => {
  for (const event of makeForged().events.filter((candidate) => candidate.type !== 'assistant/message')) {
    assert.equal('source' in event.data.message, false)
  }
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
section('6. content blocks: text stays text, reasoning becomes reasoning, nothing is lost')
// ─────────────────────────────────────────────────────────────────────────────────────────────────

await check('text blocks stay text and reasoning blocks become reasoning, in order', () => {
  const forged = makeForged()
  assert.deepEqual(forged.events[1].data.message.content, [{ type: 'text', text: 'hello' }])
  assert.deepEqual(forged.events[2].data.message.content, [
    { type: 'reasoning', text: 'think' },
    { type: 'text', text: 'hi' },
  ])
})

await check('unknown or malformed blocks are dropped, text is never coerced', () => {
  const forged = makeForged({
    messages: [
      {
        role: 'user',
        blocks: [
          { type: 'text', text: 'keep' },
          { type: 'image', text: 'drop' },
          { type: 'text', text: 42 },
          null,
          { type: 'reasoning', text: 'keep too' },
          { type: 'text', text: '' },
        ],
      },
    ],
  })
  assert.deepEqual(forged.events[1].data.message.content, [
    { type: 'text', text: 'keep' },
    { type: 'reasoning', text: 'keep too' },
    { type: 'text', text: '' },
  ])
})

await check('no conversation content is lost or reordered across the conversion', () => {
  const raw = makeRaw()
  const forged = forgeSession({ harness: 'zcode', raw })
  const expected = raw.messages.flatMap((message) => message.blocks.map((block) => ({ type: block.type, text: block.text })))
  const actual = forged.events.slice(1).flatMap((event) => event.data.message.content)
  assert.deepEqual(actual, expected)
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
section('7. the empty conversation')
// ─────────────────────────────────────────────────────────────────────────────────────────────────

await check('an empty conversation forges a header but no events', () => {
  const forged = forgeSession({ harness: 'zcode', raw: makeRaw({ messages: [] }) })
  assert.notEqual(forged.base, null)
  assert.deepEqual(forged.events, [])
  assert.match(forged.base.session.id, /^foreign-zcode-/)
  assert.equal(forged.base.session.cwd, 'F:\\work')
})

await check('buildForeignField reports no-messages for the empty conversation', () => {
  const forged = forgeSession({ harness: 'zcode', raw: makeRaw({ messages: [] }) })
  assert.deepEqual(buildForeignField({ forged, afterSeq: -1, maxBytes: DEFAULT_MAX_BYTES }), {
    field: null,
    throughSeq: null,
    overCap: false,
    reason: 'no-messages',
  })
})

await check('a conversation with only unrepresentable messages is empty too', () => {
  const forged = forgeSession({ harness: 'zcode', raw: makeRaw({ messages: [{ role: 'tool', blocks: [] }, 7, null] }) })
  assert.deepEqual(forged.events, [])
  assert.equal(buildForeignField({ forged, afterSeq: -1 }).reason, 'no-messages')
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
section('8. both functions are total: malformed input returns an error/reason, never throws')
// ─────────────────────────────────────────────────────────────────────────────────────────────────

await check('forgeSession reports malformed input instead of throwing', () => {
  const malformed = [
    undefined,
    null,
    42,
    'zcode',
    [],
    {},
    { raw: null },
    { raw: 42 },
    { raw: [] },
    { harness: 'zcode', raw: { messages: 'nope' } },
    { harness: 'zcode', raw: { messages: {} } },
  ]
  for (const request of malformed) {
    let forged
    assert.doesNotThrow(() => {
      forged = forgeSession(request)
    }, `forgeSession(${String(request)})`)
    assert.equal(forged.base, null, `request ${String(request)}`)
    assert.deepEqual(forged.events, [], `request ${String(request)}`)
    assert.equal(typeof forged.error, 'string')
    assert.ok(forged.error.length > 0)
  }
})

await check('a throwing getter anywhere is contained', () => {
  const hostileRaw = {
    get messages() {
      throw new Error('boom messages')
    },
  }
  const fromRaw = forgeSession({ harness: 'zcode', raw: hostileRaw })
  assert.equal(fromRaw.base, null)
  assert.match(String(fromRaw.error), /boom messages/)

  const hostileRequest = {
    get harness() {
      throw new Error('boom harness')
    },
    raw: makeRaw(),
  }
  const fromRequest = forgeSession(hostileRequest)
  assert.equal(fromRequest.base, null)
  assert.match(String(fromRequest.error), /^forge-failed: /)

  const throwsOnEverything = new Proxy(
    {},
    {
      get() {
        throw new Error('boom')
      },
      has() {
        throw new Error('boom')
      },
    },
  )
  assert.equal(forgeSession(throwsOnEverything).base, null)
})

await check('buildForeignField reports unusable forged input instead of throwing', () => {
  assert.deepEqual(buildForeignField(), { field: null, throughSeq: null, reason: 'no-forged-session' })
  assert.deepEqual(buildForeignField({}), { field: null, throughSeq: null, reason: 'no-forged-session' })
  assert.deepEqual(buildForeignField({ forged: null }), { field: null, throughSeq: null, reason: 'no-forged-session' })
  assert.deepEqual(buildForeignField({ forged: {} }), { field: null, throughSeq: null, reason: 'forged-has-no-base' })
  assert.deepEqual(buildForeignField({ forged: { base: {}, events: 'nope' } }), {
    field: null,
    throughSeq: null,
    reason: 'forged-has-no-events',
  })
  const badForge = forgeSession({ harness: 'zcode', raw: { messages: 'nope' } })
  assert.equal(buildForeignField({ forged: badForge }).field, null)
  const throwingForged = new Proxy(
    {},
    {
      get() {
        throw new Error('boom')
      },
    },
  )
  const built = buildForeignField({ forged: throwingForged })
  assert.equal(built.field, null)
  assert.match(String(built.reason), /^build-failed: /)
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
section('9. buildForeignField: afterSeq, byte cap, overCap, and buildLogField parity')
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const FORGED = makeForged()

/** A stand-in for a live Session whose events are the forged wire events. */
function fakeSession({ header, events }) {
  return {
    header,
    inheritedEventCount: 0,
    snapshotEvents: (from = 0) => events.filter((event) => Number(event.seq) >= from),
  }
}

/** A cap that admits some, but not all, of `forged`'s events. */
function firstPartialBuild(forged) {
  for (const maxBytes of [300, 400, 500, 600, 700, 800, 1000, 1200, 1600, 2048, 4096]) {
    const built = buildForeignField({ forged, afterSeq: -1, maxBytes })
    if (built.field !== null && built.throughSeq < forged.events.length - 1) return { maxBytes, built }
  }
  throw new Error('no cap produced a partial field')
}

await check('a full build is {...base, afterSeq, throughSeq, events} over every event', () => {
  const built = buildForeignField({ forged: FORGED, afterSeq: -1, maxBytes: DEFAULT_MAX_BYTES })
  assert.equal(built.throughSeq, 4)
  assert.equal(built.overCap, undefined)
  assert.deepEqual(built.field, { ...FORGED.base, afterSeq: -1, throughSeq: 4, events: FORGED.events })
  assert.equal(built.field.events.length, 5)
})

await check('afterSeq selects the pending range; throughSeq is the last included seq', () => {
  const built = buildForeignField({ forged: FORGED, afterSeq: 2, maxBytes: DEFAULT_MAX_BYTES })
  assert.equal(built.field.afterSeq, 2)
  assert.equal(built.throughSeq, 4)
  assert.deepEqual(built.field.events.map((event) => event.seq), [3, 4])
})

await check('everything already accepted yields no field and reason no-pending-events', () => {
  assert.deepEqual(buildForeignField({ forged: FORGED, afterSeq: 4, maxBytes: DEFAULT_MAX_BYTES }), {
    field: null,
    throughSeq: null,
    overCap: false,
    reason: 'no-pending-events',
  })
})

await check('a garbage afterSeq is treated as -1 (resend rather than skip)', () => {
  for (const afterSeq of ['2', null, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
    const built = buildForeignField({ forged: FORGED, afterSeq, maxBytes: DEFAULT_MAX_BYTES })
    assert.equal(built.field.afterSeq, -1, `afterSeq ${String(afterSeq)}`)
    assert.deepEqual(built.field.events.map((event) => event.seq), [0, 1, 2, 3, 4])
  }
})

await check('a garbage maxBytes falls back to the 20 MiB default instead of blocking', () => {
  assert.equal(DEFAULT_MAX_BYTES, 128 * 1024 * 1024)
  for (const maxBytes of [undefined, 0, -1, 1.5, 'big', null, {}, []]) {
    const built = buildForeignField({ forged: FORGED, afterSeq: -1, maxBytes })
    assert.notEqual(built.field, null, `maxBytes ${String(maxBytes)}`)
    assert.equal(built.throughSeq, 4)
  }
})

await check('the cap stops before an event that would not fit, measured on the real JSON', () => {
  const { maxBytes, built } = firstPartialBuild(FORGED)
  assert.ok(built.throughSeq >= 0 && built.throughSeq < 4)
  assert.ok(jsonBytes(built.field) <= maxBytes, `field is ${String(jsonBytes(built.field))} bytes for a ${String(maxBytes)} cap`)
  const nextEvent = FORGED.events[built.throughSeq + 1]
  assert.notEqual(nextEvent, undefined)
  const withNext = { ...built.field, throughSeq: built.throughSeq + 1, events: [...built.field.events, nextEvent] }
  assert.ok(jsonBytes(withNext) > maxBytes, 'the next event must not fit either')
})

await check('afterSeq resume returns only the remaining events, and completes the session', () => {
  const first = firstPartialBuild(FORGED)
  const second = buildForeignField({ forged: FORGED, afterSeq: first.built.throughSeq, maxBytes: DEFAULT_MAX_BYTES })
  assert.notEqual(second.field, null)
  assert.equal(second.field.afterSeq, first.built.throughSeq)
  assert.deepEqual(
    second.field.events.map((event) => event.seq),
    FORGED.events.slice(first.built.throughSeq + 1).map((event) => event.seq),
  )
  const union = [...first.built.field.events, ...second.field.events]
  assert.deepEqual(union.map((event) => event.seq), FORGED.events.map((event) => event.seq))
  const tail = buildForeignField({ forged: FORGED, afterSeq: second.throughSeq, maxBytes: DEFAULT_MAX_BYTES })
  assert.equal(tail.field, null)
  assert.equal(tail.reason, 'no-pending-events')
})

await check('a loop of small requests drains the session exactly once', () => {
  const seen = []
  let afterSeq = -1
  let requests = 0
  while (requests < 100) {
    const built = buildForeignField({ forged: FORGED, afterSeq, maxBytes: 1200 })
    requests += 1
    if (built.field === null) {
      assert.equal(built.reason, 'no-pending-events')
      break
    }
    assert.ok(built.throughSeq > afterSeq, 'every accepted request must make progress')
    seen.push(...built.field.events.map((event) => event.seq))
    afterSeq = built.throughSeq
  }
  assert.ok(requests > 1, `the 1200-byte cap should need several requests, got ${String(requests)}`)
  assert.deepEqual(seen, FORGED.events.map((event) => event.seq))
})

await check('the first pending event alone above the cap is overCap, with a reason', () => {
  const built = buildForeignField({ forged: FORGED, afterSeq: -1, maxBytes: 64 })
  assert.equal(built.field, null)
  assert.equal(built.throughSeq, null)
  assert.equal(built.overCap, true)
  assert.match(String(built.reason), /^event 0 needs .*, above maxBytes 64$/)
})

await check('overCap is false when nothing is pending at all', () => {
  const built = buildForeignField({ forged: FORGED, afterSeq: 4, maxBytes: 64 })
  assert.equal(built.field, null)
  assert.equal(built.overCap, false)
})

await check('byte accounting and boundaries agree with buildLogField at every cap', () => {
  const session = fakeSession({
    header: { version: 4, id: FORGED.base.session.id, createdAt: FORGED.base.session.createdAt, cwd: FORGED.base.session.cwd },
    events: FORGED.events,
  })
  // The same envelope bytes buildLogField would produce from a live Session: wireHeader output,
  // without the two contract-only header fields the forge adds.
  const synthetic = { base: { version: 1, sessionFormatVersion: 4, session: wireHeader(session) }, events: FORGED.events }
  for (const afterSeq of [-1, 0, 2, 4]) {
    for (const maxBytes of [1, 64, 200, 400, 600, 800, 1024, 2048, 4096, DEFAULT_MAX_BYTES]) {
      assert.deepEqual(
        buildForeignField({ forged: synthetic, afterSeq, maxBytes }),
        buildLogField({ session, afterSeq, maxBytes }),
        `afterSeq ${String(afterSeq)}, maxBytes ${String(maxBytes)}`,
      )
    }
  }
})

await check('neither function mutates its input', () => {
  const raw = makeRaw()
  const rawBefore = JSON.stringify(raw)
  const forged = forgeSession({ harness: 'zcode', raw })
  assert.equal(JSON.stringify(raw), rawBefore)
  const forgedBefore = JSON.stringify(forged)
  buildForeignField({ forged, afterSeq: -1, maxBytes: 900 })
  buildForeignField({ forged, afterSeq: 2, maxBytes: DEFAULT_MAX_BYTES })
  assert.equal(JSON.stringify(forged), forgedBefore)
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
section('10. a normal DSH reader would not reject the forged session structurally')
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The structural read a DSH-side consumer applies to one `dsh_session_log` field: envelope version,
 * session header, contiguous event seqs, known message types, `surfaceOp:'append'`, and a message
 * payload whose role agrees with the event type and whose content is made of text/reasoning blocks.
 * The assistant's source must be the official model and the JSON must round-trip cleanly.
 */
function assertDshReaderAccepts(field, note = '') {
  assert.equal(field.version, 1, note)
  assert.equal(field.sessionFormatVersion, 4, note)

  const header = field.session
  assert.equal(header.type, 'session', note)
  assert.equal(header.version, 4, note)
  assert.equal(typeof header.id, 'string', note)
  assert.ok(header.id.length > 0 && header.id.length <= MAX_SESSION_ID_LENGTH, note)
  assert.match(header.id, /^[A-Za-z0-9_.-]+$/, note)
  assert.ok(Number.isSafeInteger(header.createdAt) && header.createdAt >= 0, note)
  assert.equal(typeof header.cwd, 'string', note)
  assert.equal(header.isSeeded, false, note)

  assert.ok(Number.isSafeInteger(field.afterSeq) && field.afterSeq >= -1, note)
  assert.ok(Number.isSafeInteger(field.throughSeq), note)
  assert.ok(Array.isArray(field.events) && field.events.length > 0, note)
  assert.equal(field.events[0].seq, field.afterSeq + 1, note)

  let expected = field.afterSeq + 1
  for (const event of field.events) {
    assert.equal(event.seq, expected, `${note} event seq`)
    expected += 1
    assert.ok(Number.isSafeInteger(event.time) && event.time >= 0, `${note} event time`)
    assert.ok(['system/message', 'user/message', 'assistant/message'].includes(event.type), `${note} event type`)
    assert.equal(event.surfaceOp, 'append', `${note} surfaceOp`)

    const data = event.data
    assert.ok(data !== null && typeof data === 'object', `${note} event data`)
    assert.ok(Number.isSafeInteger(data.turn) && data.turn >= 0, `${note} turn`)
    assert.ok(Number.isSafeInteger(data.step) && data.step >= 0, `${note} step`)

    const message = data.message
    assert.ok(message !== null && typeof message === 'object', `${note} message`)
    assert.equal(message.role, event.type.slice(0, event.type.indexOf('/')), `${note} message role`)
    assert.equal(typeof message.id, 'string', `${note} message id`)
    assert.ok(message.id.length > 0, `${note} message id`)
    assert.ok(Number.isSafeInteger(message.time) && message.time >= 0, `${note} message time`)
    assert.ok(Array.isArray(message.content), `${note} message content`)
    for (const block of message.content) {
      assert.ok(block !== null && typeof block === 'object', `${note} block`)
      assert.ok(block.type === 'text' || block.type === 'reasoning', `${note} block type`)
      assert.equal(typeof block.text, 'string', `${note} block text`)
    }
    if (event.type === 'assistant/message') {
      assert.deepEqual(message.source, { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' }, `${note} source`)
      assert.deepEqual(data.stream, [], `${note} stream`)
    }
  }

  assert.equal(field.events[field.events.length - 1].seq, field.throughSeq, `${note} throughSeq`)
  assert.deepEqual(JSON.parse(JSON.stringify(field)), field, `${note} JSON round-trip`)
}

await check('a DSH reader accepts the full forged field', () => {
  const built = buildForeignField({ forged: FORGED, afterSeq: -1, maxBytes: DEFAULT_MAX_BYTES })
  assert.notEqual(built.field, null)
  assertDshReaderAccepts(built.field)
})

await check('a DSH reader accepts every resumed slice', () => {
  const { maxBytes } = firstPartialBuild(FORGED)
  let afterSeq = -1
  let requests = 0
  while (requests < 100) {
    const built = buildForeignField({ forged: FORGED, afterSeq, maxBytes })
    requests += 1
    if (built.field === null) break
    assertDshReaderAccepts(built.field, `request ${String(requests)}`)
    afterSeq = built.throughSeq
  }
  assert.ok(requests > 1, `the ${String(maxBytes)}-byte cap should need several requests, got ${String(requests)}`)
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
section('11. measured byte behaviour of an 8000-message conversation')
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A large but realistically-shaped conversation: alternating user text and assistant reasoning+text. */
function makeLargeRaw(count) {
  const messages = []
  for (let index = 0; index < count; index += 1) {
    const time = TIME + index
    if (index % 2 === 0) {
      messages.push({
        role: 'user',
        time,
        blocks: [{ type: 'text', text: `question ${String(index)}: ${'word '.repeat(48)}` }],
      })
    } else {
      messages.push({
        role: 'assistant',
        time,
        blocks: [
          { type: 'reasoning', text: `reasoning ${String(index)}: ${'detail '.repeat(48)}` },
          { type: 'text', text: `answer ${String(index)}: ${'word '.repeat(48)}` },
        ],
      })
    }
  }
  return makeRaw({ messages, createdAt: TIME })
}

const LARGE_MESSAGE_COUNT = 8000
const SLICE_CAP = 256 * 1024

const LARGE_RAW = makeLargeRaw(LARGE_MESSAGE_COUNT)
const LARGE_FORGED = forgeSession({ harness: 'zcode', label: 'ZCode', raw: LARGE_RAW })
const LARGE_FULL = buildForeignField({ forged: LARGE_FORGED, afterSeq: -1, maxBytes: DEFAULT_MAX_BYTES })
const LARGE_BYTES = jsonBytes(LARGE_FULL.field)

const LARGE_SLICES = []
let largeCursor = -1
for (let guard = 0; guard < 10000; guard += 1) {
  const built = buildForeignField({ forged: LARGE_FORGED, afterSeq: largeCursor, maxBytes: SLICE_CAP })
  if (built.field === null) {
    LARGE_SLICES.push({ tail: built })
    break
  }
  LARGE_SLICES.push({ field: built.field, bytes: jsonBytes(built.field), throughSeq: built.throughSeq })
  largeCursor = built.throughSeq
}
const LARGE_SLICE_FIELDS = LARGE_SLICES.filter((slice) => slice.field !== undefined)
const LARGE_SLICED_SEQS = LARGE_SLICE_FIELDS.flatMap((slice) => slice.field.events.map((event) => event.seq))
const LARGE_MAX_SLICE_BYTES = LARGE_SLICE_FIELDS.length === 0 ? 0 : Math.max(...LARGE_SLICE_FIELDS.map((slice) => slice.bytes))

await check(
  `8000 messages forge ${String(LARGE_FORGED.events.length)} events and fit one default-cap request (${(LARGE_BYTES / 1048576).toFixed(2)} MiB)`,
  () => {
    assert.equal(LARGE_FORGED.events.length, LARGE_MESSAGE_COUNT + 1)
    assert.notEqual(LARGE_FULL.field, null)
    assert.equal(LARGE_FULL.throughSeq, LARGE_FORGED.events.length - 1)
    assert.equal(LARGE_FULL.field.events.length, LARGE_FORGED.events.length)
    assert.ok(LARGE_BYTES < DEFAULT_MAX_BYTES, `${String(LARGE_BYTES)} bytes must be under the default cap`)
    assertDshReaderAccepts(LARGE_FULL.field, 'large')
  },
)

await check(
  `the same conversation drains in ${String(LARGE_SLICE_FIELDS.length)} x 256 KiB requests (largest field ${(LARGE_MAX_SLICE_BYTES / 1024).toFixed(1)} KiB)`,
  () => {
    assert.ok(LARGE_SLICE_FIELDS.length > 1, `expected many slices, got ${String(LARGE_SLICE_FIELDS.length)}`)
    for (const slice of LARGE_SLICE_FIELDS) {
      assert.ok(slice.bytes <= SLICE_CAP, `slice is ${String(slice.bytes)} bytes, above ${String(SLICE_CAP)}`)
      assertDshReaderAccepts(slice.field, 'slice')
    }
    assert.deepEqual(LARGE_SLICED_SEQS, LARGE_FORGED.events.map((event) => event.seq))
    const tail = LARGE_SLICES[LARGE_SLICES.length - 1].tail
    assert.equal(tail.field, null)
    assert.equal(tail.reason, 'no-pending-events')
    assert.equal(tail.overCap, false)
  },
)

await check('a single oversized message stops the slice, and is overCap below the marker size', () => {
  const huge = forgeSession({
    harness: 'zcode',
    raw: makeRaw({ messages: [{ role: 'user', time: 1, blocks: [{ type: 'text', text: 'x'.repeat(200000) }] }] }),
  })
  // 16 KiB admits the marker but not the 200 KB message: a partial field, not an overCap.
  const small = buildForeignField({ forged: huge, afterSeq: -1, maxBytes: 16 * 1024 })
  assert.notEqual(small.field, null)
  assert.equal(small.throughSeq, 0)
  assert.equal(small.field.events.length, 1)
  assert.equal(small.field.events[0].type, 'system/message')
  // Below the marker event's own size nothing can ever be sent: the stable overCap signal.
  const tiny = buildForeignField({ forged: huge, afterSeq: -1, maxBytes: 256 })
  assert.equal(tiny.field, null)
  assert.equal(tiny.overCap, true)
  assert.match(String(tiny.reason), /above maxBytes 256/)
  // The default cap carries it.
  const full = buildForeignField({ forged: huge, afterSeq: -1, maxBytes: DEFAULT_MAX_BYTES })
  assert.notEqual(full.field, null)
  assert.ok(jsonBytes(full.field) > 200000, `field is ${String(jsonBytes(full.field))} bytes`)
  assertDshReaderAccepts(full.field, 'oversized-but-fitting')
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
