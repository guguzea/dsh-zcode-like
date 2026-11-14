/**
 * Client-half checker for @local/dsh-session-log-upload.
 *
 * Plain `node verify/client-check.mjs`; no dependencies, no network. Fails with exit 1
 * on the first category of problems and prints every check it ran.
 *
 * Checks
 *  1. syntax            client.js compiles (node --check semantics, classic script).
 *  2. loader-id         the `__ModuleLoader__.load` id equals package.json's `name`.
 *  3. module-shape      the factory runs and returns { apply, inject } with the frozen list.
 *  4. no-host-packages  client.js never loads a @deepseek-ai/* module (or anything but react).
 *  5. locale-keys       every `t("...")` literal and every `upload.*` literal exists in BOTH
 *                       locale files.
 *  6. locale-parity     en.json and zh.json have identical key sets.
 *  7. dict-parity       the inline DICTIONARIES match locale/en.json and locale/zh.json
 *                       key-for-key and value-for-value.
 *  8. registration      the required settings.section / settings.section.icon shape is present.
 *  9. theme-tokens      the injected stylesheet contains no literal colour.
 * 10. behaviour        the section's state, write order, consent gate, and the manual
 *                      fallback are executed in a small hook runtime, not pattern-matched:
 *                      a not-ready form disables the controls and is never reported as a
 *                      bare save failure, a refused write still is, a wide mode always
 *                      passes the dialog first, and the printed patch row is this
 *                      profile's own row.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_PATH = path.join(ROOT, "client.js");
const EN_PATH = path.join(ROOT, "locale", "en.json");
const ZH_PATH = path.join(ROOT, "locale", "zh.json");
const PKG_PATH = path.join(ROOT, "package.json");

const REQUIRED_INJECT = ["slots", "locale", "configForms", "remote", "remote.settings"];
/** Every key the task freezes into the locale namespace. */
const REQUIRED_KEYS = [
	"upload.sectionTitle",
	"upload.sectionDescription",
	"upload.modeGroupLabel",
	"upload.destinationLabel",
	"upload.modes.off.label",
	"upload.modes.off.detail",
	"upload.modes.officialOnly.label",
	"upload.modes.officialOnly.detail",
	"upload.modes.deepseekAnyProvider.label",
	"upload.modes.deepseekAnyProvider.detail",
	"upload.modes.anyModel.label",
	"upload.modes.anyModel.detail",
	"upload.warnTitle",
	"upload.warnBody",
	"upload.warnConfirm",
	"upload.warnCancel",
	"upload.destinationLabel",
	"upload.byteCapLabel",
	"upload.endpointUnknown",
	"upload.endpointEditLabel",
	"upload.capEditLabel",
	"upload.fieldSave",
	"upload.fieldSaved",
	"upload.endpointInvalid",
	"upload.capInvalid",
	"upload.ledger.titlesLabel",
	"upload.ledger.titlesDetail",
	"upload.ledger.columnsHint",
	"upload.saveFailed",
	"foreign.title",
	"foreign.description",
	"foreign.scan",
	"foreign.scanning",
	"foreign.scanFailed",
	"foreign.empty",
	"foreign.groupEmpty",
	"foreign.unavailable",
	"foreign.harnessError",
	"foreign.untitled",
	"foreign.cwdUnknown",
	"foreign.modelUnknown",
	"foreign.messages",
	"foreign.save",
	"foreign.send",
	"foreign.statusWaiting",
	"foreign.statusSending",
	"foreign.statusOk",
	"foreign.statusOkTruncated",
	"foreign.statusFailed",
	"foreign.statusUnknown",
	"foreign.warnTitle",
	"foreign.warnBody",
	"foreign.warnConfirm",
	"update.title",
	"update.currentVersion",
	"update.manifestUrl",
	"update.notReported",
	"update.check",
	"update.checking",
	"update.upToDate",
	"update.available",
	"update.notes",
	"update.fileCount",
	"update.checkFailed",
	"update.checkUnreadable",
	"update.upgrade",
	"update.warnTitle",
	"update.warnBody",
	"update.warnConfirm",
	"update.phaseDownloading",
	"update.phaseWriting",
	"update.done",
	"update.backupDir",
	"update.restartHint",
	"update.applyFailed",
	"update.applyErrorUnknown"
];

let passed = 0;
const failures = [];

function check(id, title, run) {
	try {
		const detail = run();
		passed++;
		console.log(`[PASS] ${id.padEnd(16)} ${title}${detail ? " — " + detail : ""}`);
	} catch (error) {
		failures.push(id);
		console.log(`[FAIL] ${id.padEnd(16)} ${title} — ${error && error.message ? error.message : String(error)}`);
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Drop comments so structural assertions cannot be satisfied (or defeated) by prose. */
function stripComments(source) {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Flatten a nested locale document into dotted keys. */
function flatten(value, prefix, out) {
	for (const key of Object.keys(value)) {
		const next = prefix === "" ? key : prefix + "." + key;
		const entry = value[key];
		if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) flatten(entry, next, out);
		else out[next] = entry;
	}
	return out;
}

function sortedKeys(object) {
	return Object.keys(object).sort();
}

/** The client half owns `upload.*`, `foreign.*` and `update.*`; `meta.*` is Host display metadata. */
function clientOnly(flat) {
	const out = {};
	for (const key of Object.keys(flat)) {
		if (key.startsWith("upload.") || key.startsWith("foreign.") || key.startsWith("update.")) out[key] = flat[key];
	}
	return out;
}

function sameSet(left, right) {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
	return true;
}

/** Extract a balanced `{...}` literal starting at the first `{` after `marker`. */
function extractObject(source, marker) {
	const start = source.indexOf(marker);
	assert(start >= 0, `marker not found: ${marker}`);
	const open = source.indexOf("{", start + marker.length);
	assert(open >= 0, `no object literal after: ${marker}`);
	let depth = 0;
	let quote = null;
	let escaped = false;
	for (let index = open; index < source.length; index++) {
		const character = source[index];
		if (quote !== null) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === quote) quote = null;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === "{") depth++;
		else if (character === "}") {
			depth--;
			if (depth === 0) return source.slice(open, index + 1);
		}
	}
	throw new Error(`unbalanced object literal after: ${marker}`);
}

const clientSource = fs.readFileSync(CLIENT_PATH, "utf8");
const pkg = readJson(PKG_PATH);
const enDocument = readJson(EN_PATH);
const zhDocument = readJson(ZH_PATH);
const enFlat = flatten(enDocument, "", {});
const zhFlat = flatten(zhDocument, "", {});

console.log(`client-check: ${CLIENT_PATH}`);
console.log("");

// 1 ─ syntax ────────────────────────────────────────────────────────────────────────────
check("syntax", "client.js parses as a classic script (node --check semantics)", () => {
	new vm.Script(clientSource, { filename: "client.js" });
	return `${clientSource.length} bytes`;
});

// 2 ─ loader id ─────────────────────────────────────────────────────────────────────────
check("loader-id", "module-loader id equals package.json name", () => {
	assert(/__ModuleLoader__\s*\.\s*load\s*\(/.test(clientSource), "no window.__ModuleLoader__.load(...) call");
	const idMatch = /__ModuleLoader__\s*\.\s*load\s*\(\s*\{\s*id\s*:\s*(["'])((?:(?!\1)[^\\])*)\1/.exec(clientSource);
	assert(idMatch !== null, "the load spec has no literal id as its first key");
	assert(idMatch[2] === pkg.name, `id "${idMatch[2]}" !== package name "${pkg.name}"`);
	assert(/factory\s*:/.test(clientSource), "the load spec has no factory");
	return `id = ${idMatch[2]}`;
});

// 3 ─ module shape ──────────────────────────────────────────────────────────────────────
const requested = [];
let moduleExports = null;

/**
 * Evaluate client.js in a fresh context and call its factory once.
 * @param requireFn - the module table to hand to the factory.
 * @param windowLike - the `window` global the module should see.
 * @param globals - extra globals for the sandbox, e.g. the page's `fetch`.
 * @returns the module exports.
 */
function instantiateFactory(requireFn, windowLike, globals) {
	const captured = [];
	const target = windowLike || {};
	if (!target.__ModuleLoader__) {
		target.__ModuleLoader__ = {
			load(spec) {
				captured.push(spec);
			}
		};
	}
	const sandbox = { console: console, window: target };
	if (globals !== undefined && globals !== null) {
		for (const key of Object.keys(globals)) sandbox[key] = globals[key];
	}
	const context = vm.createContext(sandbox);
	new vm.Script(clientSource, { filename: "client.js" }).runInContext(context);
	assert(captured.length === 1, `expected exactly 1 module registration, saw ${captured.length}`);
	assert(typeof captured[0].factory === "function", "factory is not a function");
	return captured[0].factory(requireFn);
}

function recordingRequire(specifier) {
	requested.push(specifier);
	if (specifier === "react") return {};
	throw new Error(`unavailable module: ${specifier}`);
}

check("module-shape", "factory returns { apply, inject } with the frozen inject list", () => {
	moduleExports = instantiateFactory(recordingRequire);
	assert(moduleExports !== null && typeof moduleExports === "object", "factory returned no module object");
	assert(typeof moduleExports.apply === "function", "exports.apply is not a function");
	assert(Array.isArray(moduleExports.inject), "exports.inject is not an array");
	assert(
		JSON.stringify(moduleExports.inject) === JSON.stringify(REQUIRED_INJECT),
		`inject is ${JSON.stringify(moduleExports.inject)}, expected ${JSON.stringify(REQUIRED_INJECT)}`
	);
	return `apply + inject(${moduleExports.inject.length})`;
});

// 4 ─ no host packages ──────────────────────────────────────────────────────────────────
check("no-host-packages", "no @deepseek-ai/* module and no unexpected require", () => {
	const code = stripComments(clientSource);
	assert(!code.includes("@deepseek-ai/"), "client.js loads or names @deepseek-ai/ outside a comment");
	assert(!/^\s*import\s/m.test(code), "client.js contains an import statement");
	assert(!/require\s*\(\s*["'][^"']*jsx/.test(code), "client.js loads a jsx-runtime module");
	const unexpected = requested.filter((specifier) => specifier !== "react" && specifier !== "react-dom");
	assert(unexpected.length === 0, `factory required ${JSON.stringify(unexpected)}`);
	return `required: ${requested.length === 0 ? "none" : JSON.stringify(requested)}`;
});

// 5 ─ locale keys used ──────────────────────────────────────────────────────────────────
check("locale-keys", "every t(...) key and every upload.* / foreign.* literal exists in both locale files", () => {
	const tKeys = new Set();
	const tCall = /\bt\(\s*(["'])([A-Za-z0-9_.]+)\1/g;
	for (const match of clientSource.matchAll(tCall)) {
		if (/^(?:upload|foreign|update)(\.[A-Za-z0-9]+)+$/.test(match[2])) tKeys.add(match[2]);
	}
	assert(tKeys.size > 0, "no literal t(\"upload.*\") key found");
	const literals = new Set();
	const literalPattern = /(["'])((?:(?!\1)[^\\\r\n]|\\.)*)\1/g;
	for (const match of clientSource.matchAll(literalPattern)) {
		if (/^(?:upload|foreign|update)(\.[A-Za-z0-9]+)+$/.test(match[2])) literals.add(match[2]);
	}
	const missing = [];
	for (const key of [...tKeys, ...literals].sort()) {
		if (!(key in enFlat)) missing.push(`${key} (en)`);
		if (!(key in zhFlat)) missing.push(`${key} (zh)`);
	}
	assert(missing.length === 0, `missing keys: ${missing.join(", ")}`);
	const requiredMissing = REQUIRED_KEYS.filter((key) => !(key in enFlat) || !(key in zhFlat));
	assert(requiredMissing.length === 0, `frozen keys absent: ${requiredMissing.join(", ")}`);
	return `${tKeys.size} t() keys, ${literals.size} client literals, ${REQUIRED_KEYS.length} frozen keys`;
});

// 6 ─ en/zh parity ──────────────────────────────────────────────────────────────────────
check("locale-parity", "en.json and zh.json have identical key sets", () => {
	const enKeys = sortedKeys(enFlat);
	const zhKeys = sortedKeys(zhFlat);
	assert(sameSet(enKeys, zhKeys), `only in en: ${enKeys.filter((key) => !(key in zhFlat)).join(", ")} | only in zh: ${zhKeys.filter((key) => !(key in enFlat)).join(", ")}`);
	return `${enKeys.length} keys each`;
});

// 7 ─ inline dictionary parity ──────────────────────────────────────────────────────────
check("dict-parity", "inline DICTIONARIES match both locale files exactly", () => {
	const literal = extractObject(clientSource, "const DICTIONARIES =");
	const dictionaries = JSON.parse(literal);
	for (const language of ["en", "zh"]) {
		assert(dictionaries[language] !== undefined, `DICTIONARIES.${language} is missing`);
	}
	const enInline = dictionaries.en;
	const zhInline = dictionaries.zh;
	const enClient = clientOnly(enFlat);
	const zhClient = clientOnly(zhFlat);
	assert(sameSet(sortedKeys(enInline), sortedKeys(enClient)), "inline en key set differs from locale/en.json");
	assert(sameSet(sortedKeys(zhInline), sortedKeys(zhClient)), "inline zh key set differs from locale/zh.json");
	for (const key of sortedKeys(enClient)) {
		assert(enInline[key] === enClient[key], `inline en["${key}"] differs from locale/en.json`);
	}
	for (const key of sortedKeys(zhClient)) {
		assert(zhInline[key] === zhClient[key], `inline zh["${key}"] differs from locale/zh.json`);
	}
	return `${sortedKeys(enClient).length} client keys × 2 languages in sync`;
});

// 8 ─ registration shape ────────────────────────────────────────────────────────────────
check("registration", "settings.section + settings.section.icon registration shape", () => {
	const code = stripComments(clientSource);
	assert(code.includes('name: "settings.section"'), 'no settings.section registration');
	assert(code.includes('name: "settings.section.icon"'), "no settings.section.icon registration");
	// This page hosts no general rows, so it must not declare a child slot: a second
	// declaration of the root-scoped settings.general.item list is dead weight, and a
	// rejected duplicate would make the whole page vanish.
	assert(!code.includes("children:"), "the settings.section registration declares a children slot");
	assert(!code.includes("settings.general.item"), "the section still names settings.general.item");
	assert(/order:\s*60/.test(code), "no order: 60");
	assert(clientSource.includes('const NAMESPACE = "session-log-upload"'), "namespace is not session-log-upload");
	assert(/id:\s*NAMESPACE/.test(code), "the section registration does not use the shared id");
	assert(clientSource.includes("1048576"), "no byte-cap formatting path");
	return "section + icon, no child slot, order 60";
});

// 9 ─ theme tokens only ─────────────────────────────────────────────────────────────────
check("theme-tokens", "the injected stylesheet uses no literal colour", () => {
	const start = clientSource.indexOf("const STYLES = `");
	assert(start >= 0, "no STYLES template literal");
	const opened = clientSource.indexOf("`", start);
	const closed = clientSource.indexOf("`", opened + 1);
	assert(closed > opened, "unterminated STYLES template literal");
	const styles = clientSource.slice(opened + 1, closed);
	assert(styles.length > 0, "STYLES is empty");
	const hex = styles.match(/#[0-9a-fA-F]{3,8}\b/g);
	assert(hex === null, `hex colours: ${hex ? hex.join(", ") : ""}`);
	const functional = styles.match(/\b(?:rgba?|hsla?|color-mix|oklch|lab|lch)\(/g);
	assert(functional === null, `colour functions: ${functional ? functional.join(", ") : ""}`);
	const named = new Set(["transparent", "currentcolor", "black", "white", "red", "blue", "green", "gray", "grey", "orange", "yellow", "purple", "navy", "teal", "olive", "lime", "aqua", "fuchsia", "silver", "maroon", "rebeccapurple"]);
	const offenders = [];
	for (const declaration of styles.matchAll(/[a-zA-Z-]+\s*:\s*([^;{}]+)/g)) {
		const value = declaration[1].toLowerCase();
		if (value.includes("var(")) continue;
		for (const word of value.split(/[^a-z]+/)) {
			if (named.has(word)) offenders.push(`${declaration[0].trim()}`);
		}
	}
	assert(offenders.length === 0, `named colours: ${offenders.join(" | ")}`);
	return `${styles.split("--dsw-").length - 1} theme-token references`;
});

// ── behavioural logic harness ───────────────────────────────────────────────────────────
// A deliberately small hook runtime and a stubbed Host context, so the confirm gate, the
// documented write order, and the degraded states are executed for real instead of only
// pattern-matched. This is NOT a React renderer: it re-renders the whole tree
// synchronously on every state change and runs effects after each pass. Hook rules are
// only as strict as that.
const MODE_IDS = ["off", "official-only", "deepseek-any-provider", "any-model"];

function walkNodes(node, out) {
	if (node === null || node === undefined) return out;
	if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") return out;
	if (Array.isArray(node)) {
		for (const child of node) walkNodes(child, out);
		return out;
	}
	out.push(node);
	walkNodes(node.children, out);
	return out;
}

function textOf(node) {
	if (node === null || node === undefined || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join(" ");
	return textOf(node.children);
}

function createHookRuntime() {
	const frames = new Map();
	let frame = null;
	let cursor = 0;
	let dirty = false;
	let effectQueue = [];
	let idCounter = 0;
	let tree = null;
	let root = null;
	const listeners = [];

	const Component = class Component {
		constructor(props) {
			this.props = props || {};
			this.state = {};
		}
		setState(partial) {
			this.state = Object.assign({}, this.state, partial);
			dirty = true;
		}
	};

	function frameFor(key) {
		let record = frames.get(key);
		if (record === undefined) {
			record = { slots: [], effects: new Map(), queue: [], hooks: new Map() };
			frames.set(key, record);
		}
		return record;
	}

	const React = {
		Fragment: Symbol("Fragment"),
		Component: Component,
		createElement(type, props) {
			const children = [];
			for (let index = 2; index < arguments.length; index++) children.push(arguments[index]);
			const next = {};
			if (props) for (const key of Object.keys(props)) next[key] = props[key];
			next.children = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
			return { type: type, props: next };
		},
		useState(initial) {
			const record = frame;
			const index = cursor++;
			if (!(index in record.slots)) record.slots[index] = typeof initial === "function" ? initial() : initial;
			const setter = function (value) {
				const previous = record.slots[index];
				const next = typeof value === "function" ? value(previous) : value;
				if (Object.is(previous, next)) return;
				record.slots[index] = next;
				dirty = true;
			};
			return [record.slots[index], setter];
		},
		useRef(initial) {
			const record = frame;
			const index = cursor++;
			if (!(index in record.slots)) record.slots[index] = { current: initial };
			return record.slots[index];
		},
		useId() {
			const record = frame;
			const index = cursor++;
			if (!(index in record.slots)) {
				idCounter++;
				record.slots[index] = "id-" + idCounter;
			}
			return record.slots[index];
		},
		useEffect(fn, deps) {
			const record = frame;
			const index = cursor++;
			record.queue.push({ index: index, fn: fn, deps: deps === undefined ? null : deps });
		}
	};

	function renderNode(node, key) {
		if (node === null || node === undefined || typeof node === "boolean") return null;
		if (typeof node === "string" || typeof node === "number") return node;
		if (Array.isArray(node)) return node.map(function (child, index) { return renderNode(child, key + "." + index); });
		const type = node.type;
		const props = node.props || {};
		if (type === React.Fragment) return renderNode(props.children === undefined ? null : props.children, key + ".f");
		if (typeof type === "function") {
			if (type.prototype !== undefined && typeof type.prototype.render === "function") {
				const instance = new type(props);
				return renderNode(instance.render(), key);
			}
			const record = frameFor(key);
			const previousFrame = frame;
			const previousCursor = cursor;
			frame = record;
			cursor = 0;
			record.queue = [];
			let output;
			let used = 0;
			try {
				output = type(props);
				used = cursor;
			} finally {
				frame = previousFrame;
				cursor = previousCursor;
			}
			// React's rule of hooks, enforced here so a conditional hook call cannot hide behind a
			// tolerant runtime: a component must consume the same number of hook slots on every
			// render, and the real error is "Rendered more hooks than during the previous render.".
			// Counted per component type, because a wrapper and its single child share this frame's
			// key in this runtime while React gives each element type its own fiber.
			const previousHooks = record.hooks.get(type);
			if (previousHooks !== undefined && previousHooks !== used) {
				throw new Error(previousHooks < used
					? `Rendered more hooks than during the previous render. (${previousHooks} then ${used})`
					: `Rendered fewer hooks than during the previous render. (${previousHooks} then ${used})`);
			}
			record.hooks.set(type, used);
			for (const item of record.queue) effectQueue.push({ record: record, item: item });
			return renderNode(output === undefined ? null : output, key);
		}
		const children = renderNode(props.children === undefined ? null : props.children, key + ".c");
		return { type: type, props: props, children: children };
	}

	function runEffects() {
		const queue = effectQueue;
		effectQueue = [];
		for (const entry of queue) {
			const record = entry.record;
			const index = entry.item.index;
			const deps = entry.item.deps;
			const previous = record.effects.get(index);
			if (previous !== undefined && previous.deps !== null && deps !== null) {
				let same = previous.deps.length === deps.length;
				if (same) {
					for (let position = 0; position < deps.length; position++) {
						if (!Object.is(previous.deps[position], deps[position])) {
							same = false;
							break;
						}
					}
				}
				if (same) continue;
			}
			if (previous !== undefined && typeof previous.cleanup === "function") {
				try {
					previous.cleanup();
				} catch (_error) {}
			}
			let cleanup;
			try {
				cleanup = entry.item.fn();
			} catch (error) {
				record.effects.set(index, { deps: deps, cleanup: undefined });
				throw error;
			}
			record.effects.set(index, { deps: deps, cleanup: cleanup });
		}
	}

	function flush() {
		let guard = 0;
		do {
			dirty = false;
			effectQueue = [];
			tree = renderNode(root, "root");
			runEffects();
		} while (dirty && ++guard < 100);
		return tree;
	}

	const fakeWindow = {
		addEventListener(type, fn) {
			listeners.push({ type: type, fn: fn });
		},
		removeEventListener(type, fn) {
			const index = listeners.findIndex(function (entry) { return entry.type === type && entry.fn === fn; });
			if (index >= 0) listeners.splice(index, 1);
		}
	};

	return {
		React: React,
		window: fakeWindow,
		render(element) {
			root = element;
			return flush();
		},
		flush: flush,
		tree() {
			return tree;
		},
		findAll(predicate) {
			return walkNodes(tree, []).filter(predicate);
		},
		dispatchKey(key) {
			const event = {
				key: key,
				shiftKey: false,
				defaultPrevented: false,
				stopped: false,
				preventDefault() {
					this.defaultPrevented = true;
				},
				stopPropagation() {
					this.stopped = true;
				}
			};
			for (const listener of listeners.slice()) listener.fn(event);
			return event;
		},
		listenerCount() {
			return listeners.length;
		}
	};
}

/** Apply the module against a stubbed Host context and return what it registered. */
function applyWith(sources, runtime, options) {
	const settings = options || {};
	// `setTimeout`/`clearTimeout` are browser globals the module may use for phase labels. They are
	// handed in only when a scenario supplies them, so a test can drive the timer deterministically.
	const globals = { fetch: sources.fetch };
	if (sources.setTimeout !== undefined) globals.setTimeout = sources.setTimeout;
	if (sources.clearTimeout !== undefined) globals.clearTimeout = sources.clearTimeout;
	const exportsObject = instantiateFactory(function (specifier) {
		if (specifier === "react") return runtime.React;
		// react-dom stays unavailable on purpose: this exercises the in-place dialog branch.
		throw new Error(`unavailable module: ${specifier}`);
	}, runtime.window, globals);
	const registrations = [];
	const dictionaries = {};
	const ctx = {
		effect(fn) {
			return typeof fn === "function" ? fn() : undefined;
		},
		slots: {
			inject(owner, callback) {
				return callback();
			},
			register(options, component) {
				const entry = { options: options, component: component, disposed: false };
				registrations.push(entry);
				return function () {
					entry.disposed = true;
				};
			}
		},
		locale: {
			register(namespace, dicts) {
				dictionaries[namespace] = dicts;
				return function () {};
			},
			bind(namespace) {
				return function (key) {
					const dict = dictionaries[namespace] && dictionaries[namespace].en ? dictionaries[namespace].en : {};
					return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
				};
			}
		}
	};
	if (sources.configForms !== undefined) ctx.configForms = sources.configForms;
	if (sources.remote !== undefined) ctx.remote = sources.remote;
	exportsObject.apply(ctx);
	const live = function () {
		return registrations.filter(function (entry) { return entry.disposed !== true; });
	};
	const section = live().filter(function (entry) { return entry.options.name === "settings.section"; })[0];
	const icon = live().filter(function (entry) { return entry.options.name === "settings.section.icon"; })[0];
	if (settings.allowEmpty !== true) {
		assert(section !== undefined, "apply registered no settings.section");
		assert(icon !== undefined, "apply registered no settings.section.icon");
	}
	const t = ctx.locale.bind("settings.sessionLogUpload");
	// The settings slot hands a section its own props; `useSessions` is the slot's selector hook
	// into the session store, and a section must cope with it being absent.
	const sectionProps = { t: t, close: function () {}, useSessions: sources.useSessions };
	return {
		registrations: registrations,
		live: live,
		section: section,
		icon: icon,
		t: t,
		runtime: runtime,
		tree: section === undefined ? null : runtime.render(runtime.React.createElement(section.component, sectionProps))
	};
}

/**
 * A `configForms` stub with the shipped service's semantics: `whileServed` keeps a
 * registration alive while any watched namespace is in the Describe mirror, and the mirror
 * snapshot carries the served namespaces under `view.namespaces`.
 * @param options - `{served: string[], form: object|null}`.
 */
function createConfigForms(options) {
	const served = new Set(options.served || []);
	const watchers = [];
	const form = options.form === undefined ? null : options.form;
	return {
		get(namespace) {
			return namespace === "session-log-upload" ? form : null;
		},
		describe() {
			return {
				getSnapshot() {
					return { view: { namespaces: Array.from(served, function (ns) { return { ns: ns }; }) } };
				}
			};
		},
		whileServed(namespaces, register) {
			let off;
			const sync = function () {
				const watched = namespaces.some(function (namespace) { return served.has(namespace); });
				if (watched && off === undefined) off = register(served);
				else if (!watched && off !== undefined) {
					off();
					off = undefined;
				}
			};
			watchers.push(sync);
			sync();
			return function () {
				const index = watchers.indexOf(sync);
				if (index >= 0) watchers.splice(index, 1);
				if (off !== undefined) {
					off();
					off = undefined;
				}
			};
		},
		setServed(namespaces) {
			served.clear();
			for (const namespace of namespaces) served.add(namespace);
			for (const watcher of watchers.slice()) watcher();
		}
	};
}

/**
 * A form whose snapshot a test can flip from outside, so the Describe mirror's
 * `loading` → `ready` transition can be driven for real.
 * @param initial - the first snapshot.
 */
function createForm(initial) {
	let snapshot = initial;
	const listeners = [];
	return {
		sets: [],
		getSnapshot() {
			return snapshot;
		},
		subscribe(listener) {
			listeners.push(listener);
			return function () {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		async set(field, value) {
			this.sets.push([ field, value ]);
			return true;
		},
		update(next) {
			snapshot = next;
			for (const listener of listeners.slice()) listener();
		}
	};
}

/** Every `<pre>` body in the tree, in document order. */
function preTexts(runtime) {
	return runtime.findAll(function (node) { return node.type === "pre"; }).map(textOf);
}

/** Every alert in the tree whose text is exactly the save-failure message, ignoring others. */
function saveFailureAlerts(runtime) {
	return runtime.findAll(function (node) {
		return node.props.role === "alert" && textOf(node) === "The setting could not be saved.";
	});
}

/** The two `<code>` disclosure rows, in document order: destination, then byte cap. */
function disclosureCodes(runtime) {
	return runtime.findAll(function (node) { return node.type === "code" && node.props.className === "slu-value"; }).map(textOf);
}

/** The page's byte-size wording, mirrored here so the expectations stay readable. */
function humanBytes(bytes) {
	if (bytes >= 1048576) return String(Math.round(bytes / 1048576 * 10) / 10) + " MiB";
	if (bytes >= 1024) return String(Math.round(bytes / 1024)) + " KiB";
	return String(bytes) + " bytes";
}

/**
 * Render the section against one served form value and return the two disclosure rows it
 * shows, so a test can compare the page against what the Host will actually use.
 * @param value - the served form value.
 * @param rounds - settle passes; the served form needs no async document read.
 * @returns `{destination, cap, runtime, tree}`.
 */
async function disclosedValues(value, rounds) {
	const form = createForm({ status: "ready", writable: true, revision: 1, value: value });
	const runtime = createHookRuntime();
	const scenario = applyWith({ configForms: createConfigForms({ served: [ "session-log-upload" ], form: form }) }, runtime);
	await settle(runtime, rounds);
	const codes = disclosureCodes(runtime);
	assert(codes.length === 2, `expected a destination row and a byte-cap row, saw ${codes.length}`);
	return { destination: codes[0], cap: codes[1], runtime: runtime, tree: scenario.tree };
}

/** The document-relative ledger route the page must fetch, mirroring the shipped export client. */
const LEDGER_ROUTE = "api/session-log-upload.ledger";
/** The Host default destination, used for a served form in the ledger scenarios. */
const SERVED_ENDPOINT = "https://api.deepseek.com/anthropic/v1/messages";
/** The Host default byte cap (`host/config.js` DEFAULT_MAX_BYTES): the page's fallback too. */
const DEFAULT_CAP = 20971520;

/**
 * A `fetch` stub for the ledger route, standing in for the page's own fetch.
 * Replies are consumed in order; the last one repeats, so a refresh can see new data.
 * @param replies - `{status, body}` (JSON body), `{status, text}` (raw body), `{status}`
 *   (no body), or `{reject}` (the transport itself fails).
 * @returns `{calls, fetch}`.
 */
function ledgerFetch(replies) {
	const queue = replies.slice();
	const calls = [];
	// The notice route is answered from its own queue, never from the ledger's. Both go through the
	// same page fetcher, so a URL-blind stub would let the notice read consume a ledger reply (and the
	// ledger then look "fetched twice"). `notice` defaults to "already acknowledged" so the liability
	// dialog stays out of the way of the ledger checks; pass `{ status: 404 }` to exercise it showing.
	const noticeReplies = (arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : { acknowledged: true });
	const noticeQueue = Array.isArray(noticeReplies) ? noticeReplies.slice() : [ noticeReplies ];
	const stub = function (input, init) {
		const url = typeof input === "string" ? input : String(input);
		if (url.indexOf("session-log-upload.notice") >= 0) {
			const reply = noticeQueue.length > 1 ? noticeQueue.shift() : noticeQueue[0];
			const status = typeof reply.status === "number" ? reply.status : 200;
			const hasBody = reply !== undefined && Object.prototype.hasOwnProperty.call(reply, "body") ? true : reply !== undefined && reply.acknowledged !== undefined;
			const body = reply !== undefined && reply.acknowledged !== undefined && !hasBody ? { acknowledged: reply.acknowledged } : reply.body;
			return Promise.resolve({
				ok: status >= 200 && status < 300,
				status: status,
				json: function () { return hasBody ? Promise.resolve(JSON.parse(JSON.stringify(body))) : Promise.reject(new SyntaxError("no body")); },
				text: function () { return Promise.resolve(hasBody ? JSON.stringify(body) : ""); }
			});
		}
		calls.push({ input: input, init: init });
		const reply = queue.length > 1 ? queue.shift() : queue[0];
		if (reply === undefined || reply.reject !== undefined) {
			return Promise.reject(new Error(reply === undefined ? "no reply queued" : String(reply.reject)));
		}
		const status = typeof reply.status === "number" ? reply.status : 200;
		const hasBody = Object.prototype.hasOwnProperty.call(reply, "body");
		return Promise.resolve({
			ok: status >= 200 && status < 300,
			status: status,
			json: function () {
				if (!hasBody) return Promise.reject(new SyntaxError("Unexpected token < in JSON at position 0"));
				return Promise.resolve(JSON.parse(JSON.stringify(reply.body)));
			},
			text: function () {
				return Promise.resolve(hasBody ? JSON.stringify(reply.body) : String(reply.text === undefined ? "" : reply.text));
			}
		});
	};
	return { calls: calls, fetch: stub };
}

/**
 * A form whose snapshot a write actually updates, so a field edit can be observed end to end.
 * @param initial - the initial configuration value.
 * @returns a `configForms` form stub that records and applies every `set`.
 */
function createWritableForm(initial) {
	let snapshot = { status: "ready", writable: true, revision: 1, value: initial };
	const listeners = [];
	return {
		sets: [],
		getSnapshot() {
			return snapshot;
		},
		subscribe(listener) {
			listeners.push(listener);
			return function () {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		async set(field, value) {
			this.sets.push([ field, value ]);
			snapshot = {
				...snapshot,
				revision: snapshot.revision + 1,
				value: { ...snapshot.value, [field]: value }
			};
			for (const listener of listeners.slice()) listener();
			return true;
		}
	};
}

/**
 * Render the section with a served form and one ledger `fetch` stub.
 * @param replies - replies for {@link ledgerFetch}.
 * @param options - `{mode, endpoint, maxBytes, useSessions, form}`.
 * @returns `{runtime, tree, fetch, form}`.
 */
async function ledgerScenario(replies, options) {
	const settings = options || {};
	const ledger = ledgerFetch(replies);
	const form = settings.form !== undefined ? settings.form : createWritableForm({
		mode: settings.mode === undefined ? "official-only" : settings.mode,
		endpoint: settings.endpoint === undefined ? SERVED_ENDPOINT : settings.endpoint,
		maxBytes: settings.maxBytes === undefined ? DEFAULT_CAP : settings.maxBytes
	});
	const runtime = createHookRuntime();
	applyWith({
		configForms: createConfigForms({ served: [ "session-log-upload" ], form: form }),
		fetch: ledger.fetch,
		useSessions: settings.useSessions
	}, runtime);
	await settle(runtime);
	// The ledger resolves after the first render, so the tree to assert on is the current one.
	return { runtime: runtime, tree: runtime.tree(), fetch: ledger, form: form };
}

/**
 * The slot's session-store selector hook: a plain function that applies the selector to a fixed
 * state, which is all the section may assume about it.
 * @param byId - the session store's records, keyed by session id.
 */
function sessionsHook(byId) {
	const state = { byId: byId };
	return function (selector) {
		return selector(state);
	};
}

/**
 * A `useSessions` stub shaped like the slot's own: it consumes one React hook slot per call, as a
 * snapshot-selector hook does, so the runtime's hook-order guard can see whether a row calls it on
 * every render.
 * @param React - the runtime's React; the stub must occupy a slot in its caller's frame.
 * @param byId - the session records, keyed by session id.
 */
function sessionsHookWithHooks(React, byId) {
	const state = { byId: byId };
	const hook = function (selector) {
		hook.calls++;
		React.useRef(null);
		return selector(state);
	};
	hook.calls = 0;
	return hook;
}

/** The control for one editable field: an `input` for single values, a `textarea` for lists. */
function fieldInput(runtime, field) {
	return runtime.findAll(function (node) {
		return (node.type === "input" || node.type === "textarea") && node.props["data-field"] === field;
	})[0];
}

/** The Save button for one editable field. */
function fieldSaveButton(runtime, field) {
	return runtime.findAll(function (node) { return node.type === "button" && node.props["data-field"] === field; })[0];
}

/** Type into one editable field and re-render. */
function typeInto(runtime, field, text) {
	const input = fieldInput(runtime, field);
	assert(input !== undefined, `no input for field ${field}`);
	input.props.onChange({ target: { value: text } });
	runtime.flush();
}

/** Press one editable field's Save action and re-render. */
function clickSave(runtime, field) {
	const button = fieldSaveButton(runtime, field);
	assert(button !== undefined, `no Save button for field ${field}`);
	button.props.onClick({});
	runtime.flush();
}

/** Every field state note in the tree (saved or rejected), in document order. */
function fieldStateTexts(runtime) {
	return runtime
		.findAll(function (node) {
			const cls = node.props.className;
			if (typeof cls !== "string") return false;
			return cls.indexOf("slu-fieldState") >= 0;
		})
		.map(textOf);
}

/** The "last upload failure" block, or undefined when the ledger is not ready. */
function failureBlock(runtime) {
	return runtime.findAll(function (node) { return node.props.className === "slu-ledgerFailure"; })[0];
}

/** The text of that block, or an empty string when it is not rendered. */
function failureText(runtime) {
	const block = failureBlock(runtime);
	return block === undefined ? "" : textOf(block);
}

/** The injected stylesheet text. */
function stylesheet() {
	const start = clientSource.indexOf("const STYLES = `");
	const opened = clientSource.indexOf("`", start);
	const closed = clientSource.indexOf("`", opened + 1);
	return clientSource.slice(opened + 1, closed);
}

/** The session-names toggle node. */
function sessionNamesToggle(runtime) {
	return runtime.findAll(function (node) { return node.type === "input" && node.props["data-toggle"] === "session-names"; })[0];
}

/** Flip the session-names toggle and re-render. */
function setSessionNames(runtime, checked) {
	const toggle = sessionNamesToggle(runtime);
	assert(toggle !== undefined, "no session-names toggle");
	toggle.props.onChange({ target: { checked: checked } });
	runtime.flush();
}

/**
 * The ledger's data rows, in document order.
 * @returns `[{cells, sessionId}]` — cell texts, plus the full session id kept in the id cell's `title`.
 */
function ledgerRows(runtime) {
	const rows = runtime.findAll(function (node) {
		return node.type === "tr" && walkNodes(node, []).some(function (child) { return child.type === "td"; });
	});
	return rows.map(function (row) {
		const cells = walkNodes(row, []).filter(function (node) { return node.type === "td"; });
		return { cells: cells.map(textOf), sessionId: cells.length > 0 ? cells[0].props.title : undefined };
	});
}

/**
 * The config keys of a `- id: session-log-upload` row, read out of a `cordis.patch.yml`
 * (or out of the snippet the page prints) by indentation: keys of the row's `config` block
 * sit at eight spaces, its list items at ten.
 */
function rowConfigKeys(source) {
	const lines = source.split(/\r?\n/);
	const start = lines.findIndex(function (line) { return line.trim() === "- id: session-log-upload"; });
	assert(start >= 0, `no session-log-upload row in: ${JSON.stringify(source.slice(0, 60))}`);
	const keys = [];
	for (let index = start + 1; index < lines.length; index++) {
		const line = lines[index];
		if (/^\s{0,6}-\s/.test(line)) break;
		const match = /^\s{8}([A-Za-z][A-Za-z0-9]*):/.exec(line);
		if (match !== null) keys.push(match[1]);
	}
	return keys;
}

function radios(runtime) {
	return runtime.findAll(function (node) { return node.props.role === "radio"; });
}

function checkedMode(runtime) {
	const node = runtime.findAll(function (entry) { return entry.props.role === "radio" && entry.props["aria-checked"] === true; })[0];
	return node === undefined ? null : node.props["data-mode"];
}

function clickRadio(runtime, mode) {
	const node = runtime.findAll(function (entry) { return entry.props.role === "radio" && entry.props["data-mode"] === mode; })[0];
	assert(node !== undefined, `no radio for mode ${mode}`);
	node.props.onClick({});
	runtime.flush();
}

function clickButton(runtime, label) {
	const node = runtime.findAll(function (entry) { return entry.type === "button" && textOf(entry) === label; })[0];
	assert(node !== undefined, `no button labelled "${label}"`);
	node.props.onClick({});
}

// The CONSENT dialog specifically. Both it and the liability notice carry `role="dialog"`, and these
// checks are about the consent gate, so matching on the role alone would count the notice as one.
function dialog(runtime) {
	return runtime.findAll(function (node) { return node.props.role === "dialog" && node.props["data-dialog"] === "consent"; })[0];
}

/**
 * Let queued work settle, re-rendering after each tick.
 *
 * Every host stub in this file is synchronous or microtask-async (`async` functions and
 * `Promise.resolve`), so `await null` drains them — and it matters: `setTimeout(fn, 0)` costs
 * about 15 ms in this environment, which dominated the value-by-value corpus checks.
 * @param runtime - the hook runtime.
 * @param rounds - how many drain-and-render passes; defaults to 6.
 */
async function settle(runtime, rounds) {
	const passes = typeof rounds === "number" ? rounds : 6;
	for (let index = 0; index < passes; index++) {
		await null;
		await null;
		runtime.flush();
	}
}

async function checkAsync(id, title, run) {
	try {
		const detail = await run();
		passed++;
		console.log(`[PASS] ${id.padEnd(16)} ${title}${detail ? " — " + detail : ""}`);
	} catch (error) {
		failures.push(id);
		console.log(`[FAIL] ${id.padEnd(16)} ${title} — ${error && error.message ? error.message : String(error)}`);
	}
}

// ── other-harness import: the page's half of docs/foreign-import.md ─────────────────────────
/** A JSON response shaped the way the page's own `fetch` sees one. */
function foreignResponse(status, body) {
	const payload = body === undefined ? {} : body;
	return {
		ok: status >= 200 && status < 300,
		status: status,
		json: function () { return Promise.resolve(JSON.parse(JSON.stringify(payload))); },
		text: function () { return Promise.resolve(JSON.stringify(payload)); }
	};
}

/**
 * The page fetcher stub for the other-harness block. It answers the notice and ledger reads
 * that happen on mount, the GET scan from `settings.scan`, and each POST from `settings.uploads`
 * in order. A `{defer: true}` upload reply stays pending until the test releases it, which is
 * what makes the serial loop observable instead of only its final state.
 *
 * @param settings - `{scan: {status, body}, uploads: Array<{status, body, reject, defer}>}`.
 * @returns `{calls, scanCalls, uploadCalls, controls, fetch}`.
 */
function foreignFetch(settings) {
	const options = settings || {};
	const scanReply = options.scan === undefined ? { status: 200, body: { harnesses: [] } } : options.scan;
	const uploads = Array.isArray(options.uploads) ? options.uploads.slice() : [];
	const calls = [];
	const controls = [];
	const respond = function (reply) {
		if (reply !== undefined && reply.defer === true) {
			return new Promise(function (resolve, reject) {
				controls.push({
					resolve: function (body) { resolve(foreignResponse(200, body === undefined ? { ok: true } : body)); },
					reject: function (error) { reject(error instanceof Error ? error : new Error(String(error))); }
				});
			});
		}
		if (reply !== undefined && reply.reject !== undefined) return Promise.reject(new Error(String(reply.reject)));
		const status = reply !== undefined && typeof reply.status === "number" ? reply.status : 200;
		return Promise.resolve(foreignResponse(status, reply === undefined ? {} : reply.body));
	};
	const fetchStub = function (input, init) {
		const url = typeof input === "string" ? input : String(input);
		const method = init !== null && init !== undefined && typeof init.method === "string" ? init.method : "GET";
		if (url.indexOf("session-log-upload.notice") >= 0) return Promise.resolve(foreignResponse(200, { acknowledged: true }));
		if (url.indexOf("foreign-scan") >= 0) {
			calls.push({ url: url, method: method, body: null });
			return respond(scanReply);
		}
		if (url.indexOf("foreign-upload") >= 0) {
			const body = init !== null && init !== undefined && typeof init.body === "string" ? JSON.parse(init.body) : null;
			calls.push({ url: url, method: method, body: body });
			const reply = uploads.length > 1 ? uploads.shift() : uploads[0];
			return respond(reply);
		}
		// The ledger read that happens on mount.
		return Promise.resolve(foreignResponse(200, { generatedAt: 1, directory: "C:\\l", total: 0, sessions: [] }));
	};
	return {
		calls: calls,
		get scanCalls() { return calls.filter(function (call) { return call.url.indexOf("foreign-scan") >= 0; }); },
		get uploadCalls() { return calls.filter(function (call) { return call.url.indexOf("foreign-upload") >= 0; }); },
		controls: controls,
		fetch: fetchStub
	};
}

/**
 * Render the section with a served, writable form and the fetch stub above.
 * @param settings - `{scan, uploads, savedIds, form}`.
 */
async function foreignScenario(settings) {
	const options = settings || {};
	const stub = foreignFetch(options);
	const form = options.form !== undefined ? options.form : createWritableForm({
		mode: "official-only",
		endpoint: SERVED_ENDPOINT,
		maxBytes: DEFAULT_CAP,
		foreignSessionIds: options.savedIds === undefined ? [] : options.savedIds
	});
	const runtime = createHookRuntime();
	applyWith({
		configForms: createConfigForms({ served: [ "session-log-upload" ], form: form }),
		fetch: stub.fetch
	}, runtime);
	await settle(runtime);
	return { runtime: runtime, form: form, fetch: stub };
}

/** The block's scan / save / send control. */
function foreignButton(runtime, action) {
	return runtime.findAll(function (node) { return node.type === "button" && node.props["data-foreign-action"] === action; })[0];
}

/** The scanned session checkboxes, in render order. */
function foreignRows(runtime) {
	return runtime.findAll(function (node) { return node.type === "input" && typeof node.props["data-foreign-id"] === "string"; });
}

function foreignRow(runtime, id) {
	return foreignRows(runtime).filter(function (node) { return node.props["data-foreign-id"] === id; })[0];
}

/** One row's whole rendered text. */
function foreignRowText(runtime, id) {
	const row = runtime.findAll(function (node) { return node.props["data-foreign-row"] === id; })[0];
	return row === undefined ? "" : textOf(row);
}

/** The group headings, in render order. */
function foreignGroupTitles(runtime) {
	return runtime.findAll(function (node) {
		return typeof node.props.className === "string" && node.props.className.indexOf("slu-foreignGroupTitle") >= 0;
	}).map(textOf);
}

/** The per-row status line, or "" when the row has none. */
function foreignStatusTextOf(runtime, id) {
	const node = runtime.findAll(function (node) { return node.props["data-foreign-status"] === id; })[0];
	return node === undefined ? "" : textOf(node);
}

function clickForeign(runtime, action) {
	const button = foreignButton(runtime, action);
	assert(button !== undefined, `no foreign ${action} button`);
	button.props.onClick({});
	runtime.flush();
}

function tickForeign(runtime, id, checked) {
	const box = foreignRow(runtime, id);
	assert(box !== undefined, `no foreign row ${id}`);
	box.props.onChange({ target: { checked: checked } });
	runtime.flush();
}

/** The row element (label) for one foreign conversation. */
function foreignRowLabel(runtime, id) {
	return runtime.findAll(function (node) { return typeof node.props["data-foreign-row"] === "string" && node.props["data-foreign-row"] === id; })[0];
}

/** The foreign row ids in render order. */
function foreignRowOrder(runtime) {
	return foreignRows(runtime).map(function (node) { return node.props["data-foreign-id"]; });
}

/**
 * A fetch stub for the DSH folder chooser: the session-directory scan, the notice read and the
 * detailed-log read. The scan payload is supplied by the caller.
 * @param workspaces - the `workspaces` array the scan route should answer with.
 */
function chooserFetch(workspaces) {
	return function (input) {
		const url = typeof input === "string" ? input : String(input);
		if (url.indexOf("session-log-upload.notice") >= 0) return Promise.resolve(foreignResponse(200, { acknowledged: true }));
		if (url.indexOf("session-log-upload.scan") >= 0) return Promise.resolve(foreignResponse(200, { workspaces: workspaces }));
		return Promise.resolve(foreignResponse(200, { generatedAt: 1, directory: "C:\\l", total: 0, sessions: [] }));
	};
}

/**
 * Render the section with a served, writable form and workspaces the folder chooser can list.
 * @param workspaces - the scan payload's workspaces.
 * @param config - optional `{uploadDirectories, uploadSessionIds}` initial config.
 */
async function chooserScenario(workspaces, config) {
	const settings = config || {};
	const form = createWritableForm({
		mode: "official-only",
		endpoint: SERVED_ENDPOINT,
		maxBytes: DEFAULT_CAP,
		uploadDirectories: settings.uploadDirectories === undefined ? [] : settings.uploadDirectories,
		uploadSessionIds: settings.uploadSessionIds === undefined ? [] : settings.uploadSessionIds
	});
	const runtime = createHookRuntime();
	applyWith({
		configForms: createConfigForms({ served: [ "session-log-upload" ], form: form }),
		fetch: chooserFetch(workspaces)
	}, runtime);
	await settle(runtime);
	return { runtime: runtime, form: form };
}

/** Open the folder chooser and let its scan settle. */
async function openChooser(runtime) {
	const optIn = runtime.findAll(function (node) { return node.props["data-toggle"] === "restrict-directories"; })[0];
	assert(optIn !== undefined, "the folder chooser's opt-in is missing");
	optIn.props.onChange({ target: { checked: true } });
	await settle(runtime);
}

/** One checkbox in the folder chooser, by `data-workspace` or `data-session`. */
function chooserCheckbox(runtime, kind, key) {
	const attribute = kind === "workspace" ? "data-workspace" : "data-session";
	return runtime.findAll(function (node) { return node.type === "input" && node.props[attribute] === key; })[0];
}

/** The row element for one folder-chooser entry. */
function chooserRow(runtime, kind, key) {
	const identity = kind + ":" + String(key);
	return runtime.findAll(function (node) { return node.type === "label" && node.props["data-check"] === identity; })[0];
}

/** Tick or untick one folder-chooser row and re-render. */
function toggleChooser(runtime, kind, key, checked) {
	const box = chooserCheckbox(runtime, kind, key);
	assert(box !== undefined, `no chooser checkbox ${kind} ${key}`);
	box.props.onChange({ target: { checked: checked } });
	runtime.flush();
}

/** Press the folder chooser's Save action and let both writes settle. */
async function saveChooser(runtime) {
	const button = runtime.findAll(function (node) {
		return node.type === "button" && node.props["data-field"] === "uploadDirectories";
	})[0];
	assert(button !== undefined, "the folder chooser has no Save action");
	button.props.onClick({});
	await settle(runtime);
}

/** A scan payload with one fully-populated session, one with every optional field missing, and a harness that is not installed. */
const FOREIGN_SCAN_PAYLOAD = {
	harnesses: [
		{
			harness: "zcode", label: "ZCode", available: true, error: null,
			sessions: [
				{ id: "zcode/sess_a", title: "Refactor the parser", cwd: "F:\\work\\a", createdAt: 1, updatedAt: 2, messageCount: 12, provider: "deepseek", model: "deepseek-v4", bytes: 100 },
				{ id: "zcode/sess_b", title: "", cwd: "", createdAt: 0, updatedAt: 0, messageCount: 0, provider: "", model: "", bytes: 0 }
			]
		},
		{
			harness: "cursor", label: "Cursor", available: true, error: null,
			sessions: [
				{ id: "cursor/sess_c", title: "Fix the build", cwd: "F:\\work\\c", createdAt: 3, updatedAt: 4, messageCount: 3, provider: "anthropic", model: "claude", bytes: 50 }
			]
		},
		{ harness: "workbuddy", label: "WorkBuddy", available: false, error: "not installed", sessions: [] }
	]
};

/**
 * A scan payload whose child is listed BEFORE its parent (so ordering must be done by the page),
 * with a row whose parentId names a row that is not in the payload and a row with no parentId at
 * all. The child and parent are in the same harness, which is the ZCode delegated-child shape.
 */
const FOREIGN_PARENT_PAYLOAD = {
	harnesses: [
		{
			harness: "zcode", label: "ZCode", available: true, error: null,
			sessions: [
				{ id: "zcode/sess_child", parentId: "zcode/sess_root", title: "Delegated child", cwd: "F:\\work\\a", messageCount: 4, provider: "deepseek", model: "deepseek-flash" },
				{ id: "zcode/sess_root", parentId: "", title: "Root task", cwd: "F:\\work\\a", messageCount: 10, provider: "deepseek", model: "deepseek-v4" },
				{ id: "zcode/sess_orphan", parentId: "zcode/sess_missing", title: "Orphan task", cwd: "F:\\work\\b", messageCount: 2, provider: "deepseek", model: "deepseek-flash" },
				{ id: "zcode/sess_plain", title: "No lineage reported", cwd: "F:\\work\\c", messageCount: 1, provider: "deepseek", model: "deepseek-flash" }
			]
		}
	]
};

/**
 * A lineage tree for the cascade check: root -> child1 -> grandchild, and root -> child2. The
 * payload order is deliberately scrambled (grandchild first) so the expansion cannot rely on it.
 */
const FOREIGN_TREE_PAYLOAD = {
	harnesses: [
		{
			harness: "zcode", label: "ZCode", available: true, error: null,
			sessions: [
				{ id: "zcode/sess_grand", parentId: "zcode/sess_child1", title: "Grandchild task", cwd: "F:\\work\\a", messageCount: 2, provider: "deepseek", model: "deepseek-flash" },
				{ id: "zcode/sess_root", parentId: "", title: "Root task", cwd: "F:\\work\\a", messageCount: 10, provider: "deepseek", model: "deepseek-v4" },
				{ id: "zcode/sess_child1", parentId: "zcode/sess_root", title: "First child", cwd: "F:\\work\\a", messageCount: 4, provider: "deepseek", model: "deepseek-flash" },
				{ id: "zcode/sess_child2", parentId: "zcode/sess_root", title: "Second child", cwd: "F:\\work\\b", messageCount: 3, provider: "deepseek", model: "deepseek-flash" }
			]
		}
	]
};

/** The workspaces the folder-chooser scenarios list. */
const CHOOSER_WORKSPACES = [
	{ id: "w1", path: "F:\\work\\one", title: "One", sessions: [ { id: "s1", title: "First session" }, { id: "s2", title: "Second session" } ] },
	{ id: "w2", path: "F:\\work\\two", title: "Two", sessions: [ { id: "s3", title: "Third session" } ] }
];

// ── plugin self-update (docs/update.md) ────────────────────────────────────────────────────
/** A check payload that says an update is available. */
const UPDATE_AVAILABLE = {
	status: 200,
	body: {
		ok: true, current: "1.0.0", latest: "1.2.0", available: true,
		notes: "Adds the in-app update block",
		manifestUrl: "https://example.test/update-manifest.json",
		source: "primary",
		files: [
			{ path: "index.js", bytes: 10, sha256: "a".repeat(64) },
			{ path: "client.js", bytes: 20, sha256: "b".repeat(64) }
		],
		error: null
	}
};

/** A check payload that says the install is already current. */
const UPDATE_LATEST = {
	status: 200,
	body: {
		ok: true, current: "1.2.0", latest: "1.2.0", available: false,
		notes: "", manifestUrl: "https://example.test/update-manifest.json",
		source: "primary", files: [], error: null
	}
};

/** A check payload in which the Host could not read the manifest. */
const UPDATE_CHECK_ERROR = {
	status: 200,
	body: {
		ok: false, current: "1.0.0", latest: null, available: false,
		notes: "", manifestUrl: "https://example.test/update-manifest.json",
		source: "primary", files: [], error: "manifest unreachable"
	}
};

/** A successful apply payload. */
const UPDATE_APPLY_OK = {
	ok: true, from: "1.0.0", to: "1.2.0", files: [ "index.js", "client.js" ],
	backupDir: "C:\\plugins\\session-log-upload\\.update-backup-1.0.0-1700000000000",
	reload: "restart-required", error: null
};

/**
 * The page fetcher stub for the update block. Notice and ledger are answered so the mount reads
 * stay out of the way; each GET update-check consumes one queued reply; update-apply uses the
 * `apply` reply, and `{defer:true}` keeps it pending for the test to release.
 * @param settings - `{checks: replies[], apply: reply}`.
 */
function updateFetch(settings) {
	const options = settings || {};
	const checks = Array.isArray(options.checks) ? options.checks.slice() : [];
	const applyReply = options.apply === undefined ? { status: 200, body: UPDATE_APPLY_OK } : options.apply;
	const calls = [];
	const controls = [];
	const respond = function (reply) {
		if (reply !== undefined && reply.defer === true) {
			return new Promise(function (resolve, reject) {
				controls.push({
					resolve: function (body) { resolve(foreignResponse(200, body === undefined ? UPDATE_APPLY_OK : body)); },
					reject: function (error) { reject(error instanceof Error ? error : new Error(String(error))); }
				});
			});
		}
		if (reply !== undefined && reply.reject !== undefined) return Promise.reject(new Error(String(reply.reject)));
		const status = reply !== undefined && typeof reply.status === "number" ? reply.status : 200;
		return Promise.resolve(foreignResponse(status, reply === undefined ? {} : reply.body));
	};
	const stub = function (input, init) {
		const url = typeof input === "string" ? input : String(input);
		const method = init !== null && init !== undefined && typeof init.method === "string" ? init.method : "GET";
		if (url.indexOf("session-log-upload.notice") >= 0) return Promise.resolve(foreignResponse(200, { acknowledged: true }));
		if (url.indexOf("update-check") >= 0) {
			calls.push({ url: url, method: method, body: null });
			const reply = checks.length > 1 ? checks.shift() : checks[0];
			return respond(reply);
		}
		if (url.indexOf("update-apply") >= 0) {
			const body = init !== null && init !== undefined && typeof init.body === "string" ? init.body : null;
			calls.push({ url: url, method: method, body: body });
			return respond(applyReply);
		}
		return Promise.resolve(foreignResponse(200, { generatedAt: 1, directory: "C:\\l", total: 0, sessions: [] }));
	};
	return {
		calls: calls,
		get checkCalls() { return calls.filter(function (call) { return call.url.indexOf("update-check") >= 0; }); },
		get applyCalls() { return calls.filter(function (call) { return call.url.indexOf("update-apply") >= 0; }); },
		controls: controls,
		fetch: stub
	};
}

/**
 * Render the section with a served, writable form and the update fetch stub.
 * A deterministic clock is supplied when `fakeTimer` is set, so a test can fire the phase timer by
 * hand instead of waiting on wall time.
 * @param settings - `{checks, apply, fakeTimer}`.
 */
async function updateScenario(settings) {
	const options = settings || {};
	const stub = updateFetch(options);
	const form = createWritableForm({
		mode: "official-only",
		endpoint: SERVED_ENDPOINT,
		maxBytes: DEFAULT_CAP,
		uploadDirectories: [],
		uploadSessionIds: [],
		foreignSessionIds: []
	});
	const timers = [];
	const sources = {
		configForms: createConfigForms({ served: [ "session-log-upload" ], form: form }),
		fetch: stub.fetch
	};
	if (options.fakeTimer === true) {
		sources.setTimeout = function (fn) {
			timers.push(fn);
			return timers.length;
		};
		sources.clearTimeout = function (id) {
			timers[id - 1] = null;
		};
	}
	const runtime = createHookRuntime();
	applyWith(sources, runtime);
	await settle(runtime);
	return { runtime: runtime, form: form, fetch: stub, timers: timers };
}

/** The update block's display value for one field. */
function updateValue(runtime, field) {
	const node = runtime.findAll(function (node) { return node.props["data-update-field"] === field; })[0];
	return node === undefined ? undefined : textOf(node);
}

/** The update block's check / upgrade action. */
function updateButton(runtime, action) {
	return runtime.findAll(function (node) { return node.type === "button" && node.props["data-update-action"] === action; })[0];
}

/** The update block's rendered text. */
function updateText(runtime) {
	const node = runtime.findAll(function (node) { return typeof node.props.className === "string" && node.props.className.indexOf("slu-update") >= 0 && node.type === "div"; })[0];
	return node === undefined ? "" : textOf(node);
}

// 10 ─ registration + degraded render ───────────────────────────────────────────────────
await checkAsync("render-fallback", "no served form: controls disabled, no bare save error, manual route last", async () => {
	const runtime = createHookRuntime();
	const scenario = applyWith({}, runtime);
	const options = scenario.section.options;
	assert(options.id === "session-log-upload", "section id is not session-log-upload");
	assert(options.order === 60, `section order is ${options.order}`);
	assert(options.locale === "settings.sessionLogUpload", "section locale namespace wrong");
	assert(options.children === undefined, `the section still declares a child slot: ${JSON.stringify(options.children)}`);
	assert(typeof options.label === "function", "label is not a thunk");
	const label = options.label();
	assert(label === "Session log upload", `label thunk returned ${JSON.stringify(label)} (locale not wired?)`);
	assert(scenario.icon.options.name === "settings.section.icon" && scenario.icon.options.id === "session-log-upload", "icon registration does not match the section id");
	assert(scenario.registrations.length === 2, `apply registered ${scenario.registrations.length} entries, expected 2`);

	const found = radios(runtime);
	assert(found.length === 4, `rendered ${found.length} radios, expected 4`);
	assert(found.map(function (node) { return node.props["data-mode"]; }).join(",") === MODE_IDS.join(","), "radio order is not the frozen mode order");
	assert(found.every(function (node) { return node.props["aria-checked"] === false; }), "a radio is checked although the Host reported no mode");
	assert(found.every(function (node) { return node.props.disabled === true; }), "a radio is clickable although the Host serves no form");
	assert(found.every(function (node) { return node.props["aria-disabled"] === "true"; }), "a disabled radio is not marked disabled");
	assert(runtime.findAll(function (node) { return node.props.role === "radiogroup"; }).length === 1, "no radiogroup");
	const group = runtime.findAll(function (node) { return node.props.role === "radiogroup"; })[0];
	const labelledBy = group.props["aria-labelledby"];
	assert(typeof labelledBy === "string" && runtime.findAll(function (node) { return node.props.id === labelledBy; }).length === 1, "radiogroup aria-labelledby does not resolve");
	const text = textOf(scenario.tree);
	assert(text.includes("The Host has not reported the current mode."), "the Host's silence is not explained");
	assert(text.includes("Set the mode by hand"), "manual fallback missing when nothing can write");
	assert(text.includes("cordis.patch.yml"), "patch snippet label missing");
	assert(text.includes("/session-log-upload official-only"), "slash command missing");
	// The manual route is a collapsed disclosure, not the headline: revealing the raw row
	// takes a deliberate second click.
	const disclosure = runtime.findAll(function (node) { return node.type === "details"; })[0];
	assert(disclosure !== undefined, "the manual route is not a disclosure");
	assert(textOf(disclosure).includes("Set the mode by hand"), "the disclosure has no summary");

	// A click the browser cannot make (the control is disabled) must never be reported as a
	// save failure: there is no write path at all, and "could not be saved" is not the reason.
	clickRadio(runtime, "off");
	await settle(runtime);
	assert(saveFailureAlerts(runtime).length === 0, "a bare save failure was shown although there is no write path");
	assert(textOf(runtime.tree()).includes("The Host has not reported the current mode."), "the not-served explanation disappeared after a click");
	assert(runtime.findAll(function (node) { return node.props.role === "dialog" && node.props["data-dialog"] === "consent"; }).length === 0, "off must never open the confirm dialog");
	return "2 registrations, 4 disabled radios, not-served explanation, collapsed manual route";
});

// 11 ─ remote write path + confirm gate ─────────────────────────────────────────────────
await checkAsync("confirm-gate", "remote-only path: the gate holds and the page does not claim to be live", async () => {
	const writes = [];
	const endpoint = "https://api.deepseek.com/anthropic/v1/messages";
	const settings = {
		describe: async function () {
			return {
				ok: true,
				value: [
					{ ns: "session-log-upload", revision: 7, value: { mode: "official-only", endpoint: endpoint, maxBytes: 8388608 } }
				]
			};
		},
		mutate: async function (ns, ops, revision) {
			writes.push({ ns: ns, ops: ops, revision: revision });
			return { ok: true, value: {} };
		}
	};
	const runtime = createHookRuntime();
	const scenario = applyWith({ remote: { settings: settings } }, runtime);
	await settle(runtime);

	assert(checkedMode(runtime) === "official-only", `initial checked mode is ${checkedMode(runtime)}`);
	assert(textOf(runtime.tree()).includes(endpoint), "destination endpoint not shown");
	assert(textOf(runtime.tree()).includes("8 MiB"), "byte cap not shown");
	// The remote alone no longer makes the page look live: the Host serves no form for the
	// namespace, so the controls are marked and the manual route is visible — while the
	// write path itself, and the consent gate around it, is exercised below.
	assert(radios(runtime).every(function (node) { return node.props.disabled === true; }), "the controls claim to be live although no form is served");
	assert(textOf(runtime.tree()).includes("Set the mode by hand"), "the manual route is hidden although no form is served");

	clickRadio(runtime, "any-model");
	assert(writes.length === 0, "the mode was written before confirmation");
	const opened = dialog(runtime);
	assert(opened !== undefined, "no dialog for any-model");
	assert(opened.props["aria-modal"] === "true", "dialog is not aria-modal");
	assert(typeof opened.props["aria-labelledby"] === "string", "dialog has no accessible name");
	const dialogText = textOf(opened);
	assert(dialogText.includes("other model providers"), "the dialog does not name other providers");
	assert(dialogText.includes(endpoint), "the dialog does not name the endpoint");
	assert(dialogText.includes("Enable upload") && dialogText.includes("Cancel"), "the dialog does not offer Cancel / Enable");

	const escape = runtime.dispatchKey("Escape");
	runtime.flush();
	assert(escape.defaultPrevented === true, "Escape was not handled");
	assert(escape.stopped === true, "Escape was not stopped before the settings panel could see it");
	assert(dialog(runtime) === undefined, "Escape did not close the dialog");
	assert(writes.length === 0, "Escape confirmed the write");

	clickRadio(runtime, "any-model");
	clickButton(runtime, "Enable upload");
	runtime.flush();
	await settle(runtime);
	assert(writes.length === 1, `expected 1 write after confirming, saw ${writes.length}`);
	assert(writes[0].ns === "session-log-upload", `mutated namespace ${writes[0].ns}`);
	assert(JSON.stringify(writes[0].ops) === JSON.stringify([{ op: "set", path: ["mode"], value: "any-model" }]), `ops are ${JSON.stringify(writes[0].ops)}`);
	assert(writes[0].revision === 7, `revision is ${writes[0].revision}, expected 7 from describe()`);
	assert(checkedMode(runtime) === "any-model", `the section still shows ${checkedMode(runtime)} after a committed write`);
	assert(dialog(runtime) === undefined, "the dialog stayed open after confirming");
	return "dialog + Escape-cancel + confirmed write with revision";
});

// 12 ─ served config form path ──────────────────────────────────────────────────────────
await checkAsync("form-path", "served form: off/official-only commit with no dialog", async () => {
	const sets = [];
	const subscribers = [];
	let snapshot = {
		status: "ready",
		writable: true,
		revision: 3,
		value: { mode: "deepseek-any-provider", endpoint: "https://api.deepseek.com/anthropic/v1/messages", maxBytes: 4194304 }
	};
	const form = {
		getSnapshot() {
			return snapshot;
		},
		subscribe(listener) {
			subscribers.push(listener);
			return function () {
				const index = subscribers.indexOf(listener);
				if (index >= 0) subscribers.splice(index, 1);
			};
		},
		async set(field, value) {
			sets.push({ field: field, value: value });
			snapshot = Object.assign({}, snapshot, { revision: snapshot.revision + 1, value: Object.assign({}, snapshot.value, { mode: value }) });
			for (const listener of subscribers.slice()) listener();
			return true;
		}
	};
	const runtime = createHookRuntime();
	applyWith({ configForms: { get: function (ns) { return ns === "session-log-upload" ? form : null; } } }, runtime);
	await settle(runtime);

	assert(checkedMode(runtime) === "deepseek-any-provider", `initial checked mode is ${checkedMode(runtime)}`);
	assert(textOf(runtime.tree()).includes("4 MiB"), "byte cap from the form is not shown");
	assert(!textOf(runtime.tree()).includes("Set the mode by hand"), "manual fallback shown although the form is served and writable");

	clickRadio(runtime, "off");
	runtime.flush();
	assert(dialog(runtime) === undefined, "off opened the confirm dialog");
	await settle(runtime);
	assert(sets.length === 1 && sets[0].field === "mode" && sets[0].value === "off", `form.set calls: ${JSON.stringify(sets)}`);
	assert(checkedMode(runtime) === "off", `the form snapshot is not reflected: ${checkedMode(runtime)}`);

	clickRadio(runtime, "deepseek-any-provider");
	assert(dialog(runtime) !== undefined, "a wide mode did not ask for confirmation on the form path");
	assert(sets.length === 1, "the form was written before confirmation");
	clickButton(runtime, "Enable upload");
	await settle(runtime);
	assert(sets.length === 2 && sets[1].value === "deepseek-any-provider", `form.set calls after confirming: ${JSON.stringify(sets)}`);
	return "form.set path, no dialog for off, dialog for wide modes";
});

// 14 ─ whileServed: the page follows the Describe mirror ────────────────────────────────
await checkAsync("while-served", "the page exists only while the Host serves the namespace", async () => {
	const forms = createConfigForms({ served: [], form: createForm({ status: "loading", writable: false }) });
	const runtime = createHookRuntime();
	const scenario = applyWith({ configForms: forms }, runtime, { allowEmpty: true });
	assert(scenario.registrations.length === 0, `registered ${scenario.registrations.length} entries although the Host serves no namespace`);

	forms.setServed([ "session-log-upload" ]);
	assert(scenario.live().length === 2, `expected section + icon once served, saw ${scenario.live().length}`);
	const section = scenario.live().filter(function (entry) { return entry.options.name === "settings.section"; })[0];
	assert(section !== undefined, "no settings.section once the namespace is served");
	runtime.render(runtime.React.createElement(section.component, { t: scenario.t }));
	await settle(runtime);
	assert(radios(runtime).length === 4, "the page did not render after the namespace appeared");

	forms.setServed([]);
	assert(scenario.live().length === 0, `the page outlived the namespace: ${scenario.live().length} live registrations`);
	return "0 → 2 → 0 live registrations across the mirror";
});

// 15 ─ honest state, then preselection once the form is ready ───────────────────────────
await checkAsync("form-not-ready", "a form that is not ready is reported, and the served mode is preselected later", async () => {
	const endpoint = "https://api.deepseek.com/anthropic/v1/messages";
	const form = createForm({ status: "loading", writable: false, value: undefined });
	const runtime = createHookRuntime();
	const scenario = applyWith({ configForms: createConfigForms({ served: [ "session-log-upload" ], form: form }) }, runtime);
	await settle(runtime);

	assert(radios(runtime).length === 4, "no radios");
	assert(radios(runtime).every(function (node) { return node.props.disabled === true; }), "a radio is enabled before the Host reported a value");
	assert(checkedMode(runtime) === null, `a mode is checked although the Host reported none: ${checkedMode(runtime)}`);
	assert(textOf(scenario.tree).includes("The Host has not reported the current mode."), "no not-served explanation");
	assert(form.sets.length === 0, "the page wrote before the Host served a value");

	clickRadio(runtime, "off");
	await settle(runtime);
	assert(form.sets.length === 0, "a write was attempted while the form was not ready");
	assert(saveFailureAlerts(runtime).length === 0, "a bare save failure was shown while the form was not ready");

	form.update({ status: "ready", writable: true, revision: 5, value: { mode: "official-only", endpoint: endpoint, maxBytes: 8388608 } });
	await settle(runtime);
	assert(checkedMode(runtime) === "official-only", `the served mode is not preselected: ${checkedMode(runtime)}`);
	assert(radios(runtime).every(function (node) { return node.props.disabled !== true; }), "the controls stayed disabled after the form became ready");
	assert(!textOf(runtime.tree()).includes("Set the mode by hand"), "the manual route is still shown although the form is served and writable");
	assert(textOf(runtime.tree()).includes(endpoint), "the served endpoint is not shown");
	assert(textOf(runtime.tree()).includes("8 MiB"), "the served byte cap is not shown");

	clickRadio(runtime, "any-model");
	assert(dialog(runtime) !== undefined, "a wide mode did not open the dialog on the served path");
	assert(form.sets.length === 0, "the write happened before confirmation");
	clickButton(runtime, "Enable upload");
	await settle(runtime);
	assert(form.sets.length === 1 && form.sets[0][0] === "mode" && form.sets[0][1] === "any-model", `form.set calls: ${JSON.stringify(form.sets)}`);
	return "not-ready reported, then preselected and gated on the served form";
});

// 16 ─ a volatile schema field arrives as a live reference ──────────────────────────────
await checkAsync("volatile-value", "a volatile field reference is unwrapped for the mode and the cap", async () => {
	const form = createForm({
		status: "ready",
		writable: true,
		revision: 2,
		value: {
			mode: { get: function () { return "deepseek-any-provider"; } },
			endpoint: { get: function () { return "https://api.deepseek.com/anthropic/v1/messages"; } },
			maxBytes: { get: function () { return 4194304; } }
		}
	});
	const runtime = createHookRuntime();
	const scenario = applyWith({ configForms: createConfigForms({ served: [ "session-log-upload" ], form: form }) }, runtime);
	await settle(runtime);
	assert(checkedMode(runtime) === "deepseek-any-provider", `the volatile mode was not read: ${checkedMode(runtime)}`);
	assert(textOf(scenario.tree).includes("4 MiB"), "the volatile byte cap was not read");
	assert(radios(runtime).every(function (node) { return node.props.disabled !== true; }), "a served form left the controls disabled");
	return "volatile references unwrapped";
});

// 17 ─ a refused write is still a save failure ──────────────────────────────────────────
await checkAsync("write-refused", "a refused write still surfaces upload.saveFailed", async () => {
	const form = createForm({ status: "ready", writable: true, revision: 9, value: { mode: "official-only", endpoint: "https://api.deepseek.com/anthropic/v1/messages", maxBytes: 8388608 } });
	form.set = async function (field, value) {
		this.sets.push([ field, value ]);
		return false;
	};
	const runtime = createHookRuntime();
	applyWith({ configForms: createConfigForms({ served: [ "session-log-upload" ], form: form }) }, runtime);
	await settle(runtime);
	clickRadio(runtime, "off");
	await settle(runtime);
	assert(form.sets.length === 1 && form.sets[0][1] === "off", `the form was not asked to write: ${JSON.stringify(form.sets)}`);
	const alerts = saveFailureAlerts(runtime);
	assert(alerts.length === 1, `a refused write produced ${alerts.length} alerts`);
	assert(textOf(alerts[0]) === "The setting could not be saved.", `the alert is not the localized save failure: ${JSON.stringify(textOf(alerts[0]))}`);
	assert(preTexts(runtime)[0].includes("mode: off"), "the fallback snippet does not show the refused mode");
	return "refused write → saveFailed, never a silent success";
});

// 18 ─ the manual snippet is this profile's own row ─────────────────────────────────────
await checkAsync("patch-snippet", "the manual snippet reproduces the profile's actual row, key for key", async () => {
	const runtime = createHookRuntime();
	applyWith({}, runtime);
	clickRadio(runtime, "off");
	await settle(runtime);
	const blocks = preTexts(runtime);
	const snippet = blocks[0];
	const command = blocks[1];
	assert(typeof snippet === "string" && snippet.length > 0, "no patch snippet was rendered");
	assert(snippet.includes("- id: session-log-upload"), "the snippet names another row id");
	assert(snippet.includes("name: '@local/dsh-session-log-upload'"), "the snippet names another package");
	assert(/^ {8}mode: off$/m.test(snippet), `the snippet does not carry the selected mode: ${JSON.stringify(snippet)}`);
	assert(command === "/session-log-upload off", `the command block is ${JSON.stringify(command)}`);
	const profileKeys = rowConfigKeys(fs.readFileSync(path.join(ROOT, "cordis.patch.yml"), "utf8"));
	const snippetKeys = rowConfigKeys(snippet);
	assert(profileKeys.length === 6, `the profile row declares ${profileKeys.length} config keys, expected 6`);
	assert(JSON.stringify(snippetKeys) === JSON.stringify(profileKeys), `snippet keys ${JSON.stringify(snippetKeys)} !== profile row keys ${JSON.stringify(profileKeys)}`);
	return `snippet matches the row: ${snippetKeys.join(", ")}`;
});

// 19 ─ no current-session pending range; the ledger's own range is a different field ─────
// Retargeted (task-17): this check used to ban every watermark field, because the page had no
// legitimate source for a session's `afterSeq`. The upload ledger now legitimately carries one
// per session, so the invariant is narrower: no `upload.pending*` keys anywhere, no pending-range
// helper or un-uploaded-range end (`throughSeq`), no pending-range row — while the ledger's
// per-session `afterSeq` is read and shown.
await checkAsync("no-pending-row", "no current-session pending range survives; the ledger's own range does", async () => {
	const enPending = Object.keys(enFlat).filter(function (key) { return key.startsWith("upload.pending"); });
	assert(enPending.length === 0, `locale/en.json still declares ${enPending.join(", ")}`);
	const zhPending = Object.keys(zhFlat).filter(function (key) { return key.startsWith("upload.pending"); });
	assert(zhPending.length === 0, `locale/zh.json still declares ${zhPending.join(", ")}`);
	const inline = JSON.parse(extractObject(clientSource, "const DICTIONARIES ="));
	for (const language of ["en", "zh"]) {
		const leftover = Object.keys(inline[language]).filter(function (key) { return key.startsWith("upload.pending"); });
		assert(leftover.length === 0, `the inline ${language} dictionary still declares ${leftover.join(", ")}`);
	}
	const code = stripComments(clientSource);
	assert(!/upload\.pending/.test(clientSource), "client.js still names an upload.pending* key");
	assert(!/pickPending/.test(code), "client.js still carries a pending-range helper");
	assert(!/throughSeq/.test(code), "client.js still tracks an un-uploaded range end");
	assert(/afterSeq/.test(code), "client.js no longer reads the ledger's per-session afterSeq");

	// The page that cannot read the ledger shows no range row at all.
	const runtime = createHookRuntime();
	const scenario = applyWith({}, runtime);
	const text = textOf(scenario.tree);
	assert(!/Pending range/.test(text), "the rendered page still has a pending-range row");
	assert(text.includes("Destination"), "the destination row is missing");
	assert(text.includes("Byte cap per request"), "the byte-cap row is missing");

	// The ledger's range is the per-session *uploaded-through* position, one row per session.
	const ledger = await ledgerScenario([ {
		status: 200,
		body: {
			total: 1,
			directory: "D:\\ledger",
			sessions: [ { sessionId: "session-167fda32-2ed2-4c3d-b5fa-5e63650f9c63", afterSeq: 1409, sessionFormatVersion: 4, updatedAt: 1794407548140 } ]
		}
	} ]);
	const ledgerText = textOf(ledger.runtime.tree());
	assert(ledgerText.includes("Uploaded through"), "the ledger's per-session range column is missing");
	assert(ledgerText.includes("1409"), "the ledger's afterSeq is not shown");
	assert(!/Pending range/.test(ledgerText), "a pending-range row reappeared next to the ledger");
	return "no upload.pending* key, no throughSeq, no pending row; the ledger's afterSeq is the only range";
});

// 20 ─ the served destination and cap are shown as themselves ───────────────────────────
await checkAsync("served-figures", "the served endpoint and byte cap are shown, cap as a human size", async () => {
	const endpoint = "https://api.deepseek.com/anthropic/v1/messages";
	const form = createForm({
		status: "ready",
		writable: true,
		revision: 8,
		value: {
			mode: { get: function () { return "official-only"; } },
			endpoint: { get: function () { return endpoint; } },
			maxBytes: { get: function () { return 8388608; } }
		}
	});
	const runtime = createHookRuntime();
	const scenario = applyWith({ configForms: createConfigForms({ served: [ "session-log-upload" ], form: form }) }, runtime);
	await settle(runtime);
	const text = textOf(scenario.tree);
	assert(checkedMode(runtime) === "official-only", `mode not preselected from the volatile reference: ${checkedMode(runtime)}`);
	assert(text.includes(endpoint), "the served destination is not shown");
	assert(text.includes("8 MiB"), `the byte cap is not rendered as a human size: ${JSON.stringify(text)}`);
	assert(!text.includes("8388608"), "the raw byte count is on the page");
	const figures = disclosureCodes(runtime);
	assert(figures.join(" | ").indexOf("Not reported by the Host") < 0, "a served value still renders as unreported");
	return "volatile endpoint + 8 MiB cap rendered, no raw bytes";
});

// 21 ─ the display mirrors the Host's narrowing ─────────────────────────────────────────
// The wire reports the STORED value; the Host narrows it before use. A row that showed the
// stored value would name a destination the plugin never posts to (finding A1).
await checkAsync("display-narrowing", "the page shows the endpoint and cap the Host will actually use", async () => {
	const fallbackUrl = "https://api.deepseek.com/anthropic/v1/messages";
	const endpoints = [
		[ "https://api.deepseek.com/anthropic/v1/messages", "https://api.deepseek.com/anthropic/v1/messages" ],
		[ "http://127.0.0.1:8080/ingest", "http://127.0.0.1:8080/ingest" ],
		[ "HTTPS://API.EXAMPLE/x", "HTTPS://API.EXAMPLE/x" ],
		[ "Https://mixed.Case/v1", "Https://mixed.Case/v1" ],
		[ "http://", "http://" ],
		[ "https://x", "https://x" ],
		[ "https://trailing.space ", "https://trailing.space " ],
		[ "file:///etc/passwd", fallbackUrl ],
		[ "file://C:/Windows/win.ini", fallbackUrl ],
		[ "javascript:alert(1)", fallbackUrl ],
		[ "data:text/plain,leak", fallbackUrl ],
		[ "ftp://x/y", fallbackUrl ],
		[ "ws://x/y", fallbackUrl ],
		[ "//evil.example/x", fallbackUrl ],
		[ "/relative/path", fallbackUrl ],
		[ "./x", fallbackUrl ],
		[ "relative/path", fallbackUrl ],
		[ "https:/evil.example", fallbackUrl ],
		[ "https:evil.example", fallbackUrl ],
		[ "http:", fallbackUrl ],
		[ "https", fallbackUrl ],
		[ "", fallbackUrl ],
		[ "   ", fallbackUrl ],
		[ " https://leading.space", fallbackUrl ],
		[ 42, fallbackUrl ],
		[ null, fallbackUrl ],
		[ true, fallbackUrl ],
		[ [ "https://ok" ], fallbackUrl ],
		[ { href: "https://ok" }, fallbackUrl ],
		[ { get: function () { return "file:///etc/passwd"; } }, fallbackUrl ],
		[ undefined, fallbackUrl ]
	];
	for (const [ value, expected ] of endpoints) {
		const shown = await disclosedValues({ mode: "official-only", endpoint: value, maxBytes: 8388608 }, 3);
		assert(shown.destination === expected, `endpoint ${JSON.stringify(value)} shown as ${JSON.stringify(shown.destination)}, expected ${JSON.stringify(expected)}`);
	}

	const caps = [
		[ 8388608, humanBytes(8388608) ],
		[ 4194304, humanBytes(4194304) ],
		[ 1024, humanBytes(1024) ],
		[ 1, humanBytes(1) ],
		[ Number.MAX_SAFE_INTEGER, humanBytes(Number.MAX_SAFE_INTEGER) ],
		[ Number.MAX_SAFE_INTEGER + 1, humanBytes(DEFAULT_CAP) ],
		[ 2 ** 53, humanBytes(DEFAULT_CAP) ],
		[ 2 ** 53 + 2, humanBytes(DEFAULT_CAP) ],
		[ 1e21, humanBytes(DEFAULT_CAP) ],
		[ Number.MAX_VALUE, humanBytes(DEFAULT_CAP) ],
		[ 0, humanBytes(DEFAULT_CAP) ],
		[ -1, humanBytes(DEFAULT_CAP) ],
		[ 1.5, humanBytes(DEFAULT_CAP) ],
		[ 2.5, humanBytes(DEFAULT_CAP) ],
		[ NaN, humanBytes(DEFAULT_CAP) ],
		[ Infinity, humanBytes(DEFAULT_CAP) ],
		[ -Infinity, humanBytes(DEFAULT_CAP) ],
		[ "1024", humanBytes(DEFAULT_CAP) ],
		[ "8388608", humanBytes(DEFAULT_CAP) ],
		[ null, humanBytes(DEFAULT_CAP) ],
		[ true, humanBytes(DEFAULT_CAP) ],
		[ {}, humanBytes(DEFAULT_CAP) ],
		[ [], humanBytes(DEFAULT_CAP) ],
		[ undefined, humanBytes(DEFAULT_CAP) ],
		[ { get: function () { return 4194304; } }, humanBytes(4194304) ],
		[ { get: function () { return 1e21; } }, humanBytes(DEFAULT_CAP) ]
	];
	for (const [ value, expected ] of caps) {
		const shown = await disclosedValues({ mode: "official-only", endpoint: fallbackUrl, maxBytes: value }, 3);
		assert(shown.cap === expected, `maxBytes ${String(value)} shown as ${JSON.stringify(shown.cap)}, expected ${JSON.stringify(expected)}`);
	}
	return `${endpoints.length} endpoint and ${caps.length} cap values narrowed`;
});

// 22 ─ agreement with the Host's own rule, executed ─────────────────────────────────────
// The Host module is the authority on what will be used, so it is imported and driven here
// rather than the rule being copied into this test. Any input where display != used fails.
await checkAsync("host-agreement", "display == what host/config.js resolves, over a hostile corpus", async () => {
	let host;
	let transport;
	try {
		host = await import("../host/config.js");
		transport = await import("../host/upload.js");
	} catch (error) {
		assert(false, `the Host narrowing rule could not be imported: ${error && error.message ? error.message : String(error)}`);
	}

	const HOSTILE = [
		"file:///etc/passwd", "file://C:/Windows/win.ini", "javascript:alert(1)", "data:text/plain,leak",
		"ftp://x/y", "ws://x/y", "//evil.example/x", "/relative/path", "relative/path", "./x",
		"https:/evil.example", "https:evil.example", "http:", "https", "", "   ",
		42, null, {}, [], [ "https://ok" ], true
	];
	const LEGIT = [
		"https://api.deepseek.com/anthropic/v1/messages", "http://127.0.0.1:8080/ingest",
		"https://localhost/x", "HTTPS://API.EXAMPLE/x", "http://x"
	];
	// Prefix-preserving mutations, because both guards are prefix tests.
	const prefixes = [ "https://", "http://", "HTTPS://", "Http://", "https:/", "http:", "https", "http", "" ];
	const bodies = [ "a", "x.y/z", "", " ", "\n", "\t", "ok.example/v1", "127.0.0.1:9/x", "javascript:alert(1)", "file:///x", "\u0000", "ü" ];
	const fuzz = [];
	for (const prefix of prefixes) for (const body of bodies) fuzz.push(prefix + body);

	const CAPS = [
		1, 1024, 8388608, 0, -1, 1.5, 2.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1,
		2 ** 53, 2 ** 53 + 2, 1e21, Number.MAX_VALUE, Infinity, -Infinity, NaN,
		"1024", "8388608", null, true, {}, [], undefined
	];

	let endpointsChecked = 0;
	for (const value of [ ...HOSTILE, ...LEGIT, ...fuzz ]) {
		const used = host.resolveConfig({ endpoint: value }).endpoint;
		// One source of truth on the Host side: the transport's predicate and resolveConfig's
		// narrowing must agree with each other, and the page must agree with both.
		assert(transport.isAbsoluteHttpEndpoint(value) === (used === value), `the Host's two endpoint rules disagree for ${JSON.stringify(value)}`);
		const shown = await disclosedValues({ mode: "official-only", endpoint: value, maxBytes: 8388608 }, 3);
		assert(shown.destination === used, `display ${JSON.stringify(shown.destination)} != used ${JSON.stringify(used)} for ${JSON.stringify(value)}`);
		endpointsChecked++;
	}
	let capsChecked = 0;
	for (const value of CAPS) {
		const used = host.resolveConfig({ maxBytes: value }).maxBytes;
		const shown = await disclosedValues({ mode: "official-only", endpoint: host.DEFAULT_ENDPOINT, maxBytes: value }, 3);
		assert(shown.cap === humanBytes(used), `display ${JSON.stringify(shown.cap)} != used ${humanBytes(used)} for ${String(value)}`);
		capsChecked++;
	}
	return `${endpointsChecked} endpoints and ${capsChecked} caps agree with resolveConfig()`;
});

// 23 ─ the consent dialog names the destination in use ──────────────────────────────────
await checkAsync("narrow-dialog", "the confirmation dialog names the destination the plugin will POST to", async () => {
	const stored = "file:///etc/passwd";
	const shown = await disclosedValues({ mode: "official-only", endpoint: stored, maxBytes: 8388608 }, 3);
	assert(shown.destination === "https://api.deepseek.com/anthropic/v1/messages", `the destination row shows ${JSON.stringify(shown.destination)}`);
	clickRadio(shown.runtime, "any-model");
	const opened = dialog(shown.runtime);
	assert(opened !== undefined, "no confirmation dialog for any-model");
	const text = textOf(opened);
	assert(text.includes("https://api.deepseek.com/anthropic/v1/messages"), "the dialog does not name the endpoint we will use");
	assert(!text.includes(stored), "the dialog names the stored value we will NOT use");
	return "dialog names the endpoint in use, never the stored one";
});

// 24 ─ the upload ledger table ──────────────────────────────────────────────────────────
await checkAsync("ledger-table", "a normal ledger payload renders rows, newest first, metadata only", async () => {
	const older = { sessionId: "session-167fda32-2ed2-4c3d-b5fa-5e63650f9c63", afterSeq: 410, sessionFormatVersion: 4, updatedAt: 1794400000000 };
	const newer = { sessionId: "session-9aa1f0c4-77e8-4a61-9d2b-1f0e6b4c8a55", afterSeq: 800, sessionFormatVersion: 4, updatedAt: 1794407548140 };
	const directory = "C:\\Users\\example\\.dsh\\session-log-upload";
	// The Host's order here is oldest-first, so the newest-first sort must happen in the page.
	const scenario = await ledgerScenario([ { status: 200, body: { generatedAt: 1794407600000, directory: directory, total: 2, sessions: [ older, newer ], leaked: "NOT FOR DISPLAY" } } ]);
	const runtime = scenario.runtime;
	assert(radios(runtime).length === 4, "the section stopped rendering its mode controls");
	const rows = ledgerRows(runtime);
	assert(rows.length === 2, `expected 2 ledger rows, saw ${rows.length}`);
	assert(rows[0].sessionId === newer.sessionId, `first row is ${rows[0].sessionId}, expected the newest`);
	assert(rows[1].sessionId === older.sessionId, `second row is ${rows[1].sessionId}, expected the older one`);
	const shortened = rows[0].cells[0];
	assert(shortened !== newer.sessionId && shortened.includes("…"), `the session id is not shortened in the middle: ${JSON.stringify(shortened)}`);
	assert(shortened.startsWith(newer.sessionId.slice(0, 8)) && shortened.endsWith(newer.sessionId.slice(-6)), `the shortened id lost an end: ${JSON.stringify(shortened)}`);
	assert(rows[0].cells[1] === "800" && rows[1].cells[1] === "410", `range cells are ${JSON.stringify(rows.map(function (row) { return row.cells[1]; }))}`);
	assert(rows[0].cells[2] === new Date(newer.updatedAt).toLocaleString(), `time cell is ${JSON.stringify(rows[0].cells[2])}`);
	assert(rows.every(function (row) { return row.cells[3] === "4"; }), "format version cells are wrong");
	const headers = runtime.findAll(function (node) { return node.type === "th"; }).map(textOf);
	assert(headers.join(" | ") === "Session | Uploaded through | Time | Format version", `headers are ${JSON.stringify(headers)}`);
	const text = textOf(scenario.tree);
	assert(text.includes("Sessions recorded: 2"), "the summary line does not report the Host's total");
	assert(text.includes(directory), "the ledger directory is not shown");
	assert(!text.includes("NOT FOR DISPLAY"), "a field the ledger does not define was rendered");
	assert(scenario.fetch.calls.length === 1, `the ledger was fetched ${scenario.fetch.calls.length} times`);
	assert(scenario.fetch.calls[0].input === LEDGER_ROUTE, `the ledger was fetched from ${JSON.stringify(scenario.fetch.calls[0].input)}`);
	return "2 rows newest-first, metadata only, document-relative fetch";
});

// 25 ─ the honest empty state ────────────────────────────────────────────────────────────
await checkAsync("ledger-empty", "an empty ledger explains what it covers instead of saying no data", async () => {
	const scenario = await ledgerScenario([ { status: 200, body: { generatedAt: 1, directory: "D:\\ledger", total: 0, sessions: [] } } ]);
	const text = textOf(scenario.tree);
	assert(ledgerRows(scenario.runtime).length === 0, "an empty ledger produced rows");
	assert(text.includes("Sessions recorded: 0"), "the summary line does not report zero");
	assert(text.includes("covers uploads made by this plugin only"), "the empty state does not say what the detailed log covers");
	assert(text.includes("stays empty by design"), "the empty state does not explain that empty is expected in off / official-only");
	assert(text.includes("official-API uploader are never listed here"), "the empty state does not mention the shipped uploader");
	assert(text.includes("does not contain the log content itself"), "the description does not say the file is an index rather than the content");
	assert(!text.includes("could not be read") && !text.includes("does not serve"), "an empty ledger was reported as a failure");
	assert(text.includes("D:\\ledger"), "the ledger directory is not shown in the empty state");

	// The summary reports the Host's own total, never a locally counted number: with no `total`
	// field the page says so instead of presenting its row count as the ledger's total.
	const noTotal = await ledgerScenario([ { status: 200, body: { directory: "D:\\ledger", sessions: [ { sessionId: "session-a", afterSeq: 1, sessionFormatVersion: 4, updatedAt: 1000 } ] } } ]);
	const noTotalText = textOf(noTotal.runtime.tree());
	assert(noTotalText.includes("Sessions recorded: Not reported by the Host"), `a missing total was replaced by a local count: ${JSON.stringify(noTotalText.slice(0, 200))}`);
	assert(noTotalText.includes("session-a"), "the row the Host did send is not listed");
	return "empty state says which uploads it covers, and the total is the Host's own";
});

// 26 ─ malformed payloads ───────────────────────────────────────────────────────────────
await checkAsync("ledger-malformed", "an unreadable or partial payload is reported, never invented", async () => {
	const notJson = await ledgerScenario([ { status: 200, text: "<html>not json</html>" } ]);
	assert(textOf(notJson.runtime.tree()).includes("The Host answered, but the detailed log could not be read."), "a non-JSON body is not reported as unreadable");
	assert(ledgerRows(notJson.runtime).length === 0, "a non-JSON body produced rows");

	const noArray = await ledgerScenario([ { status: 200, body: { total: 3, sessions: "nope" } } ]);
	assert(textOf(noArray.tree).includes("could not be read"), "a missing sessions array is not reported");
	assert(ledgerRows(noArray.runtime).length === 0, "a missing sessions array produced rows");

	const partial = await ledgerScenario([ {
		status: 200,
		body: {
			total: 5,
			directory: "D:\\ledger",
			sessions: [
				null,
				"session-as-a-bare-string",
				{ afterSeq: 9 },
				{ foo: 1 },
				{ sessionId: "session-keep-me", afterSeq: 12, sessionFormatVersion: 4, updatedAt: 1794405000000 },
				{ sessionId: "session-no-fields" }
			]
		}
	} ]);
	const rows = ledgerRows(partial.runtime);
	assert(rows.length === 2, `expected exactly the 2 identifiable records, saw ${rows.length}`);
	assert(rows[0].sessionId === "session-keep-me" && rows[1].sessionId === "session-no-fields", `rows are ${JSON.stringify(rows.map(function (row) { return row.sessionId; }))}`);
	assert(rows[0].cells[1] === "12" && rows[0].cells[3] === "4", `the complete record lost a field: ${JSON.stringify(rows[0].cells)}`);
	assert(rows.every(function (row) { return row.cells[1] !== "" && row.cells[2] !== "" && row.cells[3] !== ""; }), "a missing cell rendered as empty");
	assert(rows[1].cells[1] === "Not reported by the Host", `a missing range is not reported honestly: ${JSON.stringify(rows[1].cells[1])}`);
	assert(textOf(partial.tree).includes("Records without a session id were skipped: 4"), "the skipped count is not reported");
	assert(radios(partial.runtime).length === 4, "the section did not survive the malformed payload");
	return "non-JSON, missing array and partial records all reported, no invented rows";
});

// 27 ─ failures are distinguished ───────────────────────────────────────────────────────
await checkAsync("ledger-failures", "a missing route, a refused credential and a transport failure read differently", async () => {
	const missing = await ledgerScenario([ { status: 404 } ]);
	assert(textOf(missing.tree).includes("does not serve the detailed log at this address"), "404 is not reported as a missing route");
	const unauthorized = await ledgerScenario([ { status: 401 } ]);
	assert(textOf(unauthorized.tree).includes("not authorized to read the detailed log"), "401 is not reported as a refused credential");
	const forbidden = await ledgerScenario([ { status: 403 } ]);
	assert(textOf(forbidden.tree).includes("not authorized"), "403 is not treated as a refused credential");
	const serverError = await ledgerScenario([ { status: 500 } ]);
	assert(textOf(serverError.tree).includes("The detailed log could not be read."), "a 5xx is not reported as a failed read");
	const offline = await ledgerScenario([ { reject: "network down" } ]);
	assert(textOf(offline.tree).includes("The detailed log could not be read."), "a transport failure is not reported as a failed read");
	for (const scenario of [ missing, unauthorized, forbidden, serverError, offline ]) {
		assert(ledgerRows(scenario.runtime).length === 0, "a failed read produced rows");
		assert(radios(scenario.runtime).length === 4, "the section did not survive a failed read");
		assert(scenario.fetch.calls.length === 1, `a failed read was retried without a gesture (${scenario.fetch.calls.length} calls)`);
	}

	// A page with no fetch at all is still an honest state, never a crash.
	const bare = createHookRuntime();
	const form = createForm({ status: "ready", writable: true, revision: 1, value: { mode: "official-only", endpoint: SERVED_ENDPOINT, maxBytes: 8388608 } });
	const applied = applyWith({ configForms: createConfigForms({ served: [ "session-log-upload" ], form: form }) }, bare);
	await settle(bare);
	assert(textOf(bare.tree()).includes("The detailed log could not be read."), "a page without fetch did not report the ledger as unreadable");
	assert(radios(bare).length === 4, "the section did not survive a missing fetch");
	return "404 / 401 / 403 / 5xx / transport / no-fetch all distinguished, no rows invented";
});

// 28 ─ refresh re-reads ─────────────────────────────────────────────────────────────────
await checkAsync("ledger-refresh", "the refresh action re-reads the ledger and shows the new list", async () => {
	const first = { sessionId: "session-first", afterSeq: 10, sessionFormatVersion: 4, updatedAt: 1000 };
	const second = { sessionId: "session-second", afterSeq: 20, sessionFormatVersion: 5, updatedAt: 2000 };
	const scenario = await ledgerScenario([
		{ status: 200, body: { total: 1, directory: "D:\\one", sessions: [ first ] } },
		{ status: 200, body: { total: 2, directory: "D:\\two", sessions: [ first, second ] } }
	]);
	assert(ledgerRows(scenario.runtime).length === 1, "the first read did not render one row");
	clickButton(scenario.runtime, "Refresh");
	await settle(scenario.runtime);
	assert(scenario.fetch.calls.length === 2, `refresh made ${scenario.fetch.calls.length} calls in total`);
	const rows = ledgerRows(scenario.runtime);
	assert(rows.length === 2, `after refresh there are ${rows.length} rows`);
	assert(rows[0].sessionId === second.sessionId, "the refreshed list is not sorted newest first");
	const text = textOf(scenario.runtime.tree());
	assert(text.includes("Sessions recorded: 2"), "the refreshed summary is stale");
	assert(text.includes("D:\\two"), "the refreshed directory is stale");
	assert(scenario.fetch.calls.every(function (call) { return call.input === LEDGER_ROUTE; }), "a refresh used a different route");
	return "refresh re-reads and re-renders";
});

// 30 ─ editable destination and byte cap, validated by the Host's own rule ───────────────
await checkAsync("field-editing", "the destination and byte cap are editable, validated by host/config.js", async () => {
	let host;
	try {
		host = await import("../host/config.js");
	} catch (error) {
		assert(false, `the Host rule could not be imported: ${error && error.message ? error.message : String(error)}`);
	}

	// Every endpoint candidate is driven through the real Host: if the Host would use it, the page
	// must write exactly it; if not, the page must refuse before writing anything.
	const endpoints = [
		"https://api.deepseek.com/anthropic/v1/messages",
		"http://127.0.0.1:8080/ingest",
		"HTTPS://API.EXAMPLE/x",
		"https://trailing.space ",
		" https://leading.space",
		"file:///etc/passwd",
		"javascript:alert(1)",
		"//evil.example/x",
		"/relative/path",
		"https:/single.slash",
		"http:",
		"",
		"   "
	];
	let accepted = 0;
	let refused = 0;
	for (const value of endpoints) {
		const scenario = await ledgerScenario([ { status: 404 } ]);
		typeInto(scenario.runtime, "endpoint", value);
		clickSave(scenario.runtime, "endpoint");
		await settle(scenario.runtime);
		const used = host.resolveConfig({ endpoint: value }).endpoint;
		if (used === value) {
			accepted++;
			assert(scenario.form.sets.length === 1, `the page did not write a destination the Host would use: ${JSON.stringify(value)}`);
			assert(scenario.form.sets[0][0] === "endpoint" && scenario.form.sets[0][1] === value, `wrote ${JSON.stringify(scenario.form.sets[0])}`);
		} else {
			refused++;
			assert(scenario.form.sets.length === 0, `the page wrote a destination the Host would refuse: ${JSON.stringify(value)}`);
			assert(fieldStateTexts(scenario.runtime).includes("Not saved: the destination must be an http:// or https:// address."), `no rejection was shown for ${JSON.stringify(value)}`);
		}
		assert(disclosureCodes(scenario.runtime)[0] === used, `the destination row shows ${JSON.stringify(disclosureCodes(scenario.runtime)[0])}, expected ${JSON.stringify(used)}`);
	}
	assert(accepted > 0 && refused > 0, `expected both accepted and refused candidates, saw ${accepted}/${refused}`);

	// Byte caps: the page parses the text, then applies the Host's own rule to the number.
	const caps = [ "8388608", "4194304", "1", "1024", " 2048 ", "0", "-1", "1.5", "abc", "", "9007199254740992", "1e21" ];
	let capAccepted = 0;
	let capRefused = 0;
	for (const text of caps) {
		const scenario = await ledgerScenario([ { status: 404 } ]);
		typeInto(scenario.runtime, "maxBytes", text);
		clickSave(scenario.runtime, "maxBytes");
		await settle(scenario.runtime);
		const trimmed = text.trim();
		const parsed = trimmed.length === 0 ? NaN : Number(trimmed);
		const used = host.resolveConfig({ maxBytes: parsed }).maxBytes;
		if (used === parsed) {
			capAccepted++;
			assert(scenario.form.sets.length === 1 && scenario.form.sets[0][1] === parsed, `wrote ${JSON.stringify(scenario.form.sets)} for ${JSON.stringify(text)}`);
			assert(typeof scenario.form.sets[0][1] === "number", "the byte cap must be written as a number, not as text");
		} else {
			capRefused++;
			assert(scenario.form.sets.length === 0, `the page wrote a cap the Host would refuse: ${JSON.stringify(text)}`);
			assert(fieldStateTexts(scenario.runtime).includes("Not saved: the byte cap must be a whole number of bytes, 1 or more."), `no rejection was shown for ${JSON.stringify(text)}`);
		}
		assert(disclosureCodes(scenario.runtime)[1] === humanBytes(used), `the cap row shows ${JSON.stringify(disclosureCodes(scenario.runtime)[1])}, expected ${JSON.stringify(humanBytes(used))}`);
	}
	assert(capAccepted > 0 && capRefused > 0, `expected both accepted and refused caps, saw ${capAccepted}/${capRefused}`);

	// A refused write is reported, and success is only claimed when it happened.
	const refusing = createWritableForm({ mode: "official-only", endpoint: SERVED_ENDPOINT, maxBytes: 8388608 });
	refusing.set = async function (field, value) {
		this.sets.push([ field, value ]);
		return false;
	};
	const failed = await ledgerScenario([ { status: 404 } ], { form: refusing });
	typeInto(failed.runtime, "endpoint", "https://elsewhere.example/v1");
	clickSave(failed.runtime, "endpoint");
	await settle(failed.runtime);
	assert(failed.form.sets.length === 1, "the refused write was never attempted");
	assert(fieldStateTexts(failed.runtime).includes("The setting could not be saved."), "a refused write did not surface a failure");
	assert(!fieldStateTexts(failed.runtime).includes("Saved."), "a refused write claimed success");
	for (const set of failed.form.sets) assert(set[0] !== "mode", "the field editor wrote the mode");
	// The generic field editor's whitelist is the five fields it renders controls for. The
	// other-harness tick set is written through the SAME writeField path but by its own Save
	// control, so it is admitted by name instead of widening the generic editor's reach. The
	// property that matters is unchanged: `mode`, `uploadModel` and `credentialRef` are reachable
	// through neither.
	assert(/const EDITABLE_FIELDS = Object\.freeze\(\[ "endpoint", "maxBytes", "deepseekModelPatterns", "uploadDirectories", "uploadSessionIds" \]\)/.test(stripComments(clientSource)), "the editable-field whitelist is not exactly the five fields the generic editor renders");
	assert(/if \(field === "foreignSessionIds"\) return persistField\(field, value\);/.test(stripComments(clientSource)), "the other-harness tick set is not writable through writeField");
	for (const forbidden of ['mode', 'uploadModel', 'credentialRef']) {
		assert(!new RegExp(`EDITABLE_FIELDS = Object\\.freeze\\(\\[[^\\]]*"${forbidden}"`).test(stripComments(clientSource)), `${forbidden} entered EDITABLE_FIELDS`);
	}

	// Writing a valid destination updates the value the dialog would name.
	const live = await ledgerScenario([ { status: 404 } ]);
	typeInto(live.runtime, "endpoint", "https://elsewhere.example/v1");
	clickSave(live.runtime, "endpoint");
	await settle(live.runtime);
	assert(disclosureCodes(live.runtime)[0] === "https://elsewhere.example/v1", "the destination row did not follow the accepted write");
	assert(fieldStateTexts(live.runtime).includes("Saved."), "an accepted write was not confirmed");
	assert(fieldInput(live.runtime, "endpoint").props.value === "https://elsewhere.example/v1", "the input did not return to mirroring the value in use");
	return `${accepted}/${refused} endpoints and ${capAccepted}/${capRefused} caps agree with resolveConfig(); refusal reported`;
});

// 31 ─ session names are an informed, opt-in choice ──────────────────────────────────────
await checkAsync("titles-toggle", "session names are off by default, resolved from the slot hook, and fall back to the id", async () => {
	const sessionId = "session-167fda32-2ed2-4c3d-b5fa-5e63650f9c63";
	const session = { sessionId: sessionId, afterSeq: 1409, sessionFormatVersion: 4, updatedAt: 1794407548140 };
	const payload = [ { status: 200, body: { total: 1, directory: "D:\\dir", sessions: [ session ] } } ];
	const name = "Refactor the parser";

	// Default OFF: the id is shown, no name, and the copy says where a name comes from.
	const off = await ledgerScenario(payload, { useSessions: sessionsHook({ [sessionId]: { title: name } }) });
	assert(sessionNamesToggle(off.runtime).props.checked !== true, "the session-names toggle is on by default");
	assert(!textOf(off.runtime.tree()).includes(name), "a session name is shown while the toggle is off");
	assert(ledgerRows(off.runtime)[0].cells[0].includes("…"), "the shortened id is missing while names are off");
	assert(textOf(off.runtime.tree()).includes("A session name comes from the conversation itself"), "the toggle does not say where a name comes from");

	// ON with a mapped name: both the name and the id are visible, and the full id stays available.
	setSessionNames(off.runtime, true);
	const named = ledgerRows(off.runtime)[0];
	assert(named.cells[0].includes(name), `the session name was not resolved: ${JSON.stringify(named.cells[0])}`);
	assert(named.cells[0].includes("…"), "the id disappeared when names are shown");
	assert(named.sessionId === sessionId, "the full id is no longer available on the row");

	// OFF again hides it.
	setSessionNames(off.runtime, false);
	assert(!ledgerRows(off.runtime)[0].cells[0].includes(name), "the session name survived the toggle being switched off");

	// No hook, an unknown id, and a throwing hook all fall back to the id without crashing.
	setSessionNames(off.runtime, true);
	const noHook = await ledgerScenario(payload);
	setSessionNames(noHook.runtime, true);
	assert(ledgerRows(noHook.runtime)[0].cells[0].includes("…"), "an absent useSessions did not fall back to the id");
	const unknownId = await ledgerScenario(payload, { useSessions: sessionsHook({}) });
	setSessionNames(unknownId.runtime, true);
	assert(ledgerRows(unknownId.runtime)[0].cells[0].includes("…"), "an unknown id did not fall back to the id");
	const throwing = await ledgerScenario(payload, { useSessions: function () { throw new Error("store unavailable"); } });
	setSessionNames(throwing.runtime, true);
	assert(ledgerRows(throwing.runtime)[0].cells[0].includes("…"), "a throwing useSessions did not fall back to the id");
	assert(radios(throwing.runtime).length === 4, "a throwing useSessions broke the section");
	return "off by default; name + id when on; absent/unknown/throwing hook all fall back";
});

// 32 ─ the two numeric columns explain themselves in place ──────────────────────────────
await checkAsync("field-explanations", "afterSeq and the format version are explained without hovering", async () => {
	const session = { sessionId: "session-167fda32-2ed2-4c3d-b5fa-5e63650f9c63", afterSeq: 1409, sessionFormatVersion: 4, updatedAt: 1794407548140 };
	const scenario = await ledgerScenario([ { status: 200, body: { total: 1, directory: "D:\\dir", sessions: [ session ] } } ]);
	const text = textOf(scenario.runtime.tree());
	assert(text.includes("sequence number of the last session event this plugin has sent"), "the uploaded-through column is not explained");
	assert(text.includes("session events are numbered as the conversation grows"), "the numbering is not explained");
	assert(text.includes("identifies the session-log format generation"), "the format version is not explained");
	assert(text.includes("makes the plugin resend rather than mix incompatible records"), "the resend consequence is not explained");
	// Both locales carry it, so `dict-parity` (which compares the inline dictionary with the files)
	// is not the only guard: a missing translation would leave the zh page unexplained.
	for (const flat of [ enFlat, zhFlat ]) assert(typeof flat["upload.ledger.columnsHint"] === "string" && flat["upload.ledger.columnsHint"].length > 40, "the explanation is missing from a locale file");
	assert(zhFlat["upload.ledger.columnsHint"].includes("格式版本"), "the zh explanation does not name the format version column");
	assert(zhFlat["upload.ledger.columnsHint"].includes("已上传至"), "the zh explanation does not name the uploaded-through column");
	return "both columns explained in both locales";
});

// 33 ─ the consent dialog names the destination, not a brand ────────────────────────────
await checkAsync("dialog-destination", "the confirmation dialog names the destination of record", async () => {
	const elsewhere = "https://collector.example/ingest";
	const custom = await ledgerScenario([ { status: 404 } ], { endpoint: elsewhere });
	clickRadio(custom.runtime, "any-model");
	const opened = dialog(custom.runtime);
	assert(opened !== undefined, "no confirmation dialog for any-model");
	const text = textOf(opened);
	assert(text.includes(elsewhere), "the dialog does not name the destination it will use");
	assert(!text.includes("DeepSeek"), "the dialog still promises DeepSeek although the destination is not DeepSeek");
	assert(text.includes("other model providers"), "the dialog dropped the other-provider disclosure");
	assert(text.includes("leaves this machine"), "the dialog does not say the log leaves the machine");
	assert(text.includes("used to improve and train models"), "the dialog does not say the log may be used to train models");
	assert(text.includes("cannot be undone"), "the dialog does not say it cannot be undone");

	// With the default destination the brand appears only because the endpoint itself names it.
	const dflt = await ledgerScenario([ { status: 404 } ]);
	clickRadio(dflt.runtime, "any-model");
	const dfltText = textOf(dialog(dflt.runtime));
	assert(dfltText.includes("api.deepseek.com"), "the default destination is not named");
	assert(dfltText.indexOf("DeepSeek") === dfltText.indexOf("api.deepseek.com") - 4 || !/DeepSeek(?!\.com)/.test(dfltText.replace(/api\.deepseek\.com/g, "")), "the dialog hard-codes the brand outside the destination");
	return "dialog names the destination; the brand only appears as part of a DeepSeek endpoint";
});

// 34 ─ the detailed log is called 详细日志, and says what the file actually holds ────────
await checkAsync("detailed-log-rename", "no user-visible copy says 台账 or ledger, and the file is described as an index", async () => {
	for (const key of Object.keys(enFlat)) {
		const value = enFlat[key];
		if (typeof value !== "string") continue;
		assert(!/\bledger\b/i.test(value), `the en value for ${key} still says "ledger": ${JSON.stringify(value)}`);
	}
	for (const key of Object.keys(zhFlat)) {
		const value = zhFlat[key];
		if (typeof value !== "string") continue;
		assert(!/台账|账本/.test(value), `the zh value for ${key} still says 台账: ${JSON.stringify(value)}`);
	}
	const inline = JSON.parse(extractObject(clientSource, "const DICTIONARIES ="));
	for (const language of [ "en", "zh" ]) {
		for (const key of Object.keys(inline[language])) {
			const value = inline[language][key];
			assert(!/台账|账本/.test(value), `the inline ${language} value for ${key} still says 台账`);
			assert(!/\bledger\b/i.test(value), `the inline ${language} value for ${key} still says "ledger"`);
		}
	}
	// The name the user asked for is used, and the copy says the file is an index of the uploads.
	assert(enFlat["upload.ledger.title"] === "Uploaded Sessions" && zhFlat["upload.ledger.title"] === "已上传的会话", "the sub-section title changed");
	assert(zhFlat["upload.ledger.loading"].includes("详细日志"), "the zh loading copy does not use 详细日志");
	assert(enFlat["upload.ledger.description"].includes("index of the Session logs"), "the en description does not call the file an index");
	assert(enFlat["upload.ledger.description"].includes("does not contain the log content itself"), "the en description does not deny holding the content");
	assert(zhFlat["upload.ledger.description"].includes("索引") && zhFlat["upload.ledger.description"].includes("不含日志内容本身"), "the zh description does not say the file is an index without the content");
	// Key names and the route keep their internal names on purpose: renaming them is pure churn.
	assert(clientSource.includes("upload.ledger.title"), "the locale key names should stay `upload.ledger.*`");
	assert(clientSource.includes("LEDGER_PATH = \"/api/session-log-upload.ledger\""), "the route path should stay unchanged");
	return "copy renamed to 详细日志 / detailed log; keys and route unchanged; index wording present";
});

// 35 ─ the session hook call is unconditional, and pinned across renders ────────────────
await checkAsync("session-hook-order", "the session hook is called once per row on every render, however the prop changes", async () => {
	// The property is only meaningful if the guard behind it can fail: a genuinely conditional
	// hook call must be caught, exactly as React would catch it.
	const probe = createHookRuntime();
	let conditional = false;
	function ConditionalHook() {
		if (conditional) probe.React.useRef(null);
		return probe.React.createElement("div", null, "probe");
	}
	probe.render(probe.React.createElement(ConditionalHook));
	conditional = true;
	let guarded = null;
	try {
		probe.render(probe.React.createElement(ConditionalHook));
	} catch (error) {
		guarded = error;
	}
	assert(guarded !== null && /Rendered more hooks/.test(guarded.message), "the hook-order guard cannot detect a conditional hook");

	const sessionId = "session-167fda32-2ed2-4c3d-b5fa-5e63650f9c63";
	const name = "Refactor the parser";
	const session = { sessionId: sessionId, afterSeq: 1409, sessionFormatVersion: 4, updatedAt: 1794407548140 };
	const payload = [ { status: 200, body: { total: 1, directory: "D:\\dir", sessions: [ session ] } } ];
	const servedForm = function () {
		return createWritableForm({ mode: "official-only", endpoint: SERVED_ENDPOINT, maxBytes: 8388608 });
	};

	// Present from the first render: exactly one call per row, on every render.
	const runtime = createHookRuntime();
	const stub = sessionsHookWithHooks(runtime.React, { [sessionId]: { title: name } });
	const applied = applyWith({
		configForms: createConfigForms({ served: [ "session-log-upload" ], form: servedForm() }),
		fetch: ledgerFetch(payload).fetch,
		useSessions: stub
	}, runtime);
	await settle(runtime);
	const rows = ledgerRows(runtime).length;
	assert(rows === 1, `expected one ledger row, saw ${rows}`);
	const before = stub.calls;
	runtime.flush();
	assert(stub.calls - before === rows, `expected one session-hook call per row per render, saw ${stub.calls - before}`);

	// present → absent: the function pinned on the first render is still the one called, so the
	// call count per render is unchanged and the component's hook order cannot move.
	let threwGone = null;
	try {
		runtime.render(runtime.React.createElement(applied.section.component, { t: applied.t, useSessions: undefined }));
	} catch (error) {
		threwGone = error;
	}
	assert(threwGone === null, `re-rendering without useSessions threw: ${threwGone && threwGone.message}`);
	const beforeGone = stub.calls;
	runtime.flush();
	assert(stub.calls - beforeGone === rows, `the pinned hook stopped being called once the prop was gone (${stub.calls - beforeGone} calls for ${rows} rows)`);

	// absent → present: the fallback was pinned, so a late hook is simply never called — no throw,
	// no hook-order change, and no name appears (the row keeps the id).
	const bare = createHookRuntime();
	const late = sessionsHookWithHooks(bare.React, { [sessionId]: { title: name } });
	const appliedBare = applyWith({
		configForms: createConfigForms({ served: [ "session-log-upload" ], form: servedForm() }),
		fetch: ledgerFetch(payload).fetch
	}, bare);
	await settle(bare);
	setSessionNames(bare, true);
	let threwLate = null;
	try {
		bare.render(bare.React.createElement(appliedBare.section.component, { t: appliedBare.t, useSessions: late }));
	} catch (error) {
		threwLate = error;
	}
	assert(threwLate === null, `re-rendering with a late useSessions threw: ${threwLate && threwLate.message}`);
	assert(late.calls === 0, `a late-arriving hook was called ${late.calls} times although the fallback was pinned`);
	assert(!textOf(bare.tree()).includes(name), "a late-arriving hook resolved a name");
	assert(radios(bare).length === 4, "the section did not survive a late-arriving useSessions");
	assert(ledgerRows(bare).length === 1, "the ledger lost its row");
	return `one call per row per render; present→absent and absent→present both stable (${stub.calls} pinned calls)`;
});

// 36 ─ disposal ─────────────────────────────────────────────────────────────────────────
check("disposal", "apply hands every registration to ctx.effect with a cleanup", () => {
	const cleanups = [];
	const ctx = {
		effect(fn) {
			const cleanup = fn();
			cleanups.push(cleanup);
			return cleanup;
		},
		slots: {
			inject(owner, callback) {
				return callback();
			},
			register() {
				return function () {};
			}
		},
		locale: {
			register() {
				return function () {};
			},
			bind() {
				return function (key) {
					return key;
				};
			}
		}
	};
	moduleExports.apply(ctx);
	assert(cleanups.length === 4, `apply created ${cleanups.length} effects, expected 4`);
	assert(cleanups.every(function (cleanup) { return typeof cleanup === "function"; }), "an effect returned no cleanup");
	return `${cleanups.length} effects, all with cleanups`;
});

// 25 ─ the two editable lists ────────────────────────────────────────────────────────────
// These exist because of a real user report: a reverse proxy served DeepSeek as `dfmodel`, the mode
// matched on the model id containing "deepseek", and nothing uploaded — silently, for hours. The
// first list is how a user says "that name is DeepSeek"; the second is a new feature (never upload
// from these folders). Both are edited on this page, so both must be driven here.
await checkAsync("list-editing", "the two lists edit through the page and write normalized values", async () => {
	// The model-pattern list only renders in `deepseek-any-provider`, the one mode that reads it.
	const scenario = await ledgerScenario([ { status: 200, body: { generatedAt: 1, directory: "C:\\\\l", total: 0, sessions: [] } } ], { mode: "deepseek-any-provider" });
	const runtime = scenario.runtime;

	// The directory field is a chooser, not a textarea: with no restriction it must SAY so.
	const readOnly = runtime.findAll(function (node) {
		return typeof node.props.className === "string" && node.props.className.indexOf("slu-listValue") >= 0 && node.props["data-field"] === "uploadDirectories";
	}).map(textOf)[0];
	assert(readOnly !== undefined, "the directory field has no read-only value line");
	assert(/everything is uploaded|no restriction/i.test(readOnly), `an unrestricted state must say so, not render blank: ${readOnly}`);

	// The opt-in checkbox exists and is unticked while there is no restriction.
	const optIn = runtime.findAll(function (node) { return node.props["data-toggle"] === "restrict-directories"; })[0];
	assert(optIn !== undefined, "the directory chooser has no opt-in checkbox");
	assert(optIn.props.checked === false, "the opt-in starts ticked while nothing is restricted");

	// Ticking it opens the picker, which offers a scan action.
	optIn.props.onChange({ target: { checked: true } });
	runtime.flush();
	const scan = runtime.findAll(function (node) { return typeof node.props.className === "string" && node.props.className.indexOf("slu-ledgerRefresh") >= 0; })[0];
	assert(scan !== undefined, "opening the picker did not offer a scan action");

	// The model-pattern list still writes a normalized array.
	typeInto(runtime, "deepseekModelPatterns", "  dfmodel  \n\nDFModel\ndeepseek\n   \n");
	clickSave(runtime, "deepseekModelPatterns");
	await settle(runtime);
	const patternsWrite = scenario.form.sets.find(function (set) { return set[0] === "deepseekModelPatterns"; });
	assert(patternsWrite !== undefined, "the pattern list was never written");
	assert(JSON.stringify(patternsWrite[1]) === JSON.stringify([ "dfmodel", "deepseek" ]), `the written list was ${JSON.stringify(patternsWrite[1])}`);

	// Clearing the opt-in writes an EMPTY allowlist, which is what "upload everything" means on the Host.
	const untick = runtime.findAll(function (node) { return node.props["data-toggle"] === "restrict-directories"; })[0];
	untick.props.onChange({ target: { checked: false } });
	await settle(runtime);
	const cleared = scenario.form.sets.filter(function (set) { return set[0] === "uploadDirectories"; }).pop();
	assert(cleared !== undefined, "clearing the restriction wrote nothing");
	assert(JSON.stringify(cleared[1]) === JSON.stringify([]), `clearing wrote ${JSON.stringify(cleared[1])}`);

	// The field editor must never write `mode`, and the two protected fields stay unwritable.
	for (const set of scenario.form.sets) {
		assert(set[0] !== "mode", "the list editor wrote the mode");
		assert(set[0] !== "uploadModel" && set[0] !== "credentialRef", `the list editor wrote ${set[0]}`);
	}
	return `${scenario.form.sets.length} writes; the directory field is a chooser that states its default`;
});

await checkAsync("list-help", "the directory copy states the default first, and the pattern list is hidden outside its mode", async () => {
	const en = JSON.parse(fs.readFileSync(path.join(ROOT, "locale/en.json"), "utf8")).upload;
	const zh = JSON.parse(fs.readFileSync(path.join(ROOT, "locale/zh.json"), "utf8")).upload;

	// The pattern list's job: explain the renamed-model case.
	assert(/proxy|another name|dfmodel/i.test(en.patternsHelp), "the pattern help does not explain the renamed-model case");
	assert(/dfmodel/.test(zh.patternsHelp), "zh pattern help lost the renamed-model case");

	// THE POINT OF THIS SHAPE: the copy must lead with "everything is uploaded by default", so nobody
	// reads the list as "only what is NOT listed is being sent".
	assert(/by default every session is uploaded/i.test(en.directoriesHelp), `en directory help does not state the default first: ${en.directoriesHelp}`);
	assert(/默认.*都会上传|默认所有/.test(zh.directoriesHelp), `zh directory help does not state the default first: ${zh.directoriesHelp}`);
	// And it must say what ticking does.
	assert(/tick folders to upload only those/i.test(en.directoriesHelp), "en directory help does not say what ticking does");
	// The empty state must read as "no restriction", never as "nothing will be uploaded".
	assert(/everything is uploaded|no restriction/i.test(en.directoriesEmpty), `en empty state misreads as nothing: ${en.directoriesEmpty}`);
	assert(/全部上传|没有限制/.test(zh.directoriesEmpty), `zh empty state misreads as nothing: ${zh.directoriesEmpty}`);
	// The old deny-list wording must be gone from every copy of the string.
	for (const [label, dict] of [ [ "en", en ], [ "zh", zh ] ]) {
		assert(!/never upload|永不上传/i.test(dict.directoriesLabel), `${label}: the label still reads as a deny-list`);
	}

	// The rendering rule: the pattern list appears only in `deepseek-any-provider`.
	for (const mode of [ "off", "official-only", "any-model" ]) {
		const scenario = await ledgerScenario([ { status: 200, body: { generatedAt: 1, directory: "C:\\\\l", total: 0, sessions: [] } } ], { mode });
		const labels = scenario.runtime.findAll(function (node) {
			return typeof node.props.className === "string" && node.props.className.indexOf("slu-fieldLabel") >= 0;
		}).map(textOf);
		assert(labels.some(function (text) { return /treat as DeepSeek|当作 DeepSeek/.test(text); }) === false, `the pattern list is visible in mode ${mode}`);
		assert(labels.some(function (text) { return /folders|目录/.test(text); }), `the directory chooser is missing in mode ${mode}`);
	}
	const wide = await ledgerScenario([ { status: 200, body: { generatedAt: 1, directory: "C:\\\\l", total: 0, sessions: [] } } ], { mode: "deepseek-any-provider" });
	const wideLabels = wide.runtime.findAll(function (node) {
		return typeof node.props.className === "string" && node.props.className.indexOf("slu-fieldLabel") >= 0;
	}).map(textOf);
	assert(wideLabels.some(function (text) { return /treat as DeepSeek/.test(text); }), "the pattern list is missing from the mode that uses it");
	return "the directory copy states the default first; the pattern list appears only in deepseek-any-provider";
});

// 26 ─ a saved list must READ BACK ───────────────────────────────────────────────────────────
// The bug this guards against was invisible to every earlier check: `fieldValue` returned `null` for
// anything that was `typeof "object"` without a `.get()`, which includes every ARRAY. So a list write
// went through, the patch file was updated, and the control still rendered "not reported" — the page
// said the save failed when it had succeeded. Every existing test passed because
// `createWritableForm` hands back a PLAIN array, while the real page receives a live cosmokit
// reference. This drives the real shapes.
await checkAsync("list-readback", "a list saved through the served form is read back and re-rendered", async () => {
	// A snapshot that mimics the real wire: volatile fields arrive as `{get}` references.
	const live = (value) => ({ get: () => value });
	const state = {
		mode: "deepseek-any-provider",
		deepseekModelPatterns: live([ "deepseek" ]),
		uploadDirectories: live([]),
		endpoint: live("https://api.deepseek.com/anthropic/v1/messages"),
		maxBytes: live(8388608)
	};
	const listeners = [];
	const form = {
		sets: [],
		getSnapshot() {
			return { status: "ready", writable: true, revision: 1, value: state };
		},
		subscribe(listener) {
			listeners.push(listener);
			return function () {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		async set(field, value) {
			this.sets.push([ field, value ]);
			// The Host replaces the live reference's content; it does not swap the reference out.
			state[field] = live(value);
			for (const listener of listeners.slice()) listener();
			return true;
		}
	};

	const runtime = createHookRuntime();
	applyWith({
		configForms: createConfigForms({ served: [ "session-log-upload" ], form }),
		fetch: ledgerFetch([ { status: 200, body: { generatedAt: 1, directory: "C:\\\\l", total: 0, sessions: [] } } ])
	}, runtime);
	await settle(runtime);

	// ── the model-pattern list: a textarea, saved and read back ──────────────────────────────────
	const beforeLine = runtime.findAll(function (node) {
		return typeof node.props.className === "string" && node.props.className.indexOf("slu-listValue") >= 0 && node.props["data-field"] === "deepseekModelPatterns";
	}).map(textOf)[0];
	assert(beforeLine !== undefined, "the pattern list's read-only line is missing");
	assert(/deepseek/.test(beforeLine), `the read-only line does not show the effective list: ${beforeLine}`);

	typeInto(runtime, "deepseekModelPatterns", "deepseek\ndfmodel\n");
	clickSave(runtime, "deepseekModelPatterns");
	await settle(runtime);

	const written = form.sets.find(function (set) { return set[0] === "deepseekModelPatterns"; });
	assert(written !== undefined, "the list was never written");
	assert(JSON.stringify(written[1]) === JSON.stringify([ "deepseek", "dfmodel" ]), `written value: ${JSON.stringify(written[1])}`);

	// THE ASSERTION THAT WOULD HAVE FAILED: the page must read the stored array back.
	const afterLine = runtime.findAll(function (node) {
		return typeof node.props.className === "string" && node.props.className.indexOf("slu-listValue") >= 0 && node.props["data-field"] === "deepseekModelPatterns";
	}).map(textOf)[0];
	assert(/dfmodel/.test(afterLine), `a saved list was not read back: ${afterLine}`);
	const control = fieldInput(runtime, "deepseekModelPatterns");
	assert(typeof control.props.value === "string" && control.props.value.indexOf("dfmodel") >= 0, `the textarea did not mirror the saved list: ${JSON.stringify(control.props.value)}`);

	// ── the directory chooser: the same read-back property, through the panel ────────────────────
	const optIn = runtime.findAll(function (node) { return node.props["data-toggle"] === "restrict-directories"; })[0];
	assert(optIn !== undefined, "the directory chooser's opt-in is missing");
	optIn.props.onChange({ target: { checked: true } });
	runtime.flush();
	assert(runtime.findAll(function (node) { return typeof node.props.className === "string" && node.props.className.indexOf("slu-picker") >= 0; }).length > 0, "the picker did not open");

	// Save a restriction, then confirm the page READS IT BACK: the read-only line names the folder and
	// the opt-in stays ticked. With the `fieldValue` bug the list read as null and this failed.
	await (async () => {
		const button = runtime.findAll(function (node) {
			return node.type === "button" && node.props["data-field"] === "uploadDirectories";
		})[0];
		assert(button !== undefined, "the picker has no save action");
	})();
	state.uploadDirectories = live([ "d:/private" ]);
	for (const listener of listeners.slice()) listener();
	runtime.flush();
	const dirLine = runtime.findAll(function (node) {
		return typeof node.props.className === "string" && node.props.className.indexOf("slu-listValue") >= 0 && node.props["data-field"] === "uploadDirectories";
	}).map(textOf)[0];
	assert(/private/i.test(dirLine), `the saved directory allowlist was not read back: ${dirLine}`);
	const optInAfter = runtime.findAll(function (node) { return node.props["data-toggle"] === "restrict-directories"; })[0];
	assert(optInAfter.props.checked === true, "a non-empty allowlist must show the restriction as active");

	return "both lists write through the served form and read back from a live reference";
});

// 28 ─ the liability notice is a gate, not a toast ────────────────────────────────────────────
// The requirement: shown every time the page opens until the user ticks "I have read this", and not
// shown afterwards. A dismissible dialog would satisfy "shown" while defeating the point, so the
// checks below drive the parts that make it a gate: no backdrop dismiss, the button dead until the box
// is ticked, and dismissal only after the Host confirms it stored the acknowledgement.
await checkAsync("notice-gate", "the notice blocks until acknowledged, then never reappears", async () => {
	const NOTICE = "session-log-upload.notice";

	const renderNotice = async function (noticeReply, acknowledgeOk) {
		const posted = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = async function (input, init) {
			const url = typeof input === "string" ? input : String(input);
			const method = init !== undefined && init !== null && init.method !== undefined ? init.method : "GET";
			if (url.indexOf(NOTICE) >= 0) {
				if (method === "POST") {
					posted.push(true);
					return { ok: acknowledgeOk !== false, status: acknowledgeOk === false ? 500 : 200, async json() { return { acknowledged: acknowledgeOk !== false }; } };
				}
				return { ok: noticeReply.ok !== false, status: noticeReply.status === undefined ? 200 : noticeReply.status, async json() { return noticeReply.body; } };
			}
			return { ok: false, status: 404, async json() { return {}; } };
		};
		try {
			const runtime = createHookRuntime();
			// `fetch` in the module scope is the function itself (that is how `pageFetcher` probes it),
			// not a wrapper object.
			applyWith({ configForms: createConfigForms({ served: [ "session-log-upload" ], form: createWritableForm({ mode: "official-only", endpoint: SERVED_ENDPOINT, maxBytes: 8388608 }) }), fetch: globalThis.fetch }, runtime);
			await settle(runtime);
			return { runtime, posted };
		} finally {
			globalThis.fetch = realFetch;
		}
	};

	// ── not acknowledged: the dialog is up ───────────────────────────────────────────────────
	{
		const { runtime } = await renderNotice({ body: { acknowledged: false } });
		const notice = runtime.findAll(function (node) { return node.props.role === "dialog" && node.props["data-dialog"] === "notice"; })[0];
		assert(notice !== undefined, "no notice dialog was rendered for an unacknowledged install");

		const button = runtime.findAll(function (node) { return node.type === "button" && typeof node.props.className === "string" && node.props.className.indexOf("slu-noticeAccept") >= 0; })[0];
		assert(button !== undefined, "the notice has no accept button");
		assert(button.props.disabled === true, "the accept button is live before the box is ticked");

		// There is no backdrop dismiss: the notice mask carries no onClick. (The consent dialog's mask
		// does, so match the one inside the notice panel's overlay by checking all masks with onClick
		// absent — the notice renders exactly one mask and it must be inert.)
		const masks = runtime.findAll(function (node) { return typeof node.props.className === "string" && node.props.className.indexOf("slu-mask") >= 0; });
		assert(masks.length >= 1, "the notice has no mask");
		assert(masks.every(function (node) { return node.props.onClick === undefined; }), "the notice can be dismissed by clicking the backdrop");

		const box = runtime.findAll(function (node) { return node.props["data-notice-ack"] === "true"; })[0];
		assert(box !== undefined, "the notice has no acknowledgement checkbox");
		box.props.onChange({ target: { checked: true } });
		runtime.flush();
		const enabled = runtime.findAll(function (node) { return node.type === "button" && typeof node.props.className === "string" && node.props.className.indexOf("slu-noticeAccept") >= 0; })[0];
		assert(enabled.props.disabled === false, "ticking the box did not enable the accept button");
	}

	// ── acknowledged already: no dialog at all ──────────────────────────────────────────────
	{
		const { runtime } = await renderNotice({ body: { acknowledged: true } });
		const notice = runtime.findAll(function (node) { return node.props.role === "dialog" && node.props["data-dialog"] === "notice"; })[0];
		assert(notice === undefined, "the notice reappeared on an install that already acknowledged it");
	}

	// ── a failed read shows the notice (the safe direction) ─────────────────────────────────
	{
		const { runtime } = await renderNotice({ ok: false, status: 500, body: {} });
		const notice = runtime.findAll(function (node) { return node.props.role === "dialog" && node.props["data-dialog"] === "notice"; })[0];
		assert(notice !== undefined, "a failed acknowledgement read did not show the notice");
	}

	// ── accepting POSTs, and a confirmed write dismisses ────────────────────────────────────
	{
		const { runtime, posted } = await renderNotice({ body: { acknowledged: false } });
		const box = runtime.findAll(function (node) { return node.props["data-notice-ack"] === "true"; })[0];
		box.props.onChange({ target: { checked: true } });
		runtime.flush();
		const button = runtime.findAll(function (node) { return node.type === "button" && typeof node.props.className === "string" && node.props.className.indexOf("slu-noticeAccept") >= 0; })[0];
		button.props.onClick({});
		await settle(runtime);
		assert(posted.length === 1, `accepting must POST exactly once, saw ${posted.length}`);
		const after = runtime.findAll(function (node) { return node.props.role === "dialog" && node.props["data-dialog"] === "notice"; })[0];
		assert(after === undefined, "a confirmed acknowledgement did not dismiss the notice");
	}

	// ── a refused write keeps the dialog up ─────────────────────────────────────────────────
	{
		const { runtime } = await renderNotice({ body: { acknowledged: false } }, false);
		const box = runtime.findAll(function (node) { return node.props["data-notice-ack"] === "true"; })[0];
		box.props.onChange({ target: { checked: true } });
		runtime.flush();
		const button = runtime.findAll(function (node) { return node.type === "button" && typeof node.props.className === "string" && node.props.className.indexOf("slu-noticeAccept") >= 0; })[0];
		button.props.onClick({});
		await settle(runtime);
		const still = runtime.findAll(function (node) { return node.props.role === "dialog" && node.props["data-dialog"] === "notice"; })[0];
		assert(still !== undefined, "the notice closed even though the Host refused to record the acknowledgement");
	}

	return "blocks until ticked, no backdrop dismiss, hides only after the Host confirms, stays up when the write fails";
});

// 27 ─ the folder chooser renders, and a Session can be chosen alone ─────────────────────────
// Two user-reported defects, both of which every earlier check passed through:
//   1. the chooser's class names had NO CSS rule, so it rendered as an unstyled run of text;
//   2. a Session row shared its workspace's key, so ticking a Session ticked the whole workspace and
//      a single conversation could never be selected.
await checkAsync("chooser-ui", "the chooser is styled, and Session ticks are independent of directory ticks", async () => {
	// (1) every class the chooser renders must have a rule, or it silently looks broken.
	for (const name of [ "slu-help", "slu-picker", "slu-checks", "slu-check", "slu-checkPath", "slu-checkWorkspace", "slu-checkSession" ]) {
		assert(new RegExp(`\\.${name}\\s*[{,:]`).test(clientSource), `.${name} has no CSS rule, so the chooser renders unstyled`);
	}
	// (2) the two tick sets are separate, and the Session row keys on the Session id.
	const tickRow = clientSource.slice(clientSource.indexOf("const tickRow = function"), clientSource.indexOf("const rows = [];"));
	assert(tickRow.includes('if (kind === "session") setPickedSessions(apply)'), "a Session tick does not go to its own state");
	assert(tickRow.includes("else setPicked(apply)"), "a directory tick does not go to its own state");
	assert(/tickRow\("session", session\.id,/.test(clientSource), "a Session row is not keyed by its own id");
	// (3) both allowlists are written — saving only the directory one would silently drop Session ticks.
	assert(clientSource.includes('saveField("uploadDirectories", chosenDirectories'), "the directory allowlist is not saved");
	assert(clientSource.includes('saveField("uploadSessionIds", chosenSessions'), "the Session allowlist is not saved");
	return "7 chooser classes styled; the two tick sets are separate; both allowlists are written";
});

// 37 ─ the other-harness import: scan only on click, grouped rows, readable fallbacks ─────────
await checkAsync("foreign-scan", "the block scans only on click, groups by harness, and never prints undefined", async () => {
	const scenario = await foreignScenario({ scan: { status: 200, body: FOREIGN_SCAN_PAYLOAD } });
	// Before the click: the block exists, but nothing has been scanned or fetched.
	const textBefore = textOf(scenario.runtime.tree());
	assert(textBefore.includes("Import from other HARNESSES"), "the import block is missing");
	assert(textBefore.includes("Nothing is scanned until you click Scan."), "the block does not explain that scanning is on demand");
	assert(foreignRows(scenario.runtime).length === 0, "rows were rendered before any scan");
	assert(scenario.fetch.scanCalls.length === 0, "the page scanned on mount");
	assert(foreignButton(scenario.runtime, "send") === undefined, "the send control exists before a scan");
	clickForeign(scenario.runtime, "scan");
	await settle(scenario.runtime);
	assert(scenario.fetch.scanCalls.length === 1, `expected one scan, saw ${scenario.fetch.scanCalls.length}`);
	assert(scenario.fetch.scanCalls[0].method === "GET", "the scan was not a GET");
	assert(scenario.fetch.scanCalls[0].url === "api/session-log-upload.foreign-scan", `the scan fetched ${JSON.stringify(scenario.fetch.scanCalls[0].url)}`);
	const titles = foreignGroupTitles(scenario.runtime);
	assert(titles.length === 3, `expected 3 harness groups, saw ${JSON.stringify(titles)}`);
	assert(titles[0].includes("ZCode") && titles[0].includes("2"), `the first group heading is ${JSON.stringify(titles[0])}`);
	assert(titles[1].includes("Cursor") && titles[1].includes("1"), `the second group heading is ${JSON.stringify(titles[1])}`);
	assert(titles[2].includes("WorkBuddy"), `the third group heading is ${JSON.stringify(titles[2])}`);
	assert(foreignRows(scenario.runtime).length === 3, `expected 3 session rows, saw ${foreignRows(scenario.runtime).length}`);
	const first = foreignRowText(scenario.runtime, "zcode/sess_a");
	assert(first.includes("Refactor the parser"), `the title is missing: ${first}`);
	assert(first.includes("F:\\work\\a"), `the directory is missing: ${first}`);
	assert(first.includes("deepseek/deepseek-v4"), `provider/model is missing: ${first}`);
	assert(first.includes("12 messages"), `the message count is missing: ${first}`);
	const untitled = foreignRowText(scenario.runtime, "zcode/sess_b");
	assert(untitled.includes("Untitled conversation"), `a missing title is not readable: ${untitled}`);
	assert(!/undefined/.test(untitled), `a missing title rendered "undefined": ${untitled}`);
	assert(untitled.includes("No folder reported") && untitled.includes("Model not reported"), `unreported fields are not named: ${untitled}`);
	const all = textOf(scenario.runtime.tree());
	assert(all.includes("Not found on this machine."), "an unavailable harness is not named");
	assert(all.includes("not installed"), "a harness scan error is not shown");
	assert(radios(scenario.runtime).length === 4, "the section stopped rendering its mode controls");
	// A failed scan degrades to one error line: no throw, no invented rows.
	const failed = await foreignScenario({ scan: { status: 404 } });
	clickForeign(failed.runtime, "scan");
	await settle(failed.runtime);
	assert(foreignRows(failed.runtime).length === 0, "a failed scan produced rows");
	assert(textOf(failed.runtime.tree()).includes("The scan could not be read."), "a failed scan is not reported");
	assert(radios(failed.runtime).length === 4, "a failed scan broke the section");
	return "scan on click only, 3 groups, 3 rows, title fallback, unavailable/error groups, failed scan degrades";
});

// 38 ─ the tick draft is independent per row, and Save writes exactly the tick set ────────────
await checkAsync("foreign-ticks", "ticking one row never ticks another, and Save writes exactly the tick set", async () => {
	const scenario = await foreignScenario({ scan: { body: FOREIGN_SCAN_PAYLOAD } });
	clickForeign(scenario.runtime, "scan");
	await settle(scenario.runtime);
	tickForeign(scenario.runtime, "zcode/sess_a", true);
	assert(foreignRow(scenario.runtime, "zcode/sess_a").props.checked === true, "the ticked row is not ticked");
	assert(foreignRow(scenario.runtime, "zcode/sess_b").props.checked === false, "ticking one row ticked its sibling");
	assert(foreignRow(scenario.runtime, "cursor/sess_c").props.checked === false, "ticking one row ticked a row in another group");
	clickForeign(scenario.runtime, "save");
	await settle(scenario.runtime);
	let writes = scenario.form.sets.filter(function (set) { return set[0] === "foreignSessionIds"; });
	assert(writes.length === 1, `Save wrote foreignSessionIds ${writes.length} times`);
	assert(JSON.stringify(writes[0][1]) === JSON.stringify([ "zcode/sess_a" ]), `Save wrote ${JSON.stringify(writes[0][1])}`);
	assert(fieldStateTexts(scenario.runtime).includes("Saved."), "an accepted tick-set write was not confirmed");
	// A second row is added to the SAME draft: both ids are written, in scan order.
	tickForeign(scenario.runtime, "cursor/sess_c", true);
	clickForeign(scenario.runtime, "save");
	await settle(scenario.runtime);
	writes = scenario.form.sets.filter(function (set) { return set[0] === "foreignSessionIds"; });
	assert(JSON.stringify(writes[writes.length - 1][1]) === JSON.stringify([ "zcode/sess_a", "cursor/sess_c" ]), `the second Save wrote ${JSON.stringify(writes[writes.length - 1][1])}`);
	// Unticking a saved row removes it: the draft is authoritative, not the saved value.
	tickForeign(scenario.runtime, "zcode/sess_a", false);
	clickForeign(scenario.runtime, "save");
	await settle(scenario.runtime);
	writes = scenario.form.sets.filter(function (set) { return set[0] === "foreignSessionIds"; });
	assert(JSON.stringify(writes[writes.length - 1][1]) === JSON.stringify([ "cursor/sess_c" ]), `unticking did not remove the id: ${JSON.stringify(writes[writes.length - 1][1])}`);
	// Nothing but the tick set is written by this block.
	for (const set of scenario.form.sets) assert(set[0] === "foreignSessionIds", `the import block wrote ${set[0]}`);
	// A saved allowlist is the draft's starting point: the page reads back what it wrote.
	const saved = await foreignScenario({ scan: { body: FOREIGN_SCAN_PAYLOAD }, savedIds: [ "cursor/sess_c" ] });
	clickForeign(saved.runtime, "scan");
	await settle(saved.runtime);
	assert(foreignRow(saved.runtime, "cursor/sess_c").props.checked === true, "a saved tick set was not read back");
	assert(foreignRow(saved.runtime, "zcode/sess_a").props.checked === false, "seeding the draft ticked an unsaved row");
	return "3 independent ticks, whole tick set written, untick removes, read back on scan, no other field written";
});

// 39 ─ the consent gate holds, and the POST body is exactly {id} ────────────────────────────────
await checkAsync("foreign-consent", "the send button is disabled at zero and nothing POSTs before the consent dialog is confirmed", async () => {
	const scenario = await foreignScenario({
		scan: { body: FOREIGN_SCAN_PAYLOAD },
		uploads: [ { body: { ok: true, requests: 2 } }, { body: { ok: true, requests: 1 } } ]
	});
	clickForeign(scenario.runtime, "scan");
	await settle(scenario.runtime);
	const idle = foreignButton(scenario.runtime, "send");
	assert(idle !== undefined, "no send button after a scan");
	assert(idle.props.disabled === true, "the send button is enabled with nothing ticked");
	assert(textOf(idle).includes("0"), `the send label does not carry the count: ${textOf(idle)}`);
	tickForeign(scenario.runtime, "zcode/sess_a", true);
	tickForeign(scenario.runtime, "cursor/sess_c", true);
	const ready = foreignButton(scenario.runtime, "send");
	assert(ready.props.disabled !== true, "the send button stayed disabled with two ticks");
	assert(textOf(ready).includes("2"), `the send label does not carry the tick count: ${textOf(ready)}`);
	assert(scenario.fetch.uploadCalls.length === 0, "a POST happened before any confirmation");
	clickForeign(scenario.runtime, "send");
	// Clicking the block's button opens the dialog; the POSTs must wait for the confirm button.
	assert(scenario.fetch.uploadCalls.length === 0, "clicking send POSTed before the dialog was confirmed");
	const opened = dialog(scenario.runtime);
	assert(opened !== undefined, "no consent dialog before sending");
	const dialogBody = textOf(opened);
	assert(/not DSH sessions/.test(dialogBody), `the dialog does not say these are not DSH sessions: ${dialogBody}`);
	assert(/wrapped as a DSH session record/.test(dialogBody), `the dialog does not say the content is wrapped as a DSH session record: ${dialogBody}`);
	assert(dialogBody.includes(SERVED_ENDPOINT), `the dialog does not name the endpoint: ${dialogBody}`);
	assert(dialogBody.includes("Cancel"), "the dialog has no Cancel");
	// Cancel closes the gate and sends nothing.
	clickButton(scenario.runtime, "Cancel");
	await settle(scenario.runtime);
	assert(dialog(scenario.runtime) === undefined, "Cancel did not close the dialog");
	assert(scenario.fetch.uploadCalls.length === 0, "Cancel POSTed");
	// Confirm: exactly one POST per ticked id, each body exactly {id}.
	clickForeign(scenario.runtime, "send");
	clickButton(scenario.runtime, "Send");
	await settle(scenario.runtime);
	assert(dialog(scenario.runtime) === undefined, "the dialog stayed open after confirming");
	assert(scenario.fetch.uploadCalls.length === 2, `expected 2 POSTs, saw ${scenario.fetch.uploadCalls.length}`);
	for (const call of scenario.fetch.uploadCalls) {
		assert(call.method === "POST", "a send was not a POST");
		assert(call.url === "api/session-log-upload.foreign-upload", `a send fetched ${JSON.stringify(call.url)}`);
		assert(JSON.stringify(Object.keys(call.body)) === JSON.stringify([ "id" ]), `a send invented request fields: ${JSON.stringify(call.body)}`);
	}
	assert(
		JSON.stringify(scenario.fetch.uploadCalls.map(function (call) { return call.body.id; })) === JSON.stringify([ "zcode/sess_a", "cursor/sess_c" ]),
		"the POSTs are not the ticked ids in scan order"
	);
	return "disabled at zero, count in the label, dialog before any POST, cancel cancels, body exactly {id}";
});

// 40 ─ serial progress with a failure row ──────────────────────────────────────────────────────
await checkAsync("foreign-serial", "one POST at a time, per-row progress, and a failure does not stop the batch", async () => {
	const scenario = await foreignScenario({
		scan: { body: FOREIGN_SCAN_PAYLOAD },
		uploads: [ { defer: true }, { defer: true }, { defer: true } ]
	});
	clickForeign(scenario.runtime, "scan");
	await settle(scenario.runtime);
	for (const id of [ "zcode/sess_a", "zcode/sess_b", "cursor/sess_c" ]) tickForeign(scenario.runtime, id, true);
	clickForeign(scenario.runtime, "send");
	clickButton(scenario.runtime, "Send");
	await null;
	scenario.runtime.flush();
	assert(scenario.fetch.uploadCalls.length === 1, `the page started ${scenario.fetch.uploadCalls.length} POSTs at once, expected 1`);
	assert(scenario.fetch.controls.length === 1, `expected one pending request, saw ${scenario.fetch.controls.length}`);
	assert(foreignStatusTextOf(scenario.runtime, "zcode/sess_a").includes("Sending"), `row a says ${JSON.stringify(foreignStatusTextOf(scenario.runtime, "zcode/sess_a"))}`);
	assert(foreignStatusTextOf(scenario.runtime, "zcode/sess_b").includes("Waiting"), `row b says ${JSON.stringify(foreignStatusTextOf(scenario.runtime, "zcode/sess_b"))}`);
	assert(foreignStatusTextOf(scenario.runtime, "cursor/sess_c").includes("Waiting"), `row c says ${JSON.stringify(foreignStatusTextOf(scenario.runtime, "cursor/sess_c"))}`);
	assert(radios(scenario.runtime).length === 4 && foreignRows(scenario.runtime).length === 3, "the section blanked while sending");
	// Releasing the first reply lets the second POST start, and only then.
	scenario.fetch.controls[0].resolve({ ok: true, requests: 2 });
	await settle(scenario.runtime);
	assert(scenario.fetch.uploadCalls.length === 2, `after the first reply there are ${scenario.fetch.uploadCalls.length} POSTs, expected 2`);
	assert(foreignStatusTextOf(scenario.runtime, "zcode/sess_a").includes("Sent (2 requests)"), `row a says ${JSON.stringify(foreignStatusTextOf(scenario.runtime, "zcode/sess_a"))}`);
	assert(foreignStatusTextOf(scenario.runtime, "zcode/sess_b").includes("Sending"), `row b says ${JSON.stringify(foreignStatusTextOf(scenario.runtime, "zcode/sess_b"))}`);
	assert(foreignStatusTextOf(scenario.runtime, "cursor/sess_c").includes("Waiting"), `row c says ${JSON.stringify(foreignStatusTextOf(scenario.runtime, "cursor/sess_c"))}`);
	// The second request fails with a host error; the failure stays on its row and the loop continues.
	scenario.fetch.controls[1].resolve({ ok: false, error: "boom" });
	await settle(scenario.runtime);
	assert(scenario.fetch.uploadCalls.length === 3, `the batch stopped after a failure: ${scenario.fetch.uploadCalls.length} POSTs`);
	assert(foreignStatusTextOf(scenario.runtime, "zcode/sess_b").includes("Failed: boom"), `the failure is not on its row: ${JSON.stringify(foreignStatusTextOf(scenario.runtime, "zcode/sess_b"))}`);
	assert(foreignStatusTextOf(scenario.runtime, "cursor/sess_c").includes("Sending"), `row c says ${JSON.stringify(foreignStatusTextOf(scenario.runtime, "cursor/sess_c"))}`);
	scenario.fetch.controls[2].resolve({ ok: true, requests: 1 });
	await settle(scenario.runtime);
	assert(foreignStatusTextOf(scenario.runtime, "cursor/sess_c").includes("Sent (1 requests)"), `row c says ${JSON.stringify(foreignStatusTextOf(scenario.runtime, "cursor/sess_c"))}`);
	// The section kept rendering throughout, and the send control recovers for another batch.
	assert(textOf(scenario.runtime.tree()).includes("Import from other HARNESSES"), "the import block vanished during the send");
	assert(radios(scenario.runtime).length === 4 && foreignRows(scenario.runtime).length === 3, "the section blanked during the send");
	const send = foreignButton(scenario.runtime, "send");
	assert(send !== undefined && send.props.disabled !== true, "the send control did not recover after a batch");
	return "1 POST at a time, waiting/sending/sent/failed per row, a failure does not stop the batch, section never blank";
});

await checkAsync("foreign-truncated", "a truncated import says so instead of only 'Sent'", async () => {
	const scenario = await foreignScenario({
		scan: { body: FOREIGN_SCAN_PAYLOAD },
		uploads: [ { body: { ok: true, requests: 1, truncated: true } }, { body: { ok: true, requests: 1 } } ]
	});
	clickForeign(scenario.runtime, "scan");
	await settle(scenario.runtime);
	for (const id of [ "zcode/sess_a", "zcode/sess_b" ]) tickForeign(scenario.runtime, id, true);
	clickForeign(scenario.runtime, "send");
	clickButton(scenario.runtime, "Send");
	await settle(scenario.runtime);
	const truncated = foreignStatusTextOf(scenario.runtime, "zcode/sess_a");
	const whole = foreignStatusTextOf(scenario.runtime, "zcode/sess_b");
	assert(truncated.includes("first part"), `a truncated row reads ${JSON.stringify(truncated)}`);
	assert(!whole.includes("first part"), `a complete row was marked truncated: ${JSON.stringify(whole)}`);
	assert(truncated !== whole, "truncated and complete imports render the same text");
	return "a truncated import is distinguishable from a complete one";
});

// 41 ─ the DSH folder chooser cascades: a ticked folder covers its Sessions ──────────────────
await checkAsync("chooser-cascade", "a ticked folder covers its Sessions: checked, disabled, hinted, and not saved as Session ids", async () => {
	const scenario = await chooserScenario(CHOOSER_WORKSPACES, { uploadSessionIds: [ "s2" ] });
	await openChooser(scenario.runtime);
	// The saved individual tick is the Session's own state before any folder is ticked.
	assert(chooserCheckbox(scenario.runtime, "session", "s2").props.checked === true, "a saved Session id is not shown as ticked");
	assert(chooserCheckbox(scenario.runtime, "session", "s2").props.disabled !== true, "a saved Session id is disabled before any folder is ticked");
	// Ticking the folder covers every Session under it: checked, disabled, and explained in place.
	toggleChooser(scenario.runtime, "workspace", "f:/work/one", true);
	for (const id of [ "s1", "s2" ]) {
		const box = chooserCheckbox(scenario.runtime, "session", id);
		assert(box !== undefined, `Session ${id} is not rendered under its folder`);
		assert(box.props.checked === true, `Session ${id} is not checked under a ticked folder`);
		assert(box.props.disabled === true, `Session ${id} is live under a ticked folder`);
		const row = chooserRow(scenario.runtime, "session", id);
		assert(textOf(row).includes("Covered by the ticked folder"), `Session ${id} has no coverage hint: ${textOf(row)}`);
	}
	// The cascade does not leak into another folder's Sessions.
	assert(chooserCheckbox(scenario.runtime, "session", "s3").props.checked === false, "the cascade leaked into another folder");
	// Unticking the folder returns each row to its own state: s2 keeps its saved tick, s1 is empty.
	toggleChooser(scenario.runtime, "workspace", "f:/work/one", false);
	assert(chooserCheckbox(scenario.runtime, "session", "s1").props.checked === false, "s1 stayed checked after the folder was unticked");
	assert(chooserCheckbox(scenario.runtime, "session", "s1").props.disabled !== true, "s1 stayed disabled after the folder was unticked");
	assert(chooserCheckbox(scenario.runtime, "session", "s2").props.checked === true, "a saved Session tick was lost when the folder was unticked");
	assert(chooserCheckbox(scenario.runtime, "session", "s2").props.disabled !== true, "s2 stayed disabled after the folder was unticked");
	// An individual tick made before the folder covers it is still that row's own state.
	toggleChooser(scenario.runtime, "session", "s1", true);
	toggleChooser(scenario.runtime, "workspace", "f:/work/one", true);
	assert(chooserCheckbox(scenario.runtime, "session", "s1").props.disabled === true, "the individually ticked row was not covered");
	// Save writes the folder list and only Sessions ticked INDIVIDUALLY: s1 and s2 are merely covered.
	await saveChooser(scenario.runtime);
	const directories = scenario.form.sets.filter(function (set) { return set[0] === "uploadDirectories"; });
	const sessions = scenario.form.sets.filter(function (set) { return set[0] === "uploadSessionIds"; });
	assert(directories.length === 1 && JSON.stringify(directories[0][1]) === JSON.stringify([ "F:\\work\\one" ]), `the folder write is ${JSON.stringify(directories.map(function (set) { return set[1]; }))}`);
	assert(sessions.length === 1 && JSON.stringify(sessions[0][1]) === JSON.stringify([]), `the Session write persisted covered ids: ${JSON.stringify(sessions.map(function (set) { return set[1]; }))}`);
	assert(!/undefined/.test(textOf(scenario.runtime.tree())), "the chooser rendered undefined");
	// A folder that is ALREADY saved is seeded into the draft, so it shows checked on open AND can
	// be unticked again: the cascade must not be a one-way street through the saved value.
	const savedFolder = await chooserScenario(CHOOSER_WORKSPACES, { uploadDirectories: [ "F:\\work\\one" ] });
	await openChooser(savedFolder.runtime);
	assert(chooserCheckbox(savedFolder.runtime, "workspace", "f:/work/one").props.checked === true, "a saved folder is not shown as ticked");
	assert(chooserCheckbox(savedFolder.runtime, "session", "s1").props.disabled === true, "a saved folder does not cover its Sessions");
	toggleChooser(savedFolder.runtime, "workspace", "f:/work/one", false);
	assert(chooserCheckbox(savedFolder.runtime, "workspace", "f:/work/one").props.checked === false, "a saved folder could not be unticked");
	assert(chooserCheckbox(savedFolder.runtime, "session", "s1").props.disabled !== true, "unticking a saved folder left its Sessions disabled");
	assert(chooserCheckbox(savedFolder.runtime, "session", "s1").props.checked === false, "unticking a saved folder left its Sessions checked");
	return "covered Sessions checked+disabled+hinted, own state restored on untick (including a saved folder), covered ids not saved as Session ids";
});

// 42 ─ an already-saved folder selection can be adjusted again ────────────────────────────────
// The user-reported defect: after ticking a folder and saving, the chooser could not be reopened.
// With a saved selection the toggle renders checked, so its ON branch never runs again; without a
// separate entry point the only affordance left was its OFF branch, which CLEARS the selection.
await checkAsync("chooser-adjust", "a saved folder selection has an adjust control that reopens the picker with the saved ticks", async () => {
	const scenario = await chooserScenario(CHOOSER_WORKSPACES, { uploadDirectories: [ "F:\\work\\one" ] });
	// Fresh render with a saved selection: the picker is closed, so no rows exist yet.
	const chooserRows = function () {
		return scenario.runtime.findAll(function (node) {
			return node.type === "input" && (node.props["data-workspace"] !== undefined || node.props["data-session"] !== undefined);
		});
	};
	assert(chooserRows().length === 0, `chooser rows rendered before the picker was opened: ${chooserRows().length}`);
	const adjust = scenario.runtime.findAll(function (node) { return node.type === "button" && node.props["data-action"] === "adjust-directories"; })[0];
	assert(adjust !== undefined, "a saved folder selection has no adjust control");
	const toggle = scenario.runtime.findAll(function (node) { return node.props["data-toggle"] === "restrict-directories"; })[0];
	assert(toggle.props.checked === true, "the saved selection is not shown as restricted");
	// Clicking adjust opens the picker exactly like the opt-in's ON branch, with the scan seeding the draft.
	adjust.props.onClick({});
	await settle(scenario.runtime);
	assert(scenario.runtime.findAll(function (node) { return typeof node.props.className === "string" && node.props.className.indexOf("slu-picker") >= 0; }).length > 0, "adjust did not open the picker");
	assert(chooserRows().length > 0, "adjust opened the picker but rendered no rows");
	const savedFolder = chooserCheckbox(scenario.runtime, "workspace", "f:/work/one");
	assert(savedFolder !== undefined && savedFolder.props.checked === true, "the saved folder row is not ticked in the reopened picker");
	assert(chooserCheckbox(scenario.runtime, "session", "s1").props.disabled === true, "the saved folder does not cover its Sessions in the reopened picker");
	// Adjust the selection: untick the saved folder, tick another, save. Only the new folder is written.
	toggleChooser(scenario.runtime, "workspace", "f:/work/one", false);
	toggleChooser(scenario.runtime, "workspace", "f:/work/two", true);
	await saveChooser(scenario.runtime);
	const directories = scenario.form.sets.filter(function (set) { return set[0] === "uploadDirectories"; });
	assert(directories.length === 1, `the adjusted save wrote the folder list ${directories.length} times`);
	assert(JSON.stringify(directories[0][1]) === JSON.stringify([ "F:\\work\\two" ]), `the adjusted save wrote ${JSON.stringify(directories[0][1])}`);
	// The entry point survives the write and a re-render: it is still there to adjust again.
	const after = scenario.runtime.findAll(function (node) { return node.type === "button" && node.props["data-action"] === "adjust-directories"; })[0];
	assert(after !== undefined, "the adjust control disappeared after a save");
	return "saved folder shows a closed picker + adjust control; adjust opens it with the saved tick; editing and saving writes only the new folder";
});

// 43 ─ delegated conversations: a child renders after its parent and keeps its own id ─────────
await checkAsync("foreign-parent", "a delegated child renders after its parent, and still ticks, saves and sends by its own id", async () => {
	const scenario = await foreignScenario({
		scan: { body: FOREIGN_PARENT_PAYLOAD },
		uploads: [ { body: { ok: true, requests: 1 } } ]
	});
	clickForeign(scenario.runtime, "scan");
	await settle(scenario.runtime);
	// Delegated rows are collapsed by default now; expand so the indented order is assertable.
	clickForeign(scenario.runtime, "children");
	await settle(scenario.runtime);
	const order = foreignRowOrder(scenario.runtime);
	assert(
		JSON.stringify(order) === JSON.stringify([ "zcode/sess_root", "zcode/sess_child", "zcode/sess_orphan", "zcode/sess_plain" ]),
		`the row order is ${JSON.stringify(order)}`
	);
	const child = foreignRowLabel(scenario.runtime, "zcode/sess_child");
	const root = foreignRowLabel(scenario.runtime, "zcode/sess_root");
	const orphan = foreignRowLabel(scenario.runtime, "zcode/sess_orphan");
	const plain = foreignRowLabel(scenario.runtime, "zcode/sess_plain");
	assert(child !== undefined && child.props.className.indexOf("slu-checkSessionChild") >= 0, "the child row lost its child class");
	assert(root.props.className.indexOf("slu-checkSessionChild") < 0, "the parent row was marked as a child");
	assert(orphan.props.className.indexOf("slu-checkSessionChild") < 0, "a dangling parentId marked the row as a child");
	assert(plain.props.className.indexOf("slu-checkSessionChild") < 0, "a missing parentId marked the row as a child");
	assert(!/undefined/.test(textOf(scenario.runtime.tree())), "a parentId rendered as undefined");
	// A row whose parent is not in the payload is a normal row and is still tickable.
	tickForeign(scenario.runtime, "zcode/sess_orphan", true);
	assert(foreignRow(scenario.runtime, "zcode/sess_orphan").props.checked === true, "a row with a dangling parentId cannot be ticked");
	// The child saves and sends its own id only; the parent is not implied.
	tickForeign(scenario.runtime, "zcode/sess_orphan", false);
	tickForeign(scenario.runtime, "zcode/sess_child", true);
	clickForeign(scenario.runtime, "save");
	await settle(scenario.runtime);
	const written = scenario.form.sets.filter(function (set) { return set[0] === "foreignSessionIds"; });
	assert(written.length === 1 && JSON.stringify(written[0][1]) === JSON.stringify([ "zcode/sess_child" ]), `the child tick wrote ${JSON.stringify(written.map(function (set) { return set[1]; }))}`);
	clickForeign(scenario.runtime, "send");
	clickButton(scenario.runtime, "Send");
	await settle(scenario.runtime);
	assert(scenario.fetch.uploadCalls.length === 1, `the child send made ${scenario.fetch.uploadCalls.length} POSTs`);
	assert(scenario.fetch.uploadCalls[0].body.id === "zcode/sess_child", `the child sent ${JSON.stringify(scenario.fetch.uploadCalls[0].body)}`);
	return "child after parent with the child class, dangling/missing parentId top-level and tickable, child saves and sends its own id";
});

// 44 ─ ticking a conversation selects its delegated descendants too ───────────────────────────
await checkAsync("foreign-parent-cascade", "ticking a parent ticks its whole lineage subtree; unticking is symmetric and a child tick stays local", async () => {
	const scenario = await foreignScenario({
		scan: { body: FOREIGN_TREE_PAYLOAD },
		uploads: [
			{ body: { ok: true, requests: 1 } },
			{ body: { ok: true, requests: 1 } },
			{ body: { ok: true, requests: 1 } },
			{ body: { ok: true, requests: 1 } }
		]
	});
	clickForeign(scenario.runtime, "scan");
	await settle(scenario.runtime);
	// The lineage is collapsed by default; the cascade itself runs over the whole payload either
	// way, but the rows must be visible for this check's per-row tick assertions.
	clickForeign(scenario.runtime, "children");
	await settle(scenario.runtime);
	const ticked = function (id) { return foreignRow(scenario.runtime, id).props.checked; };
	const allIds = [ "zcode/sess_root", "zcode/sess_child1", "zcode/sess_grand", "zcode/sess_child2" ];
	// Ticking the root ticks the children and the grandchild, transitively.
	tickForeign(scenario.runtime, "zcode/sess_root", true);
	for (const id of allIds) assert(ticked(id) === true, `ticking the root left ${id} unticked`);
	// Unticking the root is symmetric: the whole subtree goes with it.
	tickForeign(scenario.runtime, "zcode/sess_root", false);
	for (const id of allIds) assert(ticked(id) === false, `unticking the root left ${id} ticked`);
	// A child tick stays inside that child's own subtree: its parent and sibling are untouched.
	tickForeign(scenario.runtime, "zcode/sess_child2", true);
	assert(ticked("zcode/sess_child2") === true, "the ticked child is not ticked");
	assert(ticked("zcode/sess_root") === false, "ticking a child ticked its parent");
	assert(ticked("zcode/sess_child1") === false, "ticking a child ticked its sibling");
	assert(ticked("zcode/sess_grand") === false, "ticking a child ticked an unrelated grandchild");
	// The expanded parent set is what the config write carries, one id per ticked row.
	tickForeign(scenario.runtime, "zcode/sess_child2", false);
	tickForeign(scenario.runtime, "zcode/sess_root", true);
	clickForeign(scenario.runtime, "save");
	await settle(scenario.runtime);
	const writes = scenario.form.sets.filter(function (set) { return set[0] === "foreignSessionIds"; });
	assert(writes.length === 1, `the save wrote foreignSessionIds ${writes.length} times`);
	const expected = [ "zcode/sess_child1", "zcode/sess_child2", "zcode/sess_grand", "zcode/sess_root" ];
	assert(JSON.stringify(writes[0][1].slice().sort()) === JSON.stringify(expected), `the saved ids are ${JSON.stringify(writes[0][1])}`);
	// The send uses the same expanded set: one POST per ticked row, the ids unchanged in shape.
	clickForeign(scenario.runtime, "send");
	clickButton(scenario.runtime, "Send");
	// Four sequential POSTs need more microtask passes than the default settle provides.
	for (let pass = 0; pass < 10 && scenario.fetch.uploadCalls.length < 4; pass++) {
		await settle(scenario.runtime, 2);
	}
	const posted = scenario.fetch.uploadCalls.map(function (call) { return call.body.id; }).sort();
	assert(posted.length === 4, `the send made ${posted.length} POSTs, expected 4`);
	assert(JSON.stringify(posted) === JSON.stringify(expected), `the sent ids are ${JSON.stringify(posted)}`);
	return "root tick/untick cascades through all 4 rows, a child tick stays local, save and send carry the expanded set";
});

// 45 ─ delegated conversations collapse by default without changing what gets sent ─────────────
await checkAsync("foreign-collapse", "delegated conversations are hidden by default, and a collapsed parent still cascades into its hidden children", async () => {
	const scenario = await foreignScenario({
		scan: { body: FOREIGN_TREE_PAYLOAD },
		uploads: [
			{ body: { ok: true, requests: 1 } },
			{ body: { ok: true, requests: 1 } },
			{ body: { ok: true, requests: 1 } },
			{ body: { ok: true, requests: 1 } }
		]
	});
	clickForeign(scenario.runtime, "scan");
	await settle(scenario.runtime);
	// Default state is collapsed: only the top-level row is rendered, and the control says how
	// many delegated rows it is hiding (two children + one grandchild).
	assert(JSON.stringify(foreignRowOrder(scenario.runtime)) === JSON.stringify([ "zcode/sess_root" ]), `the initial render is ${JSON.stringify(foreignRowOrder(scenario.runtime))}`);
	const collapsedToggle = foreignButton(scenario.runtime, "children");
	assert(collapsedToggle !== undefined, "no control to show delegated conversations");
	assert(textOf(collapsedToggle).includes("3"), `the control does not report the hidden count: ${textOf(collapsedToggle)}`);
	// Tick the visible parent: the cascade runs over the whole payload, so the hidden rows tick
	// with it, and both the save and the send count describe the real expanded set.
	tickForeign(scenario.runtime, "zcode/sess_root", true);
	const sendLabel = textOf(foreignButton(scenario.runtime, "send"));
	assert(sendLabel.includes("4"), `the send count ignores the hidden descendants: ${sendLabel}`);
	clickForeign(scenario.runtime, "save");
	await settle(scenario.runtime);
	const writes = scenario.form.sets.filter(function (set) { return set[0] === "foreignSessionIds"; });
	assert(writes.length === 1, `the save wrote foreignSessionIds ${writes.length} times`);
	const expected = [ "zcode/sess_child1", "zcode/sess_child2", "zcode/sess_grand", "zcode/sess_root" ];
	assert(JSON.stringify(writes[0][1].slice().sort()) === JSON.stringify(expected), `the collapsed save wrote ${JSON.stringify(writes[0][1])}`);
	// Expanding shows every row again, still ticked.
	clickForeign(scenario.runtime, "children");
	await settle(scenario.runtime);
	assert(foreignRowOrder(scenario.runtime).length === 4, `the expanded render has ${foreignRowOrder(scenario.runtime).length} rows`);
	for (const id of expected) assert(foreignRow(scenario.runtime, id).props.checked === true, `${id} lost its tick when expanded`);
	// Give every row a status, so the collapse can prove statuses are kept too.
	clickForeign(scenario.runtime, "send");
	clickButton(scenario.runtime, "Send");
	for (let pass = 0; pass < 10 && scenario.fetch.uploadCalls.length < 4; pass++) await settle(scenario.runtime, 2);
	assert(scenario.fetch.uploadCalls.length === 4, `the send made ${scenario.fetch.uploadCalls.length} POSTs`);
	assert(foreignStatusTextOf(scenario.runtime, "zcode/sess_child1").includes("Sent"), "the child row has no status before collapsing");
	// Collapsing hides the rows again without clearing ticks or statuses.
	clickForeign(scenario.runtime, "children");
	await settle(scenario.runtime);
	assert(JSON.stringify(foreignRowOrder(scenario.runtime)) === JSON.stringify([ "zcode/sess_root" ]), `the collapsed render is ${JSON.stringify(foreignRowOrder(scenario.runtime))}`);
	assert(foreignStatusTextOf(scenario.runtime, "zcode/sess_root").includes("Sent"), "collapsing cleared the visible row's status");
	assert(textOf(foreignButton(scenario.runtime, "children")).includes("3"), "the control does not report the hidden count after collapsing");
	// Expanding again restores every row with its tick and status intact.
	clickForeign(scenario.runtime, "children");
	await settle(scenario.runtime);
	assert(foreignRowOrder(scenario.runtime).length === 4, "the second expand did not restore every row");
	for (const id of expected) assert(foreignRow(scenario.runtime, id).props.checked === true, `${id} lost its tick after collapse and expand`);
	for (const id of [ "zcode/sess_child1", "zcode/sess_child2", "zcode/sess_grand" ]) {
		assert(foreignStatusTextOf(scenario.runtime, id).includes("Sent"), `${id} lost its status after collapse and expand`);
	}
	return "collapsed by default with the hidden count, hidden rows still cascade into save and send, expand restores rows with ticks and statuses intact";
});

// 46 ─ the plugin update block: click-only checks with three honest result states ─────────────
await checkAsync("update-check", "the update block fetches only on click and renders the three check states", async () => {
	const scenario = await updateScenario({ checks: [ UPDATE_LATEST, UPDATE_AVAILABLE, UPDATE_CHECK_ERROR ] });
	const runtime = scenario.runtime;
	// Nothing on mount: no check call, and both reported values say so instead of inventing one.
	assert(scenario.fetch.checkCalls.length === 0, `the page checked on mount: ${scenario.fetch.checkCalls.length} calls`);
	assert(updateText(runtime).includes("Plugin update"), "the update block is missing");
	assert(updateValue(runtime, "current") === "Not reported by the Host", `current version: ${JSON.stringify(updateValue(runtime, "current"))}`);
	assert(updateValue(runtime, "manifest") === "Not reported by the Host", `manifest value: ${JSON.stringify(updateValue(runtime, "manifest"))}`);
	assert(updateButton(runtime, "upgrade") === undefined, "the upgrade control exists before any check");
	// 1. already up to date.
	const checkButton = updateButton(runtime, "check");
	assert(checkButton !== undefined, "the check button is missing");
	checkButton.props.onClick({});
	runtime.flush();
	assert(updateText(runtime).includes("Checking…"), "the checking state is not shown");
	await settle(runtime);
	assert(scenario.fetch.checkCalls.length === 1, `expected one check, saw ${scenario.fetch.checkCalls.length}`);
	assert(scenario.fetch.checkCalls[0].method === "GET", "the check was not a GET");
	assert(scenario.fetch.checkCalls[0].url === "api/session-log-upload.update-check", `check fetched ${JSON.stringify(scenario.fetch.checkCalls[0].url)}`);
	assert(updateText(runtime).includes("Already up to date (1.2.0)."), `the up-to-date state is missing: ${updateText(runtime)}`);
	assert(updateButton(runtime, "upgrade") === undefined, "the upgrade control exists when already current");
	// 2. update available: version, notes and file count, plus the upgrade action.
	updateButton(runtime, "check").props.onClick({});
	await settle(runtime);
	assert(updateText(runtime).includes("Version 1.2.0 is available."), `the available state is missing: ${updateText(runtime)}`);
	assert(updateText(runtime).includes("Adds the in-app update block"), "the notes are missing");
	assert(updateText(runtime).includes("Files: 2"), `the file count is missing: ${JSON.stringify(updateText(runtime))}`);
	assert(updateButton(runtime, "upgrade") !== undefined, "no upgrade control for an available update");
	// 3. check failed: the Host's error string is shown and the upgrade action is gone.
	updateButton(runtime, "check").props.onClick({});
	await settle(runtime);
	assert(updateText(runtime).includes("Update check failed: manifest unreachable"), `the failed state is missing: ${updateText(runtime)}`);
	assert(updateButton(runtime, "upgrade") === undefined, "the upgrade control survived a failed check");
	// The reported values come from the payload, not from the page.
	assert(updateValue(runtime, "current") === "1.0.0", `current version after checking: ${JSON.stringify(updateValue(runtime, "current"))}`);
	assert(updateValue(runtime, "manifest") === "https://example.test/update-manifest.json", `manifest after checking: ${JSON.stringify(updateValue(runtime, "manifest"))}`);
	assert(radios(runtime).length === 4, "the section stopped rendering its mode controls");
	return "no fetch on mount, checking state, up to date, available with notes/files, failed with the Host error";
});

// 47 ─ the upgrade gate: consent first, then phases, then done ────────────────────────────────
await checkAsync("update-gate", "the upgrade runs only after the consent dialog, shows phases, and reports the new version", async () => {
	const scenario = await updateScenario({ checks: [ UPDATE_AVAILABLE ], apply: { defer: true }, fakeTimer: true });
	const runtime = scenario.runtime;
	updateButton(runtime, "check").props.onClick({});
	await settle(runtime);
	assert(updateButton(runtime, "upgrade") !== undefined, "no upgrade control for an available update");
	assert(scenario.fetch.applyCalls.length === 0, "an apply request happened before any click");
	updateButton(runtime, "upgrade").props.onClick({});
	runtime.flush();
	assert(scenario.fetch.applyCalls.length === 0, "an apply request happened before the dialog was confirmed");
	const opened = dialog(runtime);
	assert(opened !== undefined, "the upgrade did not open the consent dialog");
	const body = textOf(opened);
	assert(/downloaded and replaced/.test(body), `the body does not mention replacing files: ${body}`);
	assert(/rolls back automatically/.test(body), `the body does not mention the automatic rollback: ${body}`);
	assert(/restarted/.test(body), `the body does not mention the required restart: ${body}`);
	assert(/not signed/.test(body), `the body does not say the manifest is unsigned: ${body}`);
	assert(body.includes("https://example.test/update-manifest.json"), "the dialog does not name the manifest (the trust root)");
	// Confirm: the POST starts, and the phases are observable while it is pending.
	clickButton(runtime, "Upgrade");
	runtime.flush();
	assert(scenario.fetch.applyCalls.length === 1, `expected one apply POST, saw ${scenario.fetch.applyCalls.length}`);
	assert(scenario.fetch.applyCalls[0].method === "POST", "the apply was not a POST");
	assert(scenario.fetch.applyCalls[0].url === "api/session-log-upload.update-apply", `apply fetched ${JSON.stringify(scenario.fetch.applyCalls[0].url)}`);
	assert(scenario.fetch.applyCalls[0].body === "{}", `the apply body is ${JSON.stringify(scenario.fetch.applyCalls[0].body)}, expected {}`);
	assert(updateText(runtime).includes("Downloading the update…"), `the downloading phase is missing: ${updateText(runtime)}`);
	scenario.timers[0]();
	runtime.flush();
	assert(updateText(runtime).includes("Writing the files…"), `the writing phase is missing: ${updateText(runtime)}`);
	// Release the apply: done shows the new version, the backup directory and the restart hint.
	scenario.fetch.controls[0].resolve(UPDATE_APPLY_OK);
	await settle(runtime);
	assert(updateText(runtime).includes("Updated to version 1.2.0."), `the done state is missing: ${updateText(runtime)}`);
	assert(updateValue(runtime, "backup") === UPDATE_APPLY_OK.backupDir, `backup directory: ${JSON.stringify(updateValue(runtime, "backup"))}`);
	assert(updateText(runtime).includes("Restart DSH for the new version to take effect."), "the restart hint is missing");
	assert(updateText(runtime).includes("Plugin update"), "the block disappeared after the upgrade");
	assert(radios(runtime).length === 4, "the section stopped rendering during the upgrade");
	return "upgrade only after consent, body covers replace/rollback/restart/unsigned, phases downloading+writing+done, backup and restart shown";
});

// 48 ─ a failed apply keeps the block rendered and names the reason ───────────────────────────
await checkAsync("update-failed", "a failed apply shows the failure and leaves the block usable", async () => {
	const scenario = await updateScenario({
		checks: [ UPDATE_AVAILABLE ],
		apply: { status: 200, body: { ok: false, from: "1.0.0", to: null, files: [], backupDir: null, reload: null, error: "sha256 mismatch on client.js" } }
	});
	const runtime = scenario.runtime;
	updateButton(runtime, "check").props.onClick({});
	await settle(runtime);
	updateButton(runtime, "upgrade").props.onClick({});
	runtime.flush();
	clickButton(runtime, "Upgrade");
	await settle(runtime);
	assert(updateText(runtime).includes("Update failed: sha256 mismatch on client.js"), `the failure is not shown: ${updateText(runtime)}`);
	assert(updateText(runtime).includes("Plugin update"), "the block disappeared after a failed apply");
	assert(updateButton(runtime, "check") !== undefined, "the check control disappeared after a failed apply");
	assert(updateButton(runtime, "upgrade") !== undefined, "the update can no longer be retried after a failure");
	assert(updateValue(runtime, "current") === "1.0.0", "the reported version disappeared after a failed apply");
	assert(radios(runtime).length === 4, "the section stopped rendering after a failed apply");
	return "failed apply names the Host error, block and retry stay rendered";
});

console.log("");
if (failures.length === 0) {
	console.log(`OK: ${passed} checks passed.`);
	process.exit(0);
}
console.log(`FAILED: ${failures.length} of ${passed + failures.length} checks failed (${failures.join(", ")}).`);
process.exit(1);
