/**
 * Payload-fidelity verification by differential execution.
 *
 * `host/logfield.js` claims to reproduce the shipped `dsh_session_log` field exactly.
 * Rather than eyeballing the two sources, this script extracts the shipped functions
 * **from inside app.asar** (`wireHeader`, `wireEvent`, `wireSurfaceOp`, `jsonBytes`)
 * and the shipped envelope/byte-accounting block verbatim, evaluates them, and runs
 * both implementations over the same inputs, comparing `JSON.stringify` output — which
 * also pins key ORDER, not just key sets.
 *
 * Usage: node verify/fidelity.mjs
 */

import assert from 'node:assert/strict'
import { readAsarText } from './asar-extract.mjs'
import { buildLogField, wireEvent, wireHeader, wireSurfaceOp } from '../host/logfield.js'

const SHIPPED_LOG = 'dsh/node_modules/@deepseek-ai/dsh-session-log-deepseek/lib/index.js'
const SHIPPED_SESSION = 'dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js'

const shippedLog = readAsarText(SHIPPED_LOG)
const shippedSession = readAsarText(SHIPPED_SESSION)

/** Slice [startAnchor, endAnchor) out of a text, failing loudly when an anchor moves. */
function slice(text, startAnchor, endAnchor, what) {
  const start = text.indexOf(startAnchor)
  assert.notEqual(start, -1, `${what}: start anchor not found: ${JSON.stringify(startAnchor)}`)
  const end = text.indexOf(endAnchor, start)
  assert.notEqual(end, -1, `${what}: end anchor not found: ${JSON.stringify(endAnchor)}`)
  return text.slice(start, end)
}

// ── 1. the shipped event-type vocabulary, verbatim from @deepseek-ai/dsh-session ────────────────
const shippedKnownTypes = slice(
  shippedSession,
  'const KNOWN_SESSION_EVENT_TYPES = new Set([',
  ']);',
  'KNOWN_SESSION_EVENT_TYPES',
).concat(']);')

const shippedKnownList = [...shippedKnownTypes.matchAll(/"([^"]+)"/g)].map((m) => m[1])

// The bundle inlines the same set. Read it out of host/logfield.js as text (the module does not
// export it) and compare element-for-element.
const bundleSource = await import('node:fs').then((fs) => fs.readFileSync('host/logfield.js', 'utf8'))
const bundleKnownTypes = slice(
  bundleSource,
  'const KNOWN_SESSION_EVENT_TYPES = new Set([',
  '])',
  'bundle KNOWN_SESSION_EVENT_TYPES',
).concat('])')
const bundleKnownList = [...bundleKnownTypes.matchAll(/'([^']+)'/g)].map((m) => m[1])

let failures = 0
const check = (title, fn) => {
  try {
    fn()
    console.log(`  ok    ${title}`)
  } catch (error) {
    failures++
    console.log(`  FAIL  ${title}\n        ${error.message}`)
  }
}

console.log(`shipped vocabulary: ${shippedKnownList.length} types`)
console.log(`bundle  vocabulary: ${bundleKnownList.length} types`)

check('KNOWN_SESSION_EVENT_TYPES is identical to the shipped set, in order', () => {
  assert.deepEqual(bundleKnownList, shippedKnownList)
})

// ── 2. build the shipped reference implementation from extracted source ─────────────────────────
const shippedFunctions = slice(
  shippedLog,
  'function wireHeader(session) {',
  '/**\n* Highest confirmed sequence',
  'shipped wire* + jsonBytes',
)

const shippedPrepare = slice(
  shippedLog,
  'const pending = session.snapshotEvents(SessionLogOffset(afterSeq + 1));',
  '\n\t\t} });',
  'shipped prepare body',
)

// `SessionLogOffset` validates then brands; dsh-brand's brandNumber is the identity, so a shim
// that validates the same way is exact (dsh-session/lib/index.js:30-33).
const reference = `
${shippedKnownTypes}
${shippedFunctions}
const blockedWarnings = new WeakMap();
function SessionLogOffset(value) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw new TypeError('SessionLogOffset must be a non-negative safe integer, got ' + String(value));
  return value;
}
export function shippedBuild(session, afterSeq, maxBytes, ctx) {
${shippedPrepare}
}
export { wireHeader as shippedWireHeader, wireEvent as shippedWireEvent, wireSurfaceOp as shippedWireSurfaceOp };
`
const moduleUrl = `data:text/javascript;base64,${Buffer.from(reference).toString('base64')}`
const shipped = await import(moduleUrl)
void shippedBuildSanity(shipped)
function shippedBuildSanity(mod) {
  assert.equal(typeof mod.shippedBuild, 'function')
}

// ── 3. a fake Session with the real method contract ─────────────────────────────────────────────
function makeSession({ header, events, inheritedEventCount = 0, id = 'session-1' }) {
  return {
    header,
    inheritedEventCount,
    id,
    get seq() {
      return events.length
    },
    eventAt(index) {
      return events[index]
    },
    snapshotEvents(fromSeq = 0, toSeqExclusive = events.length) {
      return Object.freeze(events.slice(fromSeq, toSeqExclusive))
    },
    appended: [],
    append(type, data) {
      this.appended.push({ type, data })
    },
  }
}

function baseHeader(extra = {}) {
  return { version: 4, id: 'session-1', createdAt: 1730000000000, isSeeded: false, ...extra }
}

const noopCtx = { logger: { warn() {} } }

/** Run both implementations on one input and compare the serialized result. */
function compare(label, { session, afterSeq, maxBytes }) {
  const shippedResult = shipped.shippedBuild(session, afterSeq, maxBytes, noopCtx)
  const shippedField = shippedResult === undefined ? null : shippedResult.value
  const shippedThrough = shippedField === null ? null : shippedField.throughSeq
  const built = buildLogField({ session, afterSeq, maxBytes })
  const bundleText = JSON.stringify(built.field)
  const shippedText = JSON.stringify(shippedField)
  if (bundleText !== shippedText) {
    throw new Error(
      `${label}: field differs\n        shipped: ${shippedText}\n        bundle : ${bundleText}`,
    )
  }
  if (built.throughSeq !== shippedThrough) {
    throw new Error(`${label}: throughSeq ${String(built.throughSeq)} vs shipped ${String(shippedThrough)}`)
  }
}

// ── 4. fixed cases: header variants ────────────────────────────────────────────────────────────
const userEvent = (seq, extra = {}) => ({
  type: 'user/message',
  seq,
  time: 1000 + seq,
  data: { text: `message ${seq}` },
  surfaceOp: 'append',
  ...extra,
})

check('minimal user message: envelope and field are byte-identical to the shipped output', () => {
  compare('minimal', {
    session: makeSession({ header: baseHeader(), events: [userEvent(0)] }),
    afterSeq: -1,
    maxBytes: 8388608,
  })
})

check('every optional header field, present and absent, matches', () => {
  const variants = [
    baseHeader(),
    baseHeader({ cwd: 'F:\\work' }),
    baseHeader({ parentSession: 'parent-9' }),
    baseHeader({ isSeeded: true }),
    baseHeader({ origin: 'subagent' }),
    baseHeader({ delegationDepth: 2 }),
    baseHeader({ agentPreset: 'verifier' }),
    baseHeader({
      cwd: '',
      parentSession: '',
      isSeeded: true,
      origin: 'subagent',
      delegationDepth: 0,
      agentPreset: '',
    }),
  ]
  variants.forEach((header, index) => {
    compare(`header variant ${index}`, {
      session: makeSession({ header, events: [userEvent(0)], inheritedEventCount: 7 }),
      afterSeq: -1,
      maxBytes: 8388608,
    })
  })
})

// ── 5. fixed cases: per-event translation ──────────────────────────────────────────────────────
const cases = {
  'assistant/message with append': {
    type: 'assistant/message',
    seq: 3,
    time: 12,
    data: { text: 'hi' },
    surfaceOp: 'append',
  },
  'assistant/message with replace': {
    type: 'assistant/message',
    seq: 3,
    time: 12,
    data: { text: 'hi' },
    surfaceOp: { startSeq: 1, endSeq: 2 },
  },
  'assistant/message ignores sourceEventSeqs': {
    type: 'assistant/message',
    seq: 3,
    time: 12,
    data: {},
    surfaceOp: 'append',
    sourceEventSeqs: [1, 2],
  },
  'system/message with sourceEventSeqs': {
    type: 'system/message',
    seq: 4,
    time: 13,
    data: { text: 'sys' },
    surfaceOp: 'append',
    sourceEventSeqs: [1, 2],
  },
  'tool/result with replace surfaceOp': {
    type: 'tool/result',
    seq: 5,
    time: 14,
    data: { ok: true },
    surfaceOp: { startSeq: 10, endSeq: 11 },
    sourceEventSeqs: [7],
  },
  'developer/message': { type: 'developer/message', seq: 6, time: 15, data: { text: 'd' }, surfaceOp: 'append' },
  'ignorable known type': { type: 'turn/start', seq: 7, time: 16, data: {}, ignorable: true },
  'ignorable unknown type with surfaceOp': {
    type: 'vendor-x/thing',
    seq: 8,
    time: 17,
    data: { a: 1 },
    ignorable: true,
    surfaceOp: { startSeq: 1, endSeq: 2 },
    sourceEventSeqs: [1],
  },
  'ignorable unknown type without extras': { type: 'vendor-x/other', seq: 9, time: 18, data: {}, ignorable: true },
  'unknown non-ignorable type': { type: 'vendor-x/plain', seq: 10, time: 19, data: {} },
  'numeric-string seq and data verbatim': {
    type: 'user/message',
    seq: 11,
    time: 20,
    data: { nested: { deep: [1, 2, { three: 3 }] }, unicode: '会话日志 · ünïcødé' },
    surfaceOp: 'append',
  },
}

check('every fixed per-event case translates identically (including replace surfaceOp)', () => {
  for (const [name, event] of Object.entries(cases)) {
    compare(name, {
      session: makeSession({ header: baseHeader(), events: [event] }),
      afterSeq: -1,
      maxBytes: 8388608,
    })
  }
})

check('wireEvent / wireHeader / wireSurfaceOp agree event-by-event with the shipped functions', () => {
  for (const [name, event] of Object.entries(cases)) {
    assert.equal(
      JSON.stringify(wireEvent(event)),
      JSON.stringify(shipped.shippedWireEvent(event)),
      `${name}: wireEvent diverged`,
    )
  }
  for (const header of [baseHeader(), baseHeader({ cwd: '/x', isSeeded: true, delegationDepth: 3 })]) {
    const session = makeSession({ header, events: [], inheritedEventCount: 5 })
    assert.equal(JSON.stringify(wireHeader(session)), JSON.stringify(shipped.shippedWireHeader(session)))
  }
  for (const op of ['append', { startSeq: '1', endSeq: 2 }, { startSeq: 3, endSeq: '4' }]) {
    assert.equal(JSON.stringify(wireSurfaceOp(op)), JSON.stringify(shipped.shippedWireSurfaceOp(op)))
  }
})

// ── 6. range selection, byte accounting, maxBytes boundaries ────────────────────────────────────
check('pending-range selection and throughSeq match, seq by seq', () => {
  const events = Array.from({ length: 12 }, (_, index) => userEvent(index))
  for (let afterSeq = -1; afterSeq < 12; afterSeq++) {
    compare(`afterSeq=${afterSeq}`, {
      session: makeSession({ header: baseHeader(), events }),
      afterSeq,
      maxBytes: 8388608,
    })
  }
})

check('an empty pending range yields no field in both implementations', () => {
  compare('empty', {
    session: makeSession({ header: baseHeader(), events: [userEvent(0)] }),
    afterSeq: 0,
    maxBytes: 8388608,
  })
})

check('maxBytes boundary behaves identically across the whole admissible range', () => {
  const events = [
    userEvent(0),
    { type: 'assistant/message', seq: 1, time: 2, data: { text: 'x'.repeat(40) }, surfaceOp: 'append' },
    userEvent(2),
  ]
  // Find the exact byte size the shipped implementation needs for each prefix, then sweep every
  // limit from 0 to that size + 3.
  const session = makeSession({ header: baseHeader(), events })
  const full = shipped.shippedBuild(session, -1, 8388608, noopCtx).value
  const total = Buffer.byteLength(JSON.stringify(full))
  for (let limit = 1; limit <= total + 3; limit++) {
    compare(`maxBytes=${limit}`, { session, afterSeq: -1, maxBytes: limit })
  }
})

check('a huge maxBytes default and a 1-byte cap agree', () => {
  const events = [userEvent(0), userEvent(1)]
  compare('huge', { session: makeSession({ header: baseHeader(), events }), afterSeq: -1, maxBytes: 2 ** 31 })
  compare('one byte', { session: makeSession({ header: baseHeader(), events }), afterSeq: -1, maxBytes: 1 })
})

// ── 7. randomized differential fuzz ─────────────────────────────────────────────────────────────
function randomEvent(random) {
  const types = [
    'user/message',
    'system/message',
    'developer/message',
    'tool/result',
    'assistant/message',
    'turn/start',
    'turn/end',
    'vendor-x/unknown',
    'tool/call',
    'plugin/whatever',
  ]
  const type = types[Math.floor(random() * types.length)]
  const seq = Math.floor(random() * 200)
  const surface = type === 'assistant/message' || ['user/message', 'system/message', 'developer/message', 'tool/result'].includes(type)
  const event = {
    type,
    seq,
    time: Math.floor(random() * 1e12),
    data: random() < 0.3 ? { text: 'x'.repeat(Math.floor(random() * 50)) } : { n: seq, nested: { list: [seq, seq + 1] } },
  }
  if (surface) event.surfaceOp = random() < 0.5 ? 'append' : { startSeq: seq - 1, endSeq: seq }
  if (random() < 0.25) event.ignorable = true
  if (random() < 0.25) event.sourceEventSeqs = [seq - 1, seq]
  return event
}

check('2000 randomized events/sessions produce identical fields', () => {
  let state = 123456789
  const random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
  for (let round = 0; round < 2000; round++) {
    const count = Math.floor(random() * 6)
    const events = []
    for (let index = 0; index < count; index++) events.push(randomEvent(random))
    events.sort((left, right) => left.seq - right.seq)
    events.forEach((event, index) => {
      event.seq = index
      if (typeof event.surfaceOp === 'object' && event.surfaceOp !== null) {
        event.surfaceOp.startSeq = Math.max(0, index - 1)
        event.surfaceOp.endSeq = index
      }
      if (Array.isArray(event.sourceEventSeqs)) event.sourceEventSeqs = event.sourceEventSeqs.map((value) => Math.abs(value % (index + 1)))
    })
    const header = baseHeader(
      random() < 0.5
        ? {}
        : {
            ...(random() < 0.5 ? { cwd: 'C:\\w' } : {}),
            ...(random() < 0.5 ? { parentSession: 'p' } : {}),
            ...(random() < 0.5 ? { isSeeded: true } : {}),
            ...(random() < 0.5 ? { origin: 'subagent' } : {}),
            ...(random() < 0.5 ? { delegationDepth: 1 } : {}),
            ...(random() < 0.5 ? { agentPreset: 'preset' } : {}),
          },
    )
    const session = makeSession({ header, events, inheritedEventCount: 3 })
    const afterSeq = Math.floor(random() * (count + 1)) - 1
    const maxBytes = random() < 0.5 ? 8388608 : Math.floor(random() * 1200) + 1
    compare(`fuzz round ${round}`, { session, afterSeq, maxBytes })
  }
})

console.log(failures === 0 ? '\nPASS: host/logfield.js is field-for-field identical to the shipped uploader' : `\nFAIL: ${failures} check(s)`)
process.exitCode = failures === 0 ? 0 : 1
