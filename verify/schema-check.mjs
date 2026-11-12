/**
 * The optional `Config` schema, tested against the REAL schema builder.
 *
 * `index.js` reaches `@deepseek-ai/schemastery` through an absolute `file://` URL inside
 * `app.asar`, which plain Node cannot import. This script extracts the two shipped ESM
 * modules into `verify/.tmp-modules/`, rewrites exactly one import line so they resolve
 * each other, and then runs the plugin's own `Config` declaration and `host/config.js`
 * against them.
 *
 * It answers two questions that matter for consent and for exfiltration:
 *   1. does `.volatile()` really produce the live reference `readLive` unwraps, with the
 *      `official-only` default applied BEFORE the wrap?
 *   2. can the settings wire write anything other than `mode` — could a browser repoint
 *      `endpoint` at its own collector?
 *
 * Usage: node verify/schema-check.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { readAsarText } from './asar-extract.mjs'
import {
  DEFAULT_CREDENTIAL_REF,
  DEFAULT_DEEPSEEK_MODEL_PATTERNS,
  DEFAULT_ENDPOINT,
  DEFAULT_UPLOAD_DIRECTORIES,
  DEFAULT_UPLOAD_SESSION_IDS,
  DEFAULT_MAX_BYTES,
  DEFAULT_UPLOAD_MODEL,
  MODES,
  resolveConfig,
} from '../host/config.js'

const TMP = new URL('./.tmp-modules/', import.meta.url)
const TMP_DIR = fileURLToPath(TMP)

let failures = 0
const check = (title, fn) => {
  try {
    fn()
    console.log(`  ok    ${title}`)
  } catch (error) {
    failures++
    console.log(`  FAIL  ${title}\n        ${error.stack?.split('\n').slice(0, 5).join('\n        ')}`)
  }
}

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
const SHIPPED = 'dsh/node_modules/@deepseek-ai/'

/** Slice [start, end) out of a text, failing loudly when an anchor moves. */
function slice(text, startAnchor, endAnchor, what) {
  const start = text.indexOf(startAnchor)
  assert.notEqual(start, -1, `${what}: start anchor not found: ${JSON.stringify(startAnchor)}`)
  const end = text.indexOf(endAnchor, start)
  assert.notEqual(end, -1, `${what}: end anchor not found: ${JSON.stringify(endAnchor)}`)
  return text.slice(start, end)
}

rmSync(TMP_DIR, { recursive: true, force: true })
mkdirSync(TMP_DIR, { recursive: true })

const cosmokit = readAsarText(`${SHIPPED}cosmokit/lib/index.js`)
const schemastery = readAsarText(`${SHIPPED}schemastery/lib/index.mjs`)
const settingsSource = readAsarText(`${SHIPPED}dsh-settings/lib/index.js`)
const indexSource = readFileSync('index.js', 'utf8')

// ── extraction, with a single, asserted import rewrite ─────────────────────────────────────────
const rewritten = schemastery.replace('from "@deepseek-ai/cosmokit"', "from './cosmokit.mjs'")
const differences = rewritten
  .split('\n')
  .map((line, index) => (line === schemastery.split('\n')[index] ? null : index))
  .filter((value) => value !== null)
assert.deepEqual(differences, [0], 'exactly one line of the shipped module may differ')
writeFileSync(`${TMP_DIR}cosmokit.mjs`, cosmokit, 'utf8')
writeFileSync(`${TMP_DIR}schemastery.mjs`, rewritten, 'utf8')

const z = (await import(new URL('./schemastery.mjs', TMP).href)).default

console.log('extracted from app.asar:')
console.log(`  cosmokit/lib/index.js         ${cosmokit.length} bytes`)
console.log(`  schemastery/lib/index.mjs     ${schemastery.length} bytes (1 import line rewritten)`)
console.log(`  schemastery version           ${JSON.parse(readAsarText(`${SHIPPED}schemastery/package.json`)).version}\n`)

// ── the plugin's own Config declaration, verbatim ──────────────────────────────────────────────
const region = slice(indexSource, 'const MODE_PATTERN', 'let Config', 'the MODE_PATTERN + modeField region')
const literal = slice(indexSource, 'Config = z.object({', '\n    }', 'the Config object literal')

// Since H2 the declaration calls the `modeField(z)` helper, and the id constraint comes from
// `MODE_PATTERN`, which is built from `MODES`. So the extracted region is: the pattern + helper
// (up to `let Config`), plus the object literal, evaluated with the same names `index.js` imports.
//
// The four `DEFAULT_*` constants are passed in rather than re-declared: `index.js` now takes its schema
// defaults from `host/config.js` instead of repeating them as literals, which is the fix for a real
// drift bug (the schema defaulted `uploadModel` to a legacy alias while the resolver used another
// name). Pass the *real* exports so this suite still proves the shipped literal, not a copy of it.
const build = new Function(
  'MODES',
  'z',
  'DEFAULT_CREDENTIAL_REF',
  'DEFAULT_DEEPSEEK_MODEL_PATTERNS',
  'DEFAULT_ENDPOINT',
  'DEFAULT_UPLOAD_DIRECTORIES',
  'DEFAULT_UPLOAD_SESSION_IDS',
  'DEFAULT_MAX_BYTES',
  'DEFAULT_UPLOAD_MODEL',
  `${region}\nreturn { schema: ${literal.replace('Config = ', '')}, MODE_PATTERN, modeField };`,
)
const built = build(
  MODES,
  z,
  DEFAULT_CREDENTIAL_REF,
  DEFAULT_DEEPSEEK_MODEL_PATTERNS,
  DEFAULT_ENDPOINT,
  DEFAULT_UPLOAD_DIRECTORIES,
  DEFAULT_UPLOAD_SESSION_IDS,
  DEFAULT_MAX_BYTES,
  DEFAULT_UPLOAD_MODEL,
)
const schema = built.schema

check('the plugin declaration builds a real schemastery object schema', () => {
  assert.equal(schema.type, 'object')
  assert.deepEqual(Object.keys(schema.dict).sort(), [ 'credentialRef', 'deepseekModelPatterns', 'endpoint', 'maxBytes', 'mode', 'uploadDirectories', 'uploadModel', 'uploadSessionIds' ])
})

check('H2: MODE_PATTERN is an exact anchored alternation of the four frozen ids', () => {
  assert.equal(built.MODE_PATTERN.source, '^(?:off|official-only|deepseek-any-provider|any-model)$')
  for (const mode of MODES) assert.ok(new RegExp(built.MODE_PATTERN.source).test(mode), `${mode} does not match its own pattern`)
  for (const bad of ['offf', 'off ', ' off', 'OFF', 'any-modelx', 'xany-model', '']) {
    assert.equal(new RegExp(built.MODE_PATTERN.source).test(bad), false, `${JSON.stringify(bad)} matched the pattern`)
  }
})

check('H2: the pattern escapes regex metacharacters when MODES is hostile', () => {
  // `MODES` comes from host/config.js; the escaping is defence in depth against an id that is not
  // a plain lowercase word (e.g. a future `a.b`), which would otherwise match unintended strings.
  const hostile = build(
    ['a.b', 'x(y)', 'p+q', 'literal'],
    z,
    DEFAULT_CREDENTIAL_REF,
    DEFAULT_DEEPSEEK_MODEL_PATTERNS,
    DEFAULT_ENDPOINT,
    DEFAULT_UPLOAD_DIRECTORIES,
    DEFAULT_UPLOAD_SESSION_IDS,
    DEFAULT_MAX_BYTES,
    DEFAULT_UPLOAD_MODEL,
  )
  assert.equal(hostile.MODE_PATTERN.source, '^(?:a\\.b|x\\(y\\)|p\\+q|literal)$')
  assert.equal(new RegExp(hostile.MODE_PATTERN.source).test('axb'), false, 'a dot matched any character')
  assert.equal(new RegExp(hostile.MODE_PATTERN.source).test('a.b'), true)
  assert.equal(new RegExp(hostile.MODE_PATTERN.source).test('x(y)'), true)
})

check('H2: modeField falls back to an unconstrained but still volatile field when .pattern() throws', () => {
  const calls = []
  const fakeZ = {
    string() {
      return {
        pattern() {
          throw new TypeError('pattern is not supported by this builder')
        },
        default(value) {
          calls.push(['default', value])
          return this
        },
        volatile() {
          calls.push(['volatile'])
          return this
        },
      }
    },
  }
  const field = built.modeField(fakeZ)
  assert.ok(field !== undefined, 'the helper returned nothing on the degraded path')
  assert.deepEqual(calls, [['default', 'official-only'], ['volatile']], 'the degraded path lost default or volatile')
})

const standard = schema['~standard']
const validate = (value) => {
  const result = standard.validate(value)
  if (result.issues) throw new Error(`validation failed: ${JSON.stringify(result.issues)}`)
  return result.value
}

check('validate({}) yields a genuine volatile reference holding the official-only default', () => {
  const value = validate({})
  assert.equal(typeof value.mode, 'object')
  assert.equal(VOLATILE_WRITE in value.mode, true, 'mode is not a cosmokit volatile reference')
  assert.equal(typeof value.mode.get, 'function')
  assert.equal(value.mode.get(), 'official-only', 'the default must be applied BEFORE the wrap')
  // `readLive` must unwrap exactly this shape.
  assert.equal(resolveConfig(value).mode, 'official-only')
})

check('validate() with an explicit mode yields a reference holding that mode', () => {
  for (const mode of ['off', 'official-only', 'deepseek-any-provider', 'any-model']) {
    const value = validate({ mode })
    assert.equal(VOLATILE_WRITE in value.mode, true)
    assert.equal(value.mode.get(), mode)
    assert.equal(resolveConfig(value).mode, mode, `resolveConfig lost ${mode}`)
  }
})

check('the reference is live: a write through it is visible to resolveConfig', () => {
  const value = validate({ mode: 'official-only' })
  value.mode[VOLATILE_WRITE]('off')
  assert.equal(resolveConfig(value).mode, 'off')
  value.mode[VOLATILE_WRITE]('any-model')
  assert.equal(resolveConfig(value).mode, 'any-model')
})

check('a non-string mode is REJECTED by the schema (so it cannot be persisted through the wire)', () => {
  for (const bad of [42, true, {}, [], { get: () => 'off' }, Symbol('x')]) {
    let threw = false
    try {
      validate({ mode: bad })
    } catch {
      threw = true
    }
    assert.equal(threw, true, `mode ${String(bad)} was accepted`)
  }
  // null is admitted and takes the default (Schema.resolve's nullable branch).
  assert.equal(validate({ mode: null }).mode.get(), 'official-only')
})

check('H2 FIXED: an unknown mode STRING is now REJECTED by the schema', () => {
  // Revision 2 accepted `offf`, which then narrowed to official-only and turned the shipped upload
  // back on. The pattern now refuses it at the write boundary.
  for (const bad of ['offf', 'off ', ' off', 'OFF', 'any-modelx', 'deepseek-any-provider ', '']) {
    const result = standard.validate({ mode: bad })
    assert.ok(result.issues !== undefined, `${JSON.stringify(bad)} was accepted by the schema`)
    const text = JSON.stringify(result.issues)
    assert.match(text, /expect string to match regexp/, `the issue for ${JSON.stringify(bad)} is not a pattern failure: ${text}`)
  }
  // `resolveConfig` keeps its own never-wider fallback for a corrupt in-memory value.
  assert.equal(resolveConfig({ mode: 'offf' }).mode, 'official-only')
})

check('exactly five fields carry the volatile marker: `mode`, the two lists, `endpoint`, `maxBytes`', () => {
  // `schema.toJSON()` is a uid/refs graph: {uid, refs:{id: node}, ...}. The live Config inspect
  // projection re-renders the same marker as `x-cordis.volatile` (observed: Config.listConfigs
  // entry `include:session-log-upload`).
  const json = schema.toJSON()
  const root = json.refs[json.uid]
  const volatileIds = Object.entries(json.refs)
    .filter(([, node]) => node?.meta?.volatile === true)
    .map(([id]) => id)
  assert.equal(volatileIds.length, 6, `expected exactly six volatile nodes, found ${volatileIds.length}`)
  // The five volatile nodes are exactly the ids these keys point at.
  const VOLATILE_KEYS = [ 'deepseekModelPatterns', 'endpoint', 'maxBytes', 'mode', 'uploadDirectories', 'uploadSessionIds' ]
  const volatileKeys = VOLATILE_KEYS.filter((key) => volatileIds.includes(String(root.dict[key])))
  assert.deepEqual(volatileKeys.sort(), [...VOLATILE_KEYS].sort(), `volatile fields: ${volatileKeys.join(', ')}`)
  for (const key of VOLATILE_KEYS) {
    assert.equal(json.refs[root.dict[key]]?.meta?.volatile, true, `${key} is not volatile`)
  }
  const modeNode = json.refs[root.dict.mode]
  assert.equal(modeNode.meta.default, 'official-only')
  assert.equal(modeNode.type, 'string')
  // H2: the id constraint is pinned against the real builder's projection.
  assert.equal(modeNode.meta.pattern.source, '^(?:off|official-only|deepseek-any-provider|any-model)$')
  assert.equal(json.refs[root.dict.endpoint].meta.default, 'https://api.deepseek.com/anthropic/v1/messages')
  assert.equal(json.refs[root.dict.endpoint].type, 'string')
  assert.equal(json.refs[root.dict.maxBytes].meta.default, 8388608)
  assert.equal(json.refs[root.dict.maxBytes].type, 'number')
  // The two stay non-volatile and carry no constraint beyond their type: they decide which credential
  // is used and which model this plugin spends money on, so the settings wire must not write them.
  for (const key of ['uploadModel', 'credentialRef']) {
    assert.notEqual(json.refs[root.dict[key]]?.meta?.volatile, true, `${key} is marked volatile`)
    assert.equal(json.refs[root.dict[key]]?.meta?.pattern, undefined, `${key} unexpectedly carries a pattern`)
  }
  // The two list fields are volatile but deliberately carry NO shape constraint beyond their type:
  // a `.min()` here would deactivate the row on a bad value and thereby disarm `off` (the fail-open
  // coupling below). They are narrowed in `resolveConfig` instead.
  for (const key of ['deepseekModelPatterns', 'uploadDirectories']) {
    assert.equal(json.refs[root.dict[key]]?.meta?.volatile, true, `${key} is not volatile`)
    assert.equal(json.refs[root.dict[key]]?.meta?.pattern, undefined, `${key} unexpectedly carries a pattern`)
  }
})

// A1 was fixed WITHOUT a schema pattern, deliberately. This check exists so the decision cannot be
// reversed by accident: a pattern here would make a malformed `endpoint` fail config validation, the
// row would deactivate, `apply` would never run, the `mode: off` exclusion would never be registered,
// and the shipped official-API upload would resume — a fail-open traded for a false disclosure.
check('A1 DESIGN: `endpoint` carries NO pattern on purpose; `mode` and `maxBytes` keep theirs', () => {
  const json = schema.toJSON()
  const root = json.refs[json.uid]
  const endpointNode = json.refs[root.dict.endpoint]
  assert.equal(endpointNode.meta.pattern, undefined, 'an `endpoint` pattern was added — see the fail-open trace above')
  assert.equal(endpointNode.type, 'string')
  // `mode` keeps its typo-rejecting pattern …
  assert.equal(json.refs[root.dict.mode].meta.pattern.source, '^(?:off|official-only|deepseek-any-provider|any-model)$')
  // … and `maxBytes` keeps its numeric bounds.
  assert.equal(json.refs[root.dict.maxBytes].meta.min, 1)
  assert.equal(json.refs[root.dict.maxBytes].meta.step, 1)
  // The source must not grow a pattern either, and must keep the reason on record. These are
  // *semantic* fragments, not exact wording: index.js is still being edited during this pass, so a
  // comment reflow or a synonym must not break the check while a lost rationale still does.
  //
  // RETARGETED: the default is no longer a string literal — it is the shared `DEFAULT_ENDPOINT`
  // constant, which is the fix for a real drift bug (the schema and the resolver each carried their own
  // copy of these defaults, and the `uploadModel` copies disagreed). What this check is actually for is
  // that `endpoint` stays a plain, pattern-free `z.string()`, so assert exactly that.
  const source = readFileSync('index.js', 'utf8')
  assert.match(source, /endpoint: z\.string\(\)\.default\(DEFAULT_ENDPOINT\)\.volatile\(\)/)
  assert.doesNotMatch(source, /endpoint: z\.string\(\)[^\n]*\.pattern\(/, 'a pattern was added to `endpoint`')
  assert.ok(source.includes('VOLATILE SCHEMA COUPLING'), 'the coupling is no longer documented in index.js')
  assert.ok(/`endpoint`[^\n]*unconstrained/.test(source), 'the plain-`z.string()` decision is no longer documented')
  assert.ok(source.includes('**resumes**'), 'the fail-open consequence is no longer named')
  assert.ok(/Do not add[^\n]{0,30}back\./.test(source), 'the "do not add a pattern" prohibition is gone')
  console.log('        rejected fix recorded: a pattern would deactivate the row on a typo and re-enable the shipped upload')
})

// ── the settings service's own projection and write guard, verbatim ────────────────────────────
const settingsFns = slice(
  settingsSource,
  'function plainSchema(schema) {',
  '//#region lib/types/index.js',
  'dsh-settings projection functions',
)
/** The shipped `redactSecrets` only matters for `role('secret')` fields; this schema has none. */
const redactSecrets = (_schema, value) => ({ value, secrets: [] })
const projection = new Function(
  'z',
  'redactSecrets',
  `${settingsFns}\nreturn { plainSchema, volatileForm, isVolatilePath, projectForm };`,
)(z, redactSecrets)

check('the documented fail-open coupling matches the shipped framework code', () => {
  // index.js documents why `endpoint` must stay unconstrained. That rationale is only true because of
  // three behaviours in the shipped framework, so assert them from the container: if a future build
  // stops throwing (or starts autofixing), the comment becomes stale and the decision needs revisiting.
  const cordis = readAsarText('dsh/node_modules/@deepseek-ai/cordis/lib/index.js')
  const loader = readAsarText('dsh/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js')
  // 1. a schema violation throws, and `autofix` is never enabled by a host caller (so nothing is
  //    silently replaced by the default before the throw).
  assert.match(cordis, /if \(result\.issues\) throw new ValidationError\(result\.issues\)/)
  assert.match(cordis, /function resolveConfig\(runtime, config\) \{\n\tif \(!runtime\.Config\) return config;/)
  // 2. `Entry.update` does not catch that throw, so the entry fails to activate.
  assert.match(cordis, /const resolved = loaded \? fiber\.resolveConfig\(config\) : void 0;/)
  // 3. the volatile commit path only warns and skips, then the ordinary update throws.
  assert.match(loader, /volatile config update failed for %C/)
  assert.match(loader, /catch \(error\) \{[\s\S]{0,200}?this\.ctx\.logger\.warn\("volatile config update failed for %C", this\.options\.id\);[\s\S]{0,120}?return true;/)
  // 4. and the in-place volatile commit that makes a settings write take effect without a restart.
  assert.match(loader, /updateVolatile\(ref, source\)/)
  for (const source of [cordis, loader]) assert.doesNotMatch(source, /autofix:\s*true/, 'a host caller now enables autofix — the coupling changed')
  console.log('        coupling verified in shipped source: throw → inactive entry → apply never runs → no `off` exclusion')
})

check('the schema declares no secret fields (so the redaction stub above is exact)', () => {
  assert.doesNotMatch(JSON.stringify(schema.toJSON()), /"role":"secret"/)
})

// RETARGETED (was: "the settings FORM projects exactly one field — mode"). That WAS the reported
// bug: a non-volatile field never reaches the browser, so the page could not show the destination.
check('RETARGETED: the settings FORM projects exactly the five volatile fields', () => {
  const form = projection.volatileForm(schema)
  assert.ok(form !== undefined, 'no form is projected at all')
  assert.deepEqual(
    Object.keys(form.dict).sort(),
    [ 'deepseekModelPatterns', 'endpoint', 'maxBytes', 'mode', 'uploadDirectories', 'uploadSessionIds' ],
    `the form exposed ${Object.keys(form.dict).join(', ')}`,
  )
})

// RETARGETED (was: "the write guard admits `mode` and REFUSES every other declared field"). The wire
// now admits five fields; the boundary that still matters is that `uploadModel` and `credentialRef`
// are refused, because they decide which credential is used and which model this plugin spends money
// on. `deepseekModelPatterns` moved to the writable side on purpose: it is how a user says that a
// proxy's renamed model (`dfmodel`) is DeepSeek.
check('RETARGETED: the write guard admits exactly the five volatile fields, refuses the other two', () => {
  for (const key of [ 'deepseekModelPatterns', 'endpoint', 'maxBytes', 'mode', 'uploadDirectories', 'uploadSessionIds' ]) {
    assert.equal(projection.isVolatilePath(schema, [key]), true, `${key} is not writable — the page could not save it`)
  }
  for (const key of ['uploadModel', 'credentialRef']) {
    assert.equal(projection.isVolatilePath(schema, [key]), false, `${key} is writable through the settings wire`)
    assert.equal(projection.isVolatilePath(schema, [key, 'nested']), false)
  }
  // `dsh-settings.write` refuses any path that is not volatile (shipped guard).
  assert.match(
    settingsSource,
    /for \(const path of paths\) if \(path\.length && !isVolatilePath\(schema, path\)\) throw new Error\(`Config field "\$\{path\.join\("\."\)\}" is not volatile`\)/,
  )
  console.log('        dsh-settings/lib/index.js:507 is the host-side guard; the wire admits five fields and refuses two')
})

// RETARGETED: the projection now carries the five volatile fields, and nothing else — no
// `uploadModel`, no `credentialRef`.
check('RETARGETED: projectForm exposes the five volatile fields and never the whole config', () => {
  const form = projection.volatileForm(schema)
  const value = validate({
    endpoint: 'https://api.deepseek.com/anthropic/v1/messages',
    uploadModel: 'attacker-model',
    credentialRef: 'ATTACKER_KEY',
    deepseekModelPatterns: ['*'],
  })
  const projected = projection.projectForm(form, value)
  assert.deepEqual(
    Object.keys(projected).sort(),
    [ 'deepseekModelPatterns', 'endpoint', 'maxBytes', 'mode', 'uploadDirectories', 'uploadSessionIds' ],
  )
  for (const key of ['uploadModel', 'credentialRef']) {
    assert.equal(key in projected, false, `${key} leaked into the browser projection`)
  }
})

// ── the boundary that moved, and the one that did not ─────────────────────────────────────────
check('ACCEPTED PROPERTY: the wire can repoint `endpoint` (deliberate, so the dialog can name it)', () => {
  const value = validate({ endpoint: 'http://127.0.0.1:54779/collect' })
  assert.equal(value.endpoint.get(), 'http://127.0.0.1:54779/collect', 'a valid http endpoint was not honoured')
  assert.equal(resolveConfig(value).endpoint, 'http://127.0.0.1:54779/collect')
})

// RETITLED for the accepted design: `endpoint` stays unconstrained **on purpose** (see the A1 DESIGN
// check above), so the schema still stores a non-http(s) value — what must never happen is the
// *resolver* following it, and the *page* showing it. The page half is asserted in
// verify/adversarial-client.mjs against the same corpus; this half pins the resolver.
check('DESIGN: the schema stores a non-http(s) `endpoint` by design; `resolveConfig` must still refuse it', () => {
  // `endpoint` is `z.string()` with no pattern, so the settings wire (or a patch row) can persist
  // anything. The descriptor the page receives is the schema-validated value, while the plugin POSTs
  // to `resolveConfig`'s narrowed value — so the dialog can name a destination that is not used.
  const hostile = 'file:///etc/passwd'
  const value = validate({ endpoint: hostile })
  assert.equal(value.endpoint.get(), hostile, 'the schema rejected it — the finding is fixed')
  assert.equal(resolveConfig(value).endpoint, 'https://api.deepseek.com/anthropic/v1/messages', 'the POST target must not follow it')
  assert.notEqual(value.endpoint.get(), resolveConfig(value).endpoint, 'reported and effective endpoints agree — the finding is fixed')
  // The divergence exists for any non-http(s) string, and it is the *reported* end that is wrong.
  for (const bad of ['javascript:alert(1)', '/relative/path', 'https:/evil.example', '']) {
    assert.equal(validate({ endpoint: bad }).endpoint.get(), bad)
    assert.equal(resolveConfig({ endpoint: { get: () => bad } }).endpoint, 'https://api.deepseek.com/anthropic/v1/messages')
  }
  console.log('        the POST always goes to an http(s) URL (fail-safe); the fix is a pattern on `endpoint`, as on `mode`')
})

check('maxBytes stays clamped by the schema: a live reference round-trips, 0 and 1.5 are refused', () => {
  assert.equal(validate({ maxBytes: 1024 }).maxBytes.get(), 1024)
  assert.equal(validate({}).maxBytes.get(), 8388608)
  for (const bad of [0, -1, 1.5, NaN, Infinity, '1024', null, true]) {
    const result = standard.validate({ maxBytes: bad })
    if (bad === null) {
      assert.equal(result.issues, undefined, 'null should take the default')
      assert.equal(result.value.maxBytes.get(), 8388608)
      continue
    }
    assert.ok(result.issues !== undefined, `maxBytes ${String(bad)} was accepted`)
  }
  assert.equal(resolveConfig({ maxBytes: { get: () => 512 } }).maxBytes, 512)
})

console.log(failures === 0 ? '\nPASS: the Config schema behaves as the plugin assumes' : `\nFAIL: ${failures} check(s)`)

rmSync(TMP_DIR, { recursive: true, force: true })
process.exitCode = failures === 0 ? 0 : 1
