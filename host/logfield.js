/**
 * Version-1 `dsh_session_log` field construction.
 *
 * The envelope and per-event translation are copied **verbatim** from the shipped uploader
 * (`@deepseek-ai/dsh-session-log-deepseek/lib/index.js:26-99` and `:150-198`, as cited by
 * `docs/api-dossier.md` §2.3/§2.4) so the receiver — DeepSeek's own parser — sees exactly the
 * shipped shape. No field name is invented here.
 *
 * Differences from the shipped module, and why:
 *   - the acceptance watermark is folded from **our own store** instead of
 *     `session-log-deepseek/delivery-accepted` events, because a plugin may not append Session
 *     events (`docs/api-dossier.md` §3.4). The caller supplies `afterSeq`.
 *   - `KNOWN_SESSION_EVENT_TYPES` is inlined below (see the note on that constant), because the
 *     package that exports it cannot be imported from a profile-installed bundle.
 *   - the shipped warning-on-blocked-event path becomes a machine-readable `reason`, since this
 *     module is not a logger.
 *
 * Pure except for reading the live Session object it is handed; never throws.
 */

import { Buffer } from 'node:buffer'

import { DEFAULT_MAX_BYTES } from './config.js'

/**
 * Copy of the `KNOWN_SESSION_EVENT_TYPES` Set from `@deepseek-ai/dsh-session/lib/index.js:79-142`
 * (Harness `0.2.2-rc.1`). The set only distinguishes two `wireEvent` branches for an event that is
 * **both** unknown to this build and carries `ignorable: true`, which is the marker for
 * out-of-repo plugin records. A future build that adds a type would push such an event into the
 * `ignorable` copy branch, which preserves `surfaceOp`/`sourceEventSeqs` instead of dropping them —
 * a strictly more faithful copy for a record this build cannot classify.
 */
const KNOWN_SESSION_EVENT_TYPES = new Set([
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'assistant/attempt',
  'assistant/message',
  'command/done',
  'command/run',
  'compaction/end',
  'compaction/prune',
  'compaction/start',
  'compaction/summary',
  'deliverables/presented',
  'developer/message',
  'feedback/message-delete',
  'feedback/message-put',
  'feedback/record',
  'goal/change',
  'hook/invoked',
  'hook/result',
  'image/offload',
  'job/registered',
  'job/settled',
  'llm/retry',
  'llm/retry-started',
  'model/selection',
  'permission/preset',
  'plan/mode',
  'request/context',
  'request/header',
  'sandbox/mode',
  'schedule/change',
  'session-log-deepseek/delivery-accepted',
  'session/end-seed',
  'session/title',
  'session/title-llm-request',
  'step/end',
  'step/start',
  'subagent/catalog',
  'subagent/descriptor',
  'subagent/model-selection-policy',
  'system/message',
  'team/member',
  'team/message/delivered',
  'team/message/queued',
  // Added by DSH 0.2.2-rc.3; verify/fidelity.mjs compares this set to the shipped one in order.
  'team/mode',
  'team/task',
  'todo/write',
  'tool-workflow/agent-end',
  'tool-workflow/agent-start',
  'tool-workflow/run-end',
  'tool-workflow/run-start',
  'tool/call',
  'tool/ptc-dispatch',
  'tool/ptc-dispatch-start',
  'tool/result',
  'turn/end',
  'turn/start',
  'user/message',
  'web/deepseek-search-llm-request',
  'working-directory/change',
  'workspace/changes',
])

/** Translate logical Session metadata to raw external request fields. Copied verbatim. */
export function wireHeader(session) {
  const header = session.header
  return {
    version: header.version,
    id: String(header.id),
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSession === undefined ? {} : { parentSession: String(header.parentSession) }),
    ...(header.isSeeded ? { seedLength: Number(session.inheritedEventCount) } : {}),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }),
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
  }
}

/** Translate compile-time sequence brands to raw numeric request fields. Copied verbatim. */
export function wireEvent(event) {
  const common = {
    seq: Number(event.seq),
    time: event.time,
    data: event.data,
    ...(event.ignorable === undefined ? {} : { ignorable: event.ignorable }),
  }
  switch (event.type) {
    case 'developer/message':
    case 'system/message':
    case 'user/message':
    case 'tool/result':
      return {
        ...common,
        type: event.type,
        surfaceOp: wireSurfaceOp(event.surfaceOp),
        ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs.map(Number) }),
      }
    case 'assistant/message':
      return {
        ...common,
        type: event.type,
        surfaceOp: wireSurfaceOp(event.surfaceOp),
      }
    default:
      if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable === true) {
        const opaque = event
        return {
          ...common,
          type: event.type,
          ignorable: true,
          ...(opaque.surfaceOp === undefined ? {} : { surfaceOp: opaque.surfaceOp }),
          ...(opaque.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opaque.sourceEventSeqs }),
        }
      }
      return {
        ...common,
        type: event.type,
      }
  }
}

/** Copied verbatim: `"append"` stays the string, anything else becomes a numeric replacement. */
export function wireSurfaceOp(op) {
  return op === 'append'
    ? op
    : {
        op: 'replace',
        startSeq: Number(op.startSeq),
        endSeq: Number(op.endSeq),
      }
}

/**
 * UTF-8 length of one value's JSON text as the request body encodes it. Copied verbatim.
 * @returns `Infinity` when the value fails to serialize, which counts as exceeding every limit.
 */
export function jsonBytes(value) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    return Number.POSITIVE_INFINITY
  }
  return Buffer.byteLength(text)
}

/**
 * Build the version-1 `dsh_session_log` field for one pending range.
 *
 * @param request field inputs.
 * @param request.session the live Session object (`ctx.sessions.get(id)`); absence returns a reason.
 * @param request.afterSeq our stored watermark — the greatest `throughSeq` already accepted for this
 *   exact Session format generation, or `-1` before any accepted request.
 * @param request.maxBytes largest serialized field we may send.
 * @returns `{field, throughSeq, reason}`; `field` is `null` (and `throughSeq` `null`) whenever there
 *   is nothing sendable — no Session, no pending events, or a first pending event above `maxBytes`.
 *   `reason` is present only in that case.
 */
export function buildLogField(request) {
  const { session, afterSeq, maxBytes } = request === null || request === undefined ? {} : request
  try {
    if (session === null || session === undefined || typeof session !== 'object') {
      return { field: null, throughSeq: null, reason: 'no-live-session' }
    }
    const header = session.header
    if (header === null || header === undefined || typeof header !== 'object') {
      return { field: null, throughSeq: null, reason: 'session-has-no-header' }
    }
    if (!Number.isSafeInteger(header.version) || header.version < 0) {
      return { field: null, throughSeq: null, reason: 'session-format-version-is-not-a-non-negative-integer' }
    }
    if (typeof session.snapshotEvents !== 'function') {
      return { field: null, throughSeq: null, reason: 'session-has-no-snapshotEvents' }
    }

    const limit = Number.isSafeInteger(maxBytes) && maxBytes >= 1 ? maxBytes : DEFAULT_MAX_BYTES
    const start = Number.isSafeInteger(afterSeq) && afterSeq >= -1 ? afterSeq : -1

    // The shipped uploader calls SessionLogOffset(afterSeq + 1); the runtime branding function is
    // an identity over a non-negative safe integer (dsh-brand/lib/index.js:28-30), and
    // Session.snapshotEvents(fromSeq, toSeqExclusive) slices by those numbers directly
    // (dsh-session/lib/index.js:1454-1460), so a plain number is exact here.
    const pending = session.snapshotEvents(start + 1)
    if (!Array.isArray(pending)) {
      return { field: null, throughSeq: null, reason: 'snapshotEvents-did-not-return-an-array' }
    }

    const envelope = {
      version: 1,
      sessionFormatVersion: header.version,
      session: wireHeader(session),
      afterSeq: Number(start),
    }

    let bytes = jsonBytes({ ...envelope, throughSeq: 0, events: [] }) - 1
    const events = []
    let candidateBytes = 0
    for (const event of pending) {
      const wire = wireEvent(event)
      const next = bytes + (events.length === 0 ? 0 : 1) + jsonBytes(wire)
      candidateBytes = next + String(event.seq).length
      if (candidateBytes > limit) break
      bytes = next
      events.push(wire)
    }

    const last = events.length === 0 ? undefined : pending[events.length - 1]
    if (last === undefined) {
      const first = pending[0]
      return {
        field: null,
        throughSeq: null,
        // A stable signal for the one blocking case: the *first* pending event alone exceeds the cap,
        // so nothing can ever be sent until the cap rises. `index.js` records it as `payload-too-large`
        // (the caller cannot reliably re-derive it from the human-readable `reason`), while the other
        // reasons here are ordinary "nothing to send" states and must not be recorded as failures.
        overCap: first !== undefined,
        reason:
          first === undefined
            ? 'no-pending-events'
            : `event ${String(first.seq)} needs ${Number.isFinite(candidateBytes) ? `${String(candidateBytes)} bytes` : 'an unserializable size'}, above maxBytes ${String(limit)}`,
      }
    }

    const throughSeq = Number(last.seq)
    return {
      field: { ...envelope, throughSeq, events },
      throughSeq,
    }
  } catch (error) {
    const message = error !== null && error !== undefined && typeof error.message === 'string' ? error.message : String(error)
    return { field: null, throughSeq: null, reason: `build-failed: ${message}` }
  }
}
