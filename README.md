# Session log upload — 会话日志上传

A DSH plugin that lets **the user** decide when a Session log is uploaded to DeepSeek.

默认值是「只上传官方 API」——装上之后行为与不装完全一致。放宽共享范围必须是用户自己的、看得见的动作。

> **⚠️ 选择宽模式会立刻开始真实上传。** 这不只是「一个设置」：选中 `deepseek-any-provider` 或
> `any-model` 之后，本机接下来的每一次符合条件的模型请求都会把会话日志 POST 到
> `api.deepseek.com`，用的凭据是配置里的 `credentialRef`。开发/测试本插件时请先确认这一点，
> 或先把 `credentialRef` 指向一个不存在的引用。本项目实测过：测试期间该会话日志确实上传过
> （见下文「已验证到哪一步」）。

---

## The four modes

| `mode` | 中文 | What leaves the machine |
|---|---|---|
| `off` | 不上传 | Nothing. The shipped official-API upload is suppressed too. |
| `official-only` | 只上传官方 API | **Default.** Only the log that rides along with a request already going to DeepSeek's official API. |
| `deepseek-any-provider` | 上传任何供应商的 deepseek | The above, **plus** a separate log-only request to DeepSeek whenever the served model id matches `deepseekModelPatterns` — even when a different provider served it. |
| `any-model` | 上传任何模型 | The above, **plus** a separate log-only request to DeepSeek after **every** model request that carries a live Session, whichever provider answered. |

Unknown or missing `mode` always falls back to `official-only`. Nothing in the plugin ever widens the
mode on the user's behalf.

## What a Session log contains

The durable record of one conversation: user messages, assistant output, tool results, and the file
paths involved. Attachments are **referenced, not embedded** — no image or file bytes are uploaded.

## Why modes 3 and 4 need their own request

`dsh_session_log` is a top-level body field owned by `@deepseek-ai/dsh-session-log-deepseek` through
the `deepseekLlmApiExtensions` registry, and **only** the official DeepSeek adapter reads that
registry. `GenerateOptions` has no free-form body field, and `llm-pi-ai/request-headers` contributes
headers only.

So when the user talks to some other provider there is no DeepSeek request to attach the log to, and
the plugin issues its own small request instead. That is a real, separately billed network call, and
the UI says so before the mode changes.

---

## Read this before you ship it to anyone

- **It sends other providers' conversations to DeepSeek.** A user in `any-model` mode has their
  Anthropic/OpenAI/local-model conversations delivered to DeepSeek. Sending one provider's session
  content to a third party may violate that provider's terms, and it is a materially different
  privacy posture from DSH's stock behaviour.
- **It must be opt-in, and the opt-in must cost a deliberate action.** The default is
  `official-only`; the two wider modes sit behind a confirmation dialog in the UI **and** a two-step
  `confirm` token on the command. Do not ship a build that defaults wider, buries the dialog, or
  re-enables a wider mode after an upgrade. A telemetry plugin that widens its own scope silently is
  malware, whatever its settings screen says.
- **The disclosure has to be true.** The dialog and the command prompt both name the endpoint. If you
  repoint `endpoint` at your own collector, fix the wording rather than letting it keep saying
  "DeepSeek".
- Uploads are **at-least-once**: a crash between server acceptance and the watermark write replays a
  range. Duplicates are possible; skipped ranges are not.

---

## Installation

**This bundle is not installed through the Plugin Manager.** It is mounted by hand, because the
Plugin Manager cannot install anything in this profile (see the environment note at the end):

1. Link the package into the profile so its bare name resolves:

   ```powershell
   cmd /c mklink /J "C:\Users\<you>\.dsh\profiles\desktop\node_modules\@local\dsh-session-log-upload" "<bundle-root>"
   ```

2. Append the row to the profile's `cordis.patch.yml`:

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

3. Changes to the plugin's own files do **not** hot-reload. Editing `cordis.patch.yml` to a
   different *content* restarts the row; so does restarting DSH.

Once you change the mode in the settings UI, the profile patch gains a **second** top-level row —
`- id: session-log-upload` — written by the config editor. That is the patch layer's normal
override-by-id shape, not a duplicate plugin: the `insert` row creates the Loader entry, and the
override row supplies the user's chosen config to it. Read both if you want to know the effective
mode; the override wins. See [INTERFACES.md](INTERFACES.md) §3 for the keys.

**Rollback:** delete the `insert` block above (and any `- id: session-log-upload` override row the
settings form wrote), then remove the junction with
`cmd /c rmdir "…\node_modules\@local\dsh-session-log-upload"`. The workspace is untouched.

---

## Configuration

Every key is optional, and the row declares a real `Config` so the settings page can read and write
it.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `mode` | enum | `official-only` | `off` \| `official-only` \| `deepseek-any-provider` \| `any-model`. **Volatile** — see the note below. |
| `deepseekModelPatterns` | `string[]` | `['deepseek']` | Case-insensitive substrings matched against the **model id** only. |
| `endpoint` | string | DeepSeek's Anthropic-compatible messages endpoint | Where the log-only request goes. **Volatile** — shown in the UI. Must be an absolute `http(s)` URL or it falls back to the default. |
| `uploadModel` | string | `deepseek-chat` | `model` field of that request — it must be a model the official API knows, since the model the user was actually talking to may be served by someone else. |
| `credentialRef` | string | `DEEPSEEK_API_KEY` | Resolved through `ctx.credentials.resolve(ref)`. |
| `maxBytes` | int ≥ 1 | `8388608` | Largest serialized `dsh_session_log` per request. **Volatile** — shown in the UI. |

`credentialRef` is resolved through `ctx.credentials.resolve(ref)`. If it resolves to nothing, the
wider modes cannot upload and the plugin reports that instead of pretending to work.

### Switching the mode without the UI

```
/session-log-upload                      # report the current mode and endpoint; writes nothing
/session-log-upload off                  # narrowing: applies immediately
/session-log-upload official-only        # narrowing: applies immediately
/session-log-upload any-model            # prints the disclosure prompt; writes NOTHING
/session-log-upload any-model confirm    # the actual widening write
/session-log-upload uploaded             # list which Session logs have been uploaded
```

### 详细日志 — what has been uploaded

**Settings → 会话日志上传 → 详细日志** lists every Session this plugin has uploaded: the Session id,
the range it was uploaded through, when it last happened, and the format version — read from
`$DSH_HOME/session-log-upload/watermarks.json`. There is a Refresh action, the log file's own
directory path, and a row-count summary that reports **the Host's own total** (or says the Host did
not report one) rather than a number the page counted for itself.

The same data is available without the UI:

```
/session-log-upload uploaded
```

**The name says "detailed log", but read what it actually is:** an **index of what was uploaded**,
not the uploaded material. Per Session it holds only the id, how far the upload got, when, and the
format generation — no prompts, no titles, no file paths, no message content. That is deliberate, so
this file can never become a second copy of your data.

Two honest limits, both stated in the UI as well:

- It covers uploads **this plugin** made. In `off` or `official-only` it is legitimately empty, and
  DSH's built-in official-API uploader is never listed here — so an empty log does not mean nothing
  was ever uploaded.
- It is **metadata only** — see above. The page also shows Session **titles** only behind an explicit
  opt-in toggle, because a title is derived from the conversation itself.

The page reads the log over an **authenticated** Host route
(`GET /api/session-log-upload.ledger`, a document-relative `fetch`), registered through the same
Connection Fetch registry the shipped `dsh-session-log-export` uses — so it inherits the page's
credential check and answers 401 without the cookie. A raw `webServer` route would have been
unauthenticated and would have exposed session ids to any local process.

The directory is **not hard-coded**: `host/watermark.js` resolves it as a non-blank `$DSH_HOME`
(with `~` expanded) with `~/.dsh` as the fallback, then joins the single literal segment
`session-log-upload`. Set `DSH_HOME` elsewhere and both files move with it.

### Attribution headers

The log-only request carries the same harness attribution headers the shipped official adapter sends,
so the receiver can attribute the upload the same way: `user-agent`
(`deepseek-harness/<version>`) from the harness's own `attributionHeaders()`, plus
`x-deepseek-harness-user-id` (the harness's **anonymous** id, the same one the shipped adapter uses)
and `x-deepseek-harness-session-id`. `x-deepseek-harness-compact` is never sent — the shipped adapter
only sends it for compaction requests, which ours never is.

All three are **best-effort**: each is omitted when its source is unavailable, no id is ever minted
invented, and a header failure never fails an upload. The two harness values are read from modules
inside the running installation, so they only resolve under Electron; in a plain-Node context the
Session id is still sent and the request still goes out.

The 详细日志 reports which headers the **last accepted** upload actually carried — names only, never
values — so you can see attribution working rather than taking it on trust.

### Maintainer note — there is no read-only middle ground

`dsh-settings`' `describe()` sends the page `projectForm(volatileForm(schema), …)` and nothing else. A
field is therefore either **volatile** — visible *and* writable through the settings RPC — or
**invisible to the page**, not even its default. That is why `mode`, `endpoint` and `maxBytes` are
volatile and the other three are not; it is also why a first version that marked only `mode` showed
`上传目标: 未配置`, which was simply false.

Two consequences you must not undo:

- **A volatile field reaches `apply` as a live cosmokit reference, not a value.** The plugin resolves
  it through `readLive()` and **re-reads the whole config per use** (`currentConfig()`), with no
  startup capture anywhere. If you reintroduce `const config = resolveConfig(rawConfig)`, the first
  settings write silently reverts `endpoint` to the default — the same fail-open class that once made
  `off` behave as `official-only`.
- **Volatile means writable.** A browser-side actor that can call `settings.mutate` on this namespace
  can repoint `endpoint`. That is an accepted trade: the alternative was a consent dialog that could
  not name where the data goes, which is worse. The remaining guard is that `resolveConfig` refuses a
  non-`http(s)` endpoint and falls back to the default, so a bad value cannot send logs to a `file:`
  or relative target. The page itself displays the destination and never offers to edit it.

The pending-range figure is deliberately **not** shown: it comes from the plugin's own watermark file,
not from configuration, so no read-only channel could report it.

---

## Why this bundle reaches into the DSH installation

A bundle installed into a profile cannot resolve bare specifiers — `@deepseek-ai/*`, `zod` and even
`@deepseek-ai/cordis` all fail with `ERR_MODULE_NOT_FOUND`, because Node resolves ESM from the
importing file's own location and the profile's `node_modules` holds none of them.

That matters because `dsh-settings` only manages profile entries that declare a `Config` with
volatile fields. So the row reaches the copy of `@deepseek-ai/schemastery` that ships **inside the
running Harness**, by absolute `file://` URL derived from `process.resourcesPath`, keeping the bare
specifier as a second candidate and "no schema" as a supported posture. If neither resolves, the
plugin still works — the mode is then patch-only and changed with the command. See
[docs/api-dossier.md](docs/api-dossier.md) §6.

Per-session watermarks are deliberately **not** stored through the harness: they are a plain JSON
file the plugin owns under `$DSH_HOME/session-log-upload/watermarks.json`.

---

## Verified to what extent

Proven against the real running Harness, not just unit tests:

- the row mounts, `Config` projects (`status: "schema"`, `mode` marked volatile), and the settings
  page registers in `settings.section` at order 60, active;
- in the real GUI: the default is preselected, `off`/`official-only` save silently, the wider modes
  raise the confirmation dialog, and the choice **survives a page refresh**;
- the page's three data rows are sourced for real: **上传目标** shows the effective endpoint,
  **每次请求的字节上限** shows `8 MiB`, and the unsourceable pending-range row is gone. (An earlier
  revision showed `未配置` / `未提供` for all three because only `mode` was volatile — see the
  maintainer note above.)
- the payload builder is byte-for-byte identical to the shipped uploader's wire format, re-derived
  against the shipped source (`verify/fidelity.mjs`);
- **the upload path works against the real endpoint.** Both wide modes have been exercised for real:
  in `deepseek-any-provider` the watermark advanced to `afterSeq: 800`, and later in `any-model` to
  `afterSeq: 1270`, then froze within 45 s each time the mode was returned to `official-only`. So
  this conversation's Session log has genuinely been transmitted to `api.deepseek.com` while a wide
  mode was selected — which is what the mode says it does, and why the dialog says it too.

**Current state on this machine:** the row is mounted at the default **`mode: official-only`**, so
nothing is being uploaded by this plugin. The profile's `cordis.patch.yml` carries the `insert` row
(and, once you change the mode in the UI, an editor-written override row too — the override wins). To
resume wider sharing, pick a mode in Settings or edit that row; to stop, set it back to
`official-only`.

Not verified: nothing in the upload path has been exercised under `any-model`; the `maxBytes`
backlog-drain path has not been driven with a real oversized event; and the plugin has never been
installed through the Plugin Manager, so its behaviour as a *bundle* (as opposed to a linked row) is
untested.

---

## Layout

| Path | Role |
|---|---|
| [index.js](index.js) | Host entry: `apply`, `inject`, optional `Config`, stream hook, exclusion, command |
| [host/config.js](host/config.js) | Raw config → resolved config, prototype-safe, volatile-aware |
| [host/eligibility.js](host/eligibility.js) | The behaviour matrix, as pure total functions |
| [host/logfield.js](host/logfield.js) | Builds the `dsh_session_log` envelope |
| [host/watermark.js](host/watermark.js) | Per-session upload watermark |
| [host/upload.js](host/upload.js) | The log-only POST |
| [client.js](client.js) | Settings section: four modes + consent gate |
| [locale/](locale/) | English and Chinese strings |
| [INTERFACES.md](INTERFACES.md) | The frozen contract the halves were built against |
| [docs/api-dossier.md](docs/api-dossier.md) | Verified harness API facts, with citations |
| [verify/](verify/) | Test suites and the independent verification report |

---

## Known environment blocker

`C:\Users\<you>\.dsh\profiles\desktop\node_modules\dsh-our-free-model` was created 2026-10-07 with an
owner the signed-in user cannot read. It is not a permissions problem that can be repaired with
`takeown` or `icacls`: an **elevated** administrator is refused by `takeown`, `icacls /reset`,
`Remove-Item` and `[System.IO.Directory]::Delete` alike, and the object returns both "access denied"
and "path not found" for the same call. That is the signature of a corrupt or orphaned NTFS
directory entry, and the normal repair is `chkdsk C: /f`.

Until it is repaired, pnpm aborts with `ERR_PNPM_EPERM` while scanning it, so **no bundle can be
installed in this profile** — which is why this plugin is mounted by hand. It also means the
`dsh-our-free-model` plugin itself may fail to load on the next DSH restart.
