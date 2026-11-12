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
	"upload.saveFailed"
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

/** The client half owns `upload.*` only; `meta.*` is Host display metadata. */
function uploadOnly(flat) {
	const out = {};
	for (const key of Object.keys(flat)) if (key.startsWith("upload.")) out[key] = flat[key];
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
check("locale-keys", "every t(...) key and every upload.* literal exists in both locale files", () => {
	const tKeys = new Set();
	const tCall = /\bt\(\s*(["'])([A-Za-z0-9_.]+)\1/g;
	for (const match of clientSource.matchAll(tCall)) {
		if (/^upload(\.[A-Za-z0-9]+)+$/.test(match[2])) tKeys.add(match[2]);
	}
	assert(tKeys.size > 0, "no literal t(\"upload.*\") key found");
	const literals = new Set();
	const literalPattern = /(["'])((?:(?!\1)[^\\\r\n]|\\.)*)\1/g;
	for (const match of clientSource.matchAll(literalPattern)) {
		if (/^upload(\.[A-Za-z0-9]+)+$/.test(match[2])) literals.add(match[2]);
	}
	const missing = [];
	for (const key of [...tKeys, ...literals].sort()) {
		if (!(key in enFlat)) missing.push(`${key} (en)`);
		if (!(key in zhFlat)) missing.push(`${key} (zh)`);
	}
	assert(missing.length === 0, `missing keys: ${missing.join(", ")}`);
	const requiredMissing = REQUIRED_KEYS.filter((key) => !(key in enFlat) || !(key in zhFlat));
	assert(requiredMissing.length === 0, `frozen keys absent: ${requiredMissing.join(", ")}`);
	return `${tKeys.size} t() keys, ${literals.size} upload.* literals, ${REQUIRED_KEYS.length} frozen keys`;
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
	const enUpload = uploadOnly(enFlat);
	const zhUpload = uploadOnly(zhFlat);
	assert(sameSet(sortedKeys(enInline), sortedKeys(enUpload)), "inline en key set differs from locale/en.json");
	assert(sameSet(sortedKeys(zhInline), sortedKeys(zhUpload)), "inline zh key set differs from locale/zh.json");
	for (const key of sortedKeys(enUpload)) {
		assert(enInline[key] === enUpload[key], `inline en["${key}"] differs from locale/en.json`);
	}
	for (const key of sortedKeys(zhUpload)) {
		assert(zhInline[key] === zhUpload[key], `inline zh["${key}"] differs from locale/zh.json`);
	}
	return `${sortedKeys(enUpload).length} upload.* keys × 2 languages in sync`;
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
	const exportsObject = instantiateFactory(function (specifier) {
		if (specifier === "react") return runtime.React;
		// react-dom stays unavailable on purpose: this exercises the in-place dialog branch.
		throw new Error(`unavailable module: ${specifier}`);
	}, runtime.window, { fetch: sources.fetch });
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
	const stub = function (input, init) {
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
		maxBytes: settings.maxBytes === undefined ? 8388608 : settings.maxBytes
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

function dialog(runtime) {
	return runtime.findAll(function (node) { return node.props.role === "dialog"; })[0];
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
	assert(runtime.findAll(function (node) { return node.props.role === "dialog"; }).length === 0, "off must never open the confirm dialog");
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
		[ Number.MAX_SAFE_INTEGER + 1, humanBytes(8388608) ],
		[ 2 ** 53, humanBytes(8388608) ],
		[ 2 ** 53 + 2, humanBytes(8388608) ],
		[ 1e21, humanBytes(8388608) ],
		[ Number.MAX_VALUE, humanBytes(8388608) ],
		[ 0, humanBytes(8388608) ],
		[ -1, humanBytes(8388608) ],
		[ 1.5, humanBytes(8388608) ],
		[ 2.5, humanBytes(8388608) ],
		[ NaN, humanBytes(8388608) ],
		[ Infinity, humanBytes(8388608) ],
		[ -Infinity, humanBytes(8388608) ],
		[ "1024", humanBytes(8388608) ],
		[ "8388608", humanBytes(8388608) ],
		[ null, humanBytes(8388608) ],
		[ true, humanBytes(8388608) ],
		[ {}, humanBytes(8388608) ],
		[ [], humanBytes(8388608) ],
		[ undefined, humanBytes(8388608) ],
		[ { get: function () { return 4194304; } }, humanBytes(4194304) ],
		[ { get: function () { return 1e21; } }, humanBytes(8388608) ]
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
	// The whitelist grew from two names to four when the user gained two editable lists (a
	// model-pattern list, so a proxy's renamed model can be marked as DeepSeek; and the working-directory
	// exclusion list). The property that matters is unchanged: `mode`, `uploadModel` and `credentialRef`
	// are never in it, so the field editor cannot touch them.
	assert(/const EDITABLE_FIELDS = Object\.freeze\(\[ "endpoint", "maxBytes", "deepseekModelPatterns", "excludedWorkingDirectories" \]\)/.test(stripComments(clientSource)), "the editable-field whitelist is not exactly the four editable fields");
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
await checkAsync("list-editing", "the two lists edit, normalize and write like the other fields", async () => {
	// The model-pattern list only renders in `deepseek-any-provider` — the one mode that reads it.
	// Elsewhere it is absent rather than shown-and-disabled, because a control that looks live but
	// does nothing is how a user comes to believe they changed something they did not. So this
	// scenario starts in that mode.
	const scenario = await ledgerScenario([ { status: 200, body: { generatedAt: 1, directory: "C:\\\\l", total: 0, sessions: [] } } ], { mode: "deepseek-any-provider" });
	const runtime = scenario.runtime;

	// With nothing configured, the read-only lines say so explicitly rather than rendering a blank.
	const valueTexts = runtime.findAll(function (node) {
		return typeof node.props.className === "string" && node.props.className.indexOf("slu-listValue") >= 0;
	}).map(textOf);
	assert(valueTexts.length === 2, `expected two list value lines in this mode, found ${valueTexts.length}`);
	assert(valueTexts.some(function (text) { return text.indexOf("(none") >= 0 || text.indexOf("Nothing") >= 0; }), "an empty list must say so explicitly, not render a blank");

	// Both controls exist and are textareas, so a multi-line list is actually editable.
	for (const field of [ "deepseekModelPatterns", "excludedWorkingDirectories" ]) {
		const control = fieldInput(runtime, field);
		assert(control !== undefined, `no control for ${field}`);
		assert(control.type === "textarea", `${field} is not a textarea`);
	}

	// Typing a messy list and saving writes ONE array: trimmed, blanks dropped, duplicates collapsed
	// case-insensitively. This is the property the user's hand-edited list depends on.
	typeInto(runtime, "deepseekModelPatterns", "  dfmodel  \n\nDFModel\ndeepseek\n   \n");
	clickSave(runtime, "deepseekModelPatterns");
	await settle(runtime);
	const patternsWrite = scenario.form.sets.find(function (set) { return set[0] === "deepseekModelPatterns"; });
	assert(patternsWrite !== undefined, "the pattern list was never written");
	assert(Array.isArray(patternsWrite[1]), `the pattern list was written as ${typeof patternsWrite[1]}`);
	assert(JSON.stringify(patternsWrite[1]) === JSON.stringify([ "dfmodel", "deepseek" ]), `the written list was ${JSON.stringify(patternsWrite[1])}`);

	typeInto(runtime, "excludedWorkingDirectories", "D:\\secret\n  \nd:/secret\nC:\\other\n");
	clickSave(runtime, "excludedWorkingDirectories");
	await settle(runtime);
	const dirsWrite = scenario.form.sets.find(function (set) { return set[0] === "excludedWorkingDirectories"; });
	assert(dirsWrite !== undefined, "the directory list was never written");
	assert(JSON.stringify(dirsWrite[1]) === JSON.stringify([ "D:\\secret", "C:\\other" ]), `the written directories were ${JSON.stringify(dirsWrite[1])}`);

	// An empty list is a legitimate value (it means "nothing"), so saving an empty box must write [],
	// not be refused as invalid.
	typeInto(runtime, "excludedWorkingDirectories", "\n  \n");
	clickSave(runtime, "excludedWorkingDirectories");
	await settle(runtime);
	const cleared = scenario.form.sets.filter(function (set) { return set[0] === "excludedWorkingDirectories"; }).pop();
	assert(JSON.stringify(cleared[1]) === JSON.stringify([]), `clearing the list wrote ${JSON.stringify(cleared[1])}`);

	// The field editor must never write `mode`, and the two protected fields stay unwritable.
	for (const set of scenario.form.sets) {
		assert(set[0] !== "mode", "the list editor wrote the mode");
		assert(set[0] !== "uploadModel" && set[0] !== "credentialRef", `the list editor wrote ${set[0]}`);
	}
	return `${scenario.form.sets.length} list writes, normalized (trim, dedupe case-insensitively, empty allowed)`;
});

await checkAsync("list-help", "the copy says what each list does, and the pattern list is hidden outside its mode", async () => {
	const en = JSON.parse(fs.readFileSync(path.join(ROOT, "locale/en.json"), "utf8")).upload;
	const zh = JSON.parse(fs.readFileSync(path.join(ROOT, "locale/zh.json"), "utf8")).upload;
	// The pattern list's job: explain the renamed-model case, which is the only reason it exists.
	assert(/proxy|another name|dfmodel/i.test(en.patternsHelp), "the pattern help does not explain the renamed-model case");
	assert(/dfmodel/.test(zh.patternsHelp), "zh pattern help lost the renamed-model case");
	// The directory list's load-bearing sentence: it stops the BUILT-IN upload too. A user pruning
	// sensitive folders would assume that, and if the copy does not say it they cannot tell.
	assert(/built-in|DSH\u2019s own official upload|official upload is stopped/i.test(en.directoriesHelp), "the directory help does not say it also stops the built-in upload");
	assert(/自带/.test(zh.directoriesHelp), "zh directory help lost the built-in-upload sentence");
	// The two sentences the user asked to delete must be gone from every copy of the string.
	for (const [label, dict] of [ [ "en", en ], [ "zh", zh ] ]) {
		assert(!/secretary|name prefix/i.test(dict.directoriesHelp), `${label}: the name-prefix caveat is back`);
		assert(!/can only narrow|widen|不能放宽|只能收紧/i.test(dict.directoriesHelp), `${label}: the narrow-only sentence is back`);
	}
	// Both empty states must exist as real strings.
	for (const key of [ "patternsEmpty", "directoriesEmpty" ]) {
		assert(typeof en[key] === "string" && en[key].length > 0, `en.${key} is missing`);
		assert(typeof zh[key] === "string" && zh[key].length > 0, `zh.${key} is missing`);
	}
	// The rendering rule: the pattern list appears only in `deepseek-any-provider`. Not "disabled
	// elsewhere" — absent, so nobody mistakes a dead control for a live one.
	for (const mode of [ "off", "official-only", "any-model" ]) {
		const scenario = await ledgerScenario([ { status: 200, body: { generatedAt: 1, directory: "C:\\\\l", total: 0, sessions: [] } } ], { mode });
		const labels = scenario.runtime.findAll(function (node) {
			return typeof node.props.className === "string" && node.props.className.indexOf("slu-fieldLabel") >= 0;
		}).map(textOf);
		const hasPatterns = labels.some(function (text) { return /treat as DeepSeek|当作 DeepSeek/.test(text); });
		assert(hasPatterns === false, `the pattern list is visible in mode ${mode}`);
		const hasDirectories = labels.some(function (text) { return /folders|目录/.test(text); });
		assert(hasDirectories === true, `the directory list is missing in mode ${mode}`);
	}
	// …and it IS visible in the one mode that reads it.
	const wide = await ledgerScenario([ { status: 200, body: { generatedAt: 1, directory: "C:\\\\l", total: 0, sessions: [] } } ], { mode: "deepseek-any-provider" });
	const wideLabels = wide.runtime.findAll(function (node) {
		return typeof node.props.className === "string" && node.props.className.indexOf("slu-fieldLabel") >= 0;
	}).map(textOf);
	assert(wideLabels.some(function (text) { return /treat as DeepSeek/.test(text); }), "the pattern list is missing from the mode that uses it");
	return "both lists explained; the pattern list appears only in deepseek-any-provider";
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
		excludedWorkingDirectories: live([]),
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

	// Before the write, the read-only line reports the effective list.
	const readOnlyBefore = runtime.findAll(function (node) {
		return typeof node.props.className === "string" && node.props.className.indexOf("slu-listValue") >= 0 && node.props["data-field"] === "deepseekModelPatterns";
	}).map(textOf)[0];
	assert(readOnlyBefore !== undefined, "the pattern list's read-only line is missing");
	assert(/deepseek/.test(readOnlyBefore), `the read-only line does not show the effective list: ${readOnlyBefore}`);

	// Type and save a second name.
	typeInto(runtime, "deepseekModelPatterns", "deepseek\ndfmodel\n");
	clickSave(runtime, "deepseekModelPatterns");
	await settle(runtime);

	const written = form.sets.find(function (set) { return set[0] === "deepseekModelPatterns"; });
	assert(written !== undefined, "the list was never written");
	assert(JSON.stringify(written[1]) === JSON.stringify([ "deepseek", "dfmodel" ]), `written value: ${JSON.stringify(written[1])}`);

	// THE ASSERTION THAT WOULD HAVE FAILED: the page must now read the stored array back. With the
	// `fieldValue` bug the read-only line said "not reported" and the textarea reverted.
	const readOnlyAfter = runtime.findAll(function (node) {
		return typeof node.props.className === "string" && node.props.className.indexOf("slu-listValue") >= 0 && node.props["data-field"] === "deepseekModelPatterns";
	}).map(textOf)[0];
	assert(/dfmodel/.test(readOnlyAfter), `a saved list was not read back: ${readOnlyAfter}`);
	const control = fieldInput(runtime, "deepseekModelPatterns");
	assert(typeof control.props.value === "string" && control.props.value.indexOf("dfmodel") >= 0, `the textarea did not mirror the saved list: ${JSON.stringify(control.props.value)}`);

	// The same for the directories, including the empty→filled direction.
	typeInto(runtime, "excludedWorkingDirectories", "D:\\private\n");
	clickSave(runtime, "excludedWorkingDirectories");
	await settle(runtime);
	const dirsReadOnly = runtime.findAll(function (node) {
		return typeof node.props.className === "string" && node.props.className.indexOf("slu-listValue") >= 0 && node.props["data-field"] === "excludedWorkingDirectories";
	}).map(textOf)[0];
	assert(/private/i.test(dirsReadOnly), `a saved directory list was not read back: ${dirsReadOnly}`);

	return "both lists write through the served form and read back from a live reference";
});

console.log("");
if (failures.length === 0) {
	console.log(`OK: ${passed} checks passed.`);
	process.exit(0);
}
console.log(`FAILED: ${failures.length} of ${passed + failures.length} checks failed (${failures.join(", ")}).`);
process.exit(1);
