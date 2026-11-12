/**
 * Pure configuration resolution for the `session-log-upload` host row.
 *
 * The row's schema is optional (INTERFACES.md §0): when no schema builder is resolvable the raw
 * `config` object from `cordis.patch.yml` is read and defaulted here in plain JavaScript, and when
 * the optional `Config` does resolve this module still owns the never-wider fallback.
 *
 * Contract (INTERFACES.md §3, §5):
 *   resolveConfig(raw) -> { mode, deepseekModelPatterns, endpoint, uploadModel, credentialRef, maxBytes }
 *
 * Rules:
 *   - never throws;
 *   - an unknown, missing or malformed `mode` falls back to `official-only`, never to a wider mode;
 *   - only **own** properties are read, so an inherited value (e.g. `Object.prototype.mode`) can
 *     neither widen the mode nor redirect the endpoint;
 *   - `mode`, `endpoint` and `maxBytes` are **volatile** schema fields, so the Loader may hand over a
 *     live reference instead of a plain value; such a reference is unwrapped by calling `get()` (see
 *     `readLive`). Callers must therefore resolve at use time, not once at startup, or a settings
 *     write would be invisible until the row restarts. `deepseekModelPatterns`, `uploadModel` and
 *     `credentialRef` are not volatile and stay plain values;
 *   - malformed fields are dropped in favour of the default (or, for the pattern list, of "matches
 *     nothing"), so a typo can only ever narrow what is uploaded.
 *
 * This module is pure: no I/O, no module-level mutable state, no bare specifiers.
 */

/** Tag shared by Cordis's volatile config references (`cosmokit`'s `volatile.write`). */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** The four frozen mode ids, in the order the settings UI presents them. */
export const MODES = ['off', 'official-only', 'deepseek-any-provider', 'any-model']

/** Default and never-wider fallback mode. */
export const DEFAULT_MODE = 'official-only'

/** Default model-id substrings; matched case-insensitively as plain substrings. */
export const DEFAULT_DEEPSEEK_MODEL_PATTERNS = ['deepseek']

/** Default destination: DeepSeek's Anthropic-compatible Messages endpoint. */
export const DEFAULT_ENDPOINT = 'https://api.deepseek.com/anthropic/v1/messages'

/** Default `model` field of our log-only request. */
export const DEFAULT_UPLOAD_MODEL = 'deepseek-flash'

/** Default credential reference; the shipped `llm-deepseek` row's `apiKeyEnv` default. */
export const DEFAULT_CREDENTIAL_REF = 'DEEPSEEK_API_KEY'

/** Default largest serialized `dsh_session_log` field, matching the shipped uploader. */
export const DEFAULT_MAX_BYTES = 8388608

/** The credential-reference grammar accepted by the credentials service. */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

const MODE_SET = new Set(MODES)

/**
 * Whether a value is one of the four frozen mode ids.
 * @param value candidate.
 * @returns `true` for `off`, `official-only`, `deepseek-any-provider`, or `any-model`.
 */
export function isMode(value) {
  return typeof value === 'string' && MODE_SET.has(value)
}

/**
 * Whether a value is an accepted credential reference (`^[A-Za-z_][A-Za-z0-9_]*$`).
 * @param value candidate.
 * @returns `true` when the credentials service would accept the reference.
 */
export function isCredentialRef(value) {
  return typeof value === 'string' && CREDENTIAL_REF_PATTERN.test(value)
}

/** A non-empty string, or `undefined`. */
function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read one **own** property of the raw config, or `undefined` when it is absent.
 *
 * Prototype-chain reads are refused on purpose: `Object.prototype.mode = 'any-model'` would otherwise
 * make the default (the case where `mode` is absent) resolve to a widened mode, and a polluted
 * `endpoint` could redirect the log-only POST. See verify/REPORT.md F3.
 *
 * @param raw the raw config object.
 * @param key the property name.
 * @returns the own value, or `undefined`.
 */
function own(raw, key) {
  return Object.hasOwn(raw, key) ? raw[key] : undefined
}

/**
 * Read a possibly-live config value.
 *
 * `mode`, `endpoint` and `maxBytes` are declared `.volatile()`, and Cordis replaces a volatile field
 * with a frozen reference (`{ get(): T, [Symbol.for("cosmokit.volatile.write")](value): void }`) whose
 * owning runtime commits later writes into it. Such a value must be read at use time — calling `get()`
 * — rather than captured once, or a settings-form write would be invisible until the row restarts.
 *
 * Any other value is returned unchanged: the remaining keys are not volatile and stay plain.
 *
 * @param value the value read from the raw config.
 * @returns the current value of a live reference, or the value itself.
 */
function readLive(value) {
  if (value === null || typeof value !== 'object') return value
  if (!(VOLATILE_WRITE in value) && typeof value.get !== 'function') return value
  try {
    return typeof value.get === 'function' ? value.get() : undefined
  } catch {
    return undefined
  }
}

/**
 * Normalize the model-id pattern list.
 *
 * Absent/null keeps the fallback. A single non-empty string is accepted as a one-element list (a
 * scalar written where a sequence was meant is the obvious intent). An array keeps only its
 * non-empty string entries, so an entry of the wrong type can only narrow the match. Any other
 * shape keeps the fallback.
 *
 * Patterns are **not** trimmed: they are matched verbatim (case-insensitively) against the model
 * id, so a stray space stays part of the pattern.
 *
 * @param value raw value.
 * @param fallback patterns to keep when the value is absent or unusable.
 * @returns a fresh array; never the caller's array.
 */
function normalizePatterns(value, fallback) {
  if (value === undefined || value === null) return [...fallback]
  if (typeof value === 'string') return value.length > 0 ? [value] : []
  if (Array.isArray(value)) {
    return value.filter((pattern) => typeof pattern === 'string' && pattern.length > 0)
  }
  return [...fallback]
}

/** A positive integer byte cap, or `undefined` when the value is unusable. */
function normalizeMaxBytes(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined
}

/**
 * THE ENDPOINT NARROWING RULE — stated exactly, because `client.js` mirrors it so the page can show
 * the destination the plugin will really use, and `verify/` asserts the two agree. The same rule is
 * the transport guard in `host/upload.js` (`isAbsoluteHttpEndpoint`).
 *
 * ACCEPTED: a string of length > 0 whose first characters are `http://` or `https://`, tested
 * case-insensitively. Nothing else is checked: no trimming, no `new URL()` parse, no host or path
 * validation. So `'HTTP://X'`, `'http://127.0.0.1:1234/v1/messages'` and `'https:// '` are all accepted
 * verbatim. Because it is a pure prefix test, **trailing** whitespace is accepted
 * (`'https://ok.example '`; `fetch`'s own URL parser ignores it) while **leading** whitespace is not
 * (`' https://ok.example'` falls back).
 *
 * FALLS BACK to `DEFAULT_ENDPOINT` (`https://api.deepseek.com/anthropic/v1/messages`): an absent or
 * inherited-only value; `undefined`/`null`; the empty string; any non-string (number, boolean, object,
 * array); any other scheme (`ftp://`, `file://`, `javascript:`, `data:`); scheme-relative (`//host/x`);
 * malformed (`https:/host`); and any value whose first character is not that prefix, including leading
 * whitespace.
 *
 * A live volatile reference is unwrapped first (see `readLive`); the rule then applies to the value it
 * holds, so a reference yielding anything unusable falls back exactly as a plain value would.
 *
 * @param value candidate destination.
 * @returns the value verbatim when accepted, otherwise `undefined` (the caller applies the default).
 */
function normalizeEndpoint(value) {
  const text = nonEmptyString(value)
  if (text === undefined) return undefined
  return /^https?:\/\//i.test(text) ? text : undefined
}

/** A complete defaulted configuration object (fresh on every call). */
function defaults() {
  return {
    mode: DEFAULT_MODE,
    deepseekModelPatterns: [...DEFAULT_DEEPSEEK_MODEL_PATTERNS],
    endpoint: DEFAULT_ENDPOINT,
    uploadModel: DEFAULT_UPLOAD_MODEL,
    credentialRef: DEFAULT_CREDENTIAL_REF,
    maxBytes: DEFAULT_MAX_BYTES,
  }
}

/**
 * Resolve the row's raw config into the plugin's frozen configuration shape.
 *
 * Never throws: any unexpected failure returns the full default set, whose mode (`official-only`)
 * is the narrowest behaviour that still matches a stock DSH installation.
 *
 * Call it at use time, not once at startup: `mode`, `endpoint` and `maxBytes` are volatile, and the
 * values returned here are what their live references hold at this instant, so a settings write is
 * visible immediately.
 *
 * @param raw the row's raw `config` value from the Loader (any type).
 * @returns `{mode, deepseekModelPatterns, endpoint, uploadModel, credentialRef, maxBytes}`.
 */
export function resolveConfig(raw) {
  try {
    const resolved = defaults()
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return resolved

    // The three volatile fields are unwrapped; the rest are plain and read directly.
    const mode = readLive(own(raw, 'mode'))
    if (isMode(mode)) resolved.mode = mode
    resolved.deepseekModelPatterns = normalizePatterns(own(raw, 'deepseekModelPatterns'), resolved.deepseekModelPatterns)

    const endpoint = normalizeEndpoint(readLive(own(raw, 'endpoint')))
    if (endpoint !== undefined) resolved.endpoint = endpoint
    const uploadModel = nonEmptyString(own(raw, 'uploadModel'))
    if (uploadModel !== undefined) resolved.uploadModel = uploadModel
    const credentialRef = nonEmptyString(own(raw, 'credentialRef'))
    if (credentialRef !== undefined && isCredentialRef(credentialRef)) resolved.credentialRef = credentialRef
    const maxBytes = normalizeMaxBytes(readLive(own(raw, 'maxBytes')))
    if (maxBytes !== undefined) resolved.maxBytes = maxBytes

    return resolved
  } catch {
    return defaults()
  }
}
