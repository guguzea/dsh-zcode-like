# API Dossier — Session-Log Upload Mode Plugin

**Contract document for the two implementers (Host half + Client half).**
Every fact below was read from the live installed Harness (`cordis_inspect_query`) or from
installed package sources under
`D:\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\`.
Nothing is inferred from memory. Anything not established is marked **UNVERIFIED** with what was tried.

## Verification legend

| Tag | Meaning |
|---|---|
| **[SOURCE]** | Quoted verbatim from an installed `lib/*.js`, `README.md`, or `package.json`. Path + line cited. |
| **[LIVE]** | Read from a live `cordis_inspect_query` response in this session. |
| **[INFERRED]** | Derived from two or more shipped examples that agree; the framework rule itself was not read. |
| **UNVERIFIED** | Could not establish; what was tried is stated. |

## Environment

- Harness runtime package: `@deepseek-ai/dsh-desktop-runtime@0.2.2-rc.1`
  (`...\app.asar\dsh\package.json:3`).
- Client packages, incl. all slot declarations, are `0.2.2-rc.1`.
- Profile: `desktop` at `C:\Users\<you>\.dsh\profiles\desktop`.
- `lib/types/**/*.d.ts` is **stripped** from this shipped build: every attempt to read
  `.../lib/types/index.d.ts` and `.../lib/types/client/index.d.ts` returned "not found".
  All type facts below therefore come from JSDoc in the built JS or from live inspect.

---

## 1. Official DeepSeek route names and credential references

### 1.1 Route names — two routes, no fallback between them

| Route string | Owning plugin | Auth header |
|---|---|---|
| `deepseek-official` | `@deepseek-ai/dsh-llm-deepseek-api-key` (entry id `llm-deepseek`) | `x-api-key` |
| `deepseek-account` | `@deepseek-ai/dsh-llm-deepseek-account` (entry id `llm-deepseek-account`) | `x-dsh-auth-token` |

**[SOURCE]** `dsh-llm-deepseek-api-key/lib/index.js:47` —
`const PROVIDER = "deepseek-official";`

**[SOURCE]** `dsh-llm-deepseek-api-key/lib/index.js:140,143,191,193` — the plugin registers into
`ctx.deepseekLlmApiExtensions.register("dsh_session_log", …)`, i.e. the `dsh_session_log` field is
attached **only** on the route the official API-key adapter serves.

**[SOURCE]** `dsh-llm-deepseek/README.md:89` — “`deepseek-official` resolves only its configured
API-key reference. `deepseek-account` resolves only the stored grant … Neither route falls back to
the other.”

**[SOURCE]** `dsh-llm-deepseek/README.md:91` — “Messages and Files requests send account tokens as
`x-dsh-auth-token` without a Bearer prefix; API keys use `x-api-key`.”

### 1.2 Credential reference string

**[SOURCE]** `dsh-llm-deepseek-api-key/lib/index.js:9-13`:

```js
const Config = z.object({
	...deepSeekConfigFields,
	...modelListingConfigFields,
	apiKeyEnv: z.string().role("credential-ref").default("DEEPSEEK_API_KEY").volatile()
});
```

**[SOURCE]** `dsh-llm-deepseek-api-key/lib/index.js:36` — the raw config string is branded at
resolution time:

```js
apiKeyEnv: credentialRef(apiKeyEnv ?? "DEEPSEEK_API_KEY"),
```

**[SOURCE]** `dsh-credentials/lib/index.js:13` — the accepted grammar:

```js
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
```

**The exact ref string a plugin passes is `"DEEPSEEK_API_KEY"`** (a POSIX shell identifier; the
default of the `apiKeyEnv` field, which the user may override in the `llm-deepseek` entry config).

### 1.3 Which `ctx.credentials` method reads it

**[SOURCE]** `dsh-llm-deepseek-api-key/lib/index.js:53-64` — the authoritative resolution path:

```js
const resolveApiKey = async (connection) => {
	const ref = connection.apiKeyEnv;
	const credentials = ctx.get("credentials");
	if (credentials !== void 0) {
		const hit = await credentials.resolve(ref);
		if (hit !== void 0) return assertUsableApiKey(hit.value, "llm-deepseek", ref);
	} else {
		const ambient = launchEnvironmentOf(ctx).get(ref);
		if (ambient !== void 0 && ambient.value.length > 0) return assertUsableApiKey(ambient.value, "llm-deepseek", ref);
	}
	throw new LlmError(`llm-deepseek: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials service (the web Models page writes it), or export ${ref} in the launching environment`, "MISSING_CREDENTIAL");
};
```

- Method: **`ctx.credentials.resolve(ref)`** → `ResolvedCredential | undefined`; the key text is
  `.value`. **[LIVE]** `credentials` Service exposes `resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>`.
- Fallback for compositions without the credentials service: `launchEnvironmentOf(ctx).get(ref)`,
  requiring `.value.length > 0`.
- `describe(ref)` returns metadata only (never the secret); it is **not** used by the adapter.

**Runnable snippet for the plugin (Host half):**

```js
import { credentialRef } from "@deepseek-ai/dsh-credentials";   // resolution UNVERIFIED, see §6
const ref = credentialRef("DEEPSEEK_API_KEY");
const credentials = ctx.get("credentials");
const hit = credentials === undefined ? undefined : await credentials.resolve(ref);
const apiKey = hit?.value;                     // undefined => cannot upload
```

### 1.4 Endpoint the upload must reach

**[SOURCE]** `dsh-llm-deepseek/README.md:57` — `baseURL` default `https://api.deepseek.com/anthropic`.

**[SOURCE]** `dsh-llm-deepseek/README.md:83` — “The official root is
`https://api.deepseek.com/anthropic`. … Model and Files requests append `/v1/messages` and
`/v1/files`, except that an exact final `/v1` segment is reused. Trailing slashes do not change
these results. A base URL must use HTTP(S) without credentials, query, or fragment.”

So the upload target is **`https://api.deepseek.com/anthropic/v1/messages`**, `x-api-key: <key>`.

**UNVERIFIED** — the minimal *valid* `messages` body a log-only request may send, and whether the
official endpoint accepts a request whose `dsh_session_log` is the only meaningful content.
Tried: read `dsh-llm-deepseek/README.md` (documented behaviour only; no minimal-body statement) and
`dsh-deepseek-llm-api-extensions/README.md`. This must be probed at implementation time.

---

## 2. Exact version-1 `dsh_session_log` payload

Source of truth: `@deepseek-ai/dsh-session-log-deepseek/lib/index.js` (229 lines, read in full).

### 2.1 Session format version constant and its origin

**[SOURCE]** `dsh-session/lib/index.js:56`:

```js
const SESSION_FORMAT_VERSION = 4;
```

**[LIVE]** the exported declaration:

```ts
export interface SessionHeader {
    readonly version: typeof SESSION_FORMAT_VERSION;
    readonly id: SessionId;
    readonly createdAt: number;
    readonly cwd?: string;
    readonly parentSession?: SessionId;
    readonly isSeeded: boolean;
    readonly origin?: 'subagent';
    readonly delegationDepth?: number;
    readonly agentPreset?: string;
}
```

The payload's `sessionFormatVersion` is **not** a literal in the session-log package — it is read
from the live session header. **[SOURCE]** `dsh-session-log-deepseek/lib/index.js:154` —
`sessionFormatVersion: session.header.version,`.

### 2.2 Top-level envelope (version 1)

**[SOURCE]** `dsh-session-log-deepseek/lib/index.js:150-198`:

```js
const afterSeq = acceptedThrough(session);
const pending = session.snapshotEvents(SessionLogOffset(afterSeq + 1));
const envelope = {
	version: 1,
	sessionFormatVersion: session.header.version,
	session: wireHeader(session),
	afterSeq: Number(afterSeq)
};
…
const throughSeq = last.seq;
return {
	value: {
		...envelope,
		throughSeq: Number(throughSeq),
		events
	},
	accept: () => {
		session.append("session-log-deepseek/delivery-accepted", {
			sessionId: session.id,
			sessionFormatVersion: session.header.version,
			throughSeq
		});
	}
};
```

| Top-level key | Type | Source |
|---|---|---|
| `version` | literal `1` | `lib/index.js:153` |
| `sessionFormatVersion` | `number` = `session.header.version` (= 4 today) | `lib/index.js:154` |
| `session` | raw session header, see 2.3 | `lib/index.js:155` |
| `afterSeq` | `number`, `Number(afterSeq)` | `lib/index.js:156` |
| `throughSeq` | `number`, `Number(last.seq)` | `lib/index.js:187` |
| `events` | array of wire envelopes, see 2.4 | `lib/index.js:188` |

**`afterSeq` semantics:** the greatest accepted `throughSeq` for *this exact* Session format
generation, or `-1` before any accepted request (`lib/index.js:105-131`, `let throughSeq = previous?.throughSeq ?? -1;`).
**`throughSeq` semantics:** the `seq` of the last event included in this field; the next request
resumes at `afterSeq = throughSeq` (`lib/index.js:151`).

When **no** event fits `maxBytes`, the whole `dsh_session_log` field is omitted
(`return;` at `lib/index.js:181`) and one warning per blocking event is logged
(`lib/index.js:176-180`). The `maxBytes` default is `8 * 1024 * 1024` (`lib/index.js:20`).
Byte accounting is `jsonBytes(...) - 1` for the empty envelope plus, per event,
`(events.length === 0 ? 0 : 1) + jsonBytes(wire)` plus `String(event.seq).length`
(`lib/index.js:158-172`), measuring UTF-8 bytes (`Buffer.byteLength(JSON.stringify(v))`,
`lib/index.js:91-99`).

### 2.3 Header translation — `wireHeader`

**[SOURCE]** `dsh-session-log-deepseek/lib/index.js:26-39`:

```js
function wireHeader(session) {
	const header = session.header;
	return {
		version: header.version,
		id: String(header.id),
		createdAt: header.createdAt,
		...header.cwd === void 0 ? {} : { cwd: header.cwd },
		...header.parentSession === void 0 ? {} : { parentSession: String(header.parentSession) },
		...header.isSeeded ? { seedLength: Number(session.inheritedEventCount) } : {},
		...header.origin === void 0 ? {} : { origin: header.origin },
		...header.delegationDepth === void 0 ? {} : { delegationDepth: header.delegationDepth },
		...header.agentPreset === void 0 ? {} : { agentPreset: header.agentPreset }
	};
}
```

Notes that matter:
- The header's own `version` equals `sessionFormatVersion`, so it appears twice.
- `id` and `parentSession` are **branded strings flattened with `String(…)`**.
- `seedLength` is present **only** when `header.isSeeded`; its value is
  `Number(session.inheritedEventCount)`.
- `isSeeded` itself is **not** emitted; `seedLength` is its only wire trace.
- Every optional field is omitted (not `null`) when absent.

### 2.4 Per-event envelope translation — `wireEvent`

**[SOURCE]** `dsh-session-log-deepseek/lib/index.js:41-86`:

```js
function wireEvent(event) {
	const common = {
		seq: Number(event.seq),
		time: event.time,
		data: event.data,
		...event.ignorable === void 0 ? {} : { ignorable: event.ignorable }
	};
	switch (event.type) {
		case "developer/message":
		case "system/message":
		case "user/message":
		case "tool/result": return {
			...common,
			type: event.type,
			surfaceOp: wireSurfaceOp(event.surfaceOp),
			...event.sourceEventSeqs === void 0 ? {} : { sourceEventSeqs: event.sourceEventSeqs.map(Number) }
		};
		case "assistant/message": return {
			...common,
			type: event.type,
			surfaceOp: wireSurfaceOp(event.surfaceOp)
		};
		default:
			if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable === true) {
				const opaque = event;
				return {
					...common,
					type: event.type,
					ignorable: true,
					...opaque.surfaceOp === void 0 ? {} : { surfaceOp: opaque.surfaceOp },
					...opaque.sourceEventSeqs === void 0 ? {} : { sourceEventSeqs: opaque.sourceEventSeqs }
				};
			}
			return {
				...common,
				type: event.type
			};
	}
}
function wireSurfaceOp(op) {
	return op === "append" ? op : {
		op: "replace",
		startSeq: Number(op.startSeq),
		endSeq: Number(op.endSeq)
	};
}
```

Envelope field rules, exactly:

| Field | Rule |
|---|---|
| `seq` | **raw number** (`Number(event.seq)`), not the branded `SessionSeq` |
| `time` | copied verbatim (`number`) |
| `data` | the canonical event `data` object **verbatim** — no translation |
| `type` | the canonical event type string verbatim |
| `ignorable` | present **only** when `event.ignorable !== undefined` (i.e. `true`) |
| `surfaceOp` | on the 5 surface types only; `"append"` stays the string `"append"`, otherwise `{ op: "replace", startSeq: number, endSeq: number }` |
| `sourceEventSeqs` | present only on `system/message`, `developer/message`, `user/message`, `tool/result` when set, and each entry `Number(…)`-flattened; never on `assistant/message`; on the unknown-ignorable branch copied unflattened |

**[SOURCE]** `dsh-session-log-deepseek/lib/index.js:5` — `KNOWN_SESSION_EVENT_TYPES` is imported from
`@deepseek-ai/dsh-session`. Its live value (read at `dsh-session/lib/index.js:79-142`) is a
60-entry `Set`; `"session-log-deepseek/delivery-accepted"` is a member at line 113.

The READMEs corroborate the same shape:

**[SOURCE]** `dsh-session-log-deepseek/README.md:41` — “The version-1 field contains
`sessionFormatVersion`, a raw session header (`seedLength` is present only for a seeded Session),
numeric `afterSeq` and `throughSeq`, and every complete canonical event translated to raw-number
envelope fields. … Surface events require `surfaceOp`, with numeric `startSeq` and `endSeq` for
replacements; only system, user, and tool events may carry `sourceEventSeqs`. Assistant provider
metadata stays in the embedded stream, and log-only events carry neither metadata field.”

### 2.5 The acceptance watermark fold (which the plugin must reproduce)

**[SOURCE]** `dsh-session-log-deepseek/lib/index.js:105-132`:

```js
function acceptedThrough(session) {
	const previous = acceptanceFolds.get(session);
	let throughSeq = previous?.throughSeq ?? -1;
	const length = session.seq;
	const start = previous?.scannedEvents ?? SessionLogOffset(0);
	for (let index = start; index < length; index++) {
		const event = session.eventAt(SessionSeq(index));
		if (event === void 0) throw new Error(`session-log-deepseek: missing event ${String(index)} below captured length ${String(length)}`);
		if (event.type !== "session-log-deepseek/delivery-accepted") continue;
		const acceptedFormatVersion = event.data.sessionFormatVersion ?? 0;
		…
		if (acceptedFormatVersion !== session.header.version) continue;
		let acceptedSeq;
		try {
			acceptedSeq = SessionSeq(event.data.throughSeq);
		} catch {
			throw new Error(`session-log-deepseek: malformed acceptance watermark at seq ${event.seq}`);
		}
		if (typeof event.data.sessionId !== "string" || event.data.sessionId.length === 0 || acceptedSeq >= event.seq) throw new Error(`session-log-deepseek: malformed acceptance watermark at seq ${event.seq}`);
		if (event.data.sessionId !== session.id) continue;
		if (acceptedSeq > throughSeq) throughSeq = acceptedSeq;
	}
	acceptanceFolds.set(session, { scannedEvents: length, throughSeq });
	return throughSeq;
}
```

Both `sessionId` **and** `sessionFormatVersion` must match, which is why forked sessions ignore
inherited parent watermarks. Acceptance appends *after* HTTP 2xx
(“The DeepSeek adapter calls the prepared contribution's `accept()` after HTTP 2xx”,
`README.md:66`), and the watermark is persisted by the ordinary session checkpoint policy — the
plugin performs no independent I/O (`README.md:68`).

### 2.6 The Session API a plugin needs to rebuild this payload

**[LIVE]** `sessions` Service (`ctx.sessions`) — `get(id: SessionId): Session | undefined`,
`list()`, `fork(...)`, `flush(session)`, `create/prepare/enter/announce`.

**[LIVE]** the `Session` class surface referenced by `sessions`:

```ts
export class Session {
    get surface(): SessionSurface;
    readonly header: SessionHeader;
    readonly inheritedEventCount: SessionLogOffset;
    get id(): SessionId;
    readonly firstLiveSeq: SessionLogOffset;
    readonly firstLifecycleSeq: SessionLogOffset;
    eventAt(seq: SessionSeq): SessionEvent | undefined;
    snapshotEvents(fromSeq?: SessionLogOffset, toSeqExclusive?: SessionLogOffset): readonly SessionEvent[];
    ownEvents(): readonly SessionEvent[];
    isOwnSeq(seq: SessionSeq): boolean;
    get seq(): SessionLogOffset;
    append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...opts): SessionEvent<T>;
    …
}
```

```ts
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
    type: K; seq: SessionSeq; time: number; data: SessionEventMap[K]; ignorable?: true;
} & (K extends SurfaceEventType ? SurfaceIntent<K> : { surfaceOp?: never; sourceEventSeqs?: never; });
```

`SessionId`, `SessionSeq`, `SessionLogOffset` are branded (`Branded<'…'>`); `SessionSeq(v)` and
`SessionLogOffset(v)` are the runtime branding functions
(`dsh-session/lib/index.js:21-33`), and `brandString` comes from `@deepseek-ai/dsh-brand`.

**The full import set the shipped package uses — `dsh-session-log-deepseek/lib/index.js:1-5`:**

```js
import { Buffer } from "node:buffer";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { brandString } from "@deepseek-ai/dsh-brand";
import { KNOWN_SESSION_EVENT_TYPES, SessionLogOffset, SessionSeq } from "@deepseek-ai/dsh-session";
```

Note the package **does not import `Session`** — it only calls methods on the live object.

**Runnable reconstruction (Host half), equivalent to the shipped payload:**

```js
const session = ctx.sessions.get(sessionId);           // sessionId already a SessionId string
if (!session) return;                                   // "No live Session means no field"
const afterSeq = myWatermark(session);                  // your own fold, see §3
const pending = session.snapshotEvents(SessionLogOffset(afterSeq + 1));
const header = session.header;
const field = {
  version: 1,
  sessionFormatVersion: header.version,                 // === SESSION_FORMAT_VERSION (4)
  session: {
    version: header.version,
    id: String(header.id),
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSession === undefined ? {} : { parentSession: String(header.parentSession) }),
    ...(header.isSeeded ? { seedLength: Number(session.inheritedEventCount) } : {}),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }),
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
  },
  afterSeq: Number(afterSeq),
  throughSeq: Number(pending.at(-1)?.seq ?? afterSeq),
  events: pending.map(wireEvent),                       // copy wireEvent/wireSurfaceOp verbatim
};
```

> **Recommendation for the implementers:** copy `wireEvent` and `wireSurfaceOp` **verbatim** from
> `dsh-session-log-deepseek/lib/index.js:41-86`. They are pure functions over `SessionEvent` with no
> package-private dependencies; re-deriving them invites drift.

---

## 3. Durable per-session watermark storage

### 3.1 What exists (live)

**[LIVE]** Host Service directory, relevant keys:

| Service key | Bound as | Relevant members |
|---|---|---|
| `storage` | `ctx.storage` | `backend: BackendRegistry`, `mount<K extends keyof StorageForms>(form, facility)`, `form<K>(form)` |
| `storageDomain` | `ctx.storageDomain` | `open<S extends DomainSpec>(spec): Promise<Domain<S>>`, `get(name)`, `closeAll()` |

**[LIVE]** `StorageForms` is an **empty declaration-merged interface**:

```ts
export interface StorageForms {
}
```

→ concrete form keys are contributed by other packages; `ctx.storage.<form>` is not statically
knowable. `@deepseek-ai/dsh-storage-domain` contributes the `domain` form, and
`@deepseek-ai/dsh-storage-json` is a **backend** registered under `json`, **not** a Service.
There is **no `storage-json` Service and no `storage-json` entry in the live Service catalog** —
the task brief's third candidate does not exist as a service in this build. Use `storageDomain`.

### 3.2 The domain form is the answer

**[SOURCE]** `dsh-storage-domain/README.md:28` — “Use this package when a host package keeps durable,
schema-validated records — workspace records, session sidecar metadata. The owning package declares
the domain once; consumers open it and get synchronous reads and durable, change-emitting writes
without ever touching a backend.”

**[SOURCE]** `dsh-storage-domain/README.md:36` — “`defineDomain` fails loudly at module load on a bad
name, a version that is not a non-negative integer, or a global schema that accepts `null`.”

**[SOURCE]** `dsh-storage-domain/README.md:49-58`:

```js
const domain = await ctx.storageDomain.open(workspaceSpec)
await domain.table('workspaces').put(id, { path: '/work/demo' })
const record = domain.table('workspaces').get(id) // synchronous, from memory
domain.table('workspaces').update(id, (r) => ({ ...r, path: newPath }))
```

**[SOURCE]** `dsh-storage-domain/README.md:58` — “The caller owns the handle's lifecycle and
releases it with `domain.close()` when the feature shuts down (typically its own `ctx.effect`
disposer).”

**[LIVE]** the exact handle types:

```ts
export interface Domain<S extends DomainSpec> {
    readonly name: string;
    readonly global: DomainGlobalHandleOf<S>;
    table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>;
    close(): Promise<void>;
}
export interface KvTable<K extends string, V> {
    get(key: K): V | undefined;
    entries(): IterableIterator<[K, V]>;
    keys(): IterableIterator<K>;
    readonly size: number;
    put(key: K, value: V): Promise<void>;
    delete(key: K): Promise<boolean>;
    deleteMany(keys: readonly K[]): Promise<number>;
    update(key: K, fn: (current: V) => V): Promise<V>;
}
export interface DomainSpec {
    readonly name: string;
    readonly version: number;
    readonly layout?: 'single' | 'per-record';
    readonly compatibleVersions?: readonly number[];
    readonly invalidRecords?: 'backup-and-skip';
    readonly global?: DomainGlobalSpec<unknown>;
    readonly tables: Record<string, DomainTableSpec>;
}
export interface DomainTableSpec<K extends string = string, V = unknown> {
    readonly valueSchema: ZodType<V>;
    readonly __key?: K;
}
```

**[LIVE]** `DomainSpec.tables` values use `ZodType<V>` — **zod**, not schemastery. Confirmed
independently by a real consumer:

**[SOURCE]** `dsh-workspace/lib/index.js:5,7`:

```js
import { z } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
```

**[SOURCE]** `dsh-storage-domain/lib/index.js:46-48` — `domainTable(schema)` is
`return { valueSchema: schema };`. `defineDomain` validates only `name` (`UNIT_NAME_RE`),
`version`, `compatibleVersions`, `layout`, `invalidRecords` (`lib/index.js:61-70`) — it does **not**
inspect `valueSchema`.

**[LIVE]** domain error codes a consumer must handle: `already-open`, `backend-not-found`,
`facet-unsupported`, `version-mismatch`, `malformed-medium`, `invalid-record`, `missing-key`
(`update` on an absent record), `closed`, `unknown-state`.

### 3.3 Runnable watermark snippet

```js
import { z } from "zod";                                        // resolution UNVERIFIED, see §6
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";

// Declared once at module scope.
const sessionLogUploadSpec = defineDomain({
  name: "session-log-upload-modes",          // must match UNIT_NAME_RE (lowercase letters/digits/-/_)
  version: 1,
  layout: "per-record",                      // one small document per session key
  tables: {
    // key: the Session id string.  value: the per-session watermark.
    watermarks: domainTable(z.object({
      throughSeq: z.number().int().min(-1),
      sessionFormatVersion: z.number().int().min(0),
      // whatever else the design needs, e.g. lastAttemptAt, mode
    })),
  },
});

export function apply(ctx) {
  ctx.inject(["storageDomain", "sessions"], (child) => {
    child.effect(() => {
      let domain;
      const ready = child.storageDomain.open(sessionLogUploadSpec)
        .then((opened) => { domain = opened; })
        .catch((error) => { child.logger.warn(error); });

      return () => { domain?.close(); void ready; };
    }, "session-log-upload: watermark domain");
  });
}

// read (synchronous, from validated memory)
const wm = domain.table("watermarks").get(String(session.id));

// write (durable before it resolves)
await domain.table("watermarks").put(String(session.id), {
  throughSeq: Number(newThroughSeq),
  sessionFormatVersion: session.header.version,
});
```

Simplest robust variant: store only `throughSeq` and require
`record.sessionFormatVersion === session.header.version` before using it — mirroring the shipped
`acceptedFormatVersion !== session.header.version` guard (`lib/index.js:116`).

### 3.4 May the plugin append its own Session event type? **No.**

**[SOURCE]** `references/practices.md:21` (the `cordis-plugin-development` skill):

> “Do not append session events with a new `type`. Readers accept an unknown stored event only when
> its envelope carries `ignorable: true`, and live `Session.append()` cannot set that marker, so the
> Session would refuse to reopen. `appendPluginRecord()` writes ignorable `plugin:` records, but it
> is reserved for DSH's experimental packages because a Session format migration keeps those records
> only on a best-effort basis. Derive state from existing events, or keep plugin-owned data in a
> storage service found through inspection.”

**[SOURCE]** `dsh-session/lib/index.js:72-77` confirms the mechanism from the other side:

> “Downstream (out-of-repo) plugin events are outside this list by construction. The persisted
> `SessionEvent.ignorable` marker is the compatibility mechanism; event-name registration was
> rejected because it does not classify omission safety and would make reads composition-dependent.”

**[LIVE]** `Session.append` signature carries `...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []` —
there is **no** parameter that can set `ignorable`.

**Verdict: a plugin may not append a new event type.** It *may* append an existing
`KNOWN_SESSION_EVENT_TYPES` member — and `"session-log-deepseek/delivery-accepted"` is one
(`dsh-session/lib/index.js:113`). That is a legal alternative to the storage domain, but it
**collides semantically** with the shipped uploader's watermark for the same Session unless the
payload is distinguishable (e.g. a different `sessionId` is impossible — the fold keys on
`event.data.sessionId !== session.id`). **Recommendation: use the storage domain; do not reuse
`delivery-accepted` for a second uploader.**

### 3.5 Mode `off` — confirmed

**[SOURCE]** `dsh-session-log-deepseek/lib/index.js:140-149` — the exclusion check runs **inside**
the `prepare` callback of the `dsh_session_log` contribution, before the watermark is read and
before any event is serialized:

```js
ctx.deepseekLlmApiExtensions.register("dsh_session_log", { prepare: (request) => {
    if (!config.enabled.get()) return void 0;
    if (request.sessionId === void 0) return void 0;
    const session = ctx.sessions.get(brandString(request.sessionId));
    if (session === void 0) return void 0;
    const upload = {
        sessionId: session.id,
        ...request.purpose === void 0 ? {} : { purpose: request.purpose }
    };
    for (const { exclude } of this.exclusions) if (exclude(upload)) return void 0;
    …
```

Returning `true` makes `prepare` return `undefined`, so **both** the field and the `accept`
callback are skipped — `accept` is only constructed on the success path
(`lib/index.js:184-197`). Corroborated by `README.md:48`: “Plugins can register synchronous,
side-effect-free predicates with `ctx.sessionLogDeepSeek.registerExclusion()`… `true` skips this
request's log field and acceptance callback.”

**[LIVE]** the signature and request payload:

```ts
registerExclusion(exclude: SessionLogUploadExclusion): () => Promise<void>
export type SessionLogUploadExclusion = (request: SessionLogUploadRequest) => boolean;
export interface SessionLogUploadRequest {
    readonly sessionId: SessionId;
    readonly purpose?: string;
}
```

**[LIVE]** the registry is reached as `ctx.get("sessionLogDeepSeek")` (optional) or
`ctx.sessionLogDeepSeek` (with `inject: ["sessionLogDeepSeek"]`).

```js
ctx.inject(["sessionLogDeepSeek"], (child) => {
  child.effect(() => child.sessionLogDeepSeek.registerExclusion(() => true));
});
```

This is **official-route only**: the exclusion registry is consulted only by the `dsh_session_log`
contribution, which only the `deepseek-official` adapter sends.

---

## 4. Client → Host settings wire (the single most important fact)

The reference implementation is the shipped Web switch **“Upload Session Log when using the
official model API”** — entry `include:ui-settings-session-log`, module
`@deepseek-ai/dsh-client-ui-settings-session-log`.

### 4.1 The wire in one line

**A Client plugin never calls a Remote itself.** It obtains a shared form with
`ctx.configForms.get("<host-entry-id>")` and calls `form.set(field, value)`. That form was created
by the `ui-settings` provider on **the provider's own fiber**, and it performs the actual Host write
through `ctx.remote.settings.mutate(ns, ops, revision)`.

### 4.2 Consumer side — verbatim shipped code

**[SOURCE]** `dsh-client-ui-settings-session-log/lib/client.js:172-220` (the complete `apply`):

```js
const inject = [
	"slots",
	"locale",
	"configForms"
];
function apply(ctx) {
	const locale = "settings.sessionLog";
	const namespace = "session-log-deepseek";
	ctx.effect(() => ctx.locale.register(locale, { en, zh, ja, es, fr, de, ru, pt }));
	const form = ctx.configForms.get(namespace);
	const preference = new UploadPreference(form);
	const face = () => ({
		hooks: {
			upload: form,
			mutation: preference.state
		},
		setEnabled: (enabled) => preference.setEnabled(enabled),
		dismiss: () => {
			preference.dismiss();
		}
	});
	ctx.effect(() => ctx.configForms.whileServed([namespace], () => ctx.slots.inject("settings.general.item", () => ctx.slots.register({
		name: "settings.general.item",
		id: namespace,
		order: 90,
		locale,
		inject: face
	}, UploadRow))));
	ctx.slots.inject("shell.overlay", () => ctx.slots.register({
		name: "shell.overlay",
		id: "session-log-upload-toast",
		locale,
		inject: face
	}, UploadToast));
}
```

Read = `form` (a snapshot store). Write = **[SOURCE]** `lib/client.js:30-45`:

```js
async setEnabled(enabled) {
	if (this.state.getSnapshot().busy) return;
	…
	let accepted = false;
	try {
		accepted = await this.form.set("enabled", enabled);
	} catch (_error) {}
	…
}
```

Map state: `upload.value?.enabled === true`, `upload.status !== "ready"`, `upload.writable`
(`lib/client.js:88-94`).

### 4.3 Provider side — the actual RPC

**[SOURCE]** `dsh-client-ui-settings/lib/client.js:1140-1182` — `ConfigFormController`:

```js
set(field, value) {
	return this.mutate([{ op: "set", path: [field], value }]);
}
unset(field) {
	return this.mutate([{ op: "unset", path: [field] }]);
}
mutate(ops, expectedRevision) {
	const ownedOps = structuredClone(ops);
	const generation = ++this.writeGeneration;
	return this.enqueue(async () => {
		const revision = expectedRevision ?? this.pendingRevision ?? this.getSnapshot().revision;
		const response = await this.ctx.remote.settings.mutate(this.spec.namespace, ownedOps, revision);
		if (!response.ok) {
			await this.recover(generation);
			return false;
		}
		…
		this.mirror.acceptView(response.value);
		return true;
	});
}
```

Snapshot store shape (**[SOURCE]** `lib/client.js:1108-1115`):
`{ status, value, base, user, revision, writable }`, with `status` `"loading" | "ready" | "unavailable"`.
`value` is present only when the rehydrated schema validates it (`lib/client.js:1233-1243`).

**[SOURCE]** `lib/client.js:1252-1274` — the provider is a Cordis `Service` named `configForms`
whose `owner` is the **providing** fiber:

```js
var ConfigForms = class extends _deepseek_ai_cordis.Service {
	constructor(ctx, config) {
		super(ctx, "configForms");
		this.mirror = config.mirror;
		this.schema = config.schema;
		this.owner = ctx;
		this.developerTools = new DeveloperToolsPreference(this.get(DEVELOPER_TOOLS_NAMESPACE));
```

with the decisive comment at `lib/client.js:1258-1262`:

> “The PROVIDING fiber, kept because a Service reads `ctx` as its *consumer's* fiber: letting a
> shared form write through the caller's context would make every caller declare `remote.settings`
> in its own `inject`.”

**Consequence: a consumer's `inject` list does NOT need `remote` or `remote.settings`** — and the
shipped companion indeed declares only `["slots", "locale", "configForms"]`.

### 4.4 `configForms` contract (from the shipped built JS)

| Member | Source |
|---|---|
| `get(entryId)` → shared, cached `ConfigFormController` | `lib/client.js:1294-1301` |
| `whileServed(namespaces, register)` → disposer; `register(servedSet)` runs once any namespace is in the describe mirror, and is torn down when none is | `lib/client.js:1315-1334` |
| `describe()` → the shared mirror's read/fold face | `lib/client.js:1287-1289` |
| `developerTools` → the `ui-settings` entry's own preference | `lib/client.js:1270-1274`, `1255` |

`whileServed` is what makes the row disappear when the Host does not expose the namespace
(`dsh-client-ui-settings-session-log/README.md:64`: “The row is unavailable when the Host does not
expose the `session-log-deepseek` namespace.”).

### 4.5 Host side — the `settings` Service

**[LIVE]** `ctx.settings` (package `@deepseek-ai/dsh-settings`, entry id `settings`):

| Method | Signature | Params |
|---|---|---|
| `configure` | `configure(presentation: { auto?: boolean }, owner: Fiber = this.ctx.fiber): () => void` | registers the calling instance's page policy |
| `prepareDocument` | `prepareDocument(): Promise<string>` | locate the profile patch for native editing |
| `describe` | `describe(options?: SettingsDescribeOptions): SettingsDescriptor[]` | `{ redactSecrets?: boolean }` |
| `update` | `update(ns: string, patch: object, expectedRevision?: number): Promise<void>` | merge fields into an entry's config |
| `replace` | `replace(ns: string, section: object, expectedRevision?: number): Promise<void>` | |
| `mutate` | `mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>` | |

```ts
export interface SettingsDescriptor {
    ns: SettingsNamespace;
    autoGenerate: boolean;
    schema: unknown;
    value: unknown;
    revision: number;
    base?: unknown;
    user?: unknown;
    applies: 'live';
    secrets?: RedactedSecret[];
}
export type SettingsPathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] };
```

**[LIVE]** `update`'s `ns` is documented as **“Profile entry id.”** — i.e. the Cordis entry id, not a
free-form name. `dsh-llm-deepseek-api-key/README.md:53` states the rule: “The settings namespace is
the Cordis entry id, or the plugin name without an entry.”

### 4.6 Remote wire (browser → Host)

**[SOURCE]** `dsh-api-settings-controller/README.md:30`:

> “`settings.describe()` returns deployment facts and every namespace under `redactSecrets: true`.
> `settings.update`, `settings.replace`, and `settings.mutate` expose the settings service's three
> write operations and return the namespace's new redacted view; stale writes use
> `settings-conflict` and other provider refusals use `settings-rejected`.”

**[SOURCE]** `dsh-client-ui-settings/lib/client.js:1447` — the read path is
`await this.ctx.remote.settings.describe()`; **[SOURCE]** `lib/client.js:1489` — the invalidation is
`ctx.remote.$on("settings/document-updated", () => mirror.load())`.

**[SOURCE]** `dsh-client-ui-settings/lib/client.js:1481` — the **provider's** `inject` is
`["remote", "remote.settings"]`. A consumer plugin does **not** declare these.

### 4.7 `dsh.client` declaration

**[SOURCE]** `dsh-client-ui-settings-session-log/package.json:29-38`:

```json
"dsh": {
  "client": {
    "inject": [
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-settings",
      "@deepseek-ai/dsh-client-ui-layout"
    ],
    "platform": "web"
  }
}
```

plus the export map entry that ships the browser artifact
(`package.json:21-24`):

```json
"./client": {
  "types": "./lib/types/client/index.d.ts",
  "default": "./lib/client.js"
}
```

- `dsh.client.platform: "web"`.
- `dsh.client.inject` **only orders activation**; per `references/practices.md:35`: “`dsh.client.inject`
  entries only order activation and stay allowed. … Do not `require('@deepseek-ai/dsh-client-ui-primitives')`
  or load any other Harness Client package as a module.”
- The companion declares **no** Remote, **no** settings namespace, and **no** extra wire field.
  It reuses the `session-log-deepseek` Host entry id as the namespace.
- A Client half that also wants `immediately` may declare it — `dsh-our-free-model/package.json:115-119`
  shows `{ "platform": "web", "immediately": true, "inject": [] }`.
- The browser artifact format (`lib/client.js:1-3, 222-224`):

```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-settings-session-log",
	factory: (require) => {
		…
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
```

The factory id **equals the package name**; `react` / `react/jsx-runtime` /
`@deepseek-ai/dsh-client-store` / `-ui-primitives` come from the browser module table via `require`.

> **Do not `require('@deepseek-ai/dsh-client-ui-primitives')` in a plain-JS plugin.** The shipped
> package does, because it is built in-repo. For a workspace-authored bundle, `references/practices.md:35`
> requires writing your own controls and copying markup/CSS (`--dsw-alias-*` tokens only), because a
> throwing component blanks the slot entry (`console: slot entry crashed in '<slot>'`).

---

## 5. Slot props and registration options

**Client inspect is unavailable in this session.** `cordis_inspect_query` with
`platform: client`, provider `Slots` (`listSubTree` for `settings.general.item` and
`settings.section`) and provider `Service` (`configForms`) each timed out after 10000 ms with
“Open or reconnect the Harness page, then retry” — retried 4 times over the session. Everything in
this section is therefore read from the shipped built Client JS, which is authoritative for the
registration/declaration shape but **not** for the framework's exhaustive prop list. See §7.

### 5.1 Slot declarations

**[SOURCE]** `dsh-client-ui-settings-general/lib/client.js:1522-1562` — the settings shell registers
`sidebar.settings` and **declares** the settings slot types as children:

```js
const disposeSlot = ctx.slots.register({
	name: "sidebar.settings",
	locale: NS,
	store: shellStore,
	children: {
		"settings.launcher": { kind: "single", scope: "root" },
		"settings.trigger": { kind: "single", scope: "root" },
		"settings.header": { kind: "single", scope: "root" },
		"settings.action": { kind: "list", scope: "root" },
		"settings.close": { kind: "single", scope: "root" },
		"settings.section": { kind: "list", scope: "root" },
		"settings.section.icon": { kind: "list", scope: "root", inline: true },
		"settings.onboarding": { kind: "list", scope: "root" }
	},
	inject: shellInjected
}, SettingsRoot);
```

**[SOURCE]** `dsh-client-ui-settings-general/lib/client.js:1587-1597` — the General section registers
`settings.section` and declares `settings.general.item`:

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
	name: "settings.section",
	id: "general",
	order: 0,
	label: () => t("general.nav"),
	locale: NS,
	children: { "settings.general.item": {
		kind: "list",
		scope: "root"
	} }
}, GeneralSection));
```

| Slot | kind | scope | declared by |
|---|---|---|---|
| `settings.section` | `list` | `root` | `sidebar.settings` children |
| `settings.general.item` | `list` | `root` | `settings.section` (`id: "general"`) children |

**[SOURCE]** `dsh-client-ui-settings-general/lib/client.js:639-644` — how a section renders its
children:

```js
function GeneralSection({ renderSlot }) {
	return (0, react_jsx_runtime.jsx)("div", {
		className: GeneralSection_module_css_default.section,
		children: renderSlot("settings.general.item", {})
	});
}
```

The parent's `children` declaration is what makes `renderSlot("settings.general.item", {})` legal.

### 5.2 Registration options for `settings.section`

**[SOURCE]** `lib/client.js:1587-1597` (quoted above). Observed options:

| Option | Value in the shipped example | Notes |
|---|---|---|
| `name` | `"settings.section"` | required |
| `id` | `"general"` | required for a `list` slot — “list-slot registration requires id (SlotCore rejects an entry without one)” (`lib/client.js:1435`) |
| `order` | `0` (number) | sorted ascending by the shell (`lib/client.js:1439`) |
| `label` | `() => t("general.nav")` — a **thunk** | resolved via `resolveSlotLabel` (`lib/client.js:1438`); may be a locale-following thunk |
| `locale` | `"settings"` | dictionary namespace used for `t` |
| `children` | `{ "settings.general.item": { kind: "list", scope: "root" } }` | a `settings.section` occupant **must** declare this to host general rows |

The nav row is built from `ctx.slots.entries("settings.section")` mapped to
`{ id: e.options.id ?? "", order: e.options.order ?? 0, label: resolveSlotLabel(e.options.label) ?? "" }`
(`lib/client.js:1434-1439`), and the icon comes from a separate
`settings.section.icon` registration with the **same `id`**
(`dsh-client-ui-settings/README.md:47`).

### 5.3 Registration options for `settings.general.item`

Two shipped examples.

**[SOURCE]** `dsh-client-ui-settings-session-log/lib/client.js:207-213`:

```js
ctx.slots.register({
	name: "settings.general.item",
	id: namespace,          // "session-log-deepseek"
	order: 90,
	locale,                 // "settings.sessionLog"
	inject: face             // () => ({ hooks, setEnabled, dismiss })
}, UploadRow)
```

**[SOURCE]** `dsh-client-ui-settings-general/lib/client.js:1356-1377`:

```js
ctx.slots.inject("settings.general.item", () => ctx.slots.register({
	name: "settings.general.item",
	id: "developer-tools",
	order: 15,
	locale: NS,
	inject: () => ({
		hooks: { developerTools: ctx.configForms.developerTools.enabled },
		setEnabled: async (enabled) => { … }
	})
}, DeveloperToolsRow));
ctx.slots.inject("settings.general.item", () => ctx.slots.register({
	name: "settings.general.item",
	id: "current-version",
	order: 100,
	locale: NS
}, CurrentVersionRow));
```

Observed options table:

| Option | Required | Notes |
|---|---|---|
| `name` | yes | `"settings.general.item"` |
| `id` | yes | must be unique in the slot (`"session-log-deepseek"`, `"developer-tools"`, `"current-version"`) |
| `order` | no | number, ascending; shipped values 15, 90, 100 |
| `locale` | no | dictionary namespace that provides this component's `t` |
| `inject` | no | a **function** (or value) whose result is composed into the component's props |
| component | yes | 2nd argument; the React function component |

### 5.4 Props a registered component receives

**[INFERRED — but from two independent shipped registrations that agree]**

| Prop | Origin | Evidence |
|---|---|---|
| `t` | the `locale` dictionary namespace, bound | `function CurrentVersionRow({ t })` (`lib/client.js:664`); `t("title")` in `UploadRow` (`session-log/lib/client.js:84`) |
| `use<CapitalizedHook>` | each key of the returned `hooks` object becomes a selector hook `useX(selector)` over that snapshot store | `hooks: { developerTools: … }` + `function DeveloperToolsRow({ useDeveloperTools, setEnabled, t })` (`general/lib/client.js:1362,694`); `hooks: { upload: form, mutation: preference.state }` + `function UploadRow({ useUpload, useMutation, setEnabled, t })` (`session-log/lib/client.js:197-206, 77-79`) |
| other `inject` keys | spread verbatim | `setEnabled`, `dismiss` (session-log); `setEnabled` (general) |
| parent-shared props | e.g. `wide` on trigger content, `renderSlot` on a section, `controller`/`useSnapshot` on the header action | `TriggerContent({ wide, t })` (`lib/client.js:598`); `GeneralSection({ renderSlot })` (`lib/client.js:639`); `SettingsDocumentAction({ controller, useSnapshot, t })` (`lib/client.js:752`) |

Selector-hook usage: `useUpload((value) => value)`, `useMutation((value) => value.busy)`
(`session-log/lib/client.js:78-79`) — i.e. `(selector) => selected`, subscribing to the smallest
slice.

**UNVERIFIED** — the complete framework-level prop set for these two slots (e.g. whether a `key`,
`options`, or `slot` prop is also injected), and the exhaustive `SlotRegistration` option schema
(`kind`, `scope`, `inline`, `children`, `store`, `label`, `order`, `id`, `name`, `locale`, `inject`
are the option names observed; the declaration-side `kind`/`scope` belong to `children` declarations,
not to a leaf registration). Tried: 4× `Slots.listSubTree` on `settings.general.item` and
`settings.section`, and 1× Client `Service.listService` for `configForms`; all timed out with
“Open or reconnect the Harness page”. `lib/types/**/*.d.ts` is absent from this build, so the
declared interface could not be read either. **Re-run live inspect with the page open before freezing
the Client component signature.**

---

## 6. How a dependency-free profile bundle declares `Config`

**Question (from the Lead): what module does the shipped package import its schema builder from, is
that specifier resolvable from a profile-installed bundle, and does `configEditor.edit` still work
with no `Config`?**

### 6.1 The import statement

**[SOURCE]** `dsh-session-log-deepseek/lib/index.js:1-5` — the first five lines:

```js
import { Buffer } from "node:buffer";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { brandString } from "@deepseek-ai/dsh-brand";
import { KNOWN_SESSION_EVENT_TYPES, SessionLogOffset, SessionSeq } from "@deepseek-ai/dsh-session";
```

The schema builder is **`@deepseek-ai/schemastery`, default import, bound to the local name `z`**
(not `zod`). **[SOURCE]** `dsh-session-log-deepseek/lib/index.js:18-21`:

```js
const Config = z.object({
	enabled: z.boolean().default(true).volatile(),
	maxBytes: z.number().step(1).min(1).default(8 * 1024 * 1024)
});
```

The same specifier is used by the shipped Client-Host halves:
`dsh-client-ui-settings/lib/index.js:1` and `dsh-client-ui-settings-general/lib/index.js:1` both open
with `import z from "@deepseek-ai/schemastery";`.

`.volatile()` is what makes a field editable through the settings form:
`dsh-settings/README.md:33` — “Forms expose only volatile fields from active, uniquely addressed
profile entries.” (corroborated at `dsh-settings/README.md:47`).

The installation pins it: **`@deepseek-ai/schemastery": "3.19.0"`** (`...\app.asar\dsh\package.json:335`),
and `@deepseek-ai/cordis": "4.1.0"` (line 7).

### 6.2 Profile `package.json`

**[SOURCE]** `C:\Users\<you>\.dsh\profiles\desktop\package.json` (read-only, full file, 20 lines):

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-our-free-model": "git+https://github.com/zouyuxuan122/dsh-our-free-model.git",
    "dsh-mc-skill": "file:./node_modules/dsh-mc-skill"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-experimental-agent-team-profile",
        "@deepseek-ai/dsh-experimental-auto-review",
        "dsh-our-free-model",
        "dsh-mc-skill"
      ]
    }
  }
}
```

- `dependencies` keys: **`dsh-our-free-model`**, **`dsh-mc-skill`** — nothing else.
- There is **no** `devDependencies` key.
- Neither `@deepseek-ai/schemastery` nor `@deepseek-ai/cordis` is declared by the profile.

### 6.3 Is `@deepseek-ai/schemastery` resolvable from a profile bundle? **UNVERIFIED — assume not.**

What was checked:

1. **`C:\Users\<you>\.dsh\profiles\desktop\node_modules`** contains only:
   `.pnpm`, `dsh-mc-skill`, `dsh-our-free-model`, `.modules.yaml`, `.pnpm-workspace-state-v1.json`.
   There is **no `@deepseek-ai` scope directory**.
2. **`node_modules/.pnpm`** contains only `lock.yaml` — no `@deepseek-ai` package is materialized in
   the profile's store.
3. **Neither installed profile bundle imports a bare `@deepseek-ai/*` specifier at runtime.**
   A recursive scan of `dsh-mc-skill/**/*.js` for `from ['"]@deepseek-ai` matched **zero** lines, and
   `dsh-our-free-model/index.js:26-40` + `src/adapter.js:20-25` import only `node:` builtins and
   relative paths (its `src/adapter.js:1-8` JSDoc explicitly says the adapter “satisfies the harness
   adapter contract structurally … which is what lets this plugin mount on more than one kernel line
   without importing a version-pinned adapter base class”).
   Both packages nonetheless *declare* `peerDependencies` on `@deepseek-ai/cordis`
   (`dsh-mc-skill/package.json:39-41`, `dsh-our-free-model/package.json:122-128`, which also peers
   `@deepseek-ai/schemastery: ^3.18.4`), so the peers are **declared but never resolved at runtime**
   in these two examples.

Node ESM resolution walks up from
`…\.dsh\profiles\desktop\node_modules\<bundle>\lib\index.js`, i.e. it would look in
`…\profiles\desktop\node_modules`, `…\profiles\desktop`, `…\.dsh`, `C:\Users\<you>`, `C:\` — none of
which contain the dsh installation. **Tried and not available:** reading a loader/resolver
implementation (no source file for the Loader was locatable from the paths I could read), and
`dsh-cordis-host-runner/README.md` (documents a `node:vm` sandbox for self-referential dynamic
packages, not profile package resolution).

**Working assumption to freeze the design on:** a workspace bundle must be
**dependency-free at runtime** — no bare `@deepseek-ai/*` import, no `zod`, no `node_modules`
beyond the bundle itself. Practical consequences:

- **`Config`:** you cannot `import z from "@deepseek-ai/schemastery"`. Two candidate escapes, both
  needing a live check before freeze:
  (a) declare no `Config` at all (see 6.4) and accept only a plain-object `config` from the patch row;
  (b) ship the schema builder by another means.
- **`ctx.storageDomain` record schemas:** `DomainTableSpec.valueSchema` is typed `ZodType<V>` and a
  real consumer imports `z` from `"zod"` (`dsh-workspace/lib/index.js:5`). `zod` is likewise not in
  the profile's `node_modules`. `defineDomain` does **not** validate `valueSchema`
  (`dsh-storage-domain/lib/index.js:61-70`), and the runtime consumers are `loadAll()` validation and
  `put()` — so a hand-rolled schema-like object with a `parse`/`safeParse` face is a plausible
  substitute, but **UNVERIFIED: which face the domain runtime actually calls.** Read
  `dsh-storage-domain/lib/index.js` around the load/put paths (480 lines; only its first 70 were read
  here) or test empirically before relying on it.

### 6.4 A row with no `Config` schema and `configEditor.edit`

- **[LIVE]** `Config.listConfigs` reports a per-entry `status`. The live values observed include
  `"schema"` (the entry declares a Config), `"absent"`, `"inactive"`, and `"tree"`. A row with no
  `Config` is reported as **`absent`**, not as a schema-less entry. Examples from the live directory:
  `include:storage → @deepseek-ai/dsh-storage` is `absent`;
  `include:mc-skill → file:///…/dsh-mc-skill/lib/index.js` is `absent` even though the package is
  installed and its patch row is listed.
- **[LIVE]** `include:session-log-deepseek` (`status: "schema"`) also reports
  **`acceptsMissing: true`** with `schema.anyOf` admitting `{"type": ["object","null"]}` and
  `default: {}` — i.e. even a schema-declaring row tolerates an omitted config.
- **[SOURCE]** `dsh-settings/README.md:33` — “Forms expose **only volatile fields** from active,
  uniquely addressed profile entries. Ordinary configuration remains editable through Cordis
  configuration files.” So a row with no `Config` contributes **no form fields** either way.
- **[SOURCE]** `dsh-settings/README.md:47` — “The [service](src/index.ts) supplies revisioned
  descriptors and **validates edits against the full plugin Config** before delegating persistence.”

**Verdict:** a form write against a namespace with no `Config` has nothing to validate against and no
volatile fields to project, so `settings.update`/`replace`/`mutate` cannot be a meaningful path for
it. **UNVERIFIED:** whether `configEditor.edit(entry, change)` itself still works when the row
declares no `Config`, and what it validates against. Tried: `dsh-config-editor` has no README
readable at the guessed path and its live entry `include:config-editor` is `absent`; the
`configEditor` Service is not in the live Service catalog, so its contract could not be inspected.
**If the design needs a patch-writable, form-editable preference (the four upload modes), the Host
plugin MUST declare a `Config` with `.volatile()` fields — which loops back to 6.3.**

---

## 7. UNVERIFIED register (blocking items first)

| # | Item | What was tried | Impact |
|---|---|---|---|
| U1 | Whether a **profile-installed workspace bundle** can resolve bare `@deepseek-ai/schemastery` / `@deepseek-ai/cordis` / `zod` at runtime | Listed `profiles/desktop/node_modules` and `.pnpm`; scanned both installed bundles for bare `@deepseek-ai/*` imports (0 matches); read `dsh-cordis-host-runner/README.md` | **Blocking.** Decides how `Config` and `storageDomain` schemas are declared. Verify by running a probe bundle and reading the import error, before the Host implementation is frozen. |
| U2 | Full prop set and exhaustive registration-option schema for `settings.section` / `settings.general.item` | 4× `Slots.listSubTree` (both slots) and 1× Client `Service.listService({service:"configForms"})` — all timed out: “Open or reconnect the Harness page, then retry”; `lib/types/**/*.d.ts` absent from this build | Blocks only the Client component signature. Re-run inspect with the page connected. The registration/declaration shapes in §5 are read from shipped built JS and are reliable. |
| U3 | Whether `configEditor.edit(entry, …)` validates anything when the row declares no `Config` | `configEditor` Service not in the live catalog; `include:config-editor` status `absent`; no readable README found at the package path | Medium. Mitigated by always declaring a `Config` with volatile fields. |
| U4 | Minimal valid `messages` body for a log-only POST to `https://api.deepseek.com/anthropic/v1/messages`, and whether the endpoint accepts a request whose only meaningful content is `dsh_session_log` | Read `dsh-llm-deepseek/README.md` and `dsh-deepseek-llm-api-extensions/README.md`; both document the field, not a minimal body | **Blocking for modes 3 and 4.** Must be probed live (or read `dsh-llm-deepseek/lib/index.js` serialize path). |
| U5 | Whether the official adapter requires a non-empty `sessionId` on the log-only request (`GenerateOptions.sessionId?: Branded<'SessionId'>`) — it does not, for a plugin's own direct POST | — | Low; the plugin's own POST is plain HTTP, not `ctx.llm.stream`. |
| U6 | The declared `SlotRegistration`/slot-option **interface** (`kind`, `scope`, `inline`, `children`) | d.ts stripped; only observed usage available | Low: declaration-side options are copied verbatim from the shipped JS in §5.1. |

---

## 8. Design consequences this dossier pins down

1. **Modes 3/4 must POST their own request.** `dsh_session_log` reaches the wire only through
   `ctx.deepseekLlmApiExtensions.register("dsh_session_log", …)` (`dsh-session-log-deepseek/lib/index.js:140`),
   whose registry is consumed only by `@deepseek-ai/dsh-llm-deepseek`
   (`dsh-deepseek-llm-api-extensions/README.md:34`: “The provider-neutral LLM seam and `llm-pi-ai` do
   not consume this registry”). **[LIVE]** `GenerateOptions` has exactly
   `provider, model, reasoningEffort, messages, system, tools, toolHistory, temperature, maxTokens,
   stop, signal, sessionId, purpose` — **no free-form body field.** The plugin must therefore do its
   own `fetch` to `https://api.deepseek.com/anthropic/v1/messages` with `x-api-key`.
2. **Reuse the official payload byte-for-byte.** Copy `wireEvent`/`wireSurfaceOp` verbatim
   (`lib/index.js:41-86`) and rebuild `{version:1, sessionFormatVersion, session, afterSeq,
   throughSeq, events}`. Do not invent field names — the receiver is DeepSeek's own parser.
3. **Mode `off` is free and exact.** `ctx.sessionLogDeepSeek.registerExclusion(() => true)` suppresses
   both the field and the acceptance callback on the official route (§3.5). No config write, no
   other plugin's row touched.
4. **Watermark = `ctx.storageDomain` domain, one record per Session id**, opened once and closed in
   the plugin's own `ctx.effect` disposer. Do **not** append a new Session event type (§3.4).
5. **Client half: `ctx.configForms.get(ns)` + `whileServed`, never a Remote.** Declare
   `dsh.client = { platform: "web", inject: [...] }` and an `./client` export; consume
   `configForms` only — `remote` / `remote.settings` are the provider's problem.
6. **The namespace is the Host entry id.** If the Host plugin's row id is, e.g.,
   `session-log-upload-modes`, that exact string is the `configForms.get(...)` / `settings.mutate(ns)`
   namespace, and it must be a row the Host actually mounts with a `Config`.
7. **`settings.general.item` is the row slot; `settings.section` is a nav page.** A nav page
   registration must declare `children: { "settings.general.item": { kind: "list", scope: "root" } }`
   for the rows to render, and a matching `settings.section.icon` registration with the **same `id`**
   for a custom glyph.
