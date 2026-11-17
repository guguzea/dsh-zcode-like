/**
 * Registry for the other-harness adapters.
 *
 * The settings page talks to exactly one entry point, and only this file composes or splits the
 * composite id `${harness}/${raw session id}` (docs/foreign-import.md, "适配器契约"). Keeping the
 * format here means a route, the page and a test can never disagree about it.
 *
 * Every function is total: an adapter that throws, a missing module field, an unknown harness or a
 * hostile id all turn into the contract's `error` string instead of an exception, because these
 * functions run inside an HTTP route handler.
 *
 * @module session-log-upload/foreign
 */

import * as antigravity from './antigravity.js'
import * as cline from './cline.js'
import * as cursor from './cursor.js'
import * as qoder from './qoder.js'
import * as workbuddy from './workbuddy.js'
import * as zcode from './zcode.js'

/**
 * The adapters, in the order the settings page presents them.
 *
 * The order is part of the interface: the page renders the groups in this order, so it is the order
 * a person reads when comparing what the machine has.
 */
export const ADAPTERS = [zcode, qoder, antigravity, cursor, workbuddy, cline]

/** A thrown value as one line of text. */
function messageOf(error) {
  if (error !== null && error !== undefined && typeof error.message === 'string' && error.message.length > 0) {
    return error.message
  }
  return String(error)
}

/**
 * The adapter for one stable harness id.
 * @param harness candidate id, e.g. `zcode`.
 * @returns the adapter module, or `undefined`.
 */
export function adapterFor(harness) {
  try {
    if (typeof harness !== 'string' || harness.length === 0) return undefined
    for (const adapter of ADAPTERS) if (adapter.harness === harness) return adapter
    return undefined
  } catch {
    return undefined
  }
}

/**
 * One `scanAll` group: the adapter's answer with its identity attached.
 * @param adapter the adapter module.
 * @param result the adapter's `scan` result, or anything it returned.
 * @returns a group shaped exactly like the route contract.
 */
function groupOf(adapter, result) {
  let error = null
  let available = false
  const sessions = []
  if (result !== null && result !== undefined && typeof result === 'object') {
    available = result.available === true
    if (typeof result.error === 'string' && result.error.length > 0) error = result.error
    if (Array.isArray(result.sessions)) {
      for (const session of result.sessions) {
        if (session !== null && session !== undefined && typeof session === 'object' && !Array.isArray(session)) {
          sessions.push(session)
        }
      }
    }
  }
  return { harness: adapter.harness, label: adapter.label, available, error, sessions }
}

/**
 * Scan every harness, in presentation order.
 *
 * Each adapter is awaited in turn rather than in parallel: they read the same disk, and a scan is a
 * deliberate, user-triggered act, so deterministic order matters more than shaving milliseconds off
 * a click that already touches gigabytes.
 *
 * @param options `{home, signal?, maxBytes?}` passed through to every adapter.
 * @returns `{harnesses: [{harness, label, available, error, sessions}]}`; never throws.
 */
export async function scanAll(options) {
  const harnesses = []
  for (const adapter of ADAPTERS) {
    try {
      harnesses.push(groupOf(adapter, await adapter.scan(options)))
    } catch (error) {
      // An adapter is not supposed to throw, but a broken one must not take the other four down.
      harnesses.push({
        harness: typeof adapter.harness === 'string' ? adapter.harness : 'unknown',
        label: typeof adapter.label === 'string' ? adapter.label : 'unknown',
        available: false,
        error: messageOf(error),
        sessions: [],
      })
    }
  }
  return { harnesses }
}

/**
 * Read one conversation by composite id.
 *
 * The raw id is everything after the first `/`; a slash inside it is rejected by the adapter's own
 * id validation, so `a/b/c` cannot address a nested path. On failure `raw` is `null`, so a caller
 * cannot mistake an error-shaped placeholder for a conversation.
 *
 * @param compositeId `${harness}/${raw session id}`.
 * @param options `{home, signal?, maxBytes?}`.
 * @returns `{adapter, raw, error}`; never throws.
 */
export async function readForeignSession(compositeId, options) {
  try {
    if (typeof compositeId !== 'string' || compositeId.length === 0 || compositeId.length > 400) {
      return { adapter: undefined, raw: null, error: 'invalid-id' }
    }
    const slash = compositeId.indexOf('/')
    if (slash <= 0 || slash === compositeId.length - 1) return { adapter: undefined, raw: null, error: 'invalid-id' }
    const adapter = adapterFor(compositeId.slice(0, slash))
    if (adapter === undefined) return { adapter: undefined, raw: null, error: 'unknown-harness' }
    const raw = await adapter.readSession(compositeId.slice(slash + 1), options)
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
      return { adapter, raw: null, error: 'read-failed' }
    }
    if (typeof raw.error === 'string' && raw.error.length > 0) return { adapter, raw: null, error: raw.error }
    return { adapter, raw, error: null }
  } catch (error) {
    return { adapter: undefined, raw: null, error: messageOf(error) }
  }
}
