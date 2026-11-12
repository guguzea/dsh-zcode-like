# Independent verification report — `@local/dsh-session-log-upload` (current revision)

**Verifier:** `verifier`. **Date:** 2026-11-12, ~12:15 (+08:00). **Latest pass:** A6 inversion + the
standing invariant, then the `attribution.resolvable` field. **Final revision verified:** `index.js`
`64140B4A48A53594`, `client.js` `EF329AA9F1AE565E`, `host/watermark.js` `FA5E3376646C877C`,
`host/upload.js` `EBF6D1A80F9ED274`, locale `EBF598068AFFC37E` / `224551335FD5CC86`. Green `run-all`
reproduced twice consecutively at that revision.
**Subject:** the bundle at `<bundle-root>\` after five change sets — revision 1 (initial), the fix pass,
the H1–H3 hardening pass, the three-volatile-field wire, A1/A2, and **the ledger + attribution
features and their UI** (this pass).
**Method:** read every shipped source; executed the *shipped* DSH modules (uploader, schema builder,
settings projector) out of `app.asar` against the bundle; ran the host half against a fake Cordis
context (now including a Connection service) and the client half against a hand-written hook runtime;
queried the live Host with `cordis_inspect_query`; read the live profile patch, watermark file and the
plugin junction (read-only).

Live installation is in scope and **was exercised by the Lead and the user**; this session did not
perform the GUI interaction itself, so **the page's visual state after this revision is the Lead's and
the user's observation, not mine** (see U1/U11).

> **Churn note.** `index.js`, `client.js`, `host/upload.js` and `host/watermark.js` all changed during
> this pass (e.g. `client.js` gained the ledger UI after my first read of it). Assertions that read a
> *comment* are written against semantic fragments, the client ledger is polled to completion rather
> than assumed settled, and the hashes below are pinned to the revision that produced the green run.

> **Editorial note (my own tooling).** While truncating a stray block I round-tripped
> `verify/adversarial-host.mjs` through PowerShell `Get-Content`/`Set-Content`, which mis-decoded the
> file (GBK) and lost 25 characters (em dashes and five line breaks). I detected it by counting
> `U+FFFD`, inverted the transformation byte-exactly, and repaired the 25 sites; the box-drawing art
> (686 `═`), CRLF endings and `node --check` are all verified intact, and every suite passes from the
> repaired file. No shipped source was touched, and no other file was round-tripped. All later text
> surgery was done with Node or the editor, never PowerShell.

---

## Verdict

**Safe to ship.** A6 is **fixed and verified**; the two retargets kept their properties; the standing
invariant that came out of A6 now guards the whole class. One profile-level item remains for the Lead
to reconcile (P1).

**A6 — FIXED, and now a standing invariant rather than a one-off check.** The fix wraps all three
optional registrations that run after the `off` exclusion (`registerLedgerRoute`,
`registerStreamHook`, `registerCommand`) in try/catch + warn, leaving the exclusion itself
deliberately unwrapped (its service is guaranteed by `inject`, and its failure means there is nothing
left to protect). I verified the wrappers by reading them, and left behind **one** general check in
place of three ad-hoc ones — *no optional registration may be able to dispose the `off` exclusion* —
asserted two ways:

- **structural**: scan every `ctx.effect(` / `ctx.on(` / `ctx.inject(` call site with a
  length-preserving brace scanner and require that the only *unprotected* sites are the two justified
  by `inject` (the exclusion and the unload disposer). A fourth optional registration added without a
  try/catch fails here even though no check names it. Sensitivity is proven in-memory: two synthesized
  mutations (an appended unguarded registration, a removed `try`) are both detected.
- **behavioural**: four seams (`connection.fetch.register`, `commands.register`, `ctx.inject`,
  `ctx.on` without `inject`) are each made to throw; for every one, `applyError` is `undefined`, the
  `off` exclusion is present and **its predicate returns `true`**, the degradation is logged by name,
  the registrations that follow still run, and a normal unload still disposes the exclusion.

**Non-vacuity, to `host-fix`'s standard.** The behavioural check would be worthless if it could not
fail, and the bug cannot be reintroduced into the shipped file — so the suite clones `index.js` into
`verify/`, excises exactly the try/catch protecting the ledger registration (absolute-URL rewrites for
its five relative imports, asserted), imports the clone and drives the identical harness against it:
the throw then escapes `apply`, and the exclusion the clone had already registered is torn down with
it. Guard present → armed; guard removed → disarmed. That is the experiment, in the suite, not a claim.

**P1 — RESOLVED (profile-level; never a defect of the plugin).** At 11:46 (+08:00) I measured the live
profile patch `C:\Users\<you>\.dsh\profiles\desktop\cordis.patch.yml` and found **two rows for the same
plugin id**: the `- insert:` row at 137-147 (`mode: official-only`) and a second bare row at 148-157
(`mode: deepseek-any-provider` — a wide mode). A bare `- id: X` in this dialect is an *override*, so the
effective live mode was plausibly the wide one, which is consent-relevant. My measurements were exact —
SHA-256 `6B507DE80569EF8E5F52ACEF94F4F66775ECF611CA8C0389B11DC1B08C496370`, 157 lines, LF endings, no
BOM, mtime 2026-11-12 11:46:05 — and the `BD2C8FF0…B7` / 147-line figure I was given was a **backup**,
not the live file, which had legitimately changed by the time I read it. The Lead removed the duplicate
at 11:59: the file now has **exactly one** row for `id: session-log-upload` with a single
`mode: official-only` line, an id-count check confirms it, the unrelated config rows are intact
(`provider: acme-relay`, `apiKeyEnv: ACME_RELAY_KEY`, `ui-settings.enabled: true`), and the plugin
row count is 1. The junction is intact
(`…\profiles\desktop\node_modules\@local\dsh-session-log-upload` → `<bundle-root>`). I did not touch the
profile.

**Known operational hazard (recorded, not a plugin defect).** Something rewrote the patch after the
Lead's restore and **recreated the editor-written override with a wide mode**. That is the hazard this
plugin's design is meant to prevent, and it is a property of the *override-by-id patch shape* rather
than a one-off mistake: any stale settings write — a page holding an older descriptor, a retry, or an
edit made against a snapshot — can silently re-widen the mode, and because the override is a separate
row it can also *duplicate* the `insert` row rather than replacing it. Consequences to keep in mind:
`mode` is genuinely live (verified here), so a re-widened mode takes effect on the next request with no
restart and no visible artefact beyond the page's own row; and a duplicated id leaves the effective
configuration dependent on how the Loader resolves the collision. The mitigations that exist are the
ones verified in this report — the schema's four-id pattern, the two-step command gate, the consent
dialog naming the destination — and none of them can prevent a stale write that is itself
schema-valid and confirmed. Worth an id-uniqueness guard on the patch file in the profile tooling, or
an "override only, never insert" convention.

This pass also verified the two new features independently, and retargeted two assertions that had gone
stale rather than weakening them.

**What holds.** The ledger route is registered read-only (GET) on Connection's authenticated Fetch
registry, skipped without a throw when there is no Connection service, and the `mode: off` exclusion
survives that path; its payload is metadata-only and cannot carry conversation content even from a
hand-crafted watermark file; `WatermarkStore.list()` is total over 12 broken/partial files and
deterministic; the attribution report is in-memory, names-only, set only by an accepted upload, and
never persisted; the attribution headers mirror the shipped adapter's three names (verified against the
shipped sources), refuse to use the account-linked identity, and mint no id when the `app.asar` helpers
are unreachable; and the page maps nine failure shapes onto four distinct, honestly-named non-ready
states, uses the Host's own `total`, invents no rows, and never renders smuggled content.

Condensed state of the safety argument (unchanged elsewhere):

* the default is `official-only` under every hostile input tested, prototype pollution is refused, and
  the schema rejects a `mode` id outside the four frozen ones;
* `off` suppresses the shipped upload through a per-request predicate that never depended on `llm`;
* the `/session-log-upload` command needs an explicit `confirm` token to widen (400-input brute force:
  0 unconfirmed widening writes), and the gate reads a **frozen** list through `isWideMode`;
* the settings wire admits exactly `mode`, `endpoint` and `maxBytes`, and refuses
  `deepseekModelPatterns`, `uploadModel` and `credentialRef`;
* no channel can make the plugin POST anywhere but an absolute HTTP(S) URL — `resolveConfig` narrows,
  and the transport refuses independently;
* nothing is captured at startup: `endpoint`, `maxBytes` and `mode` are read per use, verified
  behaviourally and through the real cosmokit volatile protocol.

---

## Revision verified

SHA-256, first 16 hex digits, pinned to the current revision (the three-volatile-field wire).
Changed files are marked ← with their previous hash; `host/logfield.js`, `host/upload.js`,
`host/watermark.js`, `host/eligibility.js`, `cordis.patch.yml`, `package.json` and `icon.svg` are
byte-identical to revision 1.

| File | SHA-256 (16) | |
|---|---|---|
| `package.json` | `51199CCD86753A8F` | |
| `index.js` | `64140B4A48A53594` | ← A6 wrappers + `attribution.resolvable` |
| `client.js` | `EF329AA9F1AE565E` | |
| `cordis.patch.yml` | `7CF60987115B50D7` | |
| `icon.svg` | `C9BB9405A9DCDD37` | |
| `locale/en.json` | `EBF598068AFFC37E` | ← |
| `locale/zh.json` | `224551335FD5CC86` | ← |
| `host/config.js` | `6B91CFD41CD15C1A` | |
| `host/eligibility.js` | `6948389400EC9C3D` | |
| `host/logfield.js` | `01F892A6A6387B73` | |
| `host/upload.js` | `EBF6D1A80F9ED274` | ← |
| `host/watermark.js` | `FA5E3376646C877C` | ← |

**Final revision, and what "green" means.** The green `run-all` above is at `index.js`
`64140B4A48A53594` and was reproduced twice consecutively after the last edit. It was **not** green
continuously, and two of those intervals are worth recording:

- After `host-fix` landed A6, my suite still contained the *finding demonstration*, so `run-all` was
  6/7 with the only red being **my own check** asserting the throw escaped `apply`. That red was my
  finding being fixed, not a regression; **the inversion was mine**, and the three checks that replaced
  it (standing invariant, structural and behavioural, plus the clone-and-excise non-vacuity proof) are
  described in the current change set.
- While the `attribution.resolvable` field was being landed (`index.js` moved
  `EE47034AC51097FE` → `3CE46041FDC095DF` → `64140B4A48A53594` across three of my reads), my battery
  caught a **real transient breakage**: `ledgerPayload()` had become `async` while the route handler
  still serialised the un-awaited call, and `JSON.stringify(<Promise>)` is `{}` — so the ledger
  answered `200` with an empty object. Both `host-unit` and my suite failed identically
  (`Object.keys(payload)` → `[]`, `payload.total` → `undefined`). One `await` fixed it, and the settled
  revision is verified above. It is recorded because it is exactly the failure a *reader* of the ledger
  cannot distinguish from "nothing uploaded", and because a build cut inside that window would have
  shipped a ledger that always looks empty. The suites caught it because they assert the payload's
  shape rather than just its status code.

So any statement that `run-all` exits 0 applies to the revision it was run against —
`D6E37BC588ECA43C` for the A1/A2 pass, `9328ACD44354F60D` for the ledger/attribution pass,
`EE47034AC51097FE` for the A6 pass — not to the tree at large. The standing invariant is what makes
that distinction safe to rely on: it fails on *structure*, so an edit that lands in two parts still
trips it on the second part.

`host/logfield.js`, `host/upload.js`, `host/watermark.js`, `host/eligibility.js`, `cordis.patch.yml`,
`package.json` and `icon.svg` are byte-identical to revision 1.

Reproduce everything with `node verify/run-all.mjs` — **exit 0, all seven suites green**:

| Suite | Result |
|---|---|
| `verify/host-unit.mjs` (implementers') | PASS 82/82 |
| `verify/client-check.mjs` (implementers') | PASS 20/20 |
| `verify/fidelity.mjs` (differential vs the shipped uploader) | PASS |
| `verify/adversarial-host.mjs` (mine, retargeted for both the H1–H3 and three-volatile passes) | PASS |
| `verify/adversarial-client.mjs` (mine, extended) | PASS |
| `verify/schema-check.mjs` (mine, vs the real schemastery) | PASS |
| `verify/check-tokens.mjs` (mine) | PASS |

---

## What I retargeted in my own suite

`verify/adversarial-host.mjs` failed 8 checks against revision 2 — every one of them asserted the
*old* buggy behaviour. Each was inverted to assert the fix, never weakened:

| Old check (asserted the bug) | Retargeted to assert |
|---|---|
| `FINDING: an inherited Object.prototype.mode selects a wider mode` | prototype pollution cannot widen `mode` **or** redirect `endpoint`/`credentialRef`/`uploadModel`/`maxBytes`/`deepseekModelPatterns` (`Object.hasOwn`) |
| `decideUpload is not total against a hostile getter` | totality: a throwing getter on each of the five fields, a throwing `Proxy`, and a null-prototype input all decide (never escape) |
| `mode off: the exclusion predicate is registered and every request is suppressed` | the exclusion is registered in **every** mode and returns `suppressShipped(currentMode())` — `true` only for `off`, and it flips with the live mode |
| `mode off: no upload even if a stream is driven` | the `llm/stream` listener is installed in every mode, stays idle outside modes 3/4, and **starts/stops uploading when the live mode flips, with no re-application** |
| `official-only: today's behaviour, no extra request and no exclusion` | same design: the listener exists in `official-only` too and decides `none` per request |
| `index.js contains no confirmation mechanism` | `CONFIRM_WORD`, `WIDE_MODES`, the gate expression, exactly one `persistMode(` call site **after** the gate, exactly one `configEditor.edit(` call inside it |
| `the command widens the mode in one call, with no confirmation step` | without the token: **zero** writes + a prompt naming the endpoint, other providers and the exact confirmation; with the token: exactly one write; case/tab/multi-space tolerant; ten near-miss tokens all refused; **400-input brute force with 0 unconfirmed widening writes** |
| `the command rejects unknown modes and takes the first token only` | unknown modes, `ANY-MODEL`, `--mode=…`, `\u0000`, bare/blank input all write nothing; a bare invocation reports status |

New checks added in this pass (the Lead's named targets):

* **§2 the volatile unwrap** — a cosmokit-shaped reference (`Object.freeze({get, [Symbol.for('cosmokit.volatile.write')]})`,
  built from the real protocol read at `cosmokit/lib/index.js:83,102-110`) is unwrapped to its current
  value; a reference that throws or holds a non-string narrows to `official-only`; **only `mode` is
  unwrapped**, so an `endpoint` object with a `get` cannot hijack the POST target.
* **§5 live-mode flipping** — mutating the live config object (and writing through the volatile
  reference) changes what the *same* plugin instance uploads and suppresses, both directions.
* **§5 the child fiber** — `ctx.inject(['llm'], …)` receives `['llm']`, the listener lands on the
  child, and the child is disposed with the row; a host without `ctx.inject` falls back to a direct
  listener.
* **§8 the schema path** — `Config` exists but is `undefined` in plain Node (graceful degradation),
  the hard-coded `app.asar` candidate path points at a real 23 KB module, and `.volatile()` appears
  exactly once.

`verify/adversarial-client.mjs` gained 6 checks for the reworked client: `whileServed` defers both
registrations until the namespace is served (and its disposer runs), a host without it registers
immediately, the not-served state disables the radios and offers the manual route with **no** spurious
save error, a volatile client-side form value is unwrapped for display, the manual block is a
collapsed `<details>`, and the printed command carries no `confirm` token.

`verify/schema-check.mjs` is new: it extracts `schemastery/lib/index.mjs` (3.19.0) and
`cosmokit/lib/index.js` from `app.asar`, rewrites exactly one import line (asserted: line 0 is the
only difference), and runs the plugin's **own** `Config` declaration plus `dsh-settings`' real
`plainSchema`/`volatileForm`/`isVolatilePath` against them.

### Retargeted again for the H1–H3 pass

H1–H3 invalidated scope-level assumptions in my suites (not behaviour), so the following were
retargeted — inverted where the fix changed the assertion's meaning, tightened where the shape moved:

| Site | Was | Now |
|---|---|---|
| `adversarial-host.mjs`, gate check | `WIDE_MODES = new Set([…])` + `WIDE_MODES.has(next)` | `Object.freeze([…])` + `export function isWideMode`, the gate expression `if (isWideMode(next) && …)`, and an assertion that the gate line does **not** touch the array itself |
| `adversarial-host.mjs`, brute force | `WIDE_MODES.has(mode)` (threw: arrays have no `.has`) | `isWideMode(mode)` — the 400-input run is green again (16 confirmed, 0 unconfirmed) |
| `adversarial-host.mjs`, "INFO: mutable Set" | emptied the set with `delete`/`add` (threw) | inverted into the authority on that regression: frozen, every mutator throws, list unchanged, unconfirmed widening still writes nothing, confirmed still writes once |
| `adversarial-host.mjs`, schema idiom | `mode: z.string().default(...).volatile()` | `mode: modeField(z)` + the helper's try/pattern/fallback text + `MODE_PATTERN` built from `MODES` with metacharacter escaping; `.volatile()` count still exactly 1 |
| `adversarial-host.mjs`, "FINDING: unconstrained mode" | asserted the constraint was absent | **inverted**: `z.string().pattern(MODE_PATTERN)` is present, and `resolveConfig` still narrows a corrupt in-memory value |
| `adversarial-host.mjs`, bare specifier | asserted exactly one bare specifier remained | **inverted**: zero `"@scope/name"` literals, no `candidates.push`, exactly one `import(specifier)` fed by `pathToFileURL(...).href` |
| `schema-check.mjs`, extraction | sliced `Config = z.object({…})` to the old `\n      break` anchor (anchor gone) | slices `const MODE_PATTERN` → `let Config` plus the object literal, and evaluates both with `MODES` and `z` in scope so `modeField` resolves |
| `schema-check.mjs`, unknown mode | asserted `offf` was accepted | **inverted**: rejected with a `expect string to match regexp` issue, for seven hostile strings |
| `schema-check.mjs`, volatile node | pinned the default only | also pins `meta.pattern.source` against the real builder's projection |
| `schema-check.mjs`, new checks | — | exact pattern source; metacharacter escaping under a hostile `MODES`; `modeField`'s degraded path still receives `.default('official-only')` and `.volatile()` when `.pattern()` throws |

Everything else passed as-is, including the client suite (untouched by H1–H3).

---

## Revision 1 findings — status and fix evidence

| # | Revision 1 finding | Status | Evidence |
|---|---|---|---|
| F1 | command widened with no confirmation | **FIXED** | `index.js:485-489` gate before the single `persistMode` call at `index.js:489`; `confirmationPrompt` names the endpoint and other providers; 400-input brute force found 0 unconfirmed widening writes |
| F2 | settings UI could not persist (no `Config`) | **FIXED** | `index.js:54-87` exports `Config`; live `Config.listConfigs` → `status: "schema"`; `verify/schema-check.mjs` shows `validate({})` yields a genuine volatile ref holding `official-only` |
| F3 | prototype pollution widened the default | **FIXED** | `host/config.js:88-90` `own()` uses `Object.hasOwn`; retargeted check covers all six keys |
| F4 | log-only POST lacks the shipped attribution headers | **ACCEPTED LIVE, still divergent** | `host/upload.js:133-139` unchanged, but the live watermark proves a **real 2xx** from `api.deepseek.com` for exactly this request — see "Live evidence" |
| F5 | `off` depended on `llm` being present | **FIXED** | `index.js:106` `inject = ['sessionLogDeepSeek']`; the listener moved to `ctx.inject(['llm'], …)` (`index.js:242-255`); the exclusion is registered unconditionally (`index.js:182-191`) and decided per request |
| F6 | no `whileServed`; a dead page could look live | **FIXED** | `client.js:1033-1041,1065-1097`; `formState()` (`client.js:409-420`) no longer treats `remote.settings.mutate`'s existence as writability |
| F7 | `dsh.client.inject` omitted the locale package | **FIXED** | `package.json` now lists both frozen packages |
| F8 | section declares no `children` | unchanged, re-verified non-breaking | the shell renders the active section's own component (`dsh-client-ui-settings-general/lib/client.js:341`) |
| F9 | `decideUpload` not total | **FIXED** | `host/eligibility.js:77-94` |
| F10 | duplicate range after a cross-route session | unchanged (by design) | reported as INFO below |
| F11 | best-effort watermark flush, no retry | unchanged | INFO below |
| F12 | `probe/` not deleted | **FIXED** | the directory is gone |
| F13 | dead `upload.pendingValue` string | unchanged | INFO below |

---

## Live evidence obtained in this pass

Read-only, from the live harness and the user profile. **None of this session's commands wrote to
`C:\Users\<you>\.dsh`, and `plugin_manager` was not run.**

1. **The row is mounted with a live schema.**
   `Config.listConfigs {name:"@local/dsh-session-log-upload"}` →
   `{id:"include:session-log-upload", patchId:"session-log-upload", status:"schema"}`.
   The entry's projected schema has `mode` with `"default":"official-only"` and
   `"x-cordis":{"volatile":true}`, and no volatile marker on any other key. This is the live
   counterpart of F2's fix.
2. **The live bundle is this workspace.** `…\profiles\desktop\node_modules\@local\dsh-session-log-upload`
   is a directory **Junction** whose target is `<bundle-root>`.
3. **The exclusion's dependency exists.** `Service.listService sessionLogDeepSeek` resolves, with
   `registerExclusion(exclude): () => Promise<void>` — so `inject = ['sessionLogDeepSeek']` is
   satisfied in this profile and the `off` predicate is live.
4. **The hook's contract matches the live host.** `Event.listEvents 'llm/stream'` is a waterfall
   `(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>`,
   and `GenerateOptions` carries `sessionId?: Branded<'SessionId'>`.
5. **A real upload was accepted by the real endpoint.**
   `C:\Users\<you>\.dsh\session-log-upload\watermarks.json` (189 bytes, mtime 21:21:13) contains one
   record: `session-167fda32-2ed2-4c3d-b5fa-5e63650f9c63` → `{afterSeq: 800, sessionFormatVersion: 4,
   updatedAt: 1794403273735}` (= 2026-11-11T13:21:13.735Z = 21:21:13 +08:00). Because
   `watermark.write` runs only when `result.ok === true` (`index.js:394-395`) and `uploadLogField`
   returns `ok: true` only for HTTP 2xx (`host/upload.js:158-161`), this is proof that DeepSeek's
   `anthropic/v1/messages` endpoint returned 2xx for a log-only POST carrying the version-1
   `dsh_session_log` field. **U4 ("will the endpoint accept it?") is retired in the affirmative.**
   It does not prove that `dsh_session_log` was *parsed* or attributed (U4'), only that the request
   was accepted.
6. **Mode persistence is real.** The live `cordis.patch.yml` (mtime 21:21:03, ten seconds before the
   watermark's last advance) carries the bundle's `insert` row plus a `dsh-config-editor`-written
   override row `- id: session-log-upload … mode: official-only`. That is the designed override
   mechanism, and it is the persisted form of a settings write.

**Not independently reproduced:** the client-side slot occupant (`Slots.listSubTree`) and
`Theme.listTokens` each timed out after 10 s twice ("Open or reconnect the Harness page"). I take the
Lead's `settings.section` occupant observation as theirs, not mine (U1).

---

## Current change set: A6 fixed, the invariant it produced, and the attribution probe

**What changed.** `index.js` now wraps its three optional registrations in try/catch + a named warning
— `registerLedgerRoute()` (the `ctx.effect`/`connection.fetch.register` call), `registerStreamHook()`
(the `ctx.inject` and the `ctx.on` fallback) and `registerCommand()` (`commands.register`). The `off`
exclusion registration is deliberately left unwrapped: its service is guaranteed by `inject`, and its
failure means there is nothing to protect. Order is unchanged — the exclusion is still the first thing
`apply` registers. Later in the same window, `attribution.resolvable` was added: the ledger payload now
**always** carries `attribution` with two booleans answering "do the two `app.asar` helpers resolve in
*this* installation?", so the page can say whether attribution will really go out without waiting for
an upload; `lastUploadAt`/`headers` still appear only after an accepted upload.

**The attribution probe, verified** (it is a new *read-only* claim, so it has to be true and harmless):
`moduleExposesHelper` only **imports** the module and checks the export is callable — asserted by
scoping the no-call check to the probe region, while the upload path is separately asserted to still
call `getOrCreateAnonymousUserId()`. `probeAttributionResolvable` narrows to booleans, so no identifier
value can reach the read-only ledger (also asserted: no UUID-shaped string anywhere in the payload);
`attributionResolvable()` memoises with `??=`, so it is probed once per row, and both consumers
(`ledgerPayload`, `ledgerText`) `await` it — a dropped `await` serialises a Promise to `{}`, which is
precisely the transient breakage observed while this landed. Off-Electron the honest answer is
`{userAgent: false, userId: false}`, asserted, and stable across reads.

**How it is verified.** Three checks replace the old finding demonstration, and they are the artefact
worth keeping:

| Check | Property |
|---|---|
| `STANDING INVARIANT (structural)` | every `ctx.effect(`/`ctx.on(`/`ctx.inject(` site is inside a `try` except the two justified by `inject` (exclusion, unload disposer). Naming-free, so a *future* optional registration is covered. Sensitivity proven with two in-memory mutations of the real source |
| `STANDING INVARIANT (behavioural)` | four seams each made to throw (`connection.fetch.register`, `commands.register`, `ctx.inject`, `ctx.on` without `inject`): `applyError` undefined, exclusion present **and its predicate returning `true`**, degradation logged by name, later registrations still run, and a normal unload still disposes it |
| `A6 NON-VACUITY` | `index.js` cloned into `verify/` with exactly the ledger try/catch excised (five relative imports rewritten to absolute URLs, asserted), imported, and driven: the throw escapes and the exclusion the clone registered is torn down — so the behavioural check *can* fail |

The Cordis source assertion is kept on purpose: `Fiber.effect` still does not catch
(`cordis/lib/index.js:463`), which is exactly why the wrappers are load-bearing. If a future build
starts catching, that assertion fails and the rationale gets revisited rather than silently rotting.

--- 

## Previous change set: the upload ledger and the attribution mirror

**What changed.** `index.js` gained (a) three attribution helpers — `harnessFileUrl`,
`buildAttributionUserAgent`, `composeAttributionHeaders`, plus `loadAttributionUserAgent` and
`loadAttributionUserId`, which import `dsh-llm` and `dsh-anonymous-user-id` by absolute `file://` URL
inside `app.asar`; (b) `acceptedUploadAttribution`, set only when `result.ok === true`; (c)
`ledgerPayload()` / `registerLedgerRoute()` / `ledgerText()`; (d) `headers: attribution` on the
log-only POST and a `/session-log-upload uploaded` listing. `host/watermark.js` gained `list()`.
`client.js` gained the ledger panel (read, four non-ready states, table, empty state, refresh) and its
locale keys.

**Asserted, by driving the real code:**

| Area | Checks |
|---|---|
| Route registration | registered exactly once, on `connection.fetch.register`, `path`/`methods:['GET']`/`requestBody:'buffered'`, disposed with the row; the shipped export route (`connectionOf(ctx).fetch.register`, `methods:["GET","HEAD"]`) is the shape being mirrored; the handler answers 200 `application/json` + `no-store` and is total over 4 argument shapes |
| No Connection | five absent/unusable shapes (`undefined`, `{}`, `{fetch:{}}`, `{fetch:{register:42}}`, `{fetch:{register:null}}`) → no registration, no throw, the `off` **registry entry** present and returning `true`, command listing still works, skip logged at debug |
| Payload content | a hostile watermark file carrying `title`/`cwd`/`prompt`/`content`/`events` yields a payload whose key set is exactly `afterSeq, directory, generatedAt, sessionFormatVersion, sessionId, sessions, total, updatedAt`; none of the secrets appear; unusable records are dropped, not invented |
| `WatermarkStore.list()` | 12 broken/partial file shapes list as `[]` (complete records still listed), newest-first ordering with missing/absent `updatedAt` last and ties by ascending id, two instances byte-identical, repeat calls identical |
| Attribution report | absent before any upload and after a **failed** upload (with the ledger still empty); present after an accepted one as `{lastUploadAt, headers:[names]}`; every name was actually sent; no transport-owned header (`accept`, `content-type`, `authorization`, `x-api-key`, `content-length`, `host`) is claimed; no header *value* appears; `watermarks.json` on disk contains none of `attribution`/`user-agent`/`x-deepseek-harness`/`lastUploadAt` and keeps exactly `{sessions, version}` |
| Attribution headers | the three names are verified against the shipped `dsh-llm-deepseek` (ids) and `dsh-llm` (`user-agent` rendering) sources; the compaction-only header is named in a comment but never set in code (comments are stripped before the check) and can never be emitted; `composeAttributionHeaders` is total over 9 hostile inputs including a throwing getter; off-Electron neither helper resolves, nothing is minted, and only `x-deepseek-harness-session-id: sess-x` is sent |
| Ledger UI | nine failure shapes → four distinct states (404 missing, 401/403 unauthorized, non-JSON/`null`/no-`sessions` malformed, 500/transport/no-fetch failed), each rendered by name; the **Host's** `total` is rendered (7, while the page's own row count is 2); two unusable records reported as `skipped 2`; no invented row for a non-object; smuggled `title`/`cwd`/`prompt`/`content`/`events` and the raw attribution report are never rendered; the empty state names this plugin and the official uploader; the read is one document-relative GET with `accept: application/json` and no body; refresh re-reads and a failed re-read publishes the failure without losing the section or keeping the stale row |

**Retargeted (moved boundary, not weakened):**

| Suite · check | Was | Now |
|---|---|---|
| `adversarial-host.mjs` · bare specifiers | `assert.deepEqual(imports, ['specifier'])` — one dynamic import | **`imports.length >= 1` and every argument is a computed variable** (no literal specifier, no `['specifier']` equality). Three imports now exist (`specifier` + two `moduleUrl`s); the property that matters is the §0 ban on importing the Harness by package name, which the old equality enforced only incidentally |
| `adversarial-client.mjs` · pending-range row | banned `afterSeq` outright | keeps banned: `upload.pending*`, `pickPending`, `throughSeq` (the *un-uploaded* range's end); **allows `afterSeq` and requires it to be rendered** — exactly two lines may mention it (the ledger read and the range cell), plus the `upload.ledger.columnRange` key |

--- 

## Previous change set: A1 moved to the client, A2 fixed

**What changed.** `host/upload.js` gained an exported `isAbsoluteHttpEndpoint` (the exact
`^https?:\/\//i` + non-empty-string rule, documented as shared with `host/config.js`
`normalizeEndpoint`) and refuses the endpoint before the POST; `index.js` records, next to the schema,
why `endpoint` stays unconstrained — the fail-open trace I found plus "do not add a pattern back";
`client.js` narrows the **reported** `endpoint`/`maxBytes` with two helpers, `endpointInUse` and
`maxBytesInUse`, before rendering the two disclosure rows and before naming the destination in the
confirmation dialog.

**Why this shape.** The schema pattern I first proposed would make a malformed `endpoint` fail config
validation → the entry fails to activate → `apply` never runs → the `mode: off` exclusion is never
registered → the shipped official-API upload **resumes**. That is a fail-open on the strongest privacy
setting, so the Lead cancelled the pattern and accepted the client-side mapping instead. The decision
is machine-checked in both directions: `schema-check.mjs` asserts `endpoint` carries **no**
`meta.pattern` (while `mode`'s and `maxBytes`'s constraints stay) and that the rationale is on record,
and it verifies the framework coupling the rationale rests on — `resolveConfig` throws on issues, the
`Entry.update` call site does not catch it, `_commitVolatile` only warns and skips, `autofix` is never
enabled by a host caller, and volatile writes commit in place via `updateVolatile(ref, source)`.

**Asserted, by driving both implementations:**

* **the agreement property** — for 34 endpoint inputs (the 21 hostile values, `https://api.deepseek.com/anthropic/v1/messages`, `http://127.0.0.1:8080/ingest`, other legitimate URLs, plain strings, non-strings, empty, whitespace, and an absent field) the destination the page renders and the destination the dialog names both equal `resolveConfig({endpoint: v}).endpoint`. Zero discrepancies. A served document always speaks for the namespace, so even an absent or non-string field shows the default rather than "not reported".
* **the same for `maxBytes`** — 20 inputs, including the ones that caught this defect class by surprise: `2**53`, `2**53 + 2`, `1e21` and `Number.MAX_VALUE` are schema-valid but **not** safe integers, so the Host refuses to use them; the page now shows the default cap for all four. (`Number.isFinite` alone would not have been enough — I flagged that to `client-fix` mid-flight and their mirror uses `Number.isSafeInteger`.)
* **no false narrowing** — every legitimate input (`https://…`, `http://…`, mixed-case scheme, a bare `http://x`, caps `1`…`8388608`, `Number.MAX_SAFE_INTEGER`) is *not* narrowed, so the page never shows the default while the plugin really uses the supplied value.
* **the fallback constants are the Host's** — the page's `PATCH_ROW.endpoint` equals `DEFAULT_ENDPOINT` and its `PATCH_ROW.maxBytes` equals `DEFAULT_MAX_BYTES`, so agreement cannot be agreement on the wrong value.
* **A2** — `uploadLogField` refuses 24 hostile endpoints **without invoking `fetch`** and returns the existing `{ok:false, retryable:false}` shape; a legitimate endpoint still reaches the transport; and the transport's predicate is asserted to be the same rule as the resolver's, input for input.

**Retargeted checks (moved boundary, not weakened):**

| Suite · check | Was | Now |
|---|---|---|
| `adversarial-host.mjs` · `host/upload.js` guard | asserted the guard was **absent** and that `fetch('file:///etc/passwd')` was called | **inverted**: the guard exists, refuses 24 hostile values without calling `fetch`, and shares one rule with `resolveConfig` |
| `schema-check.mjs` · non-http(s) endpoint | titled "FINDING (LOW)" | retitled **DESIGN** — the schema still stores it on purpose; the assertion that `resolveConfig` must refuse it is unchanged, and the page half now lives in the client suite |
| `schema-check.mjs` · schema idiom/pattern checks | `mode` was the only patterned field | unchanged in substance (it stays true), plus a new explicit check that `endpoint` has **no** pattern and a new check that the documented coupling matches the shipped framework |
| comment-text assertions | exact wording | semantic fragments (`VOLATILE SCHEMA COUPLING`, `` `endpoint`…unconstrained ``, `**resumes**`, `Do not add … back.`) so a reflow cannot break them while a lost rationale still fails |

--- 

## Previous change set: the three-volatile-field wire

**What changed.** `endpoint` and `maxBytes` joined `mode` as `.volatile()` (`index.js:115-120`), the
client's pending-range row was deleted, and `index.js` stopped capturing `resolveConfig(rawConfig)` at
startup — every use goes through `currentConfig()` (`index.js:202-204`), with `currentMode()`,
`currentEndpoint()` and per-attempt snapshots inside `performUpload` (`index.js:415`) and
`resolveCredential` (`index.js:471`). `host/config.js:184,188,194` unwraps all three volatile fields.

**Why it was needed.** `dsh-settings.describe()` ships the page only
`projectForm(volatileForm(schema), plainConfig(effectiveConfig))`, so a non-volatile field never reaches
the browser — not even its default. That is why the page said `上传目标: 未配置`. Verified from the
shipped projector: `volatileForm` keeps only volatile paths, and `dsh-settings/lib/index.js:507` refuses
a write to any path that is not volatile.

**Retargeted (6 checks, all moved boundaries, none weakened):**

| Suite · check | Was | Now |
|---|---|---|
| `adversarial-host.mjs` · "only `mode` is unwrapped …" | asserted `endpoint`/`maxBytes` objects are **not** unwrapped | **inverted**: the three volatile fields *are* unwrapped, the other three are not, and the anti-hijack guard is the scheme check — 21 non-http(s) values (plain and behind a live reference) all fall back to the default |
| `adversarial-host.mjs` · "the schema declaration …" | `.volatile()` count is 1 | count is 3, the three are `mode`/`endpoint`/`maxBytes`, and the other three carry no `.volatile()` |
| `schema-check.mjs` · "only `mode` carries the volatile marker" | exactly one volatile node | **inverted**: exactly three volatile nodes, with `mode`'s pattern and all three defaults pinned against the real builder |
| `schema-check.mjs` · "the settings FORM projects exactly one field" | form projected `['mode']` | **inverted**: the form projects exactly `mode`+`endpoint`+`maxBytes` — this assertion *was* the reported bug |
| `schema-check.mjs` · "the write guard … REFUSES every other field" | admitted 1, refused 5 | admits exactly `mode`+`endpoint`+`maxBytes`, refuses `deepseekModelPatterns`+`uploadModel`+`credentialRef`; the shipped guard at `dsh-settings/lib/index.js:507` still asserted |
| `schema-check.mjs` · "projectForm exposes only the form fields" | `['mode']` | the same three, and `uploadModel`/`credentialRef`/`deepseekModelPatterns` must not leak into the projection |

**New checks added for the new failure modes:**

* **no captured config** — `index.js` has no `(const|let|var) config =`, no stale `config.<field>` read,
  exactly one `resolveConfig()` call site (inside `currentConfig()`), and the build/POST use
  `live.maxBytes`/`live.endpoint`;
* **a live endpoint change redirects the next attempt** — no re-application: upload #1 to the default,
  mutate the live value, upload #2 goes to `http://127.0.0.1:54779/collect`, and a live `file:///`
  value sends upload #3 back to the default;
* **a live maxBytes change takes effect on the next build** — 8 events with the default cap, then a live
  `maxBytes = 400` shrinks the next body's `events.length`/`throughSeq` while `afterSeq` stays put;
  repeated through the real cosmokit volatile reference;
* **a volatile `endpoint` reference redirects the next attempt**, and a volatile write holding
  `javascript:alert(1)` is refused by the resolver;
* **`maxBytes` clamping** — a live reference round-trips; `0`, `-1`, `1.5`, `NaN`, `Infinity`, `'1024'`,
  `true` are all refused by both the schema and `resolveConfig`;
* **client-side**: the UI's write path can only ever name `mode` (asserted on `form.set`/`path: […]`
  literals, and that no `endpoint`/`maxBytes` write exists), the pending row and its locale keys are
  gone, the destination and cap are rendered read-only with no editable control, and the consent dialog
  names the destination taken from the live value.

### Accepted property (deliberate, recorded not open)

**A browser-side actor with settings-RPC access can repoint `endpoint`** (and set `maxBytes`). The Lead
traded this for a truthful destination in the consent dialog, and I agree with the trade: the previous
state made the dialog say "not configured" about a destination that *was* configured, which is a consent
failure in the dangerous direction. Bounding properties I verified:

* it is **not reachable without an explicit write** — the UI's only write field is `mode` (asserted
  statically and behaviourally), so repointing requires either a patch edit or a settings RPC call by
  something other than this page;
* the value must still be an absolute `http(s)` URL — 21 hostile schemes/relative paths are refused by
  `resolveConfig`, so the POST target cannot leave HTTP(S);
* `credentialRef`, `uploadModel` and `deepseekModelPatterns` remain unwritable through the wire, so the
  actor cannot change *what* is sent or where the key comes from.

### Findings from the three-volatile pass — A1 and A2 now CLOSED

**A1 — CLOSED (truthfulness edge).** Was: `endpoint` is an unconstrained `z.string()` (`index.js:117`),
so a non-`http(s)` value could be persisted and was what the page and the dialog reported, while
`resolveConfig` refused it and the plugin POSTed to the **default**. **Fixed without the pattern I first
proposed** — my own trace showed the pattern would introduce a *new* fail-open (row deactivation →
no `off` exclusion → the shipped upload resumes), which the Lead accepted, so the closure moved to the
client: `endpointInUse`/`maxBytesInUse` mirror the Host's rules and the disclosure rows plus the dialog
now name the value in use. Asserted by driving both implementations over 34 + 20 inputs with zero
discrepancies (see the current change set above). My proposed fix is recorded as **rejected, with the
reason**, in `index.js` itself and machine-checked by `schema-check.mjs`.

**A2 — CLOSED (wrong comment / missing guard).** Was: `index.js:114` claimed `host/upload.js` refuses
non-HTTP(S); it did not, and I proved it called `fetch('file:///etc/passwd')`. **Fixed**: the transport
now exports and applies `isAbsoluteHttpEndpoint`, refuses 24 hostile values **without invoking `fetch`**,
and returns the existing failure shape. The comment is now true, and the transport predicate is asserted
to be the same rule as `resolveConfig`'s narrowing, input for input.

**A3 — INFO (unchanged).** The live `Config.listConfigs` projection reports
`limitations: ["config/mode: regular-expression syntax or Unicode semantics require native validation"]`.
That is the projection's own caveat — the JSON Schema carries `pattern.source`, but the regexp semantics
are enforced by schemastery natively, which `verify/schema-check.mjs` exercises (`offf` rejected, the
four ids accepted). The projected schema alone is therefore not the whole constraint.

**A4 — INFO (unchanged).** The pending-range row is gone from the client and its four locale keys from
both dictionaries. I confirm the removal is correct — the watermark is not configuration, and the
read-only settings channel could never report it. It also closes the old F13 dead-string item.

**A5 — INFO (new, judgement recorded).** `mode`'s pattern and `maxBytes`'s `.min(1)` carry the same
volatile-schema coupling that made the `endpoint` pattern unacceptable: a malformed value in either
deactivates the row and therefore drops the `off` exclusion. They are kept deliberately (`mode` is the
consent switch and stops the RPC storing junk; `maxBytes` is a typed numeric field), and the coupling is
now documented in `index.js` and asserted against the shipped framework by `schema-check.mjs`. I agree
with keeping them, with the operational warning the Lead added to the README: a malformed row config
disables the row and `off` stops being enforced.

### Live cross-check (independent of the Lead's observation)

`Config.listConfigs {entry:"include:session-log-upload"}` → `status: "schema"`, and the projected schema
carries `x-cordis.volatile: true` on **exactly** `mode`, `endpoint` and `maxBytes` — with `mode`'s
`pattern.source` = `^(?:off|official-only|deepseek-any-provider|any-model)$`, `endpoint`'s default
`https://api.deepseek.com/anthropic/v1/messages`, and `maxBytes`' default `8388608`. No volatile marker
on `deepseekModelPatterns`, `uploadModel` or `credentialRef`. This matches my static and real-builder
findings field for field.

---

## Previous change set: the H1–H3 hardening pass (all three fixed)

The implementers landed H1–H3 on `index.js` after the revision-2 report. I re-derived each one myself
rather than accepting the description, and retargeted the assertions that pinned the old shape.

### N1 — FIXED — zero bare specifiers again (H1)

`index.js:90-110` now computes a single `specifier` with `pathToFileURL(join(process.resourcesPath,
'app.asar', …))` and imports it; the `candidates` array, the loop and the `'@deepseek-ai/schemastery'`
literal are gone. Verified: **zero** `"@scope/name"` literals in `index.js`, no `candidates.push`, and
exactly one dynamic `import(specifier)` whose argument is the computed URL. The absolute candidate still
points at the real module inside `app.asar` (22,988 bytes, `Schema.prototype.volatile` present), and in
plain Node `Config` is `undefined` with every suite still passing — so the documented CLI degradation
(no schema → raw config + command) is intact. `INTERFACES.md` §0 is satisfied literally again.

### N2 — FIXED — the schema constrains `mode` to the four frozen ids (H2)

`index.js:39` builds `MODE_PATTERN` from `MODES` (escaping regex metacharacters), and `index.js:56-64`
`modeField(z)` applies `z.string().pattern(MODE_PATTERN).default('official-only').volatile()`, falling
back to an unconstrained `z.string()` if `.pattern()` throws. Verified **against the real schemastery
3.19.0 extracted from `app.asar`**:

* `MODE_PATTERN.source === '^(?:off|official-only|deepseek-any-provider|any-model)$'`; all four ids match
  and `offf`, `off `, ` off`, `OFF`, `any-modelx`, `xany-model`, `''` do not;
* with a hostile `MODES` (`a.b`, `x(y)`, `p+q`) the pattern is `^(?:a\.b|x\(y\)|p\+q|literal)$` and does
  **not** match `axb` — the escaping works;
* `validate({mode:'offf'})` now returns an **issue** (`expect string to match regexp …`) instead of
  accepting it; non-strings are still rejected; `{}` and `{mode:null}` still resolve to a volatile
  reference holding `official-only`;
* the projected node is `type:'string'` with `meta.default === 'official-only'` and the pattern above,
  and it is still the only volatile node;
* the degraded path is real: with a fake builder whose `.pattern()` throws, `modeField` still returns a
  field that received `.default('official-only')` and `.volatile()`.

`resolveConfig` keeps its own never-wider fallback (`resolveConfig({mode:'offf'}).mode ===
'official-only'`) for a corrupt in-memory value, so the belt-and-braces order is: schema rejects the
write, resolver narrows anything that still reaches it.

### N3 — FIXED — the gate can no longer be disarmed (H3)

`index.js:146` is `export const WIDE_MODES = Object.freeze([…])` and `index.js:153` adds
`isWideMode(mode)`; the gate at `index.js:522` reads `isWideMode(next)` and never touches the array
directly. `verify/adversarial-host.mjs` is now the authority on the regression I originally
demonstrated: it asserts `Object.isFrozen`, that `push`/`pop`/`splice`/index-assignment/`length`-assignment
/`defineProperty` all **throw**, that the list is unchanged afterwards, and that after all of those
attempts an unconfirmed `any-model` still writes **nothing** while the confirmed form still writes
exactly once (so the gate is neither defeatable nor broken shut).

### Residual finding from this pass

* **INFO — the constraint is best-effort.** `modeField`'s `catch` deliberately keeps the schema alive
  without the pattern when a builder lacks `.pattern()`. In that degraded mode an unknown mode string
  would again reach `resolveConfig` and narrow to `official-only` (the revision-2 N2 behaviour). With the
  builder this build actually ships (schemastery 3.19.0, where `.pattern()` exists and was exercised
  above) the constraint is active. Fail-safe for widening either way; the `off` fail-open returns only
  in that hypothetical degraded mode.
* **N4 — LOW (unchanged) — `readLive` accepts any object with a `get` function.**
  `host/config.js:105-113` unwraps a value if it carries the volatile symbol **or** merely has a `get`
  function, which is more permissive than the framework's own `isVolatile` (`write in value`,
  `cosmokit/lib/index.js:116-118`). Two things keep it safe: it is applied to `mode` only
  (`host/config.js:180`), and the only writer of the resolved config is the Loader. I verified the
  consequence that matters: an `endpoint` object with a `get` returning `https://evil.example/collect` is
  **not** unwrapped and the default endpoint is used.
* **INFO**
  * **Two patch rows for one id**: the live `cordis.patch.yml` carries the `insert` row *and* the
    editor-written override row for `session-log-upload`. That is `dsh-config-editor`'s designed
    override-by-id mechanism, but it is surprising to a human reading the file; worth a line in the README.
  * **F10 unchanged**: `index.js:355-356` reads only the plugin's own watermark, so the first upload of a
    Session that already ran on `deepseek-official` restarts at `afterSeq = -1` and re-sends a range
    DeepSeek already has. Cost/duplication, never a skipped range.
  * **F11 unchanged**: `host/watermark.js:170-182` has no retry on a failed flush; a lost advance causes a
    re-send.
  * **F13 unchanged**: `upload.pendingValue` is still dead — no site substitutes its placeholders.
  * **No stray diagnostics**: `index.js` and `host/*.js` contain no `configProbe` / `config-probe`
    leftover, and the workspace root holds no probe JSON.
  * The client's manual fallback prints `/session-log-upload <mode>` **without** the confirm token, so a
    paste cannot widen in one step (verified). A user must read the command's reply to take the second step.
  * A rogue *client plugin* in the same page could still call
    `remote.settings.mutate('session-log-upload', …)` directly. It cannot repoint `endpoint` — the Host
    refuses any non-volatile path (`dsh-settings/lib/index.js:507`) — and it could equally call the LLM
    APIs, so this is scoped as out of the plugin's threat model.

---

## What I verified positively (executed, not read)

* **Payload fidelity, differentially.** `verify/fidelity.mjs` still runs the shipped `wireHeader`,
  `wireEvent`, `wireSurfaceOp`, `jsonBytes` and the shipped envelope/byte-accounting block **verbatim
  from `app.asar`** and compares `JSON.stringify` output (key order included) against
  `host/logfield.js`: all header optional combinations, 11 fixed event shapes, every `afterSeq` in a
  12-event session, **every** `maxBytes` from 1 to size+3, and 2000 fuzz rounds. Zero divergence;
  `KNOWN_SESSION_EVENT_TYPES` is 62/62 identical in order. The endpoint then accepted a real payload
  (live evidence 5).
* **The schema, against the real builder.** Extracted schemastery 3.19.0: `validate({})` produces
  `{mode: <frozen {get, [write]}>}` whose `get()` is `'official-only'` — the default is applied
  *before* the wrap, which is why `readLive` is correct; explicit modes round-trip through
  `resolveConfig`; writes through the reference are visible to `resolveConfig`; non-string modes are
  rejected.
* **No exfiltration through the settings wire.** With the real schema: `volatileForm` projects exactly
  one field (`mode`); `isVolatilePath` is `true` only for `['mode']`; and the Host's own write guard
  (`dsh-settings/lib/index.js:507`) throws for every other path. `projectForm` likewise exposes only
  `mode`.
* **The consent gate in the client, under my own hook runtime**: wide clicks open the dialog with no
  write; Escape (capture-phase), backdrop and Cancel all cancel; only the primary button writes;
  `off`/`official-only` are dialog-free; arrow/Enter/Space never write; static proof that
  `bridge.writeMode` has exactly two sites and `commit(` exactly two, one gated and one from
  `confirmPending`.
* **Defaults and the matrix.** `official-only` for `undefined`, `null`, non-objects, 20 hostile
  spellings, a throwing getter, null-prototype objects and prototype-polluted objects; the full
  mode × provider × model × `hasSession` cross-product; official routes never produce our upload;
  model matching is case-insensitive; no live Session never uploads.
* **The `off` closure and live flipping**, by execution: the exclusion is registered in every mode and
  flips with the live mode; the listener exists in every mode, passes streams through chunk-identical
  when it decides `none`, and starts/stops uploading when the live mode changes — including through a
  real cosmokit-style volatile reference, with no re-application.
* **The upload path**: body and headers as frozen; a 2xx advances the watermark and the next field
  resumes from it; a 429 does not advance and resends the same range; a transport failure stores
  nothing; a changed session-format version restarts at `-1`; an errored, aborted or abandoned stream
  uploads nothing.
* **Dependency-freedom** (now with no caveat — H1 removed the last bare specifier): every static
  specifier in all seven shipped modules is
  `node:*` or relative, except `require("react")`/`require("react-dom")` in `client.js`; no
  `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies` or `scripts`.
* **Manifest/resources**: factory id == package name; `exports`/`files` cover every shipped file
  (`probe/` is gone and never shipped); `icon.svg` well-formed at 403 bytes; locale files have
  identical 36-key sets, both carry `meta.title`/`meta.description`, English is sentence case, and
  every `upload.*` key the client renders exists in both; all 13 `--dsw-*` tokens used by the
  stylesheet are declared in the shipped theme.

---

## UNVERIFIED

| # | Item | What I tried | Impact |
|---|---|---|---|
| U1 | The GUI interaction itself (dialog → save → survives refresh) and the live slot occupant | `Slots.listSubTree` and `Theme.listTokens` each timed out twice ("Open or reconnect the Harness page"); I did not drive the GUI | The Lead's user-confirmed acceptance stands as theirs; my evidence for the same properties is static + live-config + live-file |
| U2 | That a *volatile write* reaches the **already-running** instance without a row restart | Verified `readLive` matches cosmokit's real reference shape, that Cordis documents "volatile updates retain its references" (`cordis/lib/index.js:650`), and that the plugin re-reads per decision; I could not attribute the Lead's 45 s observation between an in-place volatile update and a row restart | None for correctness — both paths are handled by design; only the "immediately, without restart" claim is unproven by me |
| U3 | `configEditor.edit(ctx.fiber.entry, …)` accepting that entry object (the command path) | Read the identity check (`dsh-config-editor/lib/index.js:73`); no command was invoked in the live profile | The command path is otherwise fully simulated and its gate is proven independent of this |
| U4 | Whether DeepSeek's receiver *parses* and **attributes** the accepted log without `user-agent`/`x-deepseek-harness-*` (F4) | Acceptance is proven by the live watermark; parsing/attribution is server-side and out of reach | Attribution/policy question, not a functional blocker |
| U5 | The full framework prop set for `settings.section` | Client inspect unavailable (U1) | My client harness supplies `t` only; an additional required prop cannot be ruled out |
| U6 | Whether the client loader gates `apply` on the exported `inject` services | Read `dsh-client-modules/lib/client.js:778-796` (load ordering); not established | `client.js:1053-1055` calls `ctx.locale.register` unguarded inside an effect; if `locale` were absent, `apply` would throw |
| U7 | Long-run / multi-session upload behaviour | Only one session record exists in the live watermark | Bounds what the live evidence can say about watermark pruning and volume |
| U8 | Whether the `app.asar` candidate survives an Electron packaging change (e.g. a different `resourcesPath` layout) | The candidate path is asserted to exist in *this* container and degrades to no schema otherwise | Would silently disable the settings wire on a differently-laid-out build; the manual/command paths still work |
| U9 | The wire **value** the page actually receives (the descriptor payload), as opposed to the schema | `Config.listConfigs` returns the projected schema, not the runtime descriptor value; I verified the schema, the projector logic (`volatileForm`/`projectForm`) and the live `x-cordis.volatile` markers, but not the response body | The Lead observed the value as `{mode, endpoint, maxBytes}`; my evidence is one layer up. If the value were empty, the page would still show `未配置` |
| U10 | Whether a settings write to `endpoint`/`maxBytes` is persisted and reloaded exactly like `mode` | The `isVolatilePath` guard and the field-agnostic `write` path are verified from shipped source, and the schema admits all three; I performed no live RPC write to `endpoint`/`maxBytes` | Would matter only if `dsh-settings` treated a non-`mode` field specially; nothing in the shipped writer does |
| U11 | The page's rendered state after this revision (destination and cap shown, pending row absent) | I did not open the GUI. The client checks are behavioural against my own hook runtime; the wire-value question is U9 | The visible result is the Lead's and the user's observation, not mine — stated as required |
| U12 | The agreement property against the **real** page, rather than my hook runtime | The property is asserted by driving the real `client.js` component (and the real `resolveConfig`) through my own minimal React runtime; a DOM/React behaviour my runtime does not model (e.g. a prop the shell supplies) could in principle change what is rendered | My runtime is the same one used for every consent-gate check, and the property is asserted on rendered output, not on source text |
| U13 | That the framework coupling behaves as documented *at runtime* (row deactivation on a malformed patch value) | Asserted from shipped source (`resolveConfig` throws; `Entry.update`'s call site does not catch; `_commitVolatile` warns and skips; no host caller enables `autofix`) — I did not induce a deactivation in the live profile | The comment's rationale and the machine check agree; a live deactivation test would need a malformed patch write to the user's profile, which is out of scope |
| U14 | Whether the two `app.asar`-sourced headers (`user-agent`, `x-deepseek-harness-user-id`) actually appear on a **live** request | Only Electron can settle this: in Node `process.resourcesPath` is unset, so I verified the totality, the naming, the mirror against the shipped sources and the absence of minting — not a live wire capture | The ledger's `attribution.headers` (read after a real upload and a reload) is the evidence; the Lead owns that read |
| U15 | ~~How the Loader resolves the duplicate `session-log-upload` id~~ | **CLOSED** — the Lead removed the duplicate at 11:59, after my 11:46 read; the file now has exactly one row for the id with `mode: official-only`, and an id-count check confirms it. I still did not observe the Loader's collision behaviour, because there is no longer a collision to observe | Kept as a closed item rather than deleted, because it documents *why* the duplicate existed (a stale override-by-id write) — see the operational hazard in the verdict |

---

## Limitations

1. My harnesses are fakes: the Cordis context, React, fetch, Session objects, commands and
   configEditor are simulated. The shipped modules I extracted (uploader, schemastery, cosmokit,
   `dsh-settings` projection) are real bytes, and the file/module extraction asserts its own anchors.
2. `verify/schema-check.mjs` rewrites exactly one import line of the shipped schemastery so it can
   resolve cosmokit; the script asserts that line 0 is the only difference.
3. The tree can move: re-run `node verify/run-all.mjs` and compare the hashes above before shipping.
4. **No visual claim.** I never opened the settings page in this pass; everything client-side is
   behavioural against my own hook runtime, or a static assertion on `client.js`. The rendered result
   after this revision (destination and cap visible, pending row gone) is the Lead's and the user's
   observation (U11).

## Verification artefacts (all under `verify/`, none shipped)

| File | Purpose |
|---|---|
| `REPORT.md` | this report |
| `run-all.mjs` | runs all seven suites, one child process each |
| `fidelity.mjs` | differential execution against the shipped uploader (+ fuzz) |
| `adversarial-host.mjs` | defaults, the three volatile fields, no-captured-config (live endpoint/cap), matrix, `off` closure, live flipping, upload path, watermark, two-step gate (+ 400-input brute force), schema shape, the transport's scheme guard (24 hostile values, no `fetch`), the ledger route and its payload, `WatermarkStore.list()` totality, the attribution report, the attribution probe (booleans only, memoised, no identity minted) and the mirroring headers, the **standing invariant** with its non-vacuity proof, dependency/manifest/locale/icon |
| `adversarial-client.mjs` | own hook runtime; consent gate, `whileServed`, not-served state, manual fallback, read-only destination/cap, mode-only write path, the A1 agreement property (34 + 20 inputs, page vs `resolveConfig`), and the ledger UI (9 failure shapes → 4 states, Host total, no invented rows, refresh) |
| `schema-check.mjs` | the real schemastery builder against the plugin's own `Config`, `dsh-settings`' projection and write guard, the "no `endpoint` pattern" decision with its reason, and the shipped-framework coupling that reason rests on |
| `asar-extract.mjs` | reads files out of `app.asar` |
| `asar-grep.mjs` | regex search over the container |
| `check-tokens.mjs` | every `--dsw-*` token used exists in the shipped theme |
