/**
 * `@local/dsh-session-log-upload` — host half.
 *
 * Chooses when DSH uploads Session logs to DeepSeek. See `INTERFACES.md` and `docs/api-dossier.md`.
 *
 * Dependency-free by construction (INTERFACES.md §0): only `node:*` builtins and relative imports,
 * plus the single absolute-`file://` import of the schema builder that ships inside the running
 * Harness (see `Config` below). The row's raw `cordis.patch.yml` config is always read and defaulted
 * by `host/config.js`, so the plugin works with or without that schema.
 *
 * Responsibilities owned here: `apply`, `inject`, the `llm/stream` hook, the `sessionLogDeepSeek`
 * exclusion, the `configEditor` self-write, the harness attribution headers of the log-only POST, and
 * the `/session-log-upload` human command.
 *
 * Invariants:
 *   - nothing is registered at module load; every registration happens inside `apply` through
 *     `ctx.effect` / `ctx.on`, and `apply` returns one cleanup that disposes them all;
 *   - no hook ever throws: a broken upload can never break a model request;
 *   - the model-request path never awaits: the log is built and POSTed fire-and-forget, with
 *     in-flight de-duplication per Session id.
 *   - the volatile fields (`mode`, `endpoint`, `maxBytes`) are read live, through `currentConfig()`,
 *     and never captured at load: a settings write must take effect without a row restart, in both
 *     directions;
 *   - the `off` exclusion needs only `sessionLogDeepSeek`, never `llm`: the strongest privacy
 *     setting must keep working in a composition that has no `llm` service (REPORT.md F5).
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  MODES,
  DEFAULT_CREDENTIAL_REF,
  DEFAULT_DEEPSEEK_MODEL_PATTERNS,
  DEFAULT_ENDPOINT,
  DEFAULT_UPLOAD_DIRECTORIES,
  DEFAULT_UPLOAD_SESSION_IDS,
  DEFAULT_FOREIGN_SESSION_IDS,
  DEFAULT_MAX_BYTES,
  DEFAULT_UPDATE_URL,
  DEFAULT_UPLOAD_MODEL,
  isUploadAllowed,
  resolveConfig,
} from './host/config.js'
import { decideUpload, suppressShipped } from './host/eligibility.js'
import { buildLogField, jsonBytes } from './host/logfield.js'
import { FailureStore } from './host/failure.js'
import { scanAll, readForeignSession } from './host/foreign/index.js'
import { ScanCache } from './host/foreign/cache.js'
import { forgeSession, buildForeignField } from './host/foreign-forge.js'
import { NoticeStore } from './host/notice.js'
import { applyUpdate, checkUpdate } from './host/update.js'
import { WatermarkStore, defaultWatermarkDirectory } from './host/watermark.js'
import { uploadLogField } from './host/upload.js'

/**
 * The four frozen mode ids as one anchored alternative (INTERFACES.md §1, §3), kept in step with
 * {@link MODES} so the schema and the resolver can never disagree.
 */
const MODE_PATTERN = new RegExp(`^(?:${MODES.map((mode) => mode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`)

/**
 * The `mode` field: a volatile string constrained to the four frozen ids.
 *
 * Without the constraint any string validates: a typo such as `offf` reaches `resolveConfig`, which
 * silently narrows it to `official-only`, and the shipped official-API upload is switched back **on**
 * — the wrong failure direction for the one setting that is supposed to stop uploads. With it, the
 * settings service rejects the write and the user is told why.
 *
 * Built defensively: a builder whose `pattern` support is missing or throws costs us the constraint
 * only, never the schema — an unconstrained field is exactly the behaviour shipped before, and the
 * volatile marker (the one thing the settings page cannot do without) is applied in both paths.
 *
 * @param z the resolved schema builder.
 * @returns the mode field schema.
 */
function modeField(z) {
  let field
  try {
    field = z.string().pattern(MODE_PATTERN)
  } catch {
    field = z.string()
  }
  return field.default('official-only').volatile()
}

/**
 * Optional `Config`.
 *
 * The settings surface only manages profile entries that declare a schema carrying volatile fields:
 * `dsh-settings`' `describe()` skips every entry whose `Config` is undefined, and a write to such an
 * entry throws `No configurable plugin entry`. Without a schema the settings page can therefore
 * neither read nor write the mode — it renders and then fails on click.
 *
 * The schema builder is `@deepseek-ai/schemastery`, which is **not** resolvable as a bare specifier
 * from a profile-installed bundle (INTERFACES.md §0). The only candidate is therefore the copy that
 * ships inside the running Harness, reached by absolute `file://` URL derived from Electron's
 * `process.resourcesPath` — no bare specifier appears anywhere in this bundle.
 *
 * A non-Electron or CLI run has no such copy, so the export stays `undefined` and the row degrades to
 * the supported no-schema posture: the raw `cordis.patch.yml` config is defaulted by `resolveConfig`
 * and the mode is changed with the `/session-log-upload` command. The export itself is always
 * declared, so no composition fails to load for want of a builder.
 *
 * `mode`, `endpoint` and `maxBytes` are volatile, because the settings page can only ever see volatile
 * fields (the rule is spelled out inside the declaration below); that is also why those three arrive in
 * `apply` as live references rather than plain values — see `host/config.js`. `deepseekModelPatterns`,
 * `uploadModel` and `credentialRef` stay non-volatile and patch-only.
 */
let Config
try {
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    const specifier = pathToFileURL(
      join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'),
    ).href
    const loaded = await import(specifier)
    const z = loaded.default ?? loaded
    if (typeof z?.object === 'function') {
      Config = z.object({
        // THE RULE: a field is either volatile (visible in the settings page **and** writable through
        // the settings RPC) or invisible to the page. There is no read-only middle ground —
        // `dsh-settings.describe()` ships the browser only `volatileForm(schema)`, so a non-volatile
        // field never reaches it, not even its default. Hence:
        //   - `mode`: the consent switch itself; the settings wire must be able to write it.
        //   - `endpoint`: consent-critical. The confirmation dialog is required to name the
        //     destination, and a blank destination is a consent failure in the dangerous direction.
        //   - `maxBytes`: informational in the page (the effective per-request byte cap).
        // Each of the three is handed to `apply` as a live reference, so `index.js` reads them **per
        // use** (never once at startup) and `resolveConfig` unwraps them all.
        //
        // Blast radius, accepted deliberately: volatility widens the settings RPC's write surface to
        // these three fields, so a browser-side actor could repoint `endpoint`. A truthful destination
        // in the consent dialog matters more than that; the value is shown to the user there, and
        // `host/upload.js` refuses outright to POST anywhere but an absolute HTTP(S) URL (its THE
        // ENDPOINT RULE, the same rule `resolveConfig`'s narrowing applies).
        //
        // VOLATILE SCHEMA COUPLING — weigh this before adding another constraint. A schema constraint
        // that a *patch* value violates does not degrade gracefully: `Entry.update` does not catch the
        // ValidationError, `_commitVolatile` warns and skips, and the ordinary update path throws
        // inside `fiber.resolveConfig`, so the entry **fails to activate**. `apply` then never runs —
        // which means the `mode: off` exclusion is never registered and the shipped official-API upload
        // **resumes**. A typo in a constrained field therefore silently re-enables the very upload the
        // user asked to stop. That is why:
        //   - `mode`'s four-id `pattern` is kept anyway: it stops the settings RPC storing junk, and
        //     the value is the consent switch itself, so a typo there is worth failing loudly;
        //   - `maxBytes`'s `.min(1)` carries the same coupling (a non-integer or < 1 cap deactivates
        //     the row) but is accepted as the price of a typed numeric field;
        //   - `endpoint` is deliberately an **unconstrained** `z.string()`:
        //     a malformed `endpoint` must not deactivate the row, so a bad value degrades safely instead —
        //     `resolveConfig`'s narrowing plus `host/upload.js`'s hard transport refusal. Do not add it back.
        // The defaults below are **the same constants `host/config.js` narrows to**, not literals.
        // They used to be literals in both places, and the two copies drifted: the schema said
        // `deepseek-chat` (an undocumented legacy alias, absent from `GET /models`) while the resolver
        // said `deepseek-flash`, so the row handed the POST a model name the code did not intend and
        // nothing on screen showed it. One definition, imported, makes that impossible.
        mode: modeField(z),
        // Both lists are permissive `z.array(z.string())` for the coupling reason above: a shape
        // constraint here would deactivate the row on a bad value and thereby disarm `off`.
        // `deepseekModelPatterns` is volatile so the user can say "this proxy's `dfmodel` is DeepSeek".
        deepseekModelPatterns: z.array(z.string()).default([...DEFAULT_DEEPSEEK_MODEL_PATTERNS]).volatile(),
        uploadDirectories: z.array(z.string()).default([...DEFAULT_UPLOAD_DIRECTORIES]).volatile(),
        uploadSessionIds: z.array(z.string()).default([...DEFAULT_UPLOAD_SESSION_IDS]).volatile(),
        // Ticked other-harness conversations. A separate list on purpose: it records a choice on the
        // import page and never widens what may be done to a DSH Session. Same permissive shape for the
        // same coupling reason.
        foreignSessionIds: z.array(z.string()).default([...DEFAULT_FOREIGN_SESSION_IDS]).volatile(),
        endpoint: z.string().default(DEFAULT_ENDPOINT).volatile(),
        uploadModel: z.string().default(DEFAULT_UPLOAD_MODEL),
        credentialRef: z.string().default(DEFAULT_CREDENTIAL_REF),
        maxBytes: z.number().step(1).min(1).default(DEFAULT_MAX_BYTES).volatile(),
        // Where in-app updates come from. Volatile so the page can show it and a user can point it at a
        // fork or mirror; an unusable value narrows back to the default, and the updater refuses a
        // non-http(s) address again before any fetch.
        updateUrl: z.string().default(DEFAULT_UPDATE_URL).volatile(),
      })
    }
  }
} catch {
  Config = undefined
}
export { Config }

// ── Harness attribution for the log-only POST ───────────────────────────────────────────────────
// The shipped official adapter sends three attribution headers on its Messages request
// (`@deepseek-ai/dsh-llm-deepseek/lib/index.js:2236-2246`):
//   `user-agent`                    ← `attributionHeaders()` from `@deepseek-ai/dsh-llm` (`:4`, `:877`)
//   `x-deepseek-harness-user-id`    ← `this.dependencies.resolveUserId()`, wired at `:2709` to
//                                     `getOrCreateAnonymousUserId()` (imported at `:13` from
//                                     `@deepseek-ai/dsh-anonymous-user-id`)
//   `x-deepseek-harness-session-id` ← `String(options.sessionId)`, only when the request has an id
// (`x-deepseek-harness-compact` is sent only when `requestIdentity.purpose === 'compaction'`, which
// our log-only POST never is, so we never send it.)
//
// The upload should be attributable the same way, so we mirror exactly those three and nothing else.
// Every step is strictly best-effort: an unavailable module, a failed import or a throwing helper
// omits that header and the upload proceeds. We never invent a value (in particular we never mint an
// id) and never send an empty string as if it were one. The User-Agent is the only value we can also
// compose ourselves, and only from the Harness's own manifest (`APP_IDENTITY`'s frozen product/url
// plus the shipped version), so the fallback produces the same string rather than a guess.

/** `product`/`url` of the shipped `APP_IDENTITY` (`@deepseek-ai/dsh-llm/lib/index.js:855-859`). */
const ATTRIBUTION_PRODUCT = 'deepseek-harness'
const ATTRIBUTION_URL = 'https://github.com/deepseek-ai/deepseek-harness'

/** Absolute `file://` URL of one file inside the running Harness, or `undefined` off-Electron. */
function harnessFileUrl(...segments) {
  if (typeof process.resourcesPath !== 'string' || process.resourcesPath.length === 0) return undefined
  return pathToFileURL(
    join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', ...segments),
  ).href
}

/**
 * The `user-agent` for one identity version: `product/version (+url)`, byte-identical to what the
 * shipped `userAgent(APP_IDENTITY)` renders (`@deepseek-ai/dsh-llm/lib/index.js:867-869`).
 *
 * @param version the `@deepseek-ai/dsh-llm` manifest version.
 * @returns the header value, or `undefined` when the version is unusable.
 */
export function buildAttributionUserAgent(version) {
  if (typeof version !== 'string' || version.trim().length === 0) return undefined
  return `${ATTRIBUTION_PRODUCT}/${version} (+${ATTRIBUTION_URL})`
}

/**
 * The `user-agent` the shipped adapter sends: `attributionHeaders()` → `userAgent(APP_IDENTITY)`
 * (`@deepseek-ai/dsh-llm/lib/index.js:867-869`), e.g.
 * `deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)`.
 *
 * @returns the value, or `undefined` when it cannot be obtained. Never throws.
 */
async function loadAttributionUserAgent() {
  const moduleUrl = harnessFileUrl('dsh-llm', 'lib', 'index.js')
  if (moduleUrl !== undefined) {
    try {
      const loaded = await import(moduleUrl)
      const headers = typeof loaded.attributionHeaders === 'function' ? loaded.attributionHeaders() : undefined
      const value = headers === null || headers === undefined ? undefined : headers['user-agent']
      if (typeof value === 'string' && value.trim().length > 0) return value
    } catch {
      /* fall through to the manifest mirror */
    }
  }
  // Fallback: the same string, composed from the shipped manifest's real version. `version` is a
  // `package.json` field, and `./package.json` is an export of `@deepseek-ai/dsh-llm` (`:849`).
  try {
    const manifestUrl = harnessFileUrl('dsh-llm', 'package.json')
    if (manifestUrl === undefined) return undefined
    const version = JSON.parse(readFileSync(new URL(manifestUrl), 'utf8')).version
    return buildAttributionUserAgent(version)
  } catch {
    /* no manifest, no user-agent */
  }
  return undefined
}

/**
 * The `x-deepseek-harness-user-id` the shipped adapter sends: the harness home's **anonymous** user
 * id (`@deepseek-ai/dsh-anonymous-user-id/lib/index.js:50`), a random UUID persisted in
 * `$DSH_HOME/.anonymous-user-id` (or `~/.dsh/...`), memoized per process and shared by every process
 * using that home — so it matches the id the shipped uploader would report.
 *
 * `ctx.get('deepseekAccount').getDeviceIdentity()` is deliberately **not** used: it returns an
 * account-linked `{ deviceId, userId, osVersion }` (`dsh-deepseek-account-platform/lib/index.js:772`)
 * the shipped adapter never sends, i.e. a stronger identifier than the one being mirrored. There is
 * no Service for the anonymous id, so it is obtained exactly as the adapter does.
 *
 * @returns the id, or `undefined`. Never throws. Best-effort: the helper creates the id file on first
 *   use, which is the shipped behaviour, and a read-only home still yields a usable id.
 */
async function loadAttributionUserId() {
  const moduleUrl = harnessFileUrl('dsh-anonymous-user-id', 'lib', 'index.js')
  if (moduleUrl === undefined) return undefined
  try {
    const loaded = await import(moduleUrl)
    const value = typeof loaded.getOrCreateAnonymousUserId === 'function' ? loaded.getOrCreateAnonymousUserId() : undefined
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolution probe: does one absolute `file://` import into the running installation succeed and
 * expose the named helper?
 *
 * This is the one claim the unit tests cannot settle — plain Node cannot read inside `app.asar` — so
 * the ledger reports it from inside the real process, without sending anything and without an upload.
 * It only *imports*; it never calls the helper (see {@link probeAttributionResolvable}).
 *
 * @param segments path segments below `.../@deepseek-ai/`.
 * @param exportName the export that must be a function.
 * @returns `true` when the import resolves and the export is callable; `false` on any failure.
 */
async function moduleExposesHelper(segments, exportName) {
  const moduleUrl = harnessFileUrl(...segments)
  if (moduleUrl === undefined) return false
  try {
    const loaded = await import(moduleUrl)
    return typeof loaded?.[exportName] === 'function'
  } catch {
    return false
  }
}

/**
 * Probe both attribution helpers. Booleans only — the values themselves are never read here.
 *
 * `getOrCreateAnonymousUserId()` is deliberately **not called**: it *creates* `$DSH_HOME/.anonymous-user-id`
 * on first use, and a read-only probe must not mint an identity merely to answer a question. The probe
 * therefore answers the resolution question only; a real upload still obtains the id exactly as the
 * shipped adapter does, and may create the file at that point, which is the shipped behaviour.
 *
 * @returns `{userAgent, userId}`; never throws.
 */
async function probeAttributionResolvable() {
  try {
    const [userAgent, userId] = await Promise.all([
      moduleExposesHelper(['dsh-llm', 'lib', 'index.js'], 'attributionHeaders'),
      moduleExposesHelper(['dsh-anonymous-user-id', 'lib', 'index.js'], 'getOrCreateAnonymousUserId'),
    ])
    return { userAgent: userAgent === true, userId: userId === true }
  } catch {
    return { userAgent: false, userId: false }
  }
}

/**
 * Compose the attribution header set from values that have already been obtained.
 *
 * Total by construction: it never throws and it omits any value that is not a non-empty string, so a
 * missing or malformed value can never turn into a header and can never fail an upload.
 *
 * @param input `{userAgent, userId, sessionId}`; anything else is tolerated.
 * @returns the headers to merge into the log-only request (possibly `{}`).
 */
export function composeAttributionHeaders(input) {
  try {
    const source = input === null || input === undefined || typeof input !== 'object' ? {} : input
    const headers = {}
    const userAgent = source.userAgent
    if (typeof userAgent === 'string' && userAgent.trim().length > 0) headers['user-agent'] = userAgent
    const userId = source.userId
    if (typeof userId === 'string' && userId.trim().length > 0) headers['x-deepseek-harness-user-id'] = userId
    const sessionId = source.sessionId
    if (typeof sessionId === 'string' && sessionId.trim().length > 0) headers['x-deepseek-harness-session-id'] = sessionId
    return headers
  } catch {
    return {}
  }
}

/** Cordis plugin name; the Loader row id (`session-log-upload`) is the settings namespace. */
export const name = 'session-log-upload'

/**
 * `sessionLogDeepSeek` is the shipped official-API uploader whose exclusion registry we own; the row
 * stays **inactive** in a profile that does not mount it, instead of throwing.
 *
 * `llm` is deliberately **not** listed: it is needed only by the `llm/stream` hook of the two wide
 * modes, while the `mode: off` exclusion must be registered whenever `sessionLogDeepSeek` exists.
 * Listing `llm` here would make the strongest privacy setting silently inactive — and therefore fail
 * *open* — in a composition that has no `llm` service (verify/REPORT.md F5). The hook is instead
 * installed on a child fiber created with `ctx.inject(['llm'], …)`, which activates exactly when
 * `llm` is available.
 *
 * `configEditor`, `commands`, `credentials` and `sessions` are read with `ctx.get(...)` and tolerated
 * as absent.
 */
export const inject = ['sessionLogDeepSeek']

/** Public command name (INTERFACES.md §2). */
export const COMMAND_NAME = 'session-log-upload'

/**
 * The exact second token that confirms a move to a wider mode (INTERFACES.md §1 rule 2).
 * Compared case-insensitively after trimming, and required before any write.
 */
export const CONFIRM_WORD = 'confirm'

/**
 * The `/session-log-upload` argument that prints the upload ledger into the conversation. This is the
 * zero-new-surface fallback for the Settings view: it works in every composition, including headless
 * ones where no connection service exists.
 */
export const LEDGER_ARGUMENT = 'uploaded'

/**
 * The connection Fetch route the Settings page reads the ledger from.
 *
 * It is registered on Connection's exact Fetch registry — never on the raw web server, which is
 * unauthenticated (`docs/state-channel.md` §2.3) — so it inherits the connection's browser-credential
 * check: a request without the page cookie is refused with 401 before any handler runs (measured
 * against a shipped `/api/...` route, `docs/state-channel.md` §2.4). This mirrors
 * `@deepseek-ai/dsh-session-log-export`'s `/api/session.markdown` registration exactly.
 */
export const LEDGER_ROUTE_PATH = '/api/session-log-upload.ledger'

/**
 * The scan route: the working directories of the live Sessions, so the settings page can offer a
 * folder list instead of making a user type paths. Same authenticated Connection Fetch registry as the
 * ledger, for the same reason (see {@link registerLedgerRoute}).
 */
export const SCAN_ROUTE_PATH = '/api/session-log-upload.scan'

/**
 * The liability-notice route: `GET` reports whether the acknowledgement is on file, `POST` records it.
 *
 * Authenticated like the others, which matters more here than anywhere else: an unauthenticated POST
 * would let any local process dismiss the notice on the user's behalf.
 */
export const NOTICE_ROUTE_PATH = '/api/session-log-upload.notice'

/**
 * The other-harness import: `GET` lists the conversations other agent harnesses stored on this machine,
 * `POST` sends one of them.
 *
 * These live behind the same authenticated registry as the ledger. The scan reports conversation
 * metadata only (titles, directories, model names, message counts); the POST is the one place in this
 * plugin that reads a foreign conversation's content, and it only ever does so for the exact id the page
 * asked for.
 */
export const FOREIGN_SCAN_ROUTE_PATH = '/api/session-log-upload.foreign-scan'

/** The other-harness send route: `POST {id}` sends exactly one conversation, so progress and errors map
 * to a row instead of to a batch that may have half-succeeded. */
export const FOREIGN_UPLOAD_ROUTE_PATH = '/api/session-log-upload.foreign-upload'

/**
 * The in-app update: `GET` checks the manifest, `POST` performs the replacement.
 *
 * A GET must never write, so the two verbs are split rather than one route with a body flag. Both sit on
 * the authenticated registry: an unauthenticated POST here would let any local process replace the
 * plugin's own code.
 */
export const UPDATE_CHECK_ROUTE_PATH = '/api/session-log-upload.update-check'

/** The update apply route: `POST {}` downloads, verifies, backs up and replaces this plugin's files. */
export const UPDATE_APPLY_ROUTE_PATH = '/api/session-log-upload.update-apply'

/** The directory this plugin runs from: the one holding index.js and package.json. */
const PLUGIN_DIRECTORY = fileURLToPath(new URL('.', import.meta.url))

/**
 * Deadline for one update check or apply, in milliseconds.
 *
 * Without it a hung manifest or file request would hold the updater's module-wide `applying` flag until
 * the socket gave up, and every later attempt would be refused as `already-running`. The whole payload is
 * well under a megabyte, so two minutes is generous.
 */
export const UPDATE_TIMEOUT_MS = 120000

/**
 * How much of one foreign conversation an import reads before giving up, in bytes.
 *
 * This is deliberately NOT `maxBytes`. `maxBytes` caps one *request*, and the send loop already splits a
 * long conversation across several of them; using it as the read budget would silently cut every
 * conversation at one request's worth and lose the tail with no error anywhere. 64 MiB covers the largest
 * conversation measured on this machine (about 51 MB of JSON) with room to spare, while still bounding what
 * one import can pull into memory.
 */
export const FOREIGN_READ_BYTES = 64 * 1024 * 1024

/** Most ledger rows the `/session-log-upload uploaded` listing prints before it summarises the rest. */
export const MAX_LEDGER_LINES = 50

/**
 * The two modes that widen collection and therefore require the confirmation step (INTERFACES.md §1
 * rule 2). Exported **frozen** so that no importer can disarm the gate by mutating shared state, and
 * read through {@link isWideMode} rather than by the gate itself.
 */
export const WIDE_MODES = Object.freeze(['deepseek-any-provider', 'any-model'])

/**
 * Whether a mode widens collection, i.e. whether moving to it needs the confirmation step.
 * @param mode the candidate mode id.
 * @returns `true` for `deepseek-any-provider` and `any-model`.
 */
export function isWideMode(mode) {
  return WIDE_MODES.includes(mode)
}

/**
 * The harness's official DeepSeek Messages base, byte-identical to what the shipped adapters default
 * to (`@deepseek-ai/dsh-llm-deepseek/lib/index.js:441`), and the value the account route passes to
 * `resolveToken` for its own requests (`dsh-llm-deepseek-account/lib/index.js:82`). Our default
 * endpoint is this base plus `/v1/messages` (`messagesApiRoot`, `dsh-llm-deepseek/lib/index.js:579-582`).
 */
export const OFFICIAL_DEEPSEEK_BASE = 'https://api.deepseek.com/anthropic'

/** Auth header of the `deepseek-official` route (the stored API key). */
export const API_KEY_HEADER = 'x-api-key'

/** Auth header of the `deepseek-account` route (the DeepSeek account token). */
export const ACCOUNT_TOKEN_HEADER = 'x-dsh-auth-token'

/**
 * Whether a destination is the harness's official DeepSeek base or a path beneath it.
 *
 * THE ACCOUNT-TOKEN GATE. `endpoint` is user-editable and may point at the user's own collector; the
 * DeepSeek **account token** must never travel there. Only the official origin, on `https://`, with a
 * path under `/anthropic`, qualifies — so a look-alike host, a plaintext `http://` downgrade, a
 * sibling path on the same host, or a path that merely starts with the same characters is refused, and
 * then the account fallback is simply not offered.
 *
 * @param endpoint the effective destination.
 * @returns `true` only for the official base (or a path beneath it).
 */
export function isOfficialDeepSeekEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) return false
  try {
    const url = new URL(endpoint)
    return (
      url.origin === 'https://api.deepseek.com' &&
      url.username === '' &&
      url.password === '' &&
      (url.pathname === '/anthropic' || url.pathname.startsWith('/anthropic/'))
    )
  } catch {
    return false
  }
}

/** Deadline for one log-only POST, including a multi-megabyte body. */
export const UPLOAD_TIMEOUT_MS = 120000

/** A message from any thrown value. */
function messageOf(error) {
  if (error !== null && error !== undefined && typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

/**
 * Register the upload engine on one plugin context.
 * @param ctx the plugin context.
 * @param rawConfig the row's raw config from the Loader; always defaulted by `resolveConfig`.
 * @returns one cleanup disposing every registration made here.
 */
export function apply(ctx, rawConfig) {
  /**
   * Resolve the row config **on every use**.
   *
   * `mode`, `endpoint` and `maxBytes` are volatile schema fields, so Cordis hands them to `apply` as
   * live cosmokit references that the settings form commits into. Capturing the resolved object once at
   * startup would freeze those three for the life of the row: a settings write would then silently
   * revert the destination to the default (and the byte cap with it) — the same fail-open class already
   * closed for `mode`. The non-volatile keys (`deepseekModelPatterns`, `uploadModel`, `credentialRef`)
   * change only through a row restart, so re-resolving them costs nothing and is always correct.
   *
   * `resolveConfig` never throws and narrows every malformed or missing value to its default, so a
   * broken live reference can only ever make this *less* permissive or more conservative.
   */
  function currentConfig() {
    return resolveConfig(rawConfig)
  }
  /**
   * The mode **right now** — a volatile field, read at decision time so a settings write takes effect
   * in both directions without restarting the row.
   */
  function currentMode() {
    return currentConfig().mode
  }
  const disposers = []
  /** In-flight upload state per Session id: `{ pending }`. */
  const uploads = new Map()
  /** Abort controllers of live log-only requests, listened to on unload. */
  const controllers = new Set()
  const credentialDiagnostics = { warned: false }
  /**
   * Attribution report for the ledger: the header **names** a real accepted upload carried.
   *
   * In memory only — deliberately not persisted into `watermarks.json`, whose schema stays as it is —
   * and scoped to this loaded row, so a reload or restart starts empty. Empty until the first upload
   * this row is told succeeded: an empty report is honest, a claim is not, and the ledger omits the
   * field entirely while it is empty.
   *
   * Names only, never values: the `user-agent` string and the anonymous user id stay out of the
   * ledger, so the "metadata only" rule has no exception for someone to widen later.
   */
  let acceptedUploadAttribution
  /**
   * Memoized resolution probe for the ledger, per loaded row: `{userAgent: boolean, userId: boolean}`.
   *
   * Probing imports the two helper modules but never calls them, so it has no side effects (in
   * particular it cannot create the anonymous id file). It never rejects.
   */
  let attributionResolution
  function attributionResolvable() {
    attributionResolution ??= probeAttributionResolvable()
    return attributionResolution
  }

  /** Best-effort logger; a logging failure must never change behaviour. */
  function log(level, message) {
    try {
      const logger = ctx.logger
      if (logger !== null && logger !== undefined && typeof logger[level] === 'function') logger[level](message)
    } catch {
      /* ignore */
    }
  }

  const watermark = new WatermarkStore(defaultWatermarkDirectory(), {
    log: (message) => log('warn', message),
  })

  // The "why is nothing arriving" record: written on a failed attempt, cleared by an accepted one, and
  // surfaced in the detailed log. It reuses the watermark store's **resolved** directory rather than
  // calling `defaultWatermarkDirectory()` again: that keeps the two artifacts in exactly one plugin
  // directory (so `DSH_HOME` cannot be resolved twice and disagree) and keeps tests that inject a
  // directory from spilling into the real home.
  const failures = new FailureStore(watermark.directory, {
    log: (message) => log('warn', message),
  })

  // The "I have read this" record for the liability notice. Kept in the same directory as the other
  // owned artifacts, and outside `Config` on purpose: consent is not configuration, and a settings
  // write must not be able to toggle it.
  const notice = new NoticeStore(watermark.directory, {
    log: (message) => log('warn', message),
  })

  // The other-harness scan cache. Kept beside the watermark so it lives with the plugin's other owned
  // state: a scan is expensive (Qoder's first pass reads gigabytes to count messages), and without a
  // disk-backed cache every DSH restart paid that cost again. One instance per loaded row; the route
  // flushes it after each scan, and every write is atomic and total.
  const scanCache = new ScanCache(watermark.directory)

  // ── The official-API suppression for mode `off` ───────────────────────────────────────────────
  // Dossier §3.5: the exclusion predicate runs inside the `dsh_session_log` prepare callback, so
  // `true` suppresses both the field and its acceptance callback.
  //
  // The predicate is registered **unconditionally** (whenever `sessionLogDeepSeek` is present, which
  // the row's `inject` guarantees) and evaluated per request against the live mode. Two consequences
  // matter: selecting `off` immediately starts suppressing the shipped upload, and leaving `off`
  // immediately stops suppressing it — neither needs a row restart. It also closes the fail-open of
  // REPORT.md F5, because it never depended on `llm` in the first place.
  /**
   * Whether one Session is inside the configured upload allowlist.
   *
   * The rule lives in `host/config.js` (`isUploadAllowed`): **both** lists empty means "no restriction
   * — upload everything", which is why an unconfigured plugin behaves exactly as before. When either
   * list is non-empty a Session is allowed if it is explicitly ticked, or if its working directory is
   * covered — the two are ORed, so a single ticked conversation uploads out of an unticked workspace.
   *
   * The shipped registry calls the exclusion predicate synchronously with only `{sessionId, purpose}`
   * (`dsh-session-log-deepseek/lib/index.js:145-149`), so the cwd has to be looked up — it is not
   * handed to us. Total by construction: a missing `sessions` service or a throwing getter resolve to
   * "allowed", because refusing on doubt would silently stop uploads the user never asked to stop.
   * A *live* session with no working directory is a different case: with a directory list and no
   * Session tick it is not covered, so it is not uploaded (`isUploadAllowed` decides that).
   *
   * @param sessionId the Session id from the request, or anything else.
   * @returns `true` when the Session may be uploaded.
   */
  function isSessionDirectoryAllowed(sessionId) {
    try {
      const live = currentConfig()
      const directories = live.uploadDirectories
      const sessionIds = live.uploadSessionIds
      const hasDirectories = Array.isArray(directories) && directories.length > 0
      const hasSessions = Array.isArray(sessionIds) && sessionIds.length > 0
      // No allowlist configured: every Session is allowed, and there is no need to look one up.
      if (!hasDirectories && !hasSessions) return true
      if (typeof sessionId !== 'string' || sessionId.length === 0) return true
      // A ticked Session does not need its cwd looked up at all.
      if (hasSessions && sessionIds.includes(sessionId)) return true
      if (!hasDirectories) return false
      const sessions = ctx.get('sessions')
      if (sessions === null || sessions === undefined || typeof sessions.get !== 'function') return true
      const session = sessions.get(sessionId)
      if (session === null || session === undefined) return true
      const header = session.header
      if (header === null || header === undefined || typeof header !== 'object') return true
      return isUploadAllowed({ cwd: header.cwd, sessionId, directories, sessionIds })
    } catch {
      return true
    }
  }

  disposers.push(
    ctx.effect(() => {
      const registry = ctx.sessionLogDeepSeek
      if (registry === null || registry === undefined || typeof registry.registerExclusion !== 'function') {
        log('warn', 'session-log-upload: the sessionLogDeepSeek exclusion registry is unavailable; mode "off" cannot suppress the shipped upload')
        return undefined
      }
      // Two independent reasons to suppress the shipped upload:
      //   1. `off`, which stops everything;
      //   2. the user's directory allowlist. This half is **not** redundant with `decideUpload`: in
      //      `deepseek-any-provider`/`any-model` an official-provider request is reported as `shipped`,
      //      so the shipped uploader owns it. Gating only our own POST would leave a user who restricted
      //      uploads to one directory still uploading from every other — the opposite of what the page
      //      says the allowlist does.
      return registry.registerExclusion((request) => {
        const sessionId = request !== null && request !== undefined && typeof request === 'object' ? request.sessionId : undefined
        return suppressShipped(currentMode()) || !isSessionDirectoryAllowed(sessionId)
      })
    }, 'session-log-upload: suppress the shipped official-API upload'),
  )

  // ── Modes 3/4: our own upload for non-official providers ──────────────────────────────────────
  // Installed unconditionally too, and decided per request from the live mode, so widening the mode
  // starts working at once and narrowing it stops our uploads at once. For `off` and `official-only`
  // the listener re-yields the stream untouched.
  registerStreamHook()

  // ── The mode switch ───────────────────────────────────────────────────────────────────────────
  registerCommand()

  // ── The upload ledger the Settings page reads (authenticated, read-only) ─────────────────────
  registerLedgerRoute()

  // ── Unload: stop in-flight log-only requests ──────────────────────────────────────────────────
  disposers.push(
    ctx.effect(
      () => () => {
        for (const controller of [...controllers]) {
          try {
            controller.abort(new Error('session-log-upload unloaded'))
          } catch {
            /* ignore */
          }
        }
        controllers.clear()
      },
      'session-log-upload: abort in-flight uploads',
    ),
  )

  return () => {
    for (const dispose of [...disposers].reverse()) {
      try {
        const result = dispose()
        if (result !== null && result !== undefined && typeof result.catch === 'function') result.catch(() => {})
      } catch (error) {
        log('warn', `session-log-upload: disposing a registration failed: ${messageOf(error)}`)
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // `llm/stream` waterfall: a listener that does not own the decision returns `next()` (or, here,
  // that same iterable wrapped so the upload fires after a successful stream). It must never rewrite
  // what the model sees: every chunk is re-yielded unchanged.
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Install the `llm/stream` listener on a child fiber that activates only while `llm` is available.
   * `llm` is intentionally absent from this row's `inject` (see the `inject` doc comment), so the
   * `off` exclusion does not depend on it. The listener itself is installed in every mode and decides
   * per request from the live mode, so a settings write needs no row restart.
   *
   * Wrapped for the same reason as the ledger route below: this is optional infrastructure that runs
   * *after* the `off` exclusion, and `Fiber.effect` does not catch, so a synchronous throw here would
   * fail the row and dispose the exclusion — silently resuming the shipped official-API upload.
   */
  function registerStreamHook() {
    const handler = (options, next) => wrapStream(options, next)
    try {
      if (typeof ctx.inject === 'function') {
        const fiber = ctx.inject(['llm'], (child) => {
          child.on('llm/stream', handler)
        })
        disposers.push(() => {
          if (fiber !== null && fiber !== undefined && typeof fiber.dispose === 'function') fiber.dispose()
        })
        return
      }
      // A host without Cordis's `ctx.inject` (test doubles, non-Cordis embeddings): register directly.
      disposers.push(ctx.on('llm/stream', handler))
    } catch (error) {
      log(
        'warn',
        `session-log-upload: the llm/stream hook could not be installed (${messageOf(error)}); modes that need it will not upload, but the mode and the "off" suppression are unaffected`,
      )
    }
  }

  function wrapStream(options, next) {
    if (typeof next !== 'function') {
      log('warn', 'session-log-upload: llm/stream dispatched without a next callback; leaving the stream alone')
      return undefined
    }
    const source = next()
    try {
      if (source === null || source === undefined || typeof source[Symbol.asyncIterator] !== 'function') return source
      const request = options === null || options === undefined ? {} : options
      const rawSessionId = request.sessionId
      if (rawSessionId === undefined || rawSessionId === null) return source
      const sessionId = String(rawSessionId)
      if (sessionId.length === 0) return source

      // The provider and model of *this* request become the upload's source label, recorded in the
      // carrier message. They are carried through unchanged: a value that is not a non-empty string
      // stays `undefined`, which the transport renders as `unknown` rather than guessing a model.
      const trigger = {
        provider: typeof request.provider === 'string' ? request.provider : undefined,
        model: typeof request.model === 'string' ? request.model : undefined,
      }
      const live = currentConfig()
      const decision = decideUpload({
        mode: live.mode,
        provider: trigger.provider,
        model: trigger.model,
        hasSession: true,
        patterns: live.deepseekModelPatterns,
        directoryAllowed: isSessionDirectoryAllowed(sessionId),
      })
      if (decision !== 'ours') return source
      return trackStream(source, sessionId, trigger)
    } catch (error) {
      log('warn', `session-log-upload: not wrapping the model stream after an internal error: ${messageOf(error)}`)
      return source
    }
  }

  /**
   * Re-yield one provider stream unchanged, then queue the upload if the stream completed
   * successfully. A consumer that abandons the stream, a thrown read, or an in-band
   * `finish {kind: error|aborted}` all suppress the upload.
   */
  async function* trackStream(stream, sessionId, trigger) {
    let finished = false
    let failed = false
    try {
      for await (const chunk of stream) {
        if (chunk !== null && chunk !== undefined && typeof chunk === 'object' && chunk.type === 'finish') {
          const kind = chunk.reason === null || chunk.reason === undefined ? undefined : chunk.reason.kind
          if (kind === 'error' || kind === 'aborted') failed = true
        }
        yield chunk
      }
      finished = true
    } finally {
      if (finished && !failed) {
        try {
          scheduleUpload(sessionId, trigger)
        } catch (error) {
          log('warn', `session-log-upload: scheduling the upload failed: ${messageOf(error)}`)
        }
      }
    }
  }

  /**
   * Queue one upload per Session, de-duplicated while one is in flight, with one tail follow-up.
   *
   * The trigger (`{provider, model}` of the request that caused the upload) travels with the queue: a
   * follow-up request replaces it, so the carrier message always names the request that actually
   * caused the POST rather than a stale earlier one.
   */
  function scheduleUpload(sessionId, trigger) {
    const active = uploads.get(sessionId)
    if (active !== undefined) {
      active.pending = true
      active.trigger = trigger
      return
    }
    const state = { pending: false, trigger }
    uploads.set(sessionId, state)
    void (async () => {
      try {
        do {
          state.pending = false
          try {
            await performUpload(sessionId, state.trigger)
          } catch (error) {
            log('warn', `session-log-upload: upload for session "${sessionId}" failed unexpectedly: ${messageOf(error)}`)
          }
        } while (state.pending)
      } finally {
        uploads.delete(sessionId)
      }
    })()
  }

  /**
   * Build and POST one pending range; never rejects.
   *
   * @param sessionId the Session to upload.
   * @param trigger `{provider, model}` of the request that caused this upload; recorded in the carrier
   *   message of the POST so the receiver can see where the conversation came from.
   */
  async function performUpload(sessionId, trigger) {
    const sessions = ctx.get('sessions')
    if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') {
      log('warn', 'session-log-upload: the sessions service is unavailable, so no Session log can be built')
      return
    }
    const session = sessions.get(sessionId)
    if (session === undefined || session === null) return

    const header = session.header
    const version = header !== null && header !== undefined && typeof header === 'object' ? header.version : undefined
    if (!Number.isSafeInteger(version) || version < 0) return

    // Everything this upload needs is read now, not at load: `endpoint` and `maxBytes` are volatile, so
    // a settings write between two uploads must be honoured without a row restart.
    const live = currentConfig()

    // Last line of defence for the upload allowlist. `wrapStream`/`decideUpload` already refuse a
    // Session outside it, but this path is also reachable from a queued upload whose decision was taken
    // earlier — and a restriction added in the meantime must stop it. Read from the live `session` we
    // already hold rather than going back through `ctx.sessions`.
    const sessionHeader = session.header
    const sessionCwd = sessionHeader !== null && sessionHeader !== undefined && typeof sessionHeader === 'object' ? sessionHeader.cwd : undefined
    if (!isUploadAllowed({ cwd: sessionCwd, sessionId, directories: live.uploadDirectories, sessionIds: live.uploadSessionIds })) {
      log('debug', `session-log-upload: session "${sessionId}" is outside the upload allowlist; not uploading`)
      return
    }

    // The watermark is read before building and advanced only after HTTP 2xx. A record from another
    // Session format generation is ignored, mirroring the shipped fold's version guard.
    const stored = watermark.read(sessionId)
    const afterSeq = stored !== undefined && stored.sessionFormatVersion === version ? stored.afterSeq : -1

    const built = buildLogField({ session, afterSeq, maxBytes: live.maxBytes })
    if (built.field === null) {
      log('debug', `session-log-upload: nothing to upload for session "${sessionId}" (${String(built.reason)})`)
      // `overCap` is the one "nothing to send" state that is a permanent stall rather than an idle
      // moment: the *first* pending event alone exceeds the cap, so no later attempt can succeed until
      // the cap rises. It is tested with `=== true` and must never be inferred by truthiness — the other
      // early returns (including the build-failure catch) do not carry the field at all, and a build
      // failure must not be reported to the user as a byte-cap problem.
      if (built.overCap === true) {
        failures.record({
          kind: 'payload-too-large',
          status: null,
          retryable: false,
          sessionId,
          detail: String(built.reason),
        })
      }
      return
    }

    // Resolve the auth scheme for *this* destination before anything else: when it does not resolve we
    // return here, with no network call and no watermark write. A missing credential therefore still
    // fails closed exactly as before, and the account token is never offered to a custom endpoint.
    const auth = await resolveAuth(live.endpoint)
    if (auth === undefined) {
      // Fails closed with no network call and no watermark write. Recorded because a missing credential
      // is the single most likely cause of a silent stall, and this is the only place that knows it.
      failures.record({
        kind: 'no-credential',
        status: null,
        retryable: false,
        sessionId,
        detail: `no credential resolved for ${live.credentialRef} at ${live.endpoint}`,
      })
      return
    }

    // Attribution is best-effort: `resolveAttributionHeaders` is total, and an empty result simply
    // leaves the request as it was before this feature existed.
    const attribution = await resolveAttributionHeaders(session, sessionId)

    const controller = new AbortController()
    const timer = setTimeout(() => {
      try {
        controller.abort(new Error('log-only upload timeout'))
      } catch {
        /* ignore */
      }
    }, UPLOAD_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    controllers.add(controller)

    let result
    try {
      result = await uploadLogField({
        fetchImpl: typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined,
        endpoint: live.endpoint,
        auth,
        source: trigger,
        sessionId,
        field: built.field,
        signal: controller.signal,
        uploadModel: live.uploadModel,
        headers: attribution,
      })
    } finally {
      clearTimeout(timer)
      controllers.delete(controller)
    }

    if (result.ok === true) {
      watermark.write(sessionId, { afterSeq: result.throughSeq, sessionFormatVersion: version })
      // An accepted upload is proof the whole path works, so the failure record is cleared. A stale
      // failure outliving a success would be the same false reassurance in the opposite direction.
      failures.clear()
      // Record the attribution report only now: an accepted upload is the only evidence that those
      // headers really went out. The names are exactly the keys handed to `uploadLogField` above, and
      // every one of them carries a non-empty string by construction, so the transport's own
      // `wireHeaders` filter cannot have dropped any of them.
      acceptedUploadAttribution = { lastUploadAt: Date.now(), headers: Object.keys(attribution).sort() }
      log('debug', `session-log-upload: uploaded session "${sessionId}" through event ${String(result.throughSeq)}`)
      return
    }
    // `uploadLogField` already classifies the failure into `FAILURE_KINDS`, which is exactly the closed
    // set the page renders, so it passes through unchanged; `normaliseFailure` still sanitises it.
    failures.record({
      kind: result.kind,
      status: result.status,
      retryable: result.retryable,
      sessionId,
      detail: String(result.error),
    })
    log(
      'warn',
      `session-log-upload: session "${sessionId}" upload failed (${result.retryable ? 'retryable' : 'permanent'}); the range stays pending: ${String(result.error)}`,
    )
  }

  /**
   * The attribution headers for one upload of one Session; total, never throws.
   *
   * The Session id header is sent only when the live Session really has one — which is guaranteed on
   * this path: `wrapStream` refuses a request without a non-empty `sessionId`, `performUpload` returns
   * unless `sessions.get(sessionId)` finds that live Session, and the uploaded field carries the same
   * id. The Session's own id is preferred so the header and the field agree.
   *
   * @param session the live Session being uploaded.
   * @param sessionId the request's Session id, used only as a last resort.
   * @returns `{'user-agent'?, 'x-deepseek-harness-user-id'?, 'x-deepseek-harness-session-id'?}`
   */
  async function resolveAttributionHeaders(session, sessionId) {
    let userAgent
    let userId
    try {
      userAgent = await loadAttributionUserAgent()
    } catch {
      userAgent = undefined
    }
    try {
      userId = await loadAttributionUserId()
    } catch {
      userId = undefined
    }
    const header = session === null || session === undefined ? undefined : session.header
    const sessionHeaderId =
      typeof session?.id === 'string' && session.id.length > 0
        ? session.id
        : header !== null && header !== undefined && typeof header.id === 'string' && header.id.length > 0
          ? header.id
          : sessionId
    return composeAttributionHeaders({ userAgent, userId, sessionId: sessionHeaderId })
  }

  /**
   * The auth header for one upload, resolved the way the harness resolves it per official route.
   *
   * The two official routes share this URL but **not** their auth scheme:
   *   - `deepseek-official` → `x-api-key` carrying the configured credential reference
   *     (`@deepseek-ai/dsh-llm-deepseek-api-key/lib/index.js:131`; ref defaults to `DEEPSEEK_API_KEY`
   *     at `:12` and `:36`), which is the user's own working case;
   *   - `deepseek-account` → `x-dsh-auth-token` carrying
   *     `deepseekAccount.resolveToken(baseURL)` (`dsh-llm-deepseek-account/lib/index.js:72`, `:82`, `:85`),
   *     which has no credential reference at all.
   *
   * Order: the configured reference first, then the account token — but the account token is offered
   * **only** to the harness's official DeepSeek base (see {@link isOfficialDeepSeekEndpoint}). This is
   * a security requirement: the user may repoint `endpoint` at their own collector, and their DeepSeek
   * account token must not travel there. For any other destination only the configured reference is
   * used, and when that does not resolve the upload fails closed with a diagnostic naming it.
   *
   * Exactly one header is ever returned: never both schemes, never a partial credential.
   *
   * @param endpoint the effective destination.
   * @returns `{header, value}`, or `undefined` (the caller must not call `fetch`).
   */
  async function resolveAuth(endpoint) {
    const credentialRef = currentConfig().credentialRef
    const credentials = ctx.get('credentials')
    let key
    // The key-side reason is *collected*, not logged: `diagnoseCredential` warns once per loaded row,
    // so logging an intermediate reason would suppress the diagnostic that actually explains the
    // outcome the user sees (in particular why the account token was not offered to their endpoint).
    let keyFailure
    if (credentials === undefined || credentials === null || typeof credentials.resolve !== 'function') {
      keyFailure = `the credentials service is unavailable, so ${credentialRef} cannot be resolved`
    } else {
      try {
        const hit = await credentials.resolve(credentialRef)
        const value = hit !== null && hit !== undefined && typeof hit.value === 'string' ? hit.value : undefined
        if (value !== undefined && value.length > 0) key = value
        else keyFailure = `no stored credential ${credentialRef}`
      } catch (error) {
        keyFailure = `resolving ${credentialRef} failed: ${messageOf(error)}`
      }
    }
    if (key !== undefined) return { header: API_KEY_HEADER, value: key }

    if (!isOfficialDeepSeekEndpoint(endpoint)) {
      diagnoseCredential(
        `${keyFailure}, and the destination ${JSON.stringify(endpoint)} is not the official DeepSeek endpoint, so the DeepSeek account token is not offered to it`,
      )
      return undefined
    }
    const token = await resolveAccountToken()
    if (token !== undefined) return { header: ACCOUNT_TOKEN_HEADER, value: token }
    diagnoseCredential(
      `${keyFailure}, and no DeepSeek account token is available either (sign in to DeepSeek in the Harness, or store the credential)`,
    )
    return undefined
  }

  /**
   * The DeepSeek account token, for the official base only.
   *
   * `resolveToken` takes a **base URL**, not a Messages endpoint: the shipped account route passes its
   * own `connection.baseURL` (`dsh-llm-deepseek-account/lib/index.js:82`), whose default is exactly
   * {@link OFFICIAL_DEEPSEEK_BASE}. Passing the canonical base rather than deriving one from the
   * effective endpoint is deliberate — `resolveToken` compares only `new URL(url).origin` against the
   * account's configured inference origin (`dsh-deepseek-account-platform/lib/index.js:804-826`), so
   * the two are equivalent for that check, while a constant cannot be shaped by a crafted endpoint.
   * That origin comparison is a second, independent gate behind ours: even if our own check were
   * bypassed, the platform refuses to hand out a token for another destination.
   *
   * @returns the token, or `undefined` (not signed in / not available / not this destination).
   */
  async function resolveAccountToken() {
    const account = ctx.get('deepseekAccount')
    if (account === undefined || account === null || typeof account.resolveToken !== 'function') return undefined
    try {
      const token = await account.resolveToken(OFFICIAL_DEEPSEEK_BASE)
      return typeof token === 'string' && token.length > 0 ? token : undefined
    } catch (error) {
      log('warn', `session-log-upload: resolving the DeepSeek account token failed: ${messageOf(error)}`)
      return undefined
    }
  }

  function diagnoseCredential(detail) {
    if (credentialDiagnostics.warned) return
    credentialDiagnostics.warned = true
    log(
      'warn',
      `session-log-upload: cannot upload Session logs: ${detail}. Store it through the credentials service (the web Models page writes it) or export it in the launching environment.`,
    )
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // The upload ledger: which Session logs this plugin has uploaded, as metadata only.
  //
  // The data is the watermark table (`WatermarkStore.list()`), which the plugin already keeps; the
  // Settings page reads it through Connection's exact Fetch registry (authenticated, read-only), and
  // `/session-log-upload uploaded` prints the same thing into the conversation for compositions
  // without a connection service. The route mirrors `@deepseek-ai/dsh-session-log-export`'s
  // `/api/session.markdown` registration shape exactly.
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The ledger payload.
   *
   * `attribution` is always present and always carries `resolvable` — the answer to "do the two
   * `app.asar` helpers resolve in *this* installation?", probed once per loaded row and cached — so the
   * user can see whether the harness attribution headers will really go out without waiting for an
   * upload. `lastUploadAt`/`headers` still appear only once an upload has actually been **accepted**.
   *
   * @returns the JSON payload (a plain, serialisable object).
   */
  async function ledgerPayload() {
    const sessions = watermark.list()
    const resolvable = await attributionResolvable()
    const attribution = { resolvable: { userAgent: resolvable.userAgent, userId: resolvable.userId } }
    if (acceptedUploadAttribution !== undefined) {
      attribution.lastUploadAt = acceptedUploadAttribution.lastUploadAt
      attribution.headers = [...acceptedUploadAttribution.headers]
    }
    const failureState = failures.snapshot()
    return {
      generatedAt: Date.now(),
      directory: watermark.directory,
      total: sessions.length,
      sessions,
      attribution,
      // Absent and `null` are different claims: a payload without these fields means "the Host did not
      // report this", while `lastFailure: null` with `consecutiveFailures: 0` means it looked and found
      // nothing. The page distinguishes the two, so they must always be present here.
      lastFailure: failureState.lastFailure,
      consecutiveFailures: failureState.consecutiveFailures,
    }
  }

  /**
   * The chooser's data: the real workspaces and Sessions the Harness already knows about.
   *
   * **This replaces a wrong implementation.** The first version asked `ctx.sessions.list()`, which
   * returns only Sessions that are *currently live in this process* — on a normal profile that is the
   * one you are talking in, so the page offered a single folder and no Sessions at all. The sidebar
   * shows every workspace and every historical Session, and that is the list a user expects to choose
   * from, so this reads the same two services the sidebar reads:
   *
   *   - `ctx.workspaceRegistry.list()` — the durable workspace registry: `id`, `path`, `title`,
   *     and the `sessionIds` belonging to each (the sidebar's workspace tree);
   *   - `ctx.sessionQuery.readTitleSnapshots(ids)` — the folded, log-backed title of each Session,
   *     batched in one observation.
   *
   * Nothing here invents a scanner. Both are the Harness's own projections, which means the page lists
   * what DSH lists, and a workspace a user added in the sidebar appears without extra work.
   *
   * What it reports is still minimal — workspace path and title, Session id and title — because the
   * page only needs enough for a person to recognise a row. No message content, no message counts.
   *
   * **Subagent Sessions are excluded.** A delegated child Session has no workspace of its own, a title
   * derived from someone else's prompt, and dozens of siblings; listing them turns a chooser into a
   * wall of noise and makes "upload only this folder" impossible to reason about. They are recognised
   * the way the Harness marks them — `origin: 'subagent'` or a `parentSession` — and dropped before
   * anything is grouped, so a workspace never shows one and a loose Session grouping never invents a
   * directory the user does not recognise.
   *
   * Every service is optional: a composition without `workspaceRegistry` or `sessionQuery` yields
   * whatever the others provide, and a failure in one yields the rest rather than an error.
   *
   * @returns `{workspaces: [{id, path, title, sessions: [{id, title}]}], total}`.
   */
  async function scanPayload() {
    const workspaces = []
    const claimed = new Set()
    let total = 0

    // Session ids worth titling: every id any workspace claims, plus every Session the query service
    // knows about that no workspace claims (a Session started in a directory that was never registered).
    const ids = []

    // Headers and the subagent set come from one corpus read, so every later filter agrees on which
    // Sessions are children. Reading it once also keeps the route to a single persistence listing.
    const headers = new Map()
    const children = new Set()
    try {
      const query = ctx.get('sessionQuery')
      if (query !== null && query !== undefined && typeof query.listSessions === 'function') {
        const records = await query.listSessions()
        if (Array.isArray(records)) {
          for (const record of records) {
            const header = record !== null && record !== undefined ? record.header : undefined
            if (header === null || header === undefined) continue
            const id = typeof header.id === 'string' ? header.id : undefined
            if (id === undefined || id.length === 0) continue
            headers.set(id, header)
            // Both markers exist in the header shape; either one means "this is a delegate".
            if (header.origin === 'subagent' || typeof header.parentSession === 'string') children.add(id)
          }
        }
      }
    } catch (error) {
      log('warn', `session-log-upload: listing Sessions for the folder chooser failed: ${messageOf(error)}`)
    }

    try {
      const registry = ctx.get('workspaceRegistry')
      if (registry !== null && registry !== undefined && typeof registry.list === 'function') {
        const listed = registry.list()
        if (Array.isArray(listed)) {
          for (const workspace of listed) {
            if (workspace === null || workspace === undefined) continue
            const path = typeof workspace.path === 'string' ? workspace.path : undefined
            const title = typeof workspace.title === 'string' ? workspace.title : undefined
            if (path === undefined && title === undefined) continue
            const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
            const sessions = []
            for (const raw of sessionIds) {
              const id = typeof raw === 'string' ? raw : raw !== null && raw !== undefined ? String(raw) : undefined
              if (id === undefined || id.length === 0 || claimed.has(id)) continue
              claimed.add(id)
              // A subagent Session is never offered as a choice; mark it claimed so the loose pass
              // below cannot re-introduce it under a directory.
              if (children.has(id)) continue
              ids.push(id)
              sessions.push({ id, title: undefined })
            }
            total += sessions.length
            workspaces.push({ id: String(workspace.id ?? ''), path: path ?? '', title: title ?? '', sessions })
          }
        }
      }
    } catch (error) {
      log('warn', `session-log-upload: reading the workspace registry failed: ${messageOf(error)}`)
    }

    // Sessions the registry does not own (started in a directory that was never registered) are listed
    // under their own working directory so they can still be chosen.
    try {
      const query = ctx.get('sessionQuery')
      if (query !== null && query !== undefined && typeof query.listSessions === 'function') {
        if (headers.size > 0) {
          const loose = new Map()
          for (const [id, header] of headers) {
            if (claimed.has(id)) continue
            claimed.add(id)
            if (children.has(id)) continue
            const cwd = typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : ''
            if (!loose.has(cwd)) loose.set(cwd, [])
            loose.get(cwd).push({ id, title: undefined })
            ids.push(id)
          }
          for (const [cwd, sessions] of loose) {
            total += sessions.length
            workspaces.push({ id: '', path: cwd, title: '', sessions })
          }
        }
      }
    } catch (error) {
      log('warn', `session-log-upload: grouping Sessions by directory failed: ${messageOf(error)}`)
    }

    // One batched title read. A rejection for one id must not lose the others, which is why the
    // service returns per-id results rather than throwing.
    if (ids.length > 0) {
      try {
        const query = ctx.get('sessionQuery')
        if (query !== null && query !== undefined && typeof query.readTitleSnapshots === 'function') {
          const results = await query.readTitleSnapshots(ids)
          const titles = new Map()
          if (Array.isArray(results)) {
            for (const result of results) {
              if (result === null || result === undefined || result.status !== 'fulfilled') continue
              const snapshot = result.value !== null && result.value !== undefined ? result.value.title : undefined
              const title = snapshot !== null && snapshot !== undefined && typeof snapshot.title === 'string' ? snapshot.title : undefined
              if (title !== undefined && title.length > 0) titles.set(String(result.sessionId), title)
            }
          }
          for (const workspace of workspaces) {
            for (const session of workspace.sessions) {
              const found = titles.get(session.id)
              if (found !== undefined) session.title = found
            }
          }
        }
      } catch (error) {
        log('warn', `session-log-upload: reading Session titles failed: ${messageOf(error)}`)
      }
    }

    // Stable order: by path, so the page renders the same list every time. A Session that never got a
    // title keeps an EMPTY STRING rather than `undefined`: the page reads `title` unconditionally, and
    // an absent field would make it print "undefined" as a Session name.
    workspaces.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    for (const workspace of workspaces) {
      for (const session of workspace.sessions) {
        if (typeof session.title !== 'string') session.title = ''
      }
    }
    return { workspaces, total }
  }

  /**
   * The other-harness scan: which conversations the adapters can see right now.
   *
   * Metadata only. The page needs enough for a person to recognise a row (title, directory, the model
   * that produced it, how many messages) and nothing more, so no message content is read on this path —
   * `readForeignSession` is only ever called by the POST, for one id at a time.
   *
   * The composite id (`harness/原始 id`) is composed by the registry; the fallback below exists only so a
   * future adapter that forgets to compose cannot produce an unticktable row.
   *
   * @returns `{harnesses: [{harness, label, available, error, sessions: [...]}]}`; never throws.
   */
  async function foreignScanPayload() {
    let entries
    try {
      entries = await scanAll({ home: homedir(), maxBytes: currentConfig().maxBytes, cache: scanCache })
    } catch (error) {
      return { harnesses: [], error: messageOf(error) }
    } finally {
      // Persist whatever this scan learned. `flush()` is total and prunes, so a scan that hit every cache
      // entry costs nothing here, and a broken cache file can never fail the scan.
      scanCache.flush()
    }
    const list = entries !== null && entries !== undefined && Array.isArray(entries.harnesses) ? entries.harnesses : []
    const harnesses = []
    for (const entry of list) {
      if (entry === null || entry === undefined || typeof entry !== 'object') continue
      const harness = typeof entry.harness === 'string' ? entry.harness : ''
      if (harness.length === 0) continue
      const sessions = []
      for (const session of Array.isArray(entry.sessions) ? entry.sessions : []) {
        if (session === null || session === undefined || typeof session !== 'object') continue
        const rawId = typeof session.id === 'string' ? session.id : ''
        if (rawId.length === 0) continue
        // The registry may hand back a bare raw id or an already-composed one; prefixing only when the id
        // does not already carry this harness keeps both acceptable without ever double-prefixing.
        const prefix = `${harness}/`
        sessions.push({
          id: rawId.startsWith(prefix) ? rawId : `${prefix}${rawId}`,
          // Optional: only the harness that records lineage reports it. The page indents a row that names a
          // parent, and treats a missing or dangling parent as top level.
          parentId:
            typeof session.parentId === 'string' && session.parentId.length > 0
              ? session.parentId.startsWith(prefix)
                ? session.parentId
                : `${prefix}${session.parentId}`
              : '',
          title: typeof session.title === 'string' ? session.title : '',
          cwd: typeof session.cwd === 'string' ? session.cwd : '',
          createdAt: Number.isSafeInteger(session.createdAt) ? session.createdAt : 0,
          updatedAt: Number.isSafeInteger(session.updatedAt) ? session.updatedAt : 0,
          messageCount: Number.isSafeInteger(session.messageCount) ? session.messageCount : 0,
          provider: typeof session.provider === 'string' ? session.provider : '',
          model: typeof session.model === 'string' ? session.model : '',
          bytes: Number.isSafeInteger(session.bytes) ? session.bytes : 0,
        })
      }
      harnesses.push({
        harness,
        label: typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : harness,
        available: entry.available === true,
        error: typeof entry.error === 'string' ? entry.error : null,
        sessions,
      })
    }
    return { harnesses }
  }

  /**
   * How many POSTs a forged conversation needs at the current cap, without sending anything.
   *
   * Used by the dry-run path so the page (and the tests) can size an import before a byte leaves the
   * machine. Mirrors the real loop exactly, which is the point: a dry run that disagreed with the upload
   * would be worse than no dry run.
   */
  function planForeignRequests(forged, maxBytes) {
    let afterSeq = -1
    let requests = 0
    let bytes = 0
    for (let guard = 0; guard < 100000; guard += 1) {
      const built = buildForeignField({ forged, afterSeq, maxBytes })
      if (built.field === null) {
        return { requests, bytes, reason: typeof built.reason === 'string' ? built.reason : 'nothing-to-send' }
      }
      bytes += jsonBytes(built.field)
      requests += 1
      afterSeq = built.throughSeq
      if (!Number.isSafeInteger(afterSeq) || afterSeq >= forged.events.length - 1) return { requests, bytes, reason: null }
    }
    return { requests, bytes, reason: 'too-many-requests' }
  }

  /**
   * Send exactly one other-harness conversation, as a forged DSH session record.
   *
   * One conversation per call, so the page can attribute a failure to a row instead of to a batch. The
   * watermark key is the forged Session id, which is deterministic, so re-sending resumes where the last
   * accepted request stopped rather than duplicating the whole conversation.
   *
   * @param request the buffered Request; body `{id, dryRun?}`.
   * @returns `{ok, id, requests, bytes, throughSeq, error}`; never throws.
   */
  async function foreignUploadPayload(request) {
    let body
    try {
      body = await request.json()
    } catch {
      return { ok: false, id: null, error: 'the request body is not JSON' }
    }
    if (body === null || body === undefined || typeof body !== 'object') {
      return { ok: false, id: null, error: 'the request body is not an object' }
    }
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (id.length === 0 || id.length > 300) return { ok: false, id, error: 'no conversation id' }

    const live = currentConfig()
    const read = await readForeignSession(id, { home: homedir(), maxBytes: FOREIGN_READ_BYTES })
    if (read === null || read === undefined || read.raw === undefined || read.adapter === undefined) {
      return { ok: false, id, error: typeof read?.error === 'string' ? read.error : 'that conversation could not be read' }
    }
    const forged = forgeSession({
      harness: read.adapter.harness,
      label: read.adapter.label,
      // The adapter contract does not carry the raw id, but the forged Session id must be stable across
      // re-reads: without this the forger falls back to hashing message content, and a re-read that was
      // truncated differently would mint a different id, orphaning the watermark and re-sending the lot.
      raw: { ...read.raw, id: id.includes('/') ? id.slice(id.indexOf('/') + 1) : id },
    })
    if (forged === null || forged === undefined || forged.base === null || forged.base === undefined) {
      return { ok: false, id, error: typeof forged?.error === 'string' ? forged.error : 'the session record could not be built' }
    }
    const forgedId = forged.base.session.id
    if (body.dryRun === true) {
      const plan = planForeignRequests(forged, live.maxBytes)
      return {
        ok: plan.reason === null,
        id,
        dryRun: true,
        forgedId,
        events: forged.events.length,
        requests: plan.requests,
        bytes: plan.bytes,
        truncated: read.raw.truncated === true,
        error: plan.reason,
      }
    }

    // Auth is resolved once per conversation, before any network call: when it does not resolve the
    // caller gets a named failure and no watermark is written, so the next attempt re-reads from the same
    // offset rather than skipping a range that never left.
    const auth = await resolveAuth(live.endpoint)
    if (auth === undefined) return { ok: false, id, error: `no credential resolved for ${live.credentialRef} at ${live.endpoint}` }

    const version = forged.base.sessionFormatVersion
    const stored = watermark.read(forgedId)
    let afterSeq = stored !== undefined && stored.sessionFormatVersion === version ? stored.afterSeq : -1
    if (afterSeq >= forged.events.length - 1) {
      return { ok: true, id, forgedId, requests: 0, bytes: 0, throughSeq: afterSeq, error: null, skipped: 'already-sent' }
    }

    // Attribution is best-effort and total; a forged record has no live Session, so only the id header is
    // derivable, which is exactly what `resolveAttributionHeaders` falls back to.
    const attribution = await resolveAttributionHeaders(undefined, forgedId)
    const source = {
      provider: typeof read.raw.provider === 'string' && read.raw.provider.length > 0 ? read.raw.provider : read.adapter.harness,
      model: read.raw.model,
    }

    let requests = 0
    let bytes = 0
    let throughSeq = afterSeq
    for (let guard = 0; guard < 100000; guard += 1) {
      const built = buildForeignField({ forged, afterSeq, maxBytes: live.maxBytes })
      if (built.field === null) {
        if (requests === 0) return { ok: false, id, forgedId, requests, bytes, error: String(built.reason ?? 'nothing to send') }
        break
      }
      bytes += jsonBytes(built.field)

      const controller = new AbortController()
      const timer = setTimeout(() => {
        try {
          controller.abort(new Error('other-harness upload timeout'))
        } catch {
          /* ignore */
        }
      }, UPLOAD_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      controllers.add(controller)

      let result
      try {
        result = await uploadLogField({
          fetchImpl: typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined,
          endpoint: live.endpoint,
          auth,
          source,
          sessionId: forgedId,
          field: built.field,
          signal: controller.signal,
          uploadModel: live.uploadModel,
          headers: attribution,
        })
      } finally {
        clearTimeout(timer)
        controllers.delete(controller)
      }

      if (result.ok !== true) {
        return { ok: false, id, forgedId, requests, bytes, throughSeq, error: String(result.error ?? 'upload failed') }
      }
      requests += 1
      throughSeq = result.throughSeq
      watermark.write(forgedId, { afterSeq: throughSeq, sessionFormatVersion: version })
      afterSeq = throughSeq
      if (!Number.isSafeInteger(afterSeq) || afterSeq >= forged.events.length - 1) break
    }

    log('debug', `session-log-upload: imported other-harness conversation "${id}" as "${forgedId}" through event ${String(throughSeq)}`)
    return { ok: true, id, forgedId, requests, bytes, throughSeq, error: null, truncated: read.raw.truncated === true }
  }

  /**
   * The update check. Total and read-only: `checkUpdate` fetches and validates the manifest, compares
   * versions and reports what it found, and writes nothing.
   *
   * The destination is read live (`updateUrl` is volatile), so pointing the plugin at a fork takes effect
   * on the next check without a row restart, exactly like `endpoint`.
   */
  async function updateCheckPayload() {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      try {
        controller.abort(new Error('update check timeout'))
      } catch {
        /* ignore */
      }
    }, UPDATE_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    controllers.add(controller)
    try {
      return await checkUpdate({
        fetchImpl: typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined,
        manifestUrl: currentConfig().updateUrl,
        directory: PLUGIN_DIRECTORY,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
      controllers.delete(controller)
    }
  }

  /**
   * The update itself: download, verify every byte, back up, replace, verify the read-back.
   *
   * The request body is deliberately ignored. The action takes no parameters, so there is nothing a
   * caller could pass to redirect the writer at a different directory or manifest — both come from this
   * closure. `applyUpdate` is all-or-nothing and restores the backups on any failure.
   */
  async function updateApplyPayload() {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      try {
        controller.abort(new Error('update apply timeout'))
      } catch {
        /* ignore */
      }
    }, UPDATE_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    controllers.add(controller)
    let result
    try {
      result = await applyUpdate({
        fetchImpl: typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined,
        manifestUrl: currentConfig().updateUrl,
        directory: PLUGIN_DIRECTORY,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
      controllers.delete(controller)
    }
    if (result !== null && result !== undefined && result.ok === true) {
      log('info', `session-log-upload: updated from ${String(result.from)} to ${String(result.to)}; restart DSH to load it`)
    }
    return result
  }

  /**
   * Register the read-only ledger and scan routes on the connection service.
   *
   * `connection` is deliberately **not** in this row's `inject`: the plugin must stay active where
   * there is no connection service, and the `mode: 'off'` exclusion must never depend on one. When it
   * is absent the routes are simply not registered (no warning: a headless composition is normal), and
   * the command listing still works.
   *
   * **Both registrations are wrapped, and that is load-bearing.** `Fiber.effect` does not catch
   * (`cordis/lib/index.js:463`), so a synchronous throw from `register` — a duplicate path, a rejected
   * request shape, a reload race — would fail the row, and Cordis would tear down the effects already
   * registered, **including the `mode: 'off'` exclusion**, silently resuming the shipped official-API
   * upload. Optional infrastructure must never be able to disarm the strongest privacy setting: a page
   * that cannot read its data is an acceptable degradation, a disposed exclusion is not.
   */
  function registerLedgerRoute() {
    const connection = ctx.get('connection')
    if (connection === null || connection === undefined || typeof connection.fetch?.register !== 'function') {
      log(
        'debug',
        `session-log-upload: no connection service, so ${LEDGER_ROUTE_PATH} is not registered; /${COMMAND_NAME} ${LEDGER_ARGUMENT} still prints the detailed log of what was uploaded`,
      )
      return
    }
    // Each route is registered in its OWN wrapped effect, so one failing cannot take the other down.
    const routes = [
      {
        path: LEDGER_ROUTE_PATH,
        effect: 'session-log-upload: upload ledger route',
        methods: ['GET'],
        payload: () => ledgerPayload(),
        what: 'the Settings page will not show the detailed log',
      },
      {
        path: SCAN_ROUTE_PATH,
        effect: 'session-log-upload: session directory scan route',
        methods: ['GET'],
        payload: () => scanPayload(),
        what: 'the Settings page cannot offer a folder list (typing a path still works)',
      },
      {
        path: NOTICE_ROUTE_PATH,
        effect: 'session-log-upload: liability notice route',
        // POST is how the page records "I have read this". It is authenticated like the GETs; an
        // unauthenticated POST would let any local process dismiss the notice for the user.
        methods: ['GET', 'POST'],
        payload: async (request) => {
          if (request !== undefined && request !== null && request.method === 'POST') {
            const recorded = notice.acknowledge()
            return { acknowledged: recorded.acknowledged, at: recorded.at }
          }
          return notice.snapshot()
        },
        what: 'the Settings page cannot show or record the liability notice',
      },
      {
        path: FOREIGN_SCAN_ROUTE_PATH,
        effect: 'session-log-upload: other-harness scan route',
        methods: ['GET'],
        payload: () => foreignScanPayload(),
        what: 'the Settings page cannot list conversations from other harnesses',
      },
      {
        path: FOREIGN_UPLOAD_ROUTE_PATH,
        effect: 'session-log-upload: other-harness send route',
        methods: ['POST'],
        // One conversation per request: the page drives it serially so a failure names a row.
        payload: (request) => foreignUploadPayload(request),
        what: 'the Settings page cannot send conversations from other harnesses',
      },
      {
        path: UPDATE_CHECK_ROUTE_PATH,
        effect: 'session-log-upload: update check route',
        methods: ['GET'],
        payload: () => updateCheckPayload(),
        what: 'the Settings page cannot check whether a newer version exists',
      },
      {
        path: UPDATE_APPLY_ROUTE_PATH,
        effect: 'session-log-upload: update apply route',
        // POST only: this replaces the plugin's own files, and a GET must never write.
        methods: ['POST'],
        payload: () => updateApplyPayload(),
        what: 'the Settings page cannot apply an update in-app (update by hand instead)',
      },
    ]
    for (const route of routes) {
      try {
        disposers.push(
          ctx.effect(
            () =>
              connection.fetch.register({
                path: route.path,
                methods: route.methods,
                requestBody: 'buffered',
                // Authentication is inherited, not implemented here: Connection dispatches this only
                // after its browser-credential check, so a request without the page cookie is refused
                // with 401 before this handler runs. Registering on the raw web server instead would
                // expose Session data to any local process (docs/state-channel.md §2.3-§2.4).
                fetch: async (request) =>
                  new Response(JSON.stringify(await route.payload(request)), {
                    status: 200,
                    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
                  }),
              }),
            route.effect,
          ),
        )
      } catch (error) {
        log(
          'warn',
          `session-log-upload: the route ${route.path} could not be registered (${messageOf(error)}); ${route.what}, but the plugin, the mode and the "off" suppression are unaffected`,
        )
      }
    }
  }

  /**
   * The detailed log of **what was uploaded**, as short human-readable lines, for
   * `/session-log-upload uploaded`. It is an index, not a copy: per Session it names the id, the event
   * sequence the log was uploaded through, and when — never what was said.
   */
  async function ledgerText() {
    const sessions = watermark.list()
    const resolvable = await attributionResolvable()
    const lines = [
      `${COMMAND_NAME}: detailed log — ${sessions.length} Session log${sessions.length === 1 ? '' : 's'} uploaded from ${watermark.directory}.`,
      '  A record of what was uploaded (session id, the event sequence it was uploaded through, and when) — not a copy of what was said.',
    ]
    const shown = sessions.slice(0, MAX_LEDGER_LINES)
    for (const entry of shown) {
      const when = entry.updatedAt === null ? 'unknown time' : new Date(entry.updatedAt).toISOString()
      lines.push(`  ${entry.sessionId}  through event ${entry.afterSeq}  (${when})`)
    }
    if (sessions.length > shown.length) lines.push(`  … and ${sessions.length - shown.length} more`)
    lines.push(
      `  Attribution helpers resolvable in this installation: user-agent=${resolvable.userAgent ? 'yes' : 'no'}, anonymous user id=${resolvable.userId ? 'yes' : 'no'}.`,
    )
    const failureState = failures.snapshot()
    if (failureState.lastFailure === null) {
      lines.push(
        failureState.readable
          ? '  No upload failure recorded: the last attempt either succeeded or none has been made.'
          : '  The failure record is unreadable, so nothing can be said about the last attempt.',
      )
    } else {
      const failure = failureState.lastFailure
      const when = Number.isSafeInteger(failure.at) ? new Date(failure.at).toISOString() : 'unknown time'
      const status = failure.status === null ? '' : ` (HTTP ${String(failure.status)})`
      const sessionPart = failure.sessionId === null ? '' : `, session ${failure.sessionId}`
      lines.push(
        `  Last upload failure: ${failure.kind}${status} at ${when}${sessionPart}, ${failure.retryable ? 'retried automatically' : 'not retried'}; ${failureState.consecutiveFailures} consecutive.`,
        `    ${failure.detail}`,
      )
    }
    if (acceptedUploadAttribution === undefined) {
      lines.push('  No upload has been accepted since this row loaded, so there is no attribution report yet.')
    } else {
      const headers = acceptedUploadAttribution.headers.length === 0 ? '(none)' : acceptedUploadAttribution.headers.join(', ')
      lines.push(
        `  Last accepted upload ${new Date(acceptedUploadAttribution.lastUploadAt).toISOString()} with attribution headers: ${headers}`,
      )
    }
    return lines.join('\n')
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // The mode switch. The write goes through `configEditor.edit(entry, change)` and the Loader's own
  // reconciliation, which restarts this row with the new raw config (docs/api-dossier.md §6.4). A
  // move to a wider mode takes two invocations: the first only prints the disclosure prompt.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  function registerCommand() {
    const commands = ctx.get('commands')
    if (commands === undefined || commands === null || typeof commands.register !== 'function') {
      log(
        'warn',
        `session-log-upload: the commands service is unavailable, so /${COMMAND_NAME} cannot be registered; set the mode in cordis.patch.yml instead`,
      )
      return
    }
    try {
      disposers.push(
        ctx.effect(
          () =>
            commands.register({
              name: COMMAND_NAME,
              description:
                `Choose when Session logs are uploaded to DeepSeek: ${MODES.join(', ')}; or "${LEDGER_ARGUMENT}" for the detailed log of what was uploaded.`,
              input: { hint: `<${MODES.join('|')}> [${CONFIRM_WORD}] | ${LEDGER_ARGUMENT}` },
              handler: handleCommand,
            }),
          `session-log-upload: /${COMMAND_NAME} command`,
        ),
      )
    } catch (error) {
      // Same class as the ledger route: optional infrastructure registered after the `off` exclusion
      // must never be able to fail the row and take the exclusion down with it.
      log('warn', `session-log-upload: /${COMMAND_NAME} could not be registered (${messageOf(error)}); the "off" suppression is unaffected`)
    }
  }

  async function handleCommand(invocation) {
    const raw = invocation !== null && invocation !== undefined && typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
    if (raw.length === 0) return { kind: 'success', text: statusText() }

    const tokens = raw.split(/\s+/u)
    const next = tokens[0]
    // The ledger listing is the zero-new-surface fallback for the Settings view: it needs no route, no
    // connection service and no client change, so it stays available in every composition.
    if (next === LEDGER_ARGUMENT) return { kind: 'success', text: await ledgerText() }
    if (!MODES.includes(next)) {
      return {
        kind: 'error',
        text: `${COMMAND_NAME}: unknown mode "${next}". Usage: /${COMMAND_NAME} <${MODES.join('|')}> [${CONFIRM_WORD}], or /${COMMAND_NAME} ${LEDGER_ARGUMENT} for the detailed log of what was uploaded`,
      }
    }
    if (next === currentMode()) {
      return { kind: 'success', text: `${COMMAND_NAME}: mode "${next}" is already active; nothing was written.` }
    }

    // Consent gate (INTERFACES.md §1 rule 2): moving **to** a wide mode requires a second, explicit
    // step that names the destination. A Host command has no dialog facility, so the confirmation is
    // part of the command line and is checked before any write. Narrowing (`off`, `official-only`)
    // never needs it.
    if (isWideMode(next) && (tokens.length < 2 || tokens[1].toLowerCase() !== CONFIRM_WORD)) {
      return { kind: 'success', text: confirmationPrompt(next) }
    }

    const persisted = await persistMode(next)
    if (persisted.ok !== true) return { kind: 'error', text: `${COMMAND_NAME}: ${persisted.text}` }
    return { kind: 'success', text: describeModeChange(next) }
  }

  /**
   * The destination **right now** — a volatile field, so the confirmation prompt must read it when it
   * is shown, never a stale or default value.
   */
  function currentEndpoint() {
    return currentConfig().endpoint
  }

  /** Status text for a bare `/<command>`: the active mode and the destination, making no change. */
  function statusText() {
    const mode = currentMode()
    const behaviour =
      mode === 'off'
        ? "Nothing is uploaded, including DSH's built-in official-API upload."
        : `Session logs are sent to DeepSeek at ${currentEndpoint()} wherever this mode allows it.`
    return `${COMMAND_NAME}: mode "${mode}" is active; nothing was written. ${behaviour} Usage: /${COMMAND_NAME} <${MODES.join('|')}> [${CONFIRM_WORD}] — changing to ${WIDE_MODES.join(' or ')} needs the ${CONFIRM_WORD} step; /${COMMAND_NAME} ${LEDGER_ARGUMENT} prints the detailed log of what was uploaded.`
  }

  /**
   * The prompt returned by a wide-mode invocation that was not confirmed. It must name the
   * destination endpoint, state plainly that other providers' conversations travel with the logs,
   * and tell the user exactly how to confirm.
   */
  function confirmationPrompt(next) {
    return [
      `${COMMAND_NAME}: nothing was written. Mode "${next}" is not active yet — moving to it needs a second, explicit step.`,
      `If you confirm, your Session logs — including conversations held with other providers — will be sent to DeepSeek at ${currentEndpoint()}, where they may be used to train models.`,
      `Re-run exactly this to confirm: /${COMMAND_NAME} ${next} ${CONFIRM_WORD}`,
    ].join('\n')
  }

  /** Write the mode into this row's own profile patch entry; report exactly why it could not. */
  async function persistMode(next) {
    const configEditor = ctx.get('configEditor')
    const fiber = ctx.fiber
    const entry = fiber !== null && fiber !== undefined ? fiber.entry : undefined
    const missing = []
    if (configEditor === undefined || configEditor === null || typeof configEditor.edit !== 'function') {
      missing.push('the configEditor service is unavailable')
    }
    if (entry === undefined || entry === null) {
      missing.push('this row is not owned by a Loader entry (ctx.fiber.entry is absent)')
    }
    if (missing.length > 0) {
      return {
        ok: false,
        text: `${missing.join(', and ')}. Set the mode in cordis.patch.yml instead:\n- id: session-log-upload\n  config:\n    mode: ${next}`,
      }
    }
    try {
      await configEditor.edit(entry, (current) => ({
        ...(current !== null && current !== undefined && typeof current === 'object' && !Array.isArray(current) ? current : {}),
        mode: next,
      }))
      return { ok: true }
    } catch (error) {
      return { ok: false, text: `the mode could not be persisted: ${messageOf(error)}` }
    }
  }

  function describeModeChange(next) {
    if (next === 'off') {
      return `${COMMAND_NAME}: mode set to "off". Nothing is uploaded, including DSH's built-in official-API upload. The new mode takes effect immediately.`
    }
    if (next === 'official-only') {
      return `${COMMAND_NAME}: mode set to "official-only" — the stock DSH behaviour, with no extra upload. The new mode takes effect immediately.`
    }
    return `${COMMAND_NAME}: mode set to "${next}". Session logs — including conversations held with other providers — will be sent to DeepSeek at ${currentEndpoint()}, where they may be used to train models. The new mode takes effect immediately.`
  }
}
