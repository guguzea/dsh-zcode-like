/**
 * Pure upload-eligibility decisions for the `session-log-upload` host row.
 *
 * Contract (INTERFACES.md §5): `decideUpload(...) -> 'shipped' | 'ours' | 'none'` and
 * `suppressShipped(mode) -> boolean`. Both are pure and total: `decideUpload` still returns one of
 * its three answers when a property read of its argument throws.
 *
 * The frozen behaviour matrix (INTERFACES.md §5) this encodes:
 *
 * | mode                  | deepseek-official / deepseek-account | any other provider              |
 * |-----------------------|--------------------------------------|---------------------------------|
 * | `off`                 | none — suppressed by our exclusion   | none                            |
 * | `official-only`       | shipped — status quo, we do nothing  | none                            |
 * | `deepseek-any-provider`| shipped — no duplicate              | model id matches ⇒ ours         |
 * | `any-model`           | shipped — no duplicate               | ours                            |
 *
 * Two readings of the task text were possible for `official-only` + an official route: the matrix
 * above says the shipped plugin still uploads there (status quo), so this module reports `shipped`
 * — "not ours, somebody else owns it" — rather than `none`. Either way this plugin uploads nothing
 * on that row, which is the behaviour that matters. See the implementation report.
 *
 * `hasSession !== true` always decides `none`: the shipped uploader requires a live Session too, so
 * a session-less request is uploaded by nobody, and claiming `shipped` for it would be untrue.
 *
 * No imports, no I/O, no module-level mutable state.
 */

/** Provider routes served by the shipped official DeepSeek adapters. */
export const OFFICIAL_PROVIDER_ROUTES = ['deepseek-official', 'deepseek-account']

const OFFICIAL_PROVIDER_SET = new Set(OFFICIAL_PROVIDER_ROUTES)

/**
 * Whether the shipped official-API upload must be suppressed for a mode.
 * @param mode a resolved mode id.
 * @returns `true` only for `off`.
 */
export function suppressShipped(mode) {
  return mode === 'off'
}

/**
 * Case-insensitive substring match of a model id against the configured patterns.
 *
 * Matching is against the **model id only** (never the provider name), as INTERFACES.md §3 fixes.
 *
 * @param model the served model id.
 * @param patterns non-empty substrings, matched case-insensitively.
 * @returns `true` when any pattern is a substring of the model id.
 */
export function matchesDeepseekModel(model, patterns) {
  if (typeof model !== 'string' || model.length === 0) return false
  if (!Array.isArray(patterns)) return false
  const candidate = model.toLowerCase()
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.length === 0) continue
    if (candidate.includes(pattern.toLowerCase())) return true
  }
  return false
}

/**
 * Decide who uploads the log for one model request.
 *
 * Total by construction (INTERFACES.md §5): a hostile argument — including one whose `mode`,
 * `provider`, `model`, `hasSession` or `patterns` getter throws — decides `none` rather than
 * propagating, so the caller's model-request path can never be broken by this predicate.
 *
 * @param request decision inputs; every field is tolerated as malformed.
 * @param request.mode resolved mode id; an unknown or missing mode never uploads.
 * @param request.provider the provider route that served (or will serve) the request.
 * @param request.model the served model id.
 * @param request.hasSession whether the request carries a Live Session id.
 * @param request.patterns configured model-id patterns (mode `deepseek-any-provider` only).
 * @param request.directoryAllowed whether the Session's working directory is inside the configured
 *   upload allowlist. An empty allowlist means "no restriction" and is computed by the caller, so this
 *   flag is `true` unless the user actually narrowed it. Checked **first** and in every mode: it is the
 *   one input here that can only ever remove an upload, and it must apply before the mode matrix so a
 *   Session outside the allowlist is never ours in any mode. The shipped-upload side of the same
 *   allowlist lives in `index.js` (its exclusion predicate), because in some modes the shipped
 *   uploader — not this plugin — owns the request.
 * @returns `'shipped'` (the shipped plugin owns it), `'ours'` (this plugin uploads), or `'none'`.
 */
export function decideUpload(request) {
  try {
    const { mode, provider, model, hasSession, patterns, directoryAllowed } = request === null || request === undefined ? {} : request

    // Absolute, and ahead of every other rule: outside the allowlist, nothing of ours is uploaded in
    // any mode. Only a literal `false` narrows — an absent flag means the caller had no allowlist to
    // apply, and must not be read as "not allowed" or every upload would stop.
    if (directoryAllowed === false) return 'none'

    if (hasSession !== true) return 'none'
    if (mode === 'off') return 'none'
    if (mode !== 'official-only' && mode !== 'deepseek-any-provider' && mode !== 'any-model') return 'none'

    const official = typeof provider === 'string' && OFFICIAL_PROVIDER_SET.has(provider)
    if (official) return 'shipped'

    if (mode === 'any-model') return 'ours'
    if (mode === 'deepseek-any-provider') return matchesDeepseekModel(model, patterns) ? 'ours' : 'none'
    return 'none'
  } catch {
    // A throwing getter (verify/REPORT.md F9) decides nothing rather than escaping.
    return 'none'
  }
}
