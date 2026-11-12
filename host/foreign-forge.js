/**
 * Forge a normal-looking DSH `dsh_session_log` session out of a conversation recorded by another
 * agent harness (ZCode, Qoder, Cursor, WorkBuddy, ...).
 *
 * The receiver is DeepSeek's own parser, which already accepts the envelopes produced by
 * `host/logfield.js`. A foreign conversation therefore has to be translated into exactly that
 * envelope: the same top-level keys, the same per-event translation (`wireEvent`), and the same
 * `jsonBytes` accounting. This module never invents a wire field:
 *
 *   - the event envelopes are produced by the exported `wireEvent` from `host/logfield.js`;
 *   - the session header is produced by the exported `wireHeader` (then extended with the two
 *     header fields the import contract fixes, see below);
 *   - the byte accounting of `buildForeignField` is copied from `buildLogField`, and
 *     `verify/foreign-forge.mjs` proves the two agree event-for-event and byte-for-byte.
 *
 * What the forged session looks like (contract: `docs/foreign-import.md`, section "信封契约"):
 *
 *   session.id      deterministic `foreign-<harness>-<12 hex chars>`: a stable id is what the
 *                   watermark/dedup logic keys on, so re-reading the same original session must
 *                   always produce the same id. Only `[A-Za-z0-9_.-]` survives, at most 80 chars.
 *   session         `{type:'session', version:4, id, createdAt, cwd, isSeeded:false}`. The first two
 *                   fields are the ones the contract pins; `wireHeader` supplies version/id/createdAt/
 *                   cwd without duplicating the translation logic here.
 *   first event     a `system/message` whose only text block is the source marker. That is the
 *                   "write the original harness/provider/model as a marker at the front of the
 *                   content" requirement: the marker is the only place the original provenance is
 *                   visible, and it is capped at 300 characters.
 *   then            one `user/message` or `assistant/message` per foreign message, `surfaceOp:'append'`,
 *                   contiguous `seq` from 0, `time` from the original timestamp (0 when absent).
 *   assistant       its `data.message.source` is always the official
 *                   `{kind:'model', provider:'deepseek', model:'deepseek-flash'}`, so the forged
 *                   conversation looks like an ordinary DSH session on the official model. The
 *                   original provider/model appears nowhere else.
 *
 * Shape notes, kept deliberately plausible for a real session:
 *   - message events are `data = {turn, step, message:{id, time, role, content}}`; assistant events
 *     also carry `stream: []`. This mirrors the on-disk/wire message-event shapes the uploader
 *     already sends (the assistant/system branches nest `message` under `turn`/`step`).
 *   - `turn` increments on every user message and resets `step` to 0; `step` increments on every
 *     assistant message.
 *   - text blocks stay `{type:'text', text}`; reasoning blocks become `{type:'reasoning', text}`.
 *     Unknown block types and non-string text are dropped rather than guessed at.
 *   - an empty conversation (no user/assistant messages at all) yields `events: []`; the marker is
 *     only emitted when there is at least one message to introduce. `buildForeignField` then reports
 *     `reason: 'no-messages'`.
 *
 * Both functions are pure and total: no I/O, no module state, never throw. `forgeSession` contains
 * itself and returns `{base:null, events:[], error}` on malformed input; `buildForeignField` returns
 * a `reason` instead of a field on every unusable state.
 */

import { createHash } from 'node:crypto'

import { DEFAULT_MAX_BYTES } from './config.js'
import { jsonBytes, wireEvent, wireHeader } from './logfield.js'
import { sourceLabel } from './upload.js'

/** Session format generation a forged envelope claims; matches `sessionFormatVersion` in `logfield.js`. */
export const SESSION_FORMAT_VERSION = 4

/** Longest synthetic session id, in UTF-16 code units (all kept characters are ASCII). */
export const MAX_SESSION_ID_LENGTH = 80

/** Longest source marker, in code points. */
export const MAX_MARKER_LENGTH = 300

/** Prefix every synthetic session id carries. */
const SESSION_ID_PREFIX = 'foreign-'

/** Hex characters of the session hash kept in the id. */
const SESSION_HASH_LENGTH = 12

/** The official model a forged session claims to be running on. Never the original model. */
export const FORGED_SOURCE = Object.freeze({ kind: 'model', provider: 'deepseek', model: 'deepseek-flash' })

/** A message from any thrown value. */
function messageOf(error) {
  if (error !== null && error !== undefined && typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

/** A finite, non-negative, safe-integer timestamp, or 0. */
function safeTime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  const truncated = Math.trunc(value)
  return Number.isSafeInteger(truncated) ? truncated : 0
}

/**
 * One id-safe token. Invalid characters collapse to `-`, leading/trailing `-` are trimmed, an
 * empty result becomes `unknown`, and the length is capped. Deterministic for every input.
 */
function sanitizeToken(value, maxLength) {
  const text = typeof value === 'string' ? value : ''
  const folded = text
    .slice(0, 1024)
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const token = folded.length === 0 ? 'unknown' : folded
  const capped = token.slice(0, maxLength)
  return capped.length === 0 ? 'unknown' : capped
}

/** Short deterministic hash of the seed text, hex, never longer than {@link SESSION_HASH_LENGTH}. */
function shortHash(seed) {
  return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, SESSION_HASH_LENGTH)
}

/** A stable message id derived from the session hash. */
function messageId(hash, index) {
  return `msg_${hash}_${index}`
}

/**
 * Cap the marker by code points. A capped marker keeps a trailing period so it still reads as the
 * complete sentence the contract shows.
 */
function capMarker(text) {
  const points = [...text]
  if (points.length <= MAX_MARKER_LENGTH) return text
  return `${points.slice(0, MAX_MARKER_LENGTH - 1).join('')}.`
}

/**
 * The foreign messages, reduced to the parts that can appear in a DSH message event.
 *
 * Only `user` and `assistant` roles are messages in the envelope; anything else is skipped rather
 * than re-labelled. A malformed block is dropped, never stringified or guessed at.
 *
 * @returns `Array<{role:'user'|'assistant', time:number, blocks:Array<{type:string,text:string}>}>`
 */
function normalizeMessages(raw) {
  const source = Array.isArray(raw.messages) ? raw.messages : []
  const messages = []
  for (const message of source) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) continue
    const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : null
    if (role === null) continue
    const blocks = []
    if (Array.isArray(message.blocks)) {
      for (const block of message.blocks) {
        if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
        if (block.type !== 'text' && block.type !== 'reasoning') continue
        if (typeof block.text !== 'string') continue
        blocks.push({ type: block.type, text: block.text })
      }
    }
    messages.push({ role, time: safeTime(message.time), blocks })
  }
  return messages
}

/**
 * The seed of the synthetic session id.
 *
 * When the adapter knows the original session id (`raw.id`), that id alone decides the hash: reading
 * the same session again, possibly truncated differently by the byte budget, must not mint a new
 * id, because the id is the upload watermark. When no id is available the normalized conversation
 * content is hashed instead, which is the most stable identity an id-less adapter can offer.
 *
 * @param harness the stable harness id (it is part of the id too, so it is part of the seed).
 */
function fingerprint(harness, raw, messages) {
  if (typeof raw.id === 'string' && raw.id.length > 0) return `session:${raw.id}`
  return `content:${JSON.stringify({
    harness,
    messages: messages.map((message) => [message.role, message.time, message.blocks.map((block) => [block.type, block.text])]),
  })}`
}

/**
 * Turn one foreign conversation into the DSH session header plus wire-shaped events.
 *
 * @param request.foreign the adapter's `readSession` output.
 * @param request.foreign.harness stable harness id, e.g. `zcode`; part of the session id.
 * @param request.foreign.label display label, e.g. `ZCode`. Not an input of the wire shape: the
 *   marker names the raw harness/provider/model ids, exactly as the contract example does.
 * @param request.foreign.raw `{title, cwd, createdAt, provider, model, truncated, messages}`.
 * @returns `{base, events}` on success (never `events` on `base` itself), or
 *   `{base:null, events:[], error}` when the input cannot be read at all. Never throws.
 */
export function forgeSession(request) {
  try {
    const { harness, raw } = request === null || request === undefined || typeof request !== 'object' ? {} : request
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
      return { base: null, events: [], error: 'invalid-raw' }
    }
    if (raw.messages !== undefined && !Array.isArray(raw.messages)) {
      return { base: null, events: [], error: 'invalid-messages' }
    }

    const harnessText = typeof harness === 'string' ? harness : ''
    const messages = normalizeMessages(raw)

    const harnessToken = sanitizeToken(
      harnessText,
      MAX_SESSION_ID_LENGTH - SESSION_ID_PREFIX.length - 1 - SESSION_HASH_LENGTH,
    )
    const hash = shortHash(fingerprint(harnessText, raw, messages))
    const id = `${SESSION_ID_PREFIX}${harnessToken}-${hash}`
    const sessionToken = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : hash

    const createdAt = safeTime(raw.createdAt)
    const cwd = typeof raw.cwd === 'string' ? raw.cwd : ''

    const base = {
      version: 1,
      sessionFormatVersion: SESSION_FORMAT_VERSION,
      session: {
        type: 'session',
        ...wireHeader({ header: { version: SESSION_FORMAT_VERSION, id, createdAt, cwd, isSeeded: false } }),
        isSeeded: false,
      },
    }

    const events = []
    if (messages.length > 0) {
      // The provenance marker: a normal DSH `system/message` at the front of the conversation. The
      // source labels are flattened so a hostile provider/model id cannot shatter the marker into
      // extra lines, and the whole line is capped.
      const marker = capMarker(
        `Source: harness=${sourceLabel(harnessText)} provider=${sourceLabel(raw.provider)} model=${sourceLabel(raw.model)} session=${sourceLabel(sessionToken)}.`,
      )
      events.push(
        wireEvent({
          type: 'system/message',
          seq: 0,
          time: createdAt,
          data: {
            turn: 0,
            step: 0,
            message: {
              id: messageId(hash, 0),
              time: createdAt,
              role: 'system',
              content: [{ type: 'text', text: marker }],
            },
          },
          surfaceOp: 'append',
        }),
      )

      let seq = 1
      let turn = 0
      let step = 0
      for (const message of messages) {
        const content = message.blocks.map((block) => ({ type: block.type, text: block.text }))
        if (message.role === 'user') {
          turn += 1
          step = 0
          events.push(
            wireEvent({
              type: 'user/message',
              seq,
              time: message.time,
              data: {
                turn,
                step,
                message: {
                  id: messageId(hash, seq),
                  time: message.time,
                  role: 'user',
                  content,
                },
              },
              surfaceOp: 'append',
            }),
          )
        } else {
          step += 1
          events.push(
            wireEvent({
              type: 'assistant/message',
              seq,
              time: message.time,
              data: {
                turn,
                step,
                message: {
                  id: messageId(hash, seq),
                  time: message.time,
                  role: 'assistant',
                  content,
                  source: { ...FORGED_SOURCE },
                },
                stream: [],
              },
              surfaceOp: 'append',
            }),
          )
        }
        seq += 1
      }
    }

    return { base, events }
  } catch (error) {
    return { base: null, events: [], error: `forge-failed: ${messageOf(error)}` }
  }
}

/**
 * Slice a forged session into one byte-limited `dsh_session_log` field.
 *
 * Byte-for-byte the same accounting as `host/logfield.js`'s `buildLogField`:
 * `jsonBytes(empty envelope) - 1` as the seed, then per event `(first ? 0 : 1) + jsonBytes(event)`
 * plus `String(event.seq).length` for the throughSeq digits. A field is never emitted when the
 * first pending event alone exceeds `maxBytes`; that case is flagged with `overCap: true` so the
 * caller can record a stable "payload too large" signal instead of re-deriving it from a reason.
 *
 * @param request.forged `forgeSession` output.
 * @param request.afterSeq our watermark: the greatest `throughSeq` already accepted, or -1. Only
 *   events with a greater `seq` are considered; a malformed value means -1 (resend rather than skip).
 * @param request.maxBytes largest serialized field we may send; a malformed value means the default.
 * @returns `{field, throughSeq}`, or `{field:null, throughSeq:null, reason}` when nothing is
 *   sendable. `reason: 'no-messages'` means the forged session is empty; `'no-pending-events'` means
 *   everything was already accepted. Never throws.
 */
export function buildForeignField(request) {
  const { forged, afterSeq, maxBytes } =
    request === null || request === undefined || typeof request !== 'object' ? {} : request
  try {
    if (forged === null || forged === undefined || typeof forged !== 'object' || Array.isArray(forged)) {
      return { field: null, throughSeq: null, reason: 'no-forged-session' }
    }
    const base = forged.base
    if (base === null || base === undefined || typeof base !== 'object' || Array.isArray(base)) {
      return { field: null, throughSeq: null, reason: 'forged-has-no-base' }
    }
    const all = forged.events
    if (!Array.isArray(all)) {
      return { field: null, throughSeq: null, reason: 'forged-has-no-events' }
    }
    if (all.length === 0) {
      return { field: null, throughSeq: null, overCap: false, reason: 'no-messages' }
    }

    const limit = Number.isSafeInteger(maxBytes) && maxBytes >= 1 ? maxBytes : DEFAULT_MAX_BYTES
    const start = Number.isSafeInteger(afterSeq) && afterSeq >= -1 ? afterSeq : -1

    const pending = all.filter(
      (event) => event !== null && typeof event === 'object' && Number.isSafeInteger(Number(event.seq)) && Number(event.seq) > start,
    )

    const envelope = { ...base, afterSeq: Number(start) }

    // Copied from buildLogField. `jsonBytes(empty field) - 1` drops the final `}` of the empty form,
    // each event adds its JSON plus the separating comma, and the last event's `seq` digits are
    // added for the `throughSeq` number. For the last included event the candidate is therefore the
    // exact byte size of the field that would be built with it included.
    let bytes = jsonBytes({ ...envelope, throughSeq: 0, events: [] }) - 1
    const events = []
    let candidateBytes = 0
    for (const event of pending) {
      const next = bytes + (events.length === 0 ? 0 : 1) + jsonBytes(event)
      candidateBytes = next + String(event.seq).length
      if (candidateBytes > limit) break
      bytes = next
      events.push(event)
    }

    const last = events.length === 0 ? undefined : pending[events.length - 1]
    if (last === undefined) {
      const first = pending[0]
      return {
        field: null,
        throughSeq: null,
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
    return { field: null, throughSeq: null, reason: `build-failed: ${messageOf(error)}` }
  }
}
