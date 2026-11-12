# Frozen interfaces — `@local/dsh-session-log-upload`

Contract between the host half, the client half, and verification.
**Do not change a "Frozen" section without telling the Lead.**

Evidence for every cited API lives in [docs/api-dossier.md](docs/api-dossier.md).

---

## 0. Hard constraint that shapes everything

> **Revision note (after first verification).** §0 below was the constraint the two halves were
> first built against, and it is still *nearly* right — but one claim is now deliberately violated,
> because the first live run proved it had to be. A profile-installed bundle really cannot resolve
> bare specifiers, so the row still declares **no** `Config` *via a bare import*. It gets one
> instead by importing `@deepseek-ai/schemastery` from the **running Electron installation** through
> an absolute `file://` URL derived from `process.resourcesPath`, with "no schema" kept as a
> supported posture. A bare-specifier fallback candidate was tried and then **removed**: it cannot
> resolve here, so it was dead code that put a bare specifier inside a bundle documented as having
> none.
>
> The reason this was worth it: `dsh-settings`' `describe()` skips every entry whose `Config` is
> undefined, and a write to such an entry throws `No configurable plugin entry`. Without a schema
> the settings page rendered perfectly and then could not read or write anything — which is exactly
> what the first live run showed. With it, the shipped settings wire works unchanged.
>
> So read every "the row exports no Config" sentence below as historical. The workloads that were
> genuinely blocked by the missing resolver — `ctx.storageDomain` value schemas — are still avoided;
> watermarks remain a plain JSON file the plugin owns.

**This bundle must be dependency-free at runtime, apart from one absolute-URL import.**

- Only `node:*` builtins, **relative** imports, and the single deliberate absolute `file://` URL
  into the running Harness are allowed.
- **No bare specifier** — not `@deepseek-ai/cordis`, not `@deepseek-ai/schemastery`, not `zod`.
  Verified: `profiles/desktop/node_modules` has no `@deepseek-ai` scope, `.pnpm` holds only
  `lock.yaml`, and `node --input-type=module -e "import('@deepseek-ai/schemastery')"` run from the
  profile directory fails with `ERR_MODULE_NOT_FOUND`. Node ESM resolves from the importing file's
  own location, which is the profile.
- **`Config` is optional and resolved at load.** If the candidate does not resolve, the row exports
  no schema and still works: the mode is read from the raw config and changed with the command. If
  the schema does resolve, the settings page becomes fully functional. Neither posture may be a
  crash.
- **`mode` is `.volatile()`**, so the settings form can project it — and Cordis hands `apply` a
  *live reference* for it, not a string. The mode must therefore be read through `readLive()` and
  **re-read per decision**, never captured once at `apply`; otherwise the user's choice is silently
  ignored and `off` fails open.
- **No `ctx.storageDomain` value schema.** Per-session watermarks are persisted by the plugin itself
  as plain JSON through `node:fs`, not through a schema-validated harness store.

---

## 1. What is being built

Four upload modes, chosen by the user:

| mode id (frozen) | 中文 | Behaviour |
|---|---|---|
| `off` | 不上传 | Nothing is uploaded. The shipped official-API upload is suppressed too. |
| `official-only` | 只上传官方 API | **Default.** Exactly today's DSH behaviour. |
| `deepseek-any-provider` | 上传任何供应商的 deepseek | As `official-only`, **plus** we upload whenever the served model id matches `deepseekModelPatterns`, whichever provider served it. |
| `any-model` | 上传任何模型 | As `official-only`, **plus** we upload for every model request carrying a live Session. |

### Why modes 3/4 need their own upload (settled)

`dsh_session_log` reaches the wire only through `ctx.deepseekLlmApiExtensions`, whose registry is
consumed only by `@deepseek-ai/dsh-llm-deepseek`. `GenerateOptions` has no free-form body field, and
`llm-pi-ai/request-headers` contributes headers only. So the plugin issues its **own** log-only POST
to the official DeepSeek endpoint, reusing the exact field format.

### Consent rules (frozen, non-negotiable)

1. Default on install is `official-only` — behaviour identical to DSH without the plugin.
2. Moving **to** `deepseek-any-provider` or `any-model` requires an explicit confirmation step naming
   the destination and stating that conversations held with **other** providers will be sent to DeepSeek.
3. Moving **to** `off` or `official-only` never requires confirmation.
4. The plugin never widens the mode on the user's behalf: no automatic escalation, no silent default
   change on upgrade.

---

## 2. Frozen identities

| Thing | Value |
|---|---|
| Package name / client factory id | `@local/dsh-session-log-upload` |
| Host patch row id = settings namespace | `session-log-upload` |
| Client `dsh.client.inject` | `["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-settings"]` |
| Public command name | `session-log-upload` |
| Install route | profile `cordis.patch.yml` `insert` row + `node_modules\@local\dsh-session-log-upload` directory junction to this workspace — **not** `install_bundle` (see README) |

---

## 3. Frozen Config — raw, defaulted in code

```yaml
- insert:
    - id: session-log-upload
      name: '@local/dsh-session-log-upload'
      config:
        mode: official-only
        deepseekModelPatterns: [deepseek]
        endpoint: https://api.deepseek.com/anthropic/v1/messages
        uploadModel: deepseek-chat
        credentialRef: DEEPSEEK_API_KEY
        maxBytes: 8388608
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `mode` | enum below | `official-only` | Selected upload mode. **Unknown/missing ⇒ `official-only`**, never wider. |
| `deepseekModelPatterns` | `string[]` | `['deepseek']` | Case-insensitive substrings matched against the **model id** only. |
| `endpoint` | string | `https://api.deepseek.com/anthropic/v1/messages` | Where we POST. |
| `uploadModel` | string | `deepseek-chat` | `model` field of our log-only request. |
| `credentialRef` | string | `DEEPSEEK_API_KEY` | Resolved via `ctx.credentials.resolve(ref)` → `.value`. |
| `maxBytes` | int ≥ 1 | `8388608` | Largest serialized `dsh_session_log` we send. |

Our log-only request (the endpoint is DeepSeek's **Anthropic-compatible** surface, so the body is an
Anthropic Messages body, not `chat/completions`; auth header `x-api-key`):

```jsonc
{
  "model": "<uploadModel>",
  "max_tokens": 1,
  "messages": [{ "role": "user", "content": "." }],
  "dsh_session_log": { /* byte-identical shape to the shipped plugin's field */ }
}
```

---

## 4. Frozen file layout / write scopes

```
<bundle-root>\
  package.json            Lead      cordis.patch.yml  Lead      icon.svg  Lead
  README.md               Lead      INTERFACES.md     Lead      index.js  host-impl
  host/config.js          host-impl      host/eligibility.js  host-impl
  host/logfield.js        host-impl      host/watermark.js    host-impl
  host/upload.js          host-impl
  client.js               client-impl    locale/*.json        client-impl (may extend upload.*)
  docs/                   api-scout     verify/              verifier
  probe/                  Lead (temporary; delete when done)
```

---

## 5. Frozen host module API (what `index.js` imports)

```js
// host/config.js  — pure
export const MODES = ['off', 'official-only', 'deepseek-any-provider', 'any-model']
export const DEFAULT_MODE = 'official-only'
/** never throws; unknown mode -> DEFAULT_MODE; drops malformed fields */
export function resolveConfig(raw) // -> {mode, deepseekModelPatterns, endpoint, uploadModel, credentialRef, maxBytes}

// host/eligibility.js — pure
export const OFFICIAL_PROVIDER_ROUTES = ['deepseek-official', 'deepseek-account']
/** @returns {'shipped'|'ours'|'none'} */
export function decideUpload({ mode, provider, model, hasSession, patterns })
/** @returns {boolean} true when the shipped upload must be suppressed (mode 'off') */
export function suppressShipped(mode)

// host/logfield.js — pure except for reading the live Session
/** @returns {{field: object|null, throughSeq: number|null, reason?: string}} */
export function buildLogField({ session, afterSeq, maxBytes })

// host/watermark.js — owns node:fs
export class WatermarkStore {
  constructor(directory)          // created on demand
  read(sessionId)                 // -> {afterSeq:number, sessionFormatVersion:number} | undefined
  write(sessionId, value)         // best-effort; never throws
}

// host/upload.js
/** @returns {Promise<{ok:true, throughSeq:number}|{ok:false, error:string, retryable:boolean}>} */
export async function uploadLogField({ fetchImpl, endpoint, credential, sessionId, field, signal })
```

`index.js` owns: `apply`, `inject`, the `llm/stream` hook, the `sessionLogDeepSeek` exclusion, the
`configEditor` self-write, and the `session-log-upload` command.

### Behaviour matrix

| mode | request to `deepseek-official` / `deepseek-account` | any other provider |
|---|---|---|
| `off` | **suppressed** by our exclusion predicate | nothing |
| `official-only` | shipped plugin uploads (status quo) | nothing |
| `deepseek-any-provider` | shipped plugin uploads; we do **not** duplicate | model id matches a pattern ⇒ we upload |
| `any-model` | shipped plugin uploads; we do **not** duplicate | we upload for every model |

Trigger: after a completed `llm/stream` for an eligible request. Never blocks or delays the user's
own request; uploads are fire-and-forget with in-flight de-duplication per Session.

---

## 6. Frozen client behaviour

A single self-contained `client.js`: `window.__ModuleLoader__.load({ id: '@local/dsh-session-log-upload', factory(require) {...} })`
returning `{ inject, apply }`.

- `inject = ["slots", "locale", "configForms", "remote", "remote.settings"]`.
- Registers one `settings.section` (id `session-log-upload`, order `60`, `label` thunk, `locale`)
  **and** a matching `settings.section.icon` with the same id.
- The section declares `children: { "settings.general.item": { kind: "list", scope: "root" } }` and
  renders the four modes as a radio group, each with a label and a one-line detail from locale.
- **Write path, in order of preference:**
  1. `ctx.configForms.get('session-log-upload')` served ⇒ `form.set('mode', value)`. **This is the
     live path** now that the row declares a `Config`; it is verified end to end in the real GUI
     (default preselected, save succeeds, the choice survives a refresh).
  2. otherwise `ctx.remote.settings.mutate('session-log-upload', [{op:'set',path:['mode'],value}], revision)`
     with `revision` from `ctx.remote.settings.describe()`. This path throws
     `No configurable plugin entry` for a schema-less row, so it is a fallback only.
  3. otherwise the page must **not pretend to be live**: disable the controls, say the Host is not
     reporting the mode, and offer the `cordis.patch.yml` snippet plus the `/session-log-upload`
     command as an explicitly last-resort route.
- The page is registered through `ctx.configForms.whileServed(['session-log-upload'], …)`, like the
  shipped companion, so it exists only while the Host actually serves the namespace.
- **Confirmation gate:** `deepseek-any-provider` and `any-model` open a confirm dialog first. The
  dialog states, in the user's language, that Session logs — including conversations held with other
  providers — leave the machine, may be used to train models, and go **to the destination named in the
  dialog**, and it cannot be dismissed by accident (Escape and backdrop-click cancel, they do not
  confirm). `off` / `official-only` commit directly.
  *(Revised after task-19: the dialog no longer hard-codes the brand "DeepSeek", because `endpoint`
  became editable and a brand claim would then be able to become false. The endpoint line is the
  destination of record.)*
- Shows the effective destination endpoint and byte cap, both read from the served form. They are
  volatile **for exactly this reason**: `dsh-settings` sends the page only `volatileForm(schema)`, so
  a non-volatile field is invisible to the browser and can only ever render as "not reported".
  *(Revised after task-19: the user asked to edit these from the page, so there are now inputs for
  them alongside a read-only line showing the value in use. The inputs are drafts; **the disclosure
  and the rows read the narrowed, in-use value**, never a draft. Writes go through a whitelist that
  contains exactly `mode`, `endpoint`, `maxBytes`, and `mode` remains reachable only through the
  gated path.)*
- There is deliberately **no pending-range row**. A row that could only ever say "not reported" is
  noise on a consent screen.
  *(Revised: the claim that no read-only channel could exist was wrong once the detailed log gained
  an authenticated Fetch route. The reason the pending range is still absent is different — the
  channel reports what has **already** been uploaded, and the un-uploaded remainder is not part of
  that record, so there was nothing to show.)*
- **Session names are opt-in.** The detailed log renders rows keyed by Session id; a toggle (default
  **off**) resolves them to titles through the slot's own `useSessions`. It is off by default because
  a title is derived from the conversation, and this page is otherwise metadata-only.
- Styling: `--dsw-alias-*` tokens only; no literal colours outside the icon. No import of any
  `@deepseek-ai/*` client package as a module. Write our own controls; do not `require` primitives.

---

## 7. Non-goals

- No attachment binaries — the Session log references them, it does not embed them.
- No upload while `mode: off`.
- No new Session event type appended (a plugin may not).
- No edit of another plugin's configuration row.
