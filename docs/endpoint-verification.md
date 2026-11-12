# Is the upload target correct? — `确定上传目标是正确的?`

**Verdict (one line).** **Yes.** `https://api.deepseek.com/anthropic/v1/messages` is *byte-identical* to the
URL the shipped DeepSeek adapter computes for its default base URL
(`messagesApiRoot("https://api.deepseek.com/anthropic") + "/messages"`,
`dsh-llm-deepseek/lib/index.js:579-582`, `:2231`), our `x-api-key` + `DEEPSEEK_API_KEY` scheme is exactly
the `deepseek-official` route's own auth (`dsh-llm-deepseek-api-key/lib/index.js:12`, `:131`), our
`dsh_session_log` sits as a top-level sibling of the model-input fields because that is where the shipped
extension mechanism spreads it (`dsh-llm-deepseek/lib/index.js:1381-1388`), and **11 accepted uploads
from this machine — the newest at 2026-11-12 12:38:19 (+08:00) — prove the URL answers 2xx in production**
(`index.js:709-710`). One documented limit: the *other* official route authenticates differently (§5).

Verified on 2026-11-12 against the shipped container at
`D:\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\…` and the live profile.
Verification-only: no plugin file was changed.

---

## 1. The exact URL the official adapter posts to

`dsh-llm-deepseek/lib/index.js:2231` is the request site:

```js
const response = await fetch(`${messagesApiRoot(connection.baseURL)}/messages`, {
    method: "POST", signal, body: extensions.payload, redirect: "error", headers: { … }
```

and `messagesApiRoot` (`:574-582`) is:

```js
/**
* Resolve the API root without duplicating an explicit provider version path.
* @param baseURL - validated configured endpoint root.
* @returns the root beneath which Messages resources are exposed.
*/
function messagesApiRoot(baseURL) {
    const base = baseURL.replace(/\/+$/u, "");
    return new URL(base).pathname.endsWith("/v1") ? base : `${base}/v1`;
}
```

It is **not** a literal: it appends `/v1` unless the configured root already ends in `/v1`, and it strips
trailing slashes first. So it is idempotent over `/v1`:

| `connection.baseURL` | `messagesApiRoot(...)` | `…/messages` |
|---|---|---|
| `https://api.deepseek.com/anthropic` (the default) | `https://api.deepseek.com/anthropic/v1` | **`https://api.deepseek.com/anthropic/v1/messages`** |
| `https://api.deepseek.com/anthropic/` | same (trailing slash stripped) | same |
| `https://api.deepseek.com/anthropic/v1` | unchanged, no `/v1/v1` | same |
| `https://gateway.example.com/anthropic` | `https://gateway.example.com/anthropic/v1` | `https://gateway.example.com/anthropic/v1/messages` |

**`connection.baseURL` itself** is resolved at `:441`:

```js
const baseURL = config.baseURL ?? environment?.get(BASE_URL_ENV)?.value ?? "https://api.deepseek.com/anthropic";
```

with `BASE_URL_ENV = "DEEPSEEK_BASE_URL"` (`:349`), `baseURL: z.string().volatile()` in the Config schema
(`:321`), and validation that it is an HTTP(S) root without credentials, query or fragment (`:443`).
`PUBLIC_BASE_URL` is the same string as the code default (`:347`,
`const PUBLIC_BASE_URL = "https://api.deepseek.com/anthropic"`), and the api-key route uses its **origin**
as the "official API" test (`dsh-llm-deepseek-api-key/lib/index.js:7-8`, `:33`).

**Live check:** the mounted api-key route (`include:llm-deepseek`) reports **no `baseURL` value** in its
projected schema, so the code default applies on this machine. Therefore our hard-coded default equals the
live adapter's destination **exactly**, character for character.

> **Caveat for a non-official deployment (not a defect, but a divergence to know).** Our plugin does not
> read `config.baseURL` / `DEEPSEEK_BASE_URL`; it has its own `endpoint` field, whose default is the
> official URL (`index.js:135`). If someone points the *adapter* at a gateway, the adapter posts logs to
> the gateway while ours still posts to `api.deepseek.com` — unless `endpoint` is changed. Two properties
> make that a safe divergence rather than a hazard: `endpoint` is `volatile`, so it is configurable
> through the patch or the settings RPC, and it must be an absolute HTTP(S) URL
> (`host/upload.js:182-184`, verified in the adversarial suite). We never follow a *redirect* either:
> `redirect: 'error'` (`host/upload.js:212`).

## 2. The request shape — Anthropic Messages, not `/chat/completions`

The adapter's serialised body (`:1728-1739`) is an Anthropic-`/messages` body, not an
OpenAI-`/chat/completions` body:

```js
return {
    model: options.model,
    stream: true,
    messages,
    max_tokens: options.maxTokens ?? model?.maxTokens ?? connection.maxTokens,
    thinking: { type: effort === "off" ? "disabled" : "enabled" },
    …
```

and the endpoint is `…/messages` (`:2231`). There is no `/chat/completions` anywhere in the adapter.
Our body (`host/upload.js:69-76`) is the same family, reduced to the minimum a Messages request needs:

```js
return {
    model: uploadModel,                       // 'deepseek-chat' by default (index.js:136) — the STUB model
    max_tokens: UPLOAD_MAX_TOKENS,            // 1 (host/upload.js:70)
    messages: [{ role: 'user', content: carrierMessage(source) }],
    dsh_session_log: field,                   // the payload that matters
}
```

**Update (after this document was first written).** The carrier message used to be the constant stub `'.'`
(`UPLOAD_STUB_CONTENT`, which no longer exists). It is now one informational line naming the provider and
model of the request that triggered the upload (`host/upload.js:114-117`):

```
DSH session-log upload. Source: provider=<provider> model=<model>. The Session log is carried in the dsh_session_log field.
```

The user's design call, and the reason is sound: a **new top-level field** could be rejected as unknown or
silently ignored, whereas `messages` is a defined part of the Messages API — so the source goes *inside*
the carrier message. The top-level key set is deliberately unchanged
(`['model','max_tokens','messages','dsh_session_log']`), the `model` field stays the stub, and the version-1
`dsh_session_log` envelope is untouched. `provider`/`model` are untrusted values, so they are flattened
(control, format, separator and surrogate runs collapse to one space), capped at 64 code points without
splitting an astral pair, and rendered as `unknown` when unusable (`host/upload.js:87-98`).

Method is `POST` (`host/upload.js:209`) as in `:2232`, and `content-type: application/json`
(`host/upload.js:199`) matches `:2238`. **The path and the protocol family are right.**

## 3. `dsh_session_log` is a top-level sibling — confirmed at the merge site

The session-log package registers the field name (`dsh-session-log-deepseek/lib/index.js:16`, `:140`):

```js
const inject = ["deepseekLlmApiExtensions", "sessions"];
…
ctx.deepseekLlmApiExtensions.register("dsh_session_log", { prepare: (request) => { … } });
```

The adapter consumes exactly that registry (`dsh-llm-deepseek/lib/index.js:2730`):

```js
prepareExtensions: (request) => ctx.get("deepseekLlmApiExtensions")?.prepare(request) ?? Promise.resolve({ … })
```

and **the placement is decided here** (`:1381-1388`), which is the line that answers the question:

```js
const fields = Object.keys(extensions.fields);
for (const field of fields) if (Object.hasOwn(body, field)) throw new LlmError(
    `DeepSeek request extension field ${JSON.stringify(field)} collides with the base request`, "REQUEST_EXTENSION");
let payload;
try {
    payload = JSON.stringify({
        ...body,            // model, stream, messages, max_tokens, thinking, …
        ...extensions.fields // ← dsh_session_log lands HERE, as a sibling
    });
```

So the serialised body is `{model, stream, messages, max_tokens, thinking, …, dsh_session_log}` — the field
is a **top-level sibling** of the model-input fields, exactly as our plugin builds it. Two further facts
worth recording because they bound our assumptions:

* there is a **collision guard**: a contributor may not shadow a base-request field, so the receiver will
  never see two contradictory `model`/`messages` values from this mechanism;
* if the merged body fails to serialise, the extension mechanism **drops the extensions and sends the base
  request alone** (`:1389-1396`, `onOmitted(fields, error)`). Our plugin does not use this mechanism (it
  builds the body itself), so that fallback does not apply to us — but it is why a log-only POST must
  carry `dsh_session_log` explicitly, which ours does.

## 4. `stream` and `accept` — the one deliberate difference, and why it is safe

The adapter **always** streams (`:1730`, `stream: true` is unconditional in the serialised body) and says so
in the headers (`:2239`, `"accept": "text/event-stream"`). It has no non-streaming Messages path.

Our plugin deliberately does the opposite: no `stream` field (so it defaults to `false`) and
`accept: application/json` (`host/upload.js:200`), documented at `host/upload.js:12-14` as "because this
request does not set `stream: true`, so the endpoint answers with one JSON message we discard".

Assessment: **correct, and the strongest evidence is empirical rather than documentary.**

* `stream` is an optional Messages parameter; omitting it requests a single JSON response. It changes the
  **response encoding**, not the routing, the auth, the URL or the request-body schema — and we discard the
  response body anyway (`host/upload.js:224`, `discardBody`).
* The shipped adapter cannot be cited as proof that a *non-streaming* request is accepted, because it never
  issues one. So the documentary evidence stops at the API contract; the empirical evidence carries the
  rest: `index.js:709-710` advances the watermark **only** on an accepted upload, and the live watermark
  holds **11 sessions** with the newest write at **2026-11-12 12:38:19 (+08:00)** — i.e. this exact URL,
  with this exact header set and this non-streaming body, answered 2xx from this machine, repeatedly.
* A `dsh_session_log`-dominated body does not need streaming: the field is parsed by the same server-side
  extension handling regardless of the response mode, and the response is discarded. There is no evidence
  the receiver treats the request differently because of `stream`.

## 5. The two official routes — same URL, **different auth**

This is the part of the question with a real answer that is not "yes, identical".

| | `deepseek-official` | `deepseek-account` |
|---|---|---|
| package | `@deepseek-ai/dsh-llm-deepseek-api-key` | `@deepseek-ai/dsh-llm-deepseek-account` |
| provider id | `PROVIDER = "deepseek-official"` (`:47`) | `PROVIDER = "deepseek-account"` (`:70`) |
| URL | `messagesApiRoot(connection.baseURL)/messages` — the shared transport | **the same**, shared transport |
| auth header | `{ "x-api-key": await resolveApiKey(connection) }` (`:131`) | `{ [TOKEN_HEADER]: token }` where `TOKEN_HEADER = "x-dsh-auth-token"` (`:72`, `:85`) |
| credential | a stored credential by ref: `apiKeyEnv` default **`DEEPSEEK_API_KEY`** (`:12`), `credentialRef(apiKeyEnv ?? "DEEPSEEK_API_KEY")` (`:36`) | `ctx.get("deepseekAccount").resolveToken(connection.baseURL)` — an **account session token**, no credential ref at all (`:80-83`) |
| no auth available | `MISSING_CREDENTIAL` ("store DEEPSEEK_API_KEY …") (`:63`) | `ACCOUNT_SIGN_IN_REQUIRED` ("Sign in to DeepSeek to use the account provider") (`:83`) |
| live on this machine | **yes** — `Config.listConfigs` → `include:llm-deepseek`, `status: "schema"` | **yes** — `Config.listConfigs` → `include:llm-deepseek-account`, `status: "schema"` |

Also note the account route's header is documented at `:71-72` as "Header carrying the account token on
Messages, Files, and model-listing requests" — it is not an alias for `x-api-key`; the two routes are two
auth schemes against the same Messages endpoint. `anthropic-version: 2023-06-01` is sent by the shared
transport for both (`:2241`).

**Consequence for our plugin, stated plainly — updated for task-21.** The plugin now implements **both**
schemes, chosen per request by `resolveAuth(endpoint)` (`index.js:826-859`), and the credential is picked
in this order:

1. the stored credential at `credentialRef` (default `DEEPSEEK_API_KEY`) → **`x-api-key`** (`:846`);
2. if no key is available, the **`x-dsh-auth-token`** account token — **but only after an endpoint gate**
   (`:848-855`): `isOfficialDeepSeekEndpoint(endpoint)` (`:408-430`) requires the official origin, on
   `https:`, with a path beneath `/anthropic`, so a look-alike host, an `http://` downgrade, a sibling
   path or a path that merely shares a prefix is refused, and the token is then **not offered at all** —
   because `endpoint` is user-editable and the account token must never travel to a user-set collector;
3. otherwise no auth, and the upload is skipped with a diagnostic (`:856-859`).

The token itself comes from `ctx.get('deepseekAccount').resolveToken(OFFICIAL_DEEPSEEK_BASE)`
(`:876-886`) — the canonical base constant (`:388`), not one derived from the effective endpoint, so a
crafted endpoint cannot shape what is passed to `resolveToken`; and the platform's own origin comparison
(`dsh-deepseek-account-platform/lib/index.js:804-826`) is a second, independent gate behind ours. The
transport accepts exactly one auth header per request (`host/upload.js:149`,
`AUTH_HEADERS = ['x-api-key', 'x-dsh-auth-token']`, and its `:243` comment: neither a stray `x-api-key`
nor a stray `x-dsh-auth-token` can produce a second scheme).

So the two sub-cases from the earlier revision are resolved as follows:

* **API-key users (this user):** unchanged — the key is preferred and the target is right.
* **Account-only users:** the upload now works on the account route *and* is refused rather than
  misdirected anywhere else.
* **Still open (E5):** whether a deployment in account mode accepts the `x-api-key` scheme when a key
  *is* also stored — this plugin prefers the key, so that combination would still send `x-api-key` to a
  route whose own adapter sends `x-dsh-auth-token`. Nothing I have read establishes the receiver's
  answer, and it is no longer a case where the plugin has no alternative (the token path exists, it is
  simply second in preference).

Nothing here is a privacy defect: no log is ever sent to a different host, in a different body shape, or
with a different account's identity, and the account token is explicitly bound to the official
destination.

**Not verified here.** I read this new auth path from source while correcting this document; I have not
driven it (no `deepseekAccount` in my harness, no live account-route upload observed). Its verification
belongs to a task of its own — see E6.

## 6. `anthropic-version` — a hard-coded constant, and ours matches

`"anthropic-version": "2023-06-01"` is a literal in the Messages request (`:2241`) and again in the Files
API transport (`:679`). It is **not** configurable, and it is not in the Config schema. Ours is the same
literal (`host/upload.js:202`). ✔

## 7. Is the credential reference right for the credential the user has?

* The api-key route's own default reference **is** `DEEPSEEK_API_KEY`
  (`dsh-llm-deepseek-api-key/lib/index.js:12`), live-projected with
  `"default": "DEEPSEEK_API_KEY"` and `x-cordis.role: "credential-ref"`. It is configurable
  (`.volatile()`, and `credentialRef(apiKeyEnv ?? …)` at `:36`), but on this machine it is unset, so the
  default stands.
* Our row's live schema has `credentialRef` default `DEEPSEEK_API_KEY` (`index.js:137`) — **the same
  reference**, so the key our plugin reads is the key the official adapter reads for this route.
* **Proof that it resolves on this machine:** the watermark advances only after `result.ok === true`
  (`index.js:709-710`), and `uploadLogField` refuses before `fetch` when no credential value is available
  (`host/upload.js:173-175`). An accepted upload therefore *implies* that `DEEPSEEK_API_KEY` resolved at
  that moment. The live file shows 11 such records (§8). I did not read the credential store itself: the
  upload evidence is both stronger and less invasive than inspecting the user's secrets.

## 8. Empirical evidence (the strongest single item)

| Evidence | Value |
|---|---|
| Live watermark file | `C:\Users\<you>\.dsh\session-log-upload\watermarks.json` |
| Records | **11** sessions, each `{afterSeq, sessionFormatVersion: 4, updatedAt}` |
| Newest write | `updatedAt: 1794458299704` = **2026-11-12 12:38:19 (+08:00)** |
| One session's progress | `session-167fda32-…` at `afterSeq: 1810` (it was `800` in an earlier pass) |
| What it proves | `index.js:709-710` writes the watermark **only** on HTTP 2xx, so each record is an accepted POST at the configured endpoint with `x-api-key` + `anthropic-version` + the non-streaming Messages body |

A 404, a wrong path, a missing/incorrect `anthropic-version`, a rejected `x-api-key`, or a
`/chat/completions`-shaped body would all have produced a non-2xx and **no watermark advance**. Eleven
records, the newest during this session, is direct evidence that the target is not merely well-formed but
**accepted by the receiver**.

## 9. Our code vs the shipped adapter — every difference and its reason

| Header / field | Adapter (`:2231-2247`) | Ours (`host/upload.js:198-214`) | Assessment |
|---|---|---|---|
| URL | `messagesApiRoot(baseURL)/messages` | the same URL, literal default | **identical** for the default and for any `/v1` base |
| method | `POST` | `POST` | identical |
| `content-type` | `application/json` | `application/json` | identical |
| `anthropic-version` | `2023-06-01` | `2023-06-01` | identical |
| auth | `…auth.headers` → `x-api-key` (api-key route) | `x-api-key` | identical for that route; see §5 for the account route |
| `user-agent` | `…attributionHeaders()` | mirrored, best-effort (`index.js:196-233`) | same value when the helper resolves |
| `x-deepseek-harness-user-id` | `this.dependencies.resolveUserId()` | mirrored from the anonymous-id helper | same source the adapter itself uses |
| `x-deepseek-harness-session-id` | only when the request has an id | only when the Session has an id | same condition |
| `x-deepseek-harness-compact` | only when `purpose === 'compaction'` | never sent | correct: a log-only POST is not a compaction |
| `anthropic-beta` | only for files / tool-change betas | never sent | correct: our body has neither |
| `accept` | `text/event-stream` | `application/json` | deliberate; §4 |
| `stream` | `true` | absent (false) | deliberate; §4 |
| body | full Messages request | minimal Messages request + `dsh_session_log` | same family; §2, §3 |
| `redirect` | `"error"` | `"error"` | identical |

Nothing in `index.js` or `host/upload.js` contradicts the shipped behaviour, and the one place where the
plugin deliberately differs (`stream`/`accept`) is the one place the empirical 2xx settles.

## 10. What would make this wrong — falsifiable conditions

For the audit trail, these are the observations that would overturn the verdict:

1. A watermark record whose `updatedAt` follows a *non*-2xx attempt (it cannot: the write is inside
   `if (result.ok === true)`, `index.js:709`).
2. A live `Config.listConfigs` showing an explicit `baseURL` on `include:llm-deepseek` that does not end in
   `/v1` or `/anthropic` (today it shows none, so the code default applies).
3. The api-key route's `apiKeyEnv` configured to a ref other than the one our `credentialRef` holds.
4. A 2xx at a *different* URL than the one configured — impossible by construction, since the URL is the
   `fetch` first argument (`host/upload.js:208`) and the only narrowing is the absolute-HTTP(S) check
   (`host/upload.js:182-184`).

## 11. Verdict, restated

**The target is correct.** Path, protocol family, method, `anthropic-version`, auth header, credential
reference and payload placement all match what the shipped adapter does for the `deepseek-official` route,
and the URL is empirically live from this machine (11 accepted uploads, newest 2026-11-12 12:38:19 +08:00).

**Two documented limits, neither a shipping defect for this user:**

1. **Non-official deployments.** Our `endpoint` does not follow the adapter's configurable `baseURL` /
   `DEEPSEEK_BASE_URL`; it defaults to the official URL. Correct for the default; a gateway deployment must
   set our `endpoint` too (it is volatile and configurable).
2. **The account route (resolved in task-21, gated).** `deepseek-account` posts to the same URL but
   authenticates with `x-dsh-auth-token` from the account session. The plugin now offers that token as a
   **fallback after the stored key**, and only when the effective endpoint passes
   `isOfficialDeepSeekEndpoint()` — so it either authenticates correctly (account-only user, official
   destination) or refuses rather than sending a token anywhere else. The remaining open question is E5
   (a stored key on an account-mode deployment), and the new path's own behaviour is E6: read from
   source, not yet driven.

---

### Changes landed after this document was first written (both verified or flagged as noted)

* **task-19 (client): the endpoint and cap are now editable from the settings page.** Landed. The
  corresponding locale keys are in place, and the client suites pass — including the retargeted
  assertions that replaced "the page cannot edit these" with "the effective value is still rendered
  read-only beside the input, and the dialog names the effective value, never an unsaved draft".
  Consequences: **who can change the target** now includes the page (the write guard still admits only
  `mode`, `endpoint`, `maxBytes`), and the "shown == used" property has been re-verified for that
  second on-screen value — the read-only line and the consent dialog are asserted against the effective
  value while a draft sits in the input.
* **task-21 (host): the account auth scheme is now implemented** — see §5. It supersedes the earlier
  revision of this document, which stated the plugin implemented only `x-api-key`. I read the new path
  from source to make this correction accurate, and flagged it as **E6**, unverified by execution.

---

### UNVERIFIED / not settled here

| # | Item | Why it is not settled | How it could be settled |
|---|---|---|---|
| E1 | Whether the **receiver** accepts a non-streaming Messages request in general (beyond our own setups) | The adapter never issues one, so no shipped code path proves it; we have 11 accepted uploads but they are all from this installation and this body shape | A one-off request with `stream` omitted against the same endpoint, or provider documentation |
| E2 | Whether `dsh_session_log` is accepted on the **account** route | Our plugin has never uploaded there (it cannot authenticate), so there is no evidence either way | Implement the `x-dsh-auth-token` path and observe a 2xx, or ask the provider |
| E3 | Whether the *user's* `DEEPSEEK_API_KEY` is the same key their official-route traffic uses | I deliberately did not read the credential store; I infer resolution from accepted uploads | Compare the ref names in `.credentials.yaml` (names only) with the live `apiKeyEnv` |
| E4 | The live route the user is actually on (`deepseek-official` vs `deepseek-account`) | Both routes are mounted; `llm.listProviders()` is a business method my read-only inspect cannot call | The Models page, or a session's provider id |
| E5 | Whether the receiver **accepts `x-api-key`** on a deployment operating in account mode | The two routes are two auth schemes at one Messages URL; I found no shipped code that proves how the server resolves a stray `x-api-key` (the adapter sends only the header its own route resolved). The plugin now *prefers* the stored key, so this combination still arises | Send one log-only POST with `x-api-key` while on the account route and read the status; or provider documentation on per-request auth resolution |
| E6 | The **task-21 account-token path** itself: the endpoint gate, the preferred-key/fallback-token order, the one-auth-header invariant, and the `deepseekAccount.resolveToken` call | Read from source while correcting this document after task-21 landed (`index.js:408-430`, `:826-886`; `host/upload.js:149`, `:243`); I have not driven it — my host harness has no `deepseekAccount` service, and no account-route upload has been observed live | A host-suite task that fakes `deepseekAccount.resolveToken` (present, absent, throwing, wrong-destination) and asserts the header chosen, that a non-official endpoint never receives the token, and that exactly one auth header goes out |
