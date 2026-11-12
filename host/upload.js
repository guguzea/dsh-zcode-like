/**
 * Transport for our own log-only request to DeepSeek's Anthropic-compatible Messages endpoint.
 *
 * `INTERFACES.md` §3 fixes the body:
 *
 *   { "model": "<uploadModel>", "max_tokens": 1,
 *     "messages": [{ "role": "user", "content": "<carrier line, see carrierMessage>" }],
 *     "dsh_session_log": { ...version-1 field... } }
 *
 * The carrier message is a short, self-describing line naming the provider and model of the request
 * that *triggered* this upload. It lives in the `messages` array — a defined part of the Messages API —
 * rather than in a new top-level field, because an unknown top-level field can be rejected or silently
 * dropped while a message cannot, and it is the message that a receiver is most likely to record. The
 * `dsh_session_log` field is untouched by it: the uploaded envelope stays byte-identical to the
 * shipped uploader's version-1 format, which is what makes the upload parseable at all. The top-level
 * `model` stays the `uploadModel` stub, which exists only to make the body valid.
 *
 * The request's auth header has no single form: the two shipped official routes share this
 * URL but not the scheme — `deepseek-official` sends `x-api-key`
 * (`@deepseek-ai/dsh-llm-deepseek-api-key/lib/index.js:131`) while `deepseek-account` sends
 * `x-dsh-auth-token` (`@deepseek-ai/dsh-llm-deepseek-account/lib/index.js:72`, `:85`). The caller
 * resolves which one applies and passes it as `request.auth`; this module guarantees that **exactly
 * one** auth header is ever sent, whatever the caller (or an extra header bag) supplies.
 *
 * The rest of the header set mirrors the one the shipped adapter sends for a
 * Messages request (`@deepseek-ai/dsh-llm-deepseek/lib/index.js:2231-2247`): `content-type`,
 * `anthropic-version: 2023-06-01`, and the route's credential header. `accept` is
 * `application/json` rather than `text/event-stream` because this request does not set
 * `stream: true`, so the endpoint answers with one JSON message we discard.
 *
 * The remaining headers that adapter sends — the attribution trio `user-agent`,
 * `x-deepseek-harness-user-id` and `x-deepseek-harness-session-id` — arrive from the caller through
 * `request.headers`; this module owns only their on-the-wire safety (see `wireHeaders`). They are
 * optional: the request is valid without any of them.
 *
 * Never throws: every failure path returns `{ok: false, error, retryable}`.
 */

import { DEFAULT_UPLOAD_MODEL } from './config.js'

/**
 * THE ENDPOINT RULE — the one predicate this transport will POST to, and the same rule
 * `host/config.js`'s `normalizeEndpoint` (and therefore `resolveConfig`) applies when it narrows the
 * configured `endpoint`. Kept as a named predicate so a future refactor cannot silently drop it, and
 * asserted to agree with `resolveConfig` in `verify/host-unit.mjs`.
 *
 * ACCEPTED: a string of length > 0 whose first characters are `http://` or `https://`, tested
 * case-insensitively (`/^https?:\/\//i`). Nothing else is checked — no trimming, no `new URL()` parse,
 * no host or path validation — so `'HTTP://X'` and `'https:// '` are both accepted, and the caller is
 * responsible for a usable destination. Because it is a pure prefix test, **trailing** whitespace is
 * accepted verbatim (`'https://ok '`; `fetch`'s own URL parser ignores it) while **leading** whitespace
 * is not.
 *
 * REFUSED (⇒ `resolveConfig` falls back to `DEFAULT_ENDPOINT`, and this transport refuses to POST):
 * the empty string; any non-string; any other scheme (`ftp://`, `file://`, `javascript:`, `data:`);
 * scheme-relative (`//host/path`) and malformed (`https:/host`) forms; and any value whose first
 * character is not that prefix, including leading whitespace (`' https://ok'` — the rule does not trim).
 *
 * `client.js` mirrors this rule to display the destination the plugin will actually use; the two must
 * agree for every input, which `verifier` asserts.
 *
 * @param value candidate destination.
 * @returns `true` when the value is an absolute HTTP(S) URL.
 */
export function isAbsoluteHttpEndpoint(value) {
  return typeof value === 'string' && value.length > 0 && /^https?:\/\//i.test(value)
}

/** Fixed token budget of the log-only request. */
export const UPLOAD_MAX_TOKENS = 1

/** Longest provider or model label embedded in the carrier message. */
export const MAX_SOURCE_LABEL_LENGTH = 64

/**
 * One provider or model id as a safe single-line label.
 *
 * The value is **untrusted data**, never a template: it is flattened before it is embedded, so every
 * control character, format character (e.g. an RTL override), unpaired surrogate and run of whitespace
 * — including newlines, tabs and the Unicode line/paragraph separators — collapses to a single space.
 * The length is capped by code points, and a value that is not a usable string becomes the literal
 * `unknown` rather than a guess.
 *
 * @param value a provider or model id, of any type.
 * @returns a single-line label, never empty, never longer than {@link MAX_SOURCE_LABEL_LENGTH}.
 */
export function sourceLabel(value) {
  if (typeof value !== 'string' || value.length === 0) return 'unknown'
  let flattened
  try {
    flattened = value.slice(0, 1024).replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\s]+/gu, ' ').trim()
  } catch {
    return 'unknown'
  }
  if (flattened.length === 0) return 'unknown'
  const points = [...flattened]
  return points.length > MAX_SOURCE_LABEL_LENGTH ? points.slice(0, MAX_SOURCE_LABEL_LENGTH).join('') : flattened
}

/**
 * The one user message our log-only request carries.
 *
 * Its only job is to be recorded: the receiver reads the top-level `model` as the model the request
 * came from, and that is deliberately the `uploadModel` stub, so the true source has to be stated
 * somewhere a receiver actually stores. A message is a defined part of the Messages API — unlike a new
 * top-level field, which may be rejected as unknown or silently ignored — so this is where the source
 * is named. It is one short informative line, not an instruction, and it never touches the uploaded
 * `dsh_session_log` field, whose version-1 shape must stay byte-identical.
 *
 * @param source `{provider, model}` of the request that triggered the upload; anything else is
 *   tolerated and renders as `unknown`.
 * @returns the carrier message content (a single line).
 */
export function carrierMessage(source) {
  const origin = source === null || source === undefined || typeof source !== 'object' ? {} : source
  return `DSH session-log upload. Source: provider=${sourceLabel(origin.provider)} model=${sourceLabel(origin.model)}. The Session log is carried in the dsh_session_log field.`
}

/** Characters of a provider error body retained in the diagnostic. */
export const ERROR_DETAIL_LIMIT = 400

/**
 * The exact request body POSTed (key order matches INTERFACES.md §3).
 * @param field the version-1 `dsh_session_log` field; passed through untouched.
 * @param uploadModel the `model` field (the stub).
 * @param source `{provider, model}` of the triggering request, named in the carrier message.
 * @returns a plain JSON-serializable body.
 */
export function buildUploadBody(field, uploadModel, source) {
  return {
    model: uploadModel,
    max_tokens: UPLOAD_MAX_TOKENS,
    messages: [{ role: 'user', content: carrierMessage(source) }],
    dsh_session_log: field,
  }
}

/**
 * Structured failure.
 *
 * `kind` is the machine-readable classification the durable failure record stores (`host/failure.js`),
 * and `status` is the HTTP status when there was one — a caller must not have to re-derive either from
 * the human-readable `error`.
 */
function failure(error, retryable, kind = 'unknown', status = null) {
  return { ok: false, error, retryable, kind, status }
}

/** A message from any thrown value. */
function messageOf(error) {
  if (error !== null && error !== undefined && typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

/** Release a response body we do not read. */
async function discardBody(response) {
  try {
    if (response.body !== null && response.body !== undefined && typeof response.body.cancel === 'function') {
      await response.body.cancel()
      return
    }
    if (typeof response.arrayBuffer === 'function') await response.arrayBuffer()
  } catch {
    /* discarding is best-effort */
  }
}

/** Read at most {@link ERROR_DETAIL_LIMIT} characters of an error body. */
async function errorDetail(response) {
  try {
    if (typeof response.text !== 'function') return ''
    const text = await response.text()
    return typeof text === 'string' ? text.slice(0, ERROR_DETAIL_LIMIT) : ''
  } catch {
    return ''
  }
}

/**
 * The caller-supplied header set, reduced to what may actually go on the wire.
 *
 * `index.js` passes the harness attribution headers here (`user-agent`,
 * `x-deepseek-harness-user-id`, `x-deepseek-harness-session-id`). They are optional and cosmetic, so
 * this filter exists to guarantee the invariant the attribution code promises: a header is sent only
 * when it carries a non-empty string value — an empty or non-string value is dropped rather than
 * transmitted as if it were an id, and a malformed `headers` argument cannot throw or leak.
 *
 * @param headers the caller's extra headers (any type).
 * @returns entries safe to merge into the request headers.
 */
function wireHeaders(headers) {
  if (headers === null || headers === undefined || typeof headers !== 'object' || Array.isArray(headers)) return []
  try {
    return Object.entries(headers).filter(
      ([name, value]) =>
        typeof name === 'string' && name.length > 0 && typeof value === 'string' && value.trim().length > 0,
    )
  } catch {
    return []
  }
}

/**
 * The two auth schemes an official route uses. Exactly one of them may ever ride on a request, and a
 * name outside this list is refused: the transport must not be usable to carry a credential in an
 * arbitrary header.
 */
export const AUTH_HEADERS = Object.freeze(['x-api-key', 'x-dsh-auth-token'])

/**
 * Resolve the single auth header for this request.
 *
 * `auth` is the caller's decision — `{header, value}` where `header` is one of {@link AUTH_HEADERS};
 * the caller is responsible for choosing it by destination (see `resolveAuth` in `index.js`). The
 * `credential` form stays supported for the `x-api-key` route (a string, or a resolved credential
 * object carrying `.value`) so callers that predate the account route keep working unchanged.
 *
 * @param auth `{header, value}` or anything else (ignored).
 * @param credential a string or `{value}` API key, used when `auth` is not usable.
 * @returns `{header, value}` or `undefined` when no usable credential was supplied.
 */
function resolveAuthHeader(auth, credential) {
  if (auth !== null && auth !== undefined && typeof auth === 'object' && !Array.isArray(auth)) {
    const header = auth.header
    const value = auth.value
    if (typeof header === 'string' && AUTH_HEADERS.includes(header) && typeof value === 'string' && value.length > 0) {
      return { header, value }
    }
    return undefined
  }
  const value =
    typeof credential === 'string'
      ? credential
      : credential !== null && credential !== undefined && typeof credential === 'object' && typeof credential.value === 'string'
        ? credential.value
        : undefined
  if (value === undefined || value.length === 0) return undefined
  return { header: 'x-api-key', value }
}

/**
 * POST one `dsh_session_log` field and report whether the endpoint accepted it.
 *
 * @param request transport inputs.
 * @param request.fetchImpl fetch implementation; defaults to `globalThis.fetch`.
 * @param request.endpoint absolute destination URL; a value that is not an absolute HTTP(S) URL is
 *   refused here without calling `fetch` (see THE ENDPOINT RULE above).
 * @param request.auth the chosen auth scheme as `{header, value}` — `x-api-key` for the key route,
 *   `x-dsh-auth-token` for the account route. Preferred over `credential`, and the only form that can
 *   select the account header.
 * @param request.credential the API key, or a resolved credential object carrying `.value`; the
 *   `x-api-key` form, kept for callers that predate the account route.
 * @param request.sessionId the Session id. The field itself carries `session.id`, and the matching
 *   attribution header rides in `headers`; this parameter stays for signature fidelity.
 * @param request.field the version-1 `dsh_session_log` field.
 * @param request.signal cancellation; the caller owns the deadline.
 * @param request.uploadModel the `model` field; defaults to `deepseek-chat`.
 * @param request.source `{provider, model}` of the request that triggered this upload; named in the
 *   carrier message. Anything else renders as `unknown` — never a guessed model, and never a template.
 * @param request.headers extra headers merged last (attribution; values that are not non-empty
 *   strings are dropped — see `wireHeaders`).
 * @returns `{ok: true, throughSeq}` on HTTP 2xx, otherwise `{ok: false, error, retryable}`.
 */
export async function uploadLogField(request) {
  const { fetchImpl, endpoint, auth, credential, sessionId, field, signal, uploadModel, source, headers } =
    request === null || request === undefined ? {} : request
  void sessionId
  try {
    if (field === null || field === undefined || typeof field !== 'object' || Array.isArray(field)) {
      return failure('no dsh_session_log field to upload', false)
    }
    if (!Number.isSafeInteger(field.throughSeq)) {
      return failure('dsh_session_log field carries no integer throughSeq', false)
    }
    const throughSeq = field.throughSeq

    const authHeader = resolveAuthHeader(auth, credential)
    if (authHeader === undefined) {
      return failure('no DeepSeek credential is available for the log-only request', false, 'no-credential')
    }
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      return failure('no upload endpoint is configured', false, 'endpoint-refused')
    }
    // Defence in depth: `resolveConfig` already narrows to an absolute HTTP(S) URL, but this transport
    // must never depend on that. A destination that is not one is refused here, before `fetch` exists,
    // with the ordinary failure shape rather than a throw (see THE ENDPOINT RULE above).
    if (!isAbsoluteHttpEndpoint(endpoint)) {
      return failure(`refusing to POST to a non-HTTP(S) endpoint: ${JSON.stringify(endpoint)}`, false, 'endpoint-refused')
    }

    const doFetch =
      typeof fetchImpl === 'function' ? fetchImpl : typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined
    if (doFetch === undefined) return failure('no fetch implementation is available', false, 'transport-error')

    const model = typeof uploadModel === 'string' && uploadModel.length > 0 ? uploadModel : DEFAULT_UPLOAD_MODEL
    let body
    try {
      body = JSON.stringify(buildUploadBody(field, model, source))
    } catch (error) {
      return failure(`dsh_session_log field is not JSON-serializable: ${messageOf(error)}`, false)
    }

    // Exactly one auth header. Any auth name in the caller's extra bag is dropped *before* the merge,
    // so neither a stray `x-api-key` nor a stray `x-dsh-auth-token` can produce a second scheme (and
    // cannot override the chosen one either).
    const extraHeaders = Object.fromEntries(wireHeaders(headers).filter(([name]) => !AUTH_HEADERS.includes(name)))
    const requestHeaders = {
      'content-type': 'application/json',
      accept: 'application/json',
      [authHeader.header]: authHeader.value,
      'anthropic-version': '2023-06-01',
      ...extraHeaders,
    }

    let response
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        headers: requestHeaders,
        body,
        redirect: 'error',
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      const aborted = signal !== null && signal !== undefined && signal.aborted === true
      return failure(`${aborted ? 'request aborted or timed out' : 'transport failure'}: ${messageOf(error)}`, true, 'transport-error')
    }
    if (response === null || response === undefined || typeof response !== 'object' || typeof response.status !== 'number') {
      return failure('transport returned no usable HTTP response', true, 'transport-error')
    }

    if (response.ok === true || (response.status >= 200 && response.status < 300)) {
      await discardBody(response)
      return { ok: true, throughSeq }
    }

    const detail = await errorDetail(response)
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500
    return failure(
      `DeepSeek rejected the log-only request (HTTP ${response.status})${detail.length === 0 ? '' : `: ${detail}`}`,
      retryable,
      'http-error',
      response.status,
    )
  } catch (error) {
    return failure(`unexpected upload failure: ${messageOf(error)}`, false)
  }
}
