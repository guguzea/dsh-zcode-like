/**
 * Independent consent-gate verification for client.js.
 *
 * Written from scratch (own minimal hook runtime, own click/keyboard driver) so that
 * a bug in the implementers' `verify/client-check.mjs` cannot hide a real defect. The
 * question this answers: can `deepseek-any-provider` / `any-model` ever reach a write
 * call without a deliberate confirmation, and are `off` / `official-only` dialog-free?
 *
 * Usage: node verify/adversarial-client.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CLIENT_SOURCE = readFileSync('client.js', 'utf8')
const CLIENT_URL = new URL('../client.js', import.meta.url).href

let failures = 0
const check = (title, fn) => {
  try {
    fn()
    console.log(`  ok    ${title}`)
  } catch (error) {
    failures++
    console.log(`  FAIL  ${title}\n        ${error.stack?.split('\n').slice(0, 4).join('\n        ')}`)
  }
}
const checkAsync = async (title, fn) => {
  try {
    await fn()
    console.log(`  ok    ${title}`)
  } catch (error) {
    failures++
    console.log(`  FAIL  ${title}\n        ${error.stack?.split('\n').slice(0, 6).join('\n        ')}`)
  }
}
/** Let every queued microtask and one macrotask land, so async write paths are observable. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

// ── static proof: every write call site ────────────────────────────────────────────────────────
console.log('static call-graph analysis of client.js')
check('the only calls into the host write path are the mode switch and its confirm handler', () => {
  const lines = CLIENT_SOURCE.split('\n')
  const hits = []
  lines.forEach((line, index) => {
    if (/bridge\.writeMode\(|writeMode\s*[:=]/.test(line) && !/^\s*[*]/.test(line)) {
      hits.push(`${index + 1}: ${line.trim()}`)
    }
  })
  // Exactly two: the bridge's exported member and the one call inside `commit`.
  assert.equal(hits.length, 2, `expected 2 writeMode sites, found:\n${hits.join('\n')}`)
  const callSite = hits.find((line) => line.includes('bridge.writeMode('))
  assert.ok(callSite !== undefined, `no bridge.writeMode() call site found in:\n${hits.join('\n')}`)
  assert.match(callSite, /attempt = Promise\.resolve\(bridge\.writeMode\(nextMode\)\)/)
  const commitLines = []
  lines.forEach((line, index) => {
    if (/(^|[^.\w])commit\(/.test(line)) commitLines.push(`${index + 1}: ${line.trim()}`)
  })
  assert.deepEqual(
    commitLines.map((line) => line.replace(/^\d+: /, '')),
    ['void commit(nextMode);', 'if (target !== null) void commit(target);'],
    `unexpected commit() call sites:\n${commitLines.join('\n')}`,
  )
})

check('CONFIRM_MODES covers exactly the two wide modes and is consulted before commit', () => {  assert.match(CLIENT_SOURCE, /const CONFIRM_MODES = \[ "deepseek-any-provider", "any-model" \];/)
  const selectBody = CLIENT_SOURCE.slice(
    CLIENT_SOURCE.indexOf('const select = function (nextMode, index) {'),
    CLIENT_SOURCE.indexOf('const confirmPending = function () {'),
  )
  const gateIndex = selectBody.indexOf('CONFIRM_MODES.indexOf(nextMode) >= 0')
  const commitIndex = selectBody.indexOf('commit(nextMode)')
  assert.ok(gateIndex >= 0 && commitIndex > gateIndex, 'the confirm branch must precede the direct commit')
  const gateBranch = selectBody.slice(gateIndex, commitIndex)
  assert.match(gateBranch, /setPendingMode\(nextMode\);\s*return;/)
  assert.doesNotMatch(gateBranch, /commit\(/)
})

check('Escape and the backdrop both route to onCancel, never onConfirm', () => {
  assert.match(
    CLIENT_SOURCE,
    /if \(event === null \|\| event === undefined \|\| event\.key !== "Escape"\) return;[\s\S]{0,400}?cancel\(\);/,
  )
  assert.match(CLIENT_SOURCE, /className: "slu-mask", "aria-hidden": "true", onClick: props\.onCancel/)
  assert.match(CLIENT_SOURCE, /ref: cancelRef,[\s\S]{0,200}?onClick: props\.onCancel/)
  // onConfirm is reachable only from the confirm button.
  const confirmUses = [...CLIENT_SOURCE.matchAll(/props\.onConfirm|onConfirm:/g)].map((m) => m.index)
  assert.equal(confirmUses.length, 2)
})

// ── a minimal hook runtime ─────────────────────────────────────────────────────────────────────
/**
 * The runtime's model, stated so it is not over-trusted.
 *
 * - Instances are keyed by component identity + tree position in a per-runtime `WeakMap`. The plugin's
 *   `Section`/`LedgerRow` are module-level functions inside a factory that runs once per file, so with
 *   a single module-level runtime a *row-level* latch would bind per FILE rather than per mount, and an
 *   earlier scenario would silently poison every later one (this really happened: client-fix's first
 *   hook-latch shape looked broken for that reason). `applyClient` therefore wraps each registered
 *   component in a fresh identity per apply, which isolates one scenario from the next and makes a
 *   per-mount latch testable here.
 * - React's rules of hooks ARE enforced (`renderNode` compares each component's hook count with its
 *   previous render and throws), so "does not throw" is meaningful; the guard's own sensitivity is
 *   asserted in a check below.
 * - Still NOT modelled: concurrent rendering, real reconciliation/memoisation, portals beyond a
 *   pass-through, and the shell's own hooks. Structural assertions remain the real guarantee.
 */
function createRuntime() {
  /** Instances keyed by component identity + tree position, holding hook slots across renders. */
  const byType = new WeakMap()
  let pending = []
  let renderRequested = false
  const stateUpdates = []

  const getInstance = (type, key) => {
    let instances = byType.get(type)
    if (instances === undefined) {
      instances = new Map()
      byType.set(type, instances)
    }
    let instance = instances.get(key)
    if (instance === undefined) {
      instance = { slots: [], cursor: 0, effects: [], cleanups: [] }
      instances.set(key, instance)
    }
    return instance
  }

  let current = null

  const hooks = {
    useState(initial) {
      const instance = current
      const index = instance.cursor++
      if (instance.slots.length <= index) {
        instance.slots[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = instance.slots[index]
      const setter = (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
        stateUpdates.push(true)
        schedule()
      }
      return [slot.value, setter]
    },
    useRef(initial) {
      const instance = current
      const index = instance.cursor++
      if (instance.slots.length <= index) instance.slots[index] = { kind: 'ref', value: { current: initial } }
      return instance.slots[index].value
    },
    useEffect(fn, deps) {
      const instance = current
      const index = instance.cursor++
      if (instance.slots.length <= index) instance.slots[index] = { kind: 'effect', deps: undefined, fn }
      const slot = instance.slots[index]
      const changed =
        slot.deps === undefined || deps === undefined || deps.length !== slot.deps.length || deps.some((value, i) => !Object.is(value, slot.deps[i]))
      slot.fn = fn
      if (changed) {
        slot.deps = deps
        pending.push({ instance, slot })
      }
    },
    useId() {
      const instance = current
      const index = instance.cursor++
      if (instance.slots.length <= index) instance.slots[index] = { kind: 'id', value: `id-${index}-${instance.slots.length}` }
      return instance.slots[index].value
    },
  }

  function schedule() {
    renderRequested = true
  }

  const React = {
    createElement(type, props, ...children) {
      const flat = []
      const push = (child) => {
        if (child === null || child === undefined || child === false || child === true) return
        if (Array.isArray(child)) child.forEach(push)
        else flat.push(child)
      }
      children.forEach(push)
      return { type, props: { ...(props ?? {}), children: flat.length === 1 ? flat[0] : flat } }
    },
    Fragment: Symbol('Fragment'),
    useState: hooks.useState,
    useRef: hooks.useRef,
    useEffect: hooks.useEffect,
    useId: hooks.useId,
    Component: class Component {
      constructor(props) {
        this.props = props
        this.state = {}
      }
      setState(next) {
        this.state = { ...this.state, ...next }
      }
      static getDerivedStateFromError() {
        return null
      }
    },
  }

  const ReactDOM = {
    createPortal(node) {
      return node
    },
  }

  /** Render a node tree; function components get a stable instance key per position. */
  function renderNode(node, key) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return { text: String(node), props: {}, children: [] }
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${key}.${index}`)).filter(Boolean)
    const { type, props } = node
    if (type === React.Fragment) return renderNode(props.children, `${key}f`)
    if (typeof type === 'function') {
      const instance = getInstance(type, key)
      const previous = current
      current = instance
      const wasCursor = instance.cursor
      instance.cursor = 0
      // Class components (the error boundary) are constructed once.
      let rendered
      if (type.prototype && typeof type.prototype.render === 'function') {
        const component = new type(props)
        rendered = component.render()
      } else {
        rendered = type(props)
      }
      current = previous
      // Enforce React's own rule, so "does not throw" means something in this harness: a component
      // that calls a different number of hooks than on its previous render is an error, and this is
      // the check that turns a conditional hook call into a failure rather than a silent pass.
      if (instance.hookCount !== undefined && instance.hookCount !== instance.cursor) {
        throw new Error(
          `${type.name || 'A component'} rendered ${instance.cursor} hooks but the previous render used ${instance.hookCount} (rules of hooks)`,
        )
      }
      instance.hookCount = instance.cursor
      instance.cursor = wasCursor
      if (rendered === null || rendered === undefined) return null
      return renderNode(rendered, `${key}->${type.name || 'anon'}`)
    }
    return {
      type,
      props,
      children: Array.isArray(props.children)
        ? props.children.map((child, index) => renderNode(child, `${key}.${index}`)).filter(Boolean)
        : renderNode(props.children, `${key}.0`) === null
          ? []
          : [renderNode(props.children, `${key}.0`)],
    }
  }

  function flatten(node, out = []) {
    if (node === null || node === undefined) return out
    if (Array.isArray(node)) {
      node.forEach((child) => flatten(child, out))
      return out
    }
    if (node.props !== undefined) out.push(node)
    if (Array.isArray(node.children)) node.children.forEach((child) => flatten(child, out))
    return out
  }

  function runPendingEffects() {
    const queue = pending
    pending = []
    for (const { instance, slot } of queue) {
      const index = slot.index ?? instance.slots.indexOf(slot)
      const existing = instance.cleanups[index]
      if (typeof existing === 'function') existing()
      const cleanup = slot.fn()
      instance.cleanups[index] = typeof cleanup === 'function' ? cleanup : undefined
    }
  }

  return {
    React,
    ReactDOM,
    /** Full render + effect flush, looped until quiescent. */
    render(element) {
      let tree = null
      for (let pass = 0; pass < 25; pass++) {
        renderRequested = false
        tree = renderNode(element, 'root')
        runPendingEffects()
        if (!renderRequested && pending.length === 0) break
      }
      return tree
    },
    nodes(tree) {
      return flatten(tree)
    },
    requests: () => stateUpdates.length,
  }
}

// ── browser globals ────────────────────────────────────────────────────────────────────────────
function installDOM() {
  const listeners = new Map()
  const window = {
    addEventListener(type, handler, capture) {
      listeners.set(`${type}:${capture === true}`, handler)
    },
    removeEventListener(type, capture) {
      listeners.delete(`${type}:${capture === true}`)
    },
  }
  const head = {
    children: [],
    appendChild(child) {
      this.children.push(child)
      child.parentNode = this
    },
    removeChild(child) {
      this.children = this.children.filter((entry) => entry !== child)
    },
  }
  const document = {
    activeElement: null,
    body: {},
    contains: () => true,
    head,
    createElement: () => ({ setAttribute() {}, textContent: '', parentNode: null }),
  }
  return {
    window,
    document,
    dispatchKey(key) {
      const handler = listeners.get('keydown:true') ?? listeners.get('keydown:false')
      if (handler === undefined) return false
      handler({
        key,
        preventDefault() {},
        stopPropagation() {},
        shiftKey: false,
      })
      return true
    },
    hasEscapeListener: () => listeners.has('keydown:true') || listeners.has('keydown:false'),
  }
}

// ── load client.js in a fake browser ───────────────────────────────────────────────────────────
const dom = installDOM()
const runtime = createRuntime()
let loaded = null
globalThis.window = Object.assign(dom.window, {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = { id, module: factory((specifier) => {
        if (specifier === 'react') return runtime.React
        if (specifier === 'react-dom') return runtime.ReactDOM
        throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
      }) }
    },
  },
})
globalThis.document = dom.document
globalThis.React = runtime.React

await import(CLIENT_URL)

assert.ok(loaded !== null, 'client.js did not call window.__ModuleLoader__.load')
console.log(`client module id: ${loaded.id}\n`)

/** Build a fake Client ctx and apply the plugin, capturing the section component. */
function applyClient({ form, mutate, withWhileServed = false, noRemote = false }) {
  const registered = []
  const cleanups = []
  const whileServedCalls = { calls: [], disposed: 0 }
  const ctx = {
    effect(fn) {
      const cleanup = fn()
      cleanups.push(cleanup)
      return cleanup
    },
    locale: {
      register() {},
      bind() {
        return (key) => key
      },
    },
    slots: {
      inject(name, callback) {
        return callback(name)
      },
      register(options, component) {
        registered.push({ options, component })
      },
    },
    configForms: {
      get: () => form ?? null,
      describe: () => ({ getSnapshot: () => ({ descriptors: [] }) }),
      ...(withWhileServed
        ? {
            whileServed(namespaces, register) {
              whileServedCalls.calls.push({ namespaces, register })
              return () => {
                whileServedCalls.disposed++
              }
            },
          }
        : {}),
    },
    remote: noRemote
      ? undefined
      : {
          settings: {
            describe: async () => [],
            mutate: async (...args) => {
              mutate.calls.push(args)
              return mutate.result ?? { ok: true }
            },
          },
        },
  }
  loaded.module.apply(ctx)
  const section = registered.find((entry) => entry.options.name === 'settings.section')
  const icon = registered.find((entry) => entry.options.name === 'settings.section.icon')
  // Give each apply its OWN component identities. The plugin's `Section`/`LedgerRow` are module-level
  // functions, so this runtime's instance cache (a WeakMap keyed by component identity) would otherwise
  // carry hook state — the session-name latch, drafts, the ledger — from one check into the next, which
  // is neither React's behaviour nor a property of the plugin. Wrapping forwards props unchanged.
  const freshen = (entry) => (entry === undefined ? entry : { ...entry, component: (props) => entry.component(props) })
  return { registered, section: freshen(section), icon: freshen(icon), ctx, cleanups, whileServedCalls }
}

const t = (key) => key

/** Compile-time label lookup so assertions can name controls by text. */
function find(root, predicate) {
  const nodes = runtime.nodes(root)
  return nodes.find(predicate) ?? null
}
const byClass = (root, className) => find(root, (node) => node.props.className === className)
const radios = (root) =>
  runtime.nodes(root).filter((node) => node.props.role === 'radio')
const radioFor = (root, mode) => find(root, (node) => node.props['data-mode'] === mode)
const dialog = (root) => find(root, (node) => node.props.role === 'dialog')
const mask = (root) => byClass(root, 'slu-mask')
const confirmButton = (root) =>
  find(root, (node) => typeof node.props.className === 'string' && node.props.className.includes('slu-btnPrimary'))
const cancelButton = (root) => {
  const panel = dialog(root)
  if (panel === null) return null
  return panel.children.find((child) => child.props?.className === 'slu-btn')
}

function click(node) {
  assert.ok(node !== null && node !== undefined, 'cannot click a missing node')
  assert.equal(typeof node.props.onClick, 'function', 'node has no onClick')
  node.props.onClick({ preventDefault() {}, stopPropagation() {} })
}

function readyForm(mode) {
  return {
    setCalls: [],
    snapshot: { status: 'ready', writable: true, value: { mode }, endpoint: 'https://api.deepseek.com/anthropic/v1/messages', maxBytes: 8388608 },
    getSnapshot() {
      return this.snapshot
    },
    subscribe() {
      return () => {}
    },
    async set(field, value) {
      this.setCalls.push([field, value])
      this.snapshot = { ...this.snapshot, value: { ...this.snapshot.value, [field]: value } }
      return true
    },
  }
}

// ── scenario 1: served form, the path that can actually write ──────────────────────────────────
check('served form: clicking a wide mode opens the dialog and performs NO write', () => {
  const form = readyForm('official-only')
  const mutate = { calls: [] }
  const applied = applyClient({ form, mutate })
  let tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  assert.equal(radios(tree).length, 4, 'four radios expected')
  click(radioFor(tree, 'any-model'))
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  assert.ok(dialog(tree) !== null, 'dialog must be open after selecting any-model')
  assert.deepEqual(form.setCalls, [], 'a write happened before confirmation (form path)')
  assert.deepEqual(mutate.calls, [], 'a write happened before confirmation (remote path)')
})

check('served form: confirming the dialog writes exactly the selected wide mode, once', () => {
  const form = readyForm('official-only')
  const mutate = { calls: [] }
  const applied = applyClient({ form, mutate })
  let tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  click(radioFor(tree, 'any-model'))
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  click(confirmButton(tree))
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  assert.deepEqual(form.setCalls, [['mode', 'any-model']])
  assert.equal(dialog(tree), null, 'the dialog must close after confirming')
})

check('served form: Escape cancels instead of confirming', () => {
  const form = readyForm('official-only')
  const mutate = { calls: [] }
  const applied = applyClient({ form, mutate })
  let tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  click(radioFor(tree, 'deepseek-any-provider'))
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  assert.ok(dialog(tree) !== null)
  assert.equal(dom.dispatchKey('Escape'), true, 'no capture-phase Escape listener was registered')
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  assert.equal(dialog(tree), null, 'Escape must close the dialog')
  assert.deepEqual(form.setCalls, [], 'Escape wrote the mode')
  assert.deepEqual(mutate.calls, [])
})

check('served form: a backdrop click cancels instead of confirming', () => {
  const form = readyForm('official-only')
  const mutate = { calls: [] }
  const applied = applyClient({ form, mutate })
  let tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  click(radioFor(tree, 'any-model'))
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  click(mask(tree))
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  assert.equal(dialog(tree), null)
  assert.deepEqual(form.setCalls, [])
  assert.deepEqual(mutate.calls, [])
})

check('served form: the Cancel button cancels instead of confirming', () => {
  const form = readyForm('official-only')
  const mutate = { calls: [] }
  const applied = applyClient({ form, mutate })
  let tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  click(radioFor(tree, 'any-model'))
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  const cancel = find(tree, (node) => node.props.className === 'slu-btn')
  click(cancel)
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  assert.equal(dialog(tree), null)
  assert.deepEqual(form.setCalls, [])
})

check('served form: off and official-only commit with no dialog', () => {
  const form = readyForm('any-model')
  const mutate = { calls: [] }
  const applied = applyClient({ form, mutate })
  let tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  click(radioFor(tree, 'off'))
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  assert.equal(dialog(tree), null, 'narrowing must not open a dialog')
  assert.deepEqual(form.setCalls, [['mode', 'off']])
  const mutate2 = { calls: [] }
  const applied2 = applyClient({ form: readyForm('deepseek-any-provider'), mutate: mutate2 })
  let tree2 = runtime.render(runtime.React.createElement(applied2.section.component, { t }))
  click(radioFor(tree2, 'official-only'))
  tree2 = runtime.render(runtime.React.createElement(applied2.section.component, { t }))
  assert.equal(dialog(tree2), null)
})

// ── scenario 2: no served form, the remote path ────────────────────────────────────────────────
await checkAsync('remote path: the gate holds and the confirmed write carries the described revision', async () => {
  const mutate = {
    calls: [],
    result: { ok: true },
  }
  const applied = applyClient({ form: null, mutate })
  let tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  click(radioFor(tree, 'deepseek-any-provider'))
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  assert.ok(dialog(tree) !== null)
  assert.deepEqual(mutate.calls, [])
  click(confirmButton(tree))
  await settle()
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  assert.equal(mutate.calls.length, 1)
  const [ns, ops, revision] = mutate.calls[0]
  assert.equal(ns, 'session-log-upload')
  assert.deepEqual(ops, [{ op: 'set', path: ['mode'], value: 'deepseek-any-provider' }])
  assert.equal(revision, undefined)
})

// ── scenario 3: keyboard is not a bypass ───────────────────────────────────────────────────────
check('arrow/Enter/Space keydown on a radio never writes and never opens a dialog', () => {
  const form = readyForm('official-only')
  const mutate = { calls: [] }
  const applied = applyClient({ form, mutate })
  let tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  const wide = radioFor(tree, 'any-model')
  for (const key of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End', 'Enter', ' ', 'Tab']) {
    wide.props.onKeyDown({ key, preventDefault() {}, stopPropagation() {}, shiftKey: false })
    tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
    assert.equal(dialog(tree), null, `key ${key} opened the dialog`)
    assert.deepEqual(form.setCalls, [], `key ${key} wrote the mode`)
    assert.deepEqual(mutate.calls, [])
  }
})

check('a wide mode already showing cannot be re-selected into a silent write', () => {
  const form = readyForm('any-model')
  const mutate = { calls: [] }
  const applied = applyClient({ form, mutate })
  let tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  click(radioFor(tree, 'any-model'))
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  assert.equal(dialog(tree), null, 're-selecting the current mode must be a no-op')
  assert.deepEqual(form.setCalls, [])
})

await checkAsync('a failed write falls back to the manual route and does not claim success', async () => {
  const mutate = { calls: [], result: { ok: false } }
  // A form that reports itself served but rejects the write, so the remote path is tried and fails.
  const form = readyForm('official-only')
  form.set = async (field, value) => {
    form.setCalls.push([field, value])
    return false
  }
  const applied = applyClient({ form, mutate })
  let tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  click(radioFor(tree, 'any-model'))
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  click(confirmButton(tree))
  await settle()
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  assert.equal(mutate.calls.length, 1, 'the remote fallback should have been attempted')
  const text = JSON.stringify(runtime.nodes(tree).map((node) => node.props.children).filter((value) => typeof value === 'string'))
  assert.match(text, /upload\.saveFailed/, 'the failure must be surfaced')
  assert.match(text, /mode: any-model/, 'the manual snippet must show the mode the user tried to select')
})

// ── registration shape ─────────────────────────────────────────────────────────────────────────
// ── scenario 4: the reworked "not served" state and whileServed ──────────────────────────────
function unavailableForm() {
  return {
    setCalls: [],
    snapshot: { status: 'unavailable', writable: false },
    getSnapshot() {
      return this.snapshot
    },
    subscribe() {
      return () => {}
    },
    async set(field, value) {
      this.setCalls.push([field, value])
      return true
    },
  }
}

check('whileServed: the section is registered only when the Host serves the namespace', () => {
  const mutate = { calls: [] }
  const applied = applyClient({ form: readyForm('off'), mutate, withWhileServed: true })
  assert.equal(applied.whileServedCalls.calls.length, 2, 'both the section and its icon must wait on whileServed')
  for (const call of applied.whileServedCalls.calls) {
    assert.deepEqual(call.namespaces, ['session-log-upload'])
    assert.equal(typeof call.register, 'function')
  }
  assert.equal(applied.registered.length, 0, 'nothing may register before the namespace is served')
  // The Host starts serving it: the register callbacks run.
  for (const call of applied.whileServedCalls.calls) call.register()
  assert.equal(applied.registered.length, 2, 'both registrations must appear once served')
  assert.ok(applied.registered.some((entry) => entry.options.name === 'settings.section'))
  assert.ok(applied.registered.some((entry) => entry.options.name === 'settings.section.icon'))
  // The effect cleanup must end the watch.
  for (const cleanup of applied.cleanups) if (typeof cleanup === 'function') cleanup()
  assert.equal(applied.whileServedCalls.disposed, 2)
})

check('a host without whileServed still registers immediately', () => {
  const applied = applyClient({ form: readyForm('off'), mutate: { calls: [] } })
  assert.equal(applied.registered.length, 2)
  assert.equal(applied.whileServedCalls.calls.length, 0)
})

check('not served: the radios are disabled and the manual route is shown instead', () => {
  const form = unavailableForm()
  const mutate = { calls: [] }
  const applied = applyClient({ form, mutate })
  let tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  const options = radios(tree)
  assert.equal(options.length, 4)
  for (const option of options) {
    assert.equal(option.props.disabled, true, 'a radio for an unserved namespace must be disabled')
    assert.equal(option.props['aria-disabled'], 'true')
  }
  assert.ok(find(tree, (node) => node.props.className === 'slu-manual') !== null, 'the manual route must be offered')
  assert.ok(find(tree, (node) => node.props.className === 'slu-error') === null, 'no failure may be reported before an attempt')
})

await checkAsync('not served with no remote: a forced click writes nothing and claims no save failure', async () => {
  const form = unavailableForm()
  const applied = applyClient({ form, mutate: { calls: [] }, noRemote: true })
  let tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  click(radioFor(tree, 'off'))
  await settle()
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  assert.deepEqual(form.setCalls, [], 'a form that is not ready must never receive a write')
  assert.ok(find(tree, (node) => node.props.className === 'slu-error') === null, 'a bare save failure must not be shown when there was no write path')
  assert.ok(find(tree, (node) => node.props.className === 'slu-manual') !== null)
})

check('a volatile form value is unwrapped for display (live reference on the client side)', () => {
  const form = readyForm('official-only')
  form.snapshot = { status: 'ready', writable: true, value: { mode: { get: () => 'any-model' } }, endpoint: 'https://x', maxBytes: 1024 }
  const applied = applyClient({ form, mutate: { calls: [] } })
  const tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  const checked = radios(tree).filter((node) => node.props['aria-checked'] === true)
  assert.equal(checked.length, 1, 'exactly one radio must be checked')
  assert.equal(checked[0].props['data-mode'], 'any-model', 'the volatile reference was not unwrapped')
})

check('the manual fallback never prints a one-step widening command', () => {
  const form = unavailableForm()
  const applied = applyClient({ form, mutate: { calls: [] }, noRemote: true })
  const tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  const blocks = runtime.nodes(tree).filter((node) => node.props.className === 'slu-pre')
  const text = blocks.map((node) => (typeof node.props.children === 'string' ? node.props.children : '')).join('\n')
  assert.ok(text.includes('/session-log-upload'), 'the manual block must print a command')
  assert.ok(!/\bconfirm\b/.test(text), 'the printed command must not carry the confirmation token, so a paste cannot widen in one step')
  // It prints the profile's own row, key for key.
  for (const key of ['mode:', 'deepseekModelPatterns:', 'endpoint:', 'uploadModel:', 'credentialRef:', 'maxBytes:']) {
    assert.ok(text.includes(key), `the printed patch row is missing ${key}`)
  }
})

check('the manual block is collapsed behind a summary (last resort, not the expected path)', () => {
  const applied = applyClient({ form: unavailableForm(), mutate: { calls: [] }, noRemote: true })
  const tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  const details = find(tree, (node) => node.type === 'details')
  assert.ok(details !== null, 'the manual block must be a <details> disclosure')
  assert.ok(runtime.nodes(tree).some((node) => node.type === 'summary'))
})

// ── scenario 5: this revision — three volatile fields, two of them editable ──────────────────
// RETARGETED. This used to assert that the only literal either write path could use was `"mode"`,
// which was right while `mode` was the only writable field. task-19 makes `endpoint` and `maxBytes`
// editable from the page at the user's request, so the contract is now: the UI may write exactly the
// three volatile fields, never `deepseekModelPatterns` / `uploadModel` / `credentialRef`, and `mode`
// must still only be reachable through the consent-gated path. The literal-matching is gone because
// the field is now a variable, so assert the whitelist and drive the write paths instead.
check('RETARGETED: the UI may write exactly the four whitelisted fields — never `mode`, `uploadModel`, `credentialRef`', () => {
  // The whitelist is the guard, and `mode` is deliberately NOT in it: mode has its own gated path.
  // It grew from two names to four when the user gained two editable lists — a model-pattern list (so
  // a proxy's renamed model can be marked as DeepSeek) and an upload-directory allowlist. The line
  // that must not move is the same one: `mode`, `uploadModel`, `credentialRef` stay out.
  assert.match(
    CLIENT_SOURCE,
    /const EDITABLE_FIELDS = Object\.freeze\(\[ ?"endpoint", ?"maxBytes", ?"deepseekModelPatterns", ?"uploadDirectories", ?"uploadSessionIds" ?\]\);/,
    'the editable-field whitelist changed shape or contents',
  )
  assert.match(CLIENT_SOURCE, /if \(EDITABLE_FIELDS\.indexOf\(field\) < 0\) return \{ ok: false, path: "none", doc: null \}/)
  const whitelist = [...(CLIENT_SOURCE.match(/EDITABLE_FIELDS = Object\.freeze\(\[([^\]]*)\]/) ?? [])][1]
  for (const forbidden of ['mode', 'uploadModel', 'credentialRef']) {
    assert.equal(whitelist.includes(forbidden), false, `${forbidden} is in EDITABLE_FIELDS`)
  }
  // `mode` has its own writer, reached only from the consent-gated path.
  // CRLF-tolerant: this checkout writes CRLF (core.autocrlf=true), so `\n`-only anchors never match.
  assert.match(CLIENT_SOURCE, /async function writeMode\(nextMode\) \{\r?\n\t+return persistField\("mode", nextMode\);/)
  // No literal write of the two protected fields through any path, and no literal `mode` write from
  // the field editor either (it writes `field`, a variable, which the whitelist bounds).
  for (const protectedField of ['uploadModel', 'credentialRef']) {
    assert.doesNotMatch(CLIENT_SOURCE, new RegExp(`form\\.set\\(\\s*"${protectedField}"`), `the UI writes ${protectedField}`)
    assert.doesNotMatch(CLIENT_SOURCE, new RegExp(`path:\\s*\\[\\s*"${protectedField}"`), `the UI writes ${protectedField}`)
  }
  // The render exposes exactly two editable field names, and no input is offered for anything else.
  // `data-field: field` is the generic editor (endpoint / maxBytes / the pattern list). The directory
  // chooser carries a literal `data-field: "uploadDirectories"` because it is not one generic control.
  // Both forms must stay within the whitelist: no data-field may name `mode` or a protected field.
  const dataFields = [ ...new Set([ ...CLIENT_SOURCE.matchAll(/"data-field":\s*field|"data-field":\s*"([^"]+)"/g) ].map((m) => m[1] ?? 'field')) ]
  assert.deepEqual(dataFields.sort(), [ 'field', 'uploadDirectories' ], `data-field values: ${JSON.stringify(dataFields)}`)
  for (const forbidden of [ 'mode', 'uploadModel', 'credentialRef' ]) {
    assert.equal(dataFields.includes(forbidden), false, `a data-field names ${forbidden}`)
  }
  assert.match(CLIENT_SOURCE, /field === "endpoint" \? "upload\.endpointEditLabel" : "upload\.capEditLabel"/)
})

check('RETARGETED: the effective destination and cap are still rendered read-only ALONGSIDE the inputs', () => {
  // RETARGETED. "Read-only" used to mean "there is no control at all". The property that matters now
  // is the one the A1 work established: the *effective* value stays on screen in `code.slu-value`
  // next to the input, and it is what the dialog names — so neither the disclosure nor the consent
  // dialog can ever read a draft the user has not saved. A draft is a second value; the effective
  // value is the one that must keep being shown.
  const form = readyForm('official-only')
  form.snapshot = {
    status: 'ready',
    writable: true,
    value: { mode: 'official-only', endpoint: 'https://api.deepseek.com/anthropic/v1/messages', maxBytes: 8388608 },
  }
  const applied = applyClient({ form, mutate: { calls: [] } })
  let tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  const effectiveValues = () =>
    runtime.nodes(tree)
      .filter((node) => node.props.className === 'slu-value')
      .map((node) => (typeof node.props.children === 'string' ? node.props.children : ''))
  assert.ok(
    effectiveValues().includes('https://api.deepseek.com/anthropic/v1/messages'),
    `the effective destination is not rendered: ${JSON.stringify(effectiveValues())}`,
  )
  assert.ok(effectiveValues().some((value) => value.includes('MiB')), `the effective cap is not rendered: ${JSON.stringify(effectiveValues())}`)
  // Both inputs exist and mirror the effective value while untouched.
  const inputs = runtime.nodes(tree).filter((node) => node.type === 'input' && node.props['data-field'] !== undefined)
  assert.deepEqual(
    inputs.map((node) => node.props['data-field']).sort(),
    ['endpoint', 'maxBytes'],
    'the page no longer offers exactly the two editable fields',
  )
  for (const input of inputs) assert.equal(typeof input.props.value, 'string', 'an input does not mirror the effective value')
  assert.ok(inputs.some((input) => input.props.value === 'https://api.deepseek.com/anthropic/v1/messages'))
  // Now type a draft into the endpoint input: the input changes, the read-only effective value does not.
  const endpointInput = inputs.find((input) => input.props['data-field'] === 'endpoint')
  endpointInput.props.onChange({ target: { value: 'https://evil.example/collect' } })
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  const afterDraft = runtime.nodes(tree).find((node) => node.type === 'input' && node.props['data-field'] === 'endpoint')
  assert.equal(afterDraft.props.value, 'https://evil.example/collect', 'the draft did not reach the input')
  assert.ok(
    effectiveValues().includes('https://api.deepseek.com/anthropic/v1/messages'),
    'the read-only effective destination followed the unsaved draft',
  )
  assert.equal(effectiveValues().includes('https://evil.example/collect'), false, 'an unsaved draft was published as the effective destination')
  // The dialog names the effective destination, not the draft.
  const wideMode = runtime.nodes(tree).find((node) => node.props.role === 'radio' && node.props['data-mode'] === 'any-model')
  assert.ok(wideMode !== undefined, 'the wide-mode radio is missing')
  click(wideMode)
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  const panel = find(tree, (node) => node.props.className === 'slu-panelEndpoint')
  assert.ok(panel !== null, 'the dialog does not name a destination')
  const named = String(panel.props.children)
  assert.ok(named.includes('https://api.deepseek.com/anthropic/v1/messages'), `the dialog named a draft: ${named}`)
  assert.equal(named.includes('https://evil.example/collect'), false, 'the dialog named an unsaved draft')
})

check('RETARGETED: the pending-range row is gone, and the ledger still renders the real range', () => {
  // The old banned set was extended by the editable fields, so this check now carries only the
  // pending-range property plus the ledger's own range rendering.
  // RETARGETED. This used to ban `afterSeq` outright, which was right while the page had no
  // legitimate source for a Session's range. The ledger now reads `afterSeq` per Session from the
  // Host's own watermark table and renders it under "Uploaded through", so the banned set is the
  // dead pending-range surface plus `throughSeq` (the *un-uploaded* range's end — the Endpoint
  // never reports it, and rendering it would be a second, locally invented range).
  for (const gone of ['upload.pendingLabel', 'upload.pendingNone', 'upload.pendingUnknown', 'pickPending', 'throughSeq']) {
    assert.equal(CLIENT_SOURCE.includes(gone), false, `${gone} is still referenced`)
  }
  // The one channel that may carry `afterSeq` is the ledger, and it must actually render it: exactly
  // two lines may mention it — the payload read and the rendered range cell — so a pending-range row
  // cannot come back without failing this.
  const afterSeqLines = CLIENT_SOURCE.split('\n').filter((line) => line.includes('afterSeq'))
  assert.equal(afterSeqLines.length, 2, `afterSeq must appear on exactly two lines, found ${afterSeqLines.length}`)
  assert.match(afterSeqLines[0], /afterSeq: numberOrNull\(record\.afterSeq\)/, 'the ledger no longer reads afterSeq')
  assert.match(afterSeqLines[1], /session\.afterSeq === null \? t\("upload\.valueUnknown"\)/, 'the ledger no longer renders the range')
  assert.match(CLIENT_SOURCE, /upload\.ledger\.columnRange/, 'the ledger range column is gone')
  const form = readyForm('official-only')
  form.snapshot = {
    status: 'ready',
    writable: true,
    value: { mode: 'official-only', endpoint: 'https://api.deepseek.com/anthropic/v1/messages', maxBytes: 8388608 },
  }
  const applied = applyClient({ form, mutate: { calls: [] } })
  const tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  const values = runtime.nodes(tree)
    .filter((node) => node.props.className === 'slu-value')
    .map((node) => (typeof node.props.children === 'string' ? node.props.children : ''))
  assert.ok(
    values.some((value) => value === 'https://api.deepseek.com/anthropic/v1/messages'),
    `the destination is not rendered: ${JSON.stringify(values)}`,
  )
  assert.ok(values.some((value) => value.includes('MiB')), `the byte cap is not rendered: ${JSON.stringify(values)}`)
  // The old "nothing that could edit them" assertion is gone: the fields ARE editable now, and the
  // property that replaced it (the effective value stays rendered read-only beside the input) is the
  // dedicated retargeted check above.
})

check('the consent dialog still names the destination from the live value', () => {
  const form = readyForm('official-only')
  form.snapshot = {
    status: 'ready',
    writable: true,
    value: { mode: 'official-only', endpoint: 'http://127.0.0.1:54779/collect', maxBytes: 1024 },
  }
  const applied = applyClient({ form, mutate: { calls: [] } })
  let tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  click(radioFor(tree, 'any-model'))
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  const panel = dialog(tree)
  assert.ok(panel !== null, 'the dialog did not open')
  const panelText = runtime
    .nodes(panel)
    .map((node) => (typeof node.props.children === 'string' ? node.props.children : ''))
    .join(' ')
  assert.ok(panelText.includes('http://127.0.0.1:54779/collect'), `the dialog did not name the destination: ${panelText}`)
  assert.ok(panelText.includes('upload.warnBody'), 'the dialog body is missing')
})

// ── scenario 6: the A1 agreement property — what the page shows is what the Host will use ────
const { DEFAULT_ENDPOINT, DEFAULT_MAX_BYTES, resolveConfig } = await import('../host/config.js')

/** A printable description of any value, including ones that cannot be stringified. */
function describe(value) {
  try {
    if (typeof value === 'symbol') return value.toString()
    if (value === null) return 'null'
    if (value === undefined) return 'undefined'
    if (typeof value === 'object') return JSON.stringify(value) ?? Object.prototype.toString.call(value)
    return String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

/** The 21 hostile endpoints plus the legitimate ones and assorted plain/non-string values. */
const ENDPOINT_CORPUS = [
  // hostile (the verifier's list)
  'file:///etc/passwd',
  'file://C:/Windows/win.ini',
  'javascript:alert(1)',
  'data:text/plain,leak',
  'ftp://x/y',
  'ws://x/y',
  '//evil.example/x',
  '/relative/path',
  'relative/path',
  './x',
  'https:/evil.example',
  'https:evil.example',
  'http:',
  '',
  '   ',
  42,
  null,
  {},
  [],
  ['https://ok'],
  true,
  // legitimate
  'https://api.deepseek.com/anthropic/v1/messages',
  'http://127.0.0.1:8080/ingest',
  'https://localhost/collect',
  'HTTPS://API.EXAMPLE/collect',
  // plain strings / non-strings
  'https://',
  'ftp:/x',
  'x',
  'https://ok.example/x ',
  ' https://ok.example/x',
  undefined,
  0,
  false,
  Symbol('endpoint'),
]

/** The cap corpus: the schema accepts integers past the safe range, `normalizeMaxBytes` does not. */
const MAXBYTES_CORPUS = [
  1,
  512,
  1024,
  8388608,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  2 ** 53,
  2 ** 53 + 2,
  1e21,
  Number.MAX_VALUE,
  0,
  -1,
  1.5,
  NaN,
  Infinity,
  '1024',
  null,
  true,
  {},
  undefined,
]

/** An independent re-implementation of the display format, so a bug in the client's cannot hide. */
function formatCap(bytes, t) {
  if (bytes >= 1048576) return String(Math.round((bytes / 1048576) * 10) / 10) + ' ' + t('upload.unitMiB')
  if (bytes >= 1024) return String(Math.round(bytes / 1024)) + ' ' + t('upload.unitKiB')
  return String(bytes) + ' ' + t('upload.unitBytes')
}

/** The `code.slu-value` that follows the label whose text is `label`. */
function valueAfterLabel(root, label) {
  const fields = runtime.nodes(root).filter((node) => node.props.className === 'slu-field')
  for (const field of fields) {
    const labelText = runtime
      .nodes(field)
      .map((node) => (typeof node.props.children === 'string' ? node.props.children : ''))
      .join('|')
    if (!labelText.includes(label)) continue
    const value = runtime.nodes(field).find((node) => node.props.className === 'slu-value')
    if (value !== undefined) return typeof value.props.children === 'string' ? value.props.children : null
  }
  return null
}

/** Render the section with a given wire value and read what the page would show. */
function shownByThePage({ endpoint, maxBytes }) {
  const form = readyForm('official-only')
  const value = {}
  if (endpoint !== undefined) value.endpoint = endpoint
  if (maxBytes !== undefined) value.maxBytes = maxBytes
  value.mode = 'official-only'
  form.snapshot = { status: 'ready', writable: true, value }
  const applied = applyClient({ form, mutate: { calls: [] } })
  let tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  const destination = valueAfterLabel(tree, 'upload.destinationLabel')
  const cap = valueAfterLabel(tree, 'upload.byteCapLabel')
  click(radioFor(tree, 'deepseek-any-provider'))
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  const panel = find(tree, (node) => node.props.className === 'slu-panelEndpoint')
  const dialogDestination = panel === null ? null : String(panel.props.children)
  return { destination, cap, dialogDestination }
}

check('A1 PROPERTY: for every endpoint input, the shown destination equals the destination the Host will use', () => {
  let checked = 0
  let discrepancies = 0
  for (const value of ENDPOINT_CORPUS) {
    // What the Host will actually POST to.
    const used = resolveConfig({ endpoint: value }).endpoint
    const shown = shownByThePage({ endpoint: value })
    // A served document speaks for this namespace, so the page must name the endpoint in use —
    // including for a non-string, an empty string or an absent field (all of which fall back).
    const expected = used
    if (shown.destination !== expected) {
      discrepancies++
      console.log(`        SHOWN ≠ USED for ${describe(value)}: page shows ${JSON.stringify(shown.destination)}, Host uses ${JSON.stringify(used)}`)
    }
    assert.equal(
      shown.dialogDestination,
      'upload.destinationLabel' + ': ' + expected,
      `the dialog named a different destination than the Host uses for ${describe(value)}`,
    )
    checked++
  }
  assert.equal(discrepancies, 0, `${discrepancies} endpoint inputs are shown but not used`)
  console.log(`        ${checked} endpoint inputs: shown == used, including the dialog`)
})

check('A1 PROPERTY: for every maxBytes input, the shown cap equals the cap the Host will use', () => {
  let checked = 0
  let discrepancies = 0
  for (const value of MAXBYTES_CORPUS) {
    const used = resolveConfig({ maxBytes: value }).maxBytes
    const shown = shownByThePage({ maxBytes: value })
    const expected = used === null || used === undefined ? 'upload.valueUnknown' : formatCap(used, t)
    if (shown.cap !== expected) {
      discrepancies++
      console.log(`        SHOWN ≠ USED for maxBytes ${describe(value)}: page shows ${JSON.stringify(shown.cap)}, Host uses ${JSON.stringify(used)}`)
    }
    checked++
  }
  assert.equal(discrepancies, 0, `${discrepancies} maxBytes inputs are shown but not used`)
  console.log(`        ${checked} cap inputs: shown == used`)
})

check('A1 PROPERTY: the page falls back to the SAME defaults the Host uses', () => {
  // A single divergent constant would make every "shown == used" case above agree on the wrong value.
  const source = CLIENT_SOURCE
  assert.ok(source.includes(`endpoint: "${DEFAULT_ENDPOINT}"`), `the page's fallback endpoint is not the Host default ${DEFAULT_ENDPOINT}`)
  assert.ok(source.includes(`maxBytes: ${DEFAULT_MAX_BYTES}`), `the page's fallback cap is not the Host default ${DEFAULT_MAX_BYTES}`)
  // RETARGETED. The inline predicates were refactored: display narrowing and input validation now share
  // one `isAbsoluteHttpEndpoint()` / `isUsableByteCap()`, which is strictly better for drift than two
  // paraphrases of the Host rule. Assert the RULE is defined once and that both consumers use it, and
  // drive the resulting behaviour below rather than pinning the old inline expression. Matching is on
  // whitespace-flattened text, because the source is indented and the predicates contain slashes.
  const flat = CLIENT_SOURCE.replace(/\s+/g, ' ')
  assert.ok(
    flat.includes('function isAbsoluteHttpEndpoint(value) { return typeof value === "string" && value.length > 0 && /^https?:\\/\\//i.test(value); }'),
    'the shared endpoint predicate is missing or no longer the Host rule',
  )
  assert.ok(
    flat.includes('function isUsableByteCap(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }'),
    'the shared cap predicate is missing or no longer the Host rule',
  )
  // Both the display narrowing and the write validation go through the shared predicates.
  assert.ok(flat.includes('function endpointInUse(value) { return isAbsoluteHttpEndpoint(value) ? value : PATCH_ROW.endpoint; }'))
  assert.ok(flat.includes('function maxBytesInUse(value) { return isUsableByteCap(value) ? value : PATCH_ROW.maxBytes; }'))
  assert.ok(flat.includes('function endpointToWrite(text) { return isAbsoluteHttpEndpoint(text) ? text : null; }'))
  assert.ok(flat.includes('return isUsableByteCap(parsed) ? parsed : null;'))
  // One definition each: a second copy is how the two paths drift apart again.
  for (const name of ['isAbsoluteHttpEndpoint', 'isUsableByteCap']) {
    const definitions = [...CLIENT_SOURCE.matchAll(new RegExp(`function ${name}\\(value\\)`, 'g'))].length
    assert.equal(definitions, 1, `${name} is defined ${definitions} times`)
  }
  // Drove the agreement: the predicates agree with the Host for the whole corpus (the two checks above),
  // and the write path uses the same predicate as the display path for every draft.
  for (const value of [DEFAULT_ENDPOINT, 'http://127.0.0.1:8080/ingest', 'file:///etc/passwd', '', '   ', 'https:/x', 42, null, {}]) {
    const displayed = shownByThePage({ endpoint: value }).destination
    const hostUses = resolveConfig({ endpoint: value }).endpoint
    assert.equal(displayed, hostUses, `display disagrees with the Host for ${JSON.stringify(value)}`)
  }
  for (const value of [DEFAULT_MAX_BYTES, 1, 2 ** 53, 1e21, 0, -1, 1.5]) {
    const displayed = shownByThePage({ maxBytes: value }).cap
    const hostUses = resolveConfig({ maxBytes: value }).maxBytes
    assert.equal(displayed, formatCap(hostUses, t), `cap display disagrees with the Host for ${String(value)}`)
  }
})

check('A1 PROPERTY: the non-string and out-of-range values are exactly the ones the Host refuses', () => {
  // Guard against the client "narrowing" something the Host would have accepted (a false negative
  // would show the default while the plugin really used the supplied value).
  for (const value of ['https://api.deepseek.com/anthropic/v1/messages', 'http://127.0.0.1:8080/ingest', 'https://localhost/collect', 'HTTPS://API.EXAMPLE/collect']) {
    assert.equal(resolveConfig({ endpoint: value }).endpoint, value, `the Host refuses a legitimate endpoint: ${value}`)
    assert.equal(shownByThePage({ endpoint: value }).destination, value, `the page narrowed a legitimate endpoint: ${value}`)
  }
  for (const value of [Number.MAX_SAFE_INTEGER, 1, 512, 1024, 8388608]) {
    assert.equal(resolveConfig({ maxBytes: value }).maxBytes, value, `the Host refuses a legitimate cap: ${value}`)
    assert.equal(shownByThePage({ maxBytes: value }).cap, formatCap(value, t), `the page narrowed a legitimate cap: ${value}`)
  }
})

// ── scenario 7: the upload ledger UI (the page's half of the read-only ledger) ────────────────
/** A fetch fake: `handler(input, init)` is the page's fetch — a factory, so a throw is a transport failure. */
async function renderWithLedger(handler, body, extraProps = {}) {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch =
    handler === null
      ? undefined
      : async (input, init) => {
          // The liability notice is read from its own route on mount. Answer it here so it never
          // consumes a ledger reply (which made the ledger look "read twice") and so the notice dialog
          // stays out of the way of these checks — they are about the ledger, not about consent.
          const url = typeof input === 'string' ? input : String(input)
          if (url.indexOf('session-log-upload.notice') >= 0) return jsonResponse({ acknowledged: true })
          calls.push({ input, init })
          return handler(input, init)
        }
  try {
    const form = readyForm('official-only')
    const applied = applyClient({ form, mutate: { calls: [] } })
    const render = () => runtime.render(runtime.React.createElement(applied.section.component, { t, ...extraProps }))
    let tree = render()
    // The read publishes asynchronously, so poll until the section leaves its loading state rather
    // than assuming a fixed number of ticks — a stale read would silently test the previous case.
    // The ledger read retries a failure (0/120/400 ms), and this suite loads the real module, so those
    // are real timers: the poll has to hand the event loop real time, not just microtask ticks, or a
    // failing case would sit in "loading" forever.
    for (let attempt = 0; attempt < 40 && allText(tree).includes('upload.ledger.loading'); attempt++) {
      await settle()
      await new Promise((resolve) => setTimeout(resolve, 25))
      tree = render()
    }
    assert.equal(allText(tree).includes('upload.ledger.loading'), false, 'the ledger never left its loading state')
    // A body runs INSIDE the fetch stub's scope, so a gesture that re-reads still uses the fake.
    if (body === undefined) return { tree, calls, applied, render }
    return await body({ tree, calls, applied, render })
  } finally {
    globalThis.fetch = realFetch
  }
}
const jsonResponse = (body, status = 200) => ({ ok: status < 400, status, async json() { return body } })
const textResponse = (status) => ({ ok: status < 400, status, async json() { throw new Error('not json') } })
/** Every string rendered anywhere under `root`. */
const renderedStrings = (root) =>
  runtime
    .nodes(root)
    .flatMap((node) => (typeof node.props.children === 'string' ? [node.props.children] : []))
const allText = (root) => renderedStrings(root).join('\u0000')

await checkAsync('LEDGER UI: four DISTINCT non-ready states, each named honestly', async () => {
  // Each entry is a fetch *factory* (`null` = the page exposes no fetch at all), so the same shape the
  // page calls is what fails: a throw, a status, or a body that cannot be read.
  const cases = [
    ['missing (404)', () => textResponse(404), 'upload.ledger.stateMissing'],
    ['unauthorized (401)', () => textResponse(401), 'upload.ledger.stateUnauthorized'],
    ['forbidden (403)', () => textResponse(403), 'upload.ledger.stateUnauthorized'],
    ['server error (500)', () => textResponse(500), 'upload.ledger.stateFailed'],
    ['transport failure', () => { throw new Error('network down') }, 'upload.ledger.stateFailed'],
    ['non-JSON 200', () => textResponse(200), 'upload.ledger.stateMalformed'],
    ['JSON without a sessions array', () => jsonResponse({ total: 3 }), 'upload.ledger.stateMalformed'],
    ['JSON null', () => jsonResponse(null), 'upload.ledger.stateMalformed'],
    ['no page fetch at all', null, 'upload.ledger.stateFailed'],
  ]
  const seen = new Set()
  for (const [label, factory, expected] of cases) {
    const { tree } = await renderWithLedger(factory)
    const text = allText(tree)
    assert.ok(text.includes(expected), `${label} did not render ${expected} (saw ${JSON.stringify(text.slice(-90))})`)
    assert.equal(
      text.includes('upload.ledger.stateMissing'),
      expected === 'upload.ledger.stateMissing',
      `${label} claimed the wrong state`,
    )
    seen.add(expected)
  }
  assert.equal(seen.size, 4, `expected four distinct non-ready states, saw ${[...seen].join(', ')}`)
  console.log(`        9 failure shapes mapped onto ${seen.size} distinct, honestly-named states`)
})

await checkAsync('LEDGER UI: the HOST total is rendered, never a locally counted number', async () => {
  const body = {
    generatedAt: 1730000000000,
    directory: 'C:\\Users\\x\\.dsh\\session-log-upload',
    total: 7,
    sessions: [
      { sessionId: 'sess-new', afterSeq: 12, sessionFormatVersion: 4, updatedAt: 1730000000000 },
      { sessionId: 'sess-old', afterSeq: 3, sessionFormatVersion: 4, updatedAt: 1720000000000 },
      { afterSeq: 1, sessionFormatVersion: 4, updatedAt: 1710000000000 },
      'not-an-object',
    ],
  }
  const { tree, calls } = await renderWithLedger(() => jsonResponse(body))
  const text = allText(tree)
  // Two usable rows, TWO skipped records (one without a session id, one not an object at all), and a
  // Host total that is higher than either — the page must report the Host's number, not its own.
  // The rendered line is `<total label> <n>`, so match the label and its number as one phrase.
  assert.ok(/upload\.ledger\.total 7/.test(text), `the Host total was not rendered: ${text.slice(-200)}`)
  assert.ok(!/upload\.ledger\.total 2/.test(text), 'the page counted its own rows instead of using the Host total')
  assert.ok(/upload\.ledger\.skipped 2/.test(text), `the skipped records were not reported: ${JSON.stringify(text.slice(-160))}`)
  assert.ok(text.includes('sess-new') && text.includes('sess-old'), 'the real rows are missing')
  assert.ok(text.includes('12') && text.includes('4'), 'the range and format version are not rendered')
  assert.equal(text.includes('not-an-object'), false, 'a non-record was rendered as a row')
  // The range column renders per row; `throughSeq` never appears anywhere.
  assert.equal(text.includes('throughSeq'), false)
  // The read is exactly one GET of the document-relative route, asking for JSON and sending no body.
  assert.equal(calls.length, 1, 'the ledger was read more than once on mount')
  assert.equal(calls[0].input, 'api/session-log-upload.ledger')
  assert.equal(calls[0].input.startsWith('/'), false, 'an absolute path would escape the page base')
  assert.equal(calls[0].init.method ?? 'GET', 'GET')
  assert.equal(calls[0].init.body, undefined, 'the read must not send a body')
  assert.equal(calls[0].init.headers.accept, 'application/json')
})

await checkAsync('LEDGER UI: metadata only — a payload cannot smuggle content into the page', async () => {
  const body = {
    generatedAt: 1730000000000,
    directory: 'C:\\ledger',
    total: 1,
    sessions: [
      {
        sessionId: 'sess-1',
        afterSeq: 9,
        sessionFormatVersion: 4,
        updatedAt: 1730000000000,
        title: 'SECRET-TITLE',
        cwd: 'C:\\Users\\SECRET\\private',
        prompt: 'SECRET-PROMPT',
        content: 'SECRET-CONTENT',
        events: [{ text: 'SECRET-EVENT' }],
      },
    ],
    attribution: { lastUploadAt: 1730000000000, headers: ['user-agent'] },
  }
  const { tree } = await renderWithLedger(() => jsonResponse(body))
  const text = allText(tree)
  for (const secret of ['SECRET-TITLE', 'SECRET-USER', 'SECRET-PROMPT', 'SECRET-CONTENT', 'SECRET-EVENT']) {
    assert.equal(text.includes(secret), false, `${secret} was rendered by the page`)
  }
  assert.ok(text.includes('sess-1'), 'the one legitimate row is missing')
  // The attribution report is Host-side evidence; the page must not invent a rendering for it.
  assert.equal(text.includes('user-agent'), false, 'the page rendered the raw attribution report')
})

await checkAsync('LEDGER UI: the empty state explains that it covers this plugin only', async () => {
  const { tree } = await renderWithLedger(() => jsonResponse({ generatedAt: 1, directory: 'C:\\l', total: 0, sessions: [] }))
  const text = allText(tree)
  assert.ok(text.includes('upload.ledger.empty'), 'the empty state is missing')
  assert.ok(/upload\.ledger\.total 0/.test(text), 'a zero total should still be shown')
  // The key itself must be the plugin-scoped wording, not a generic "no data" line.
  const en = JSON.parse(readFileSync('locale/en.json', 'utf8')).upload.ledger
  assert.match(en.empty, /this plugin only/i)
  assert.match(en.empty, /official/i)
  assert.match(en.stateMissing, /Host does not serve/i)
  assert.notEqual(en.stateMissing, en.stateFailed)
  assert.notEqual(en.stateUnauthorized, en.stateFailed)
  assert.notEqual(en.stateMalformed, en.stateFailed)
})

await checkAsync('LEDGER UI: refresh re-reads, and a re-read failure does not crash the section', async () => {
  let round = 0
  await renderWithLedger(
    () => {
      round++
      return round === 1
        ? jsonResponse({ total: 1, sessions: [{ sessionId: 'sess-1', afterSeq: 5, sessionFormatVersion: 4, updatedAt: 1 }] })
        : textResponse(500)
    },
    async ({ tree, calls, render }) => {
      assert.equal(calls.length, 1, 'the ledger was not read once on mount')
      assert.ok(allText(tree).includes('sess-1'), 'the first read did not render its row')
      // The refresh control is the button that carries the ledger refresh label and its own handler.
      const button = runtime
        .nodes(tree)
        .find((node) => node.props.className === 'slu-btn slu-ledgerRefresh')
      assert.ok(button !== undefined, 'the ledger refresh control is missing')
      click(button)
      await settle()
      await settle()
      let after = render()
      // The re-read retries a failure, so the failure state appears only after the bounded attempts run
      // out. Poll with real time (the retries are real timers) instead of assuming one tick.
      for (let attempt = 0; attempt < 40 && !allText(after).includes('upload.ledger.stateFailed'); attempt++) {
        await settle()
        await new Promise((resolve) => setTimeout(resolve, 25))
        after = render()
      }
      // A refresh re-reads the ledger; the retries mean it asks more than once when the Host fails.
      assert.ok(calls.length >= 2, `refresh did not re-read the ledger (${calls.length} calls)`)
      // The refresh re-read failed; the section must say so and keep rendering, not throw or vanish.
      assert.ok(allText(after).includes('upload.ledger.stateFailed'), 'the failed refresh was not surfaced')
      assert.ok(allText(after).includes('upload.ledger.title'), 'the ledger section disappeared after the failure')
      assert.equal(allText(after).includes('sess-1'), false, 'the stale row survived a failed refresh')
    },
  )
})

// ── scenario 8: the editable fields, the opt-in session names, and the copy ───────────────────
/** Render the section with a served form and return the tree plus the recording form. */
function renderEditable(form = readyForm('official-only'), extraProps = {}, options = {}) {
  const mutate = options.mutate ?? { calls: [], result: { ok: true } }
  const applied = applyClient({ form, mutate, noRemote: options.noRemote === true })
  const render = () => runtime.render(runtime.React.createElement(applied.section.component, { t, ...extraProps }))
  return { tree: render(), render, form, mutate, applied }
}
/** Every rendered string, for asserting which locale key is on screen. */
const stringsOf = (tree) => runtime.nodes(tree).flatMap((node) => (typeof node.props.children === 'string' ? [node.props.children] : []))
const fieldInput = (tree, field) => runtime.nodes(tree).find((node) => node.type === 'input' && node.props['data-field'] === field) ?? null
const saveButton = (tree, field) =>
  runtime.nodes(tree).find((node) => node.type === 'button' && node.props['data-field'] === field) ?? null

await checkAsync('EDITABLE FIELDS (driven): the cap writes a NUMBER, and only the two editable fields are ever written', async () => {
  const { tree, render, form } = renderEditable()
  // Draft 1024 bytes and save it.
  fieldInput(tree, 'maxBytes').props.onChange({ target: { value: '1024' } })
  let current = render()
  click(saveButton(current, 'maxBytes'))
  await settle()
  current = render()
  assert.deepEqual(form.setCalls, [['maxBytes', 1024]], `the cap write was ${JSON.stringify(form.setCalls)}`)
  assert.equal(typeof form.setCalls[0][1], 'number', 'the cap wrote the input STRING instead of a byte count')
  assert.equal(stringsOf(current).includes('upload.fieldSaved'), true, 'a successful save did not report success')
  // Draft an endpoint and save it.
  fieldInput(current, 'endpoint').props.onChange({ target: { value: 'https://custom.example/ingest' } })
  current = render()
  click(saveButton(current, 'endpoint'))
  await settle()
  current = render()
  assert.deepEqual(form.setCalls[1], ['endpoint', 'https://custom.example/ingest'])
  // Across every write the page made, the field set is exactly the two editable names: `mode` never
  // moves through this path (it has its own gate) and the three protected fields are never written.
  for (const [field] of form.setCalls) assert.ok(['endpoint', 'maxBytes'].includes(field), `the page wrote ${field}`)
  assert.equal(form.setCalls.some(([field]) => field === 'mode'), false, 'the field editor wrote the mode')
  // Rendered: exactly two editable inputs exist, and neither is a protected field.
  const inputs = runtime.nodes(current).filter((node) => node.type === 'input' && node.props['data-field'] !== undefined)
  assert.deepEqual(inputs.map((node) => node.props['data-field']).sort(), ['endpoint', 'maxBytes'])
  console.log(`        writes seen: ${JSON.stringify(form.setCalls)}`)
})

await checkAsync('EDITABLE FIELDS (driven): an invalid draft writes nothing; a refused write never claims "Saved"', async () => {
  const { tree, render, form } = renderEditable()
  // An endpoint the Host would refuse, and a cap that is not a safe integer >= 1.
  fieldInput(tree, 'endpoint').props.onChange({ target: { value: 'file:///etc/passwd' } })
  let current = render()
  click(saveButton(current, 'endpoint'))
  await settle()
  current = render()
  assert.deepEqual(form.setCalls, [], 'an invalid endpoint draft reached the Host')
  assert.ok(stringsOf(current).includes('upload.endpointInvalid'), 'the invalid draft was not explained')
  assert.equal(stringsOf(current).includes('upload.fieldSaved'), false, 'an invalid draft claimed success')
  for (const badCap of ['0', '-1', '1.5', 'abc', '', '1e21']) {
    fieldInput(current, 'maxBytes').props.onChange({ target: { value: badCap } })
    current = render()
    click(saveButton(current, 'maxBytes'))
    await settle()
    current = render()
    assert.deepEqual(form.setCalls, [], `the cap draft ${JSON.stringify(badCap)} reached the Host`)
    assert.ok(stringsOf(current).includes('upload.capInvalid'), `the cap draft ${JSON.stringify(badCap)} was not explained`)
    assert.equal(stringsOf(current).includes('upload.fieldSaved'), false, `the cap draft ${JSON.stringify(badCap)} claimed success`)
  }

  // A write the Host refuses: the form path declines and the remote path answers `ok:false`.
  const refusingForm = readyForm('official-only')
  refusingForm.set = async function (field, value) {
    this.setCalls.push([field, value])
    return false
  }
  const refusing = renderEditable(refusingForm, {}, { mutate: { calls: [], result: { ok: false } } })
  fieldInput(refusing.tree, 'endpoint').props.onChange({ target: { value: 'https://custom.example/ingest' } })
  let refused = refusing.render()
  click(saveButton(refused, 'endpoint'))
  await settle()
  await settle()
  refused = refusing.render()
  assert.equal(refusing.mutate.calls.length, 1, 'a refused form write did not try the remote path')
  assert.ok(stringsOf(refused).includes('upload.saveFailed'), 'a refused write did not surface a failure')
  assert.equal(stringsOf(refused).includes('upload.fieldSaved'), false, 'a refused write claimed "Saved"')

  // A form whose `set` throws must fall back the same way, not report success.
  const throwingForm = readyForm('official-only')
  throwingForm.set = async function () {
    throw new Error('the form refused the write')
  }
  const throwing = renderEditable(throwingForm, {}, { mutate: { calls: [], result: { ok: false } } })
  fieldInput(throwing.tree, 'maxBytes').props.onChange({ target: { value: '2048' } })
  let threw = throwing.render()
  click(saveButton(threw, 'maxBytes'))
  await settle()
  await settle()
  threw = throwing.render()
  assert.equal(throwing.mutate.calls.length, 1, 'a throwing form write did not try the remote path')
  assert.ok(stringsOf(threw).includes('upload.saveFailed'), 'a throwing write did not surface a failure')
  assert.equal(stringsOf(threw).includes('upload.fieldSaved'), false, 'a throwing write claimed "Saved"')
})

/** A fake slot hook: records what the selector returns, and how many times it was invoked. */
function sessionsHook(state) {
  // The hook is called as a BARE function by the component (`useSessions(...)`), so the counter must
  // live in the closure — `this` is undefined at the call site.
  const hook = {
    seen: [],
    calls: 0,
    useSessions(selector) {
      hook.calls++
      const value = selector(state)
      hook.seen.push(value)
      return value
    },
  }
  return hook
}

const LEDGER_BODY = {
  generatedAt: 1730000000000,
  directory: 'C:\\ledger',
  total: 2,
  sessions: [
    { sessionId: 'sess-1', afterSeq: 12, sessionFormatVersion: 4, updatedAt: 1730000000000 },
    { sessionId: 'sess-2', afterSeq: 3, sessionFormatVersion: 4, updatedAt: 1720000000000 },
  ],
}

await checkAsync('SESSION NAMES (driven): OFF by default, and with it off no title leaves the sessions store', async () => {
  const store = { byId: { 'sess-1': { title: 'SECRET-TITLE-1' }, 'sess-2': { title: 'SECRET-TITLE-2' } } }
  const hook = sessionsHook(store)
  const jsonResponse = (body) => ({ ok: true, status: 200, async json() { return body } })
  await renderWithLedger(() => jsonResponse(LEDGER_BODY), async ({ tree, render }) => {
    // Default OFF: the toggle renders unchecked, and the selector returned nothing for every row.
    const toggle = find(tree, (node) => node.props['data-toggle'] === 'session-names')
    assert.ok(toggle !== null, 'the session-name toggle is missing')
    assert.equal(toggle.props.checked, false, 'session names are ON by default')
    assert.ok(hook.seen.length >= 2, 'the hook was not called once per row')
    assert.deepEqual([...new Set(hook.seen)], [undefined], `a title left the store while the toggle was off: ${JSON.stringify(hook.seen)}`)
    const text = allText(tree)
    assert.equal(text.includes('SECRET-TITLE'), false, 'a session title was rendered while the toggle was off')
    assert.ok(text.includes('sess-1') && text.includes('sess-2'), 'the ids are not rendered')
    // Turn it on: now the selector yields the title and the row renders it.
    toggle.props.onChange({ target: { checked: true } })
    const on = render()
    assert.equal(find(on, (node) => node.props['data-toggle'] === 'session-names').props.checked, true)
    assert.deepEqual([...new Set(hook.seen)], [undefined, 'SECRET-TITLE-1', 'SECRET-TITLE-2'], 'the selector did not yield the titles when asked')
    const onText = allText(on)
    for (const title of ['SECRET-TITLE-1', 'SECRET-TITLE-2']) assert.ok(onText.includes(title), `${title} is not rendered with the toggle on`)
    // The copy explains where a name comes from, which is why it is opt-in.
    const en = JSON.parse(readFileSync('locale/en.json', 'utf8')).upload.ledger
    assert.match(en.titlesDetail, /comes from the conversation/i, 'the opt-in copy no longer explains the title source')
    assert.match(en.titlesDetail, /off by default/i)
  }, { useSessions: hook.useSessions })
  console.log('        toggle off: selector yielded undefined for every row and no title was rendered')
})

await checkAsync('SESSION NAMES: an absent, unknown or throwing hook degrades to the id and never throws', async () => {
  const jsonResponse = (body) => ({ ok: true, status: 200, async json() { return body } })
  const cases = [
    ['absent hook', {}],
    ['unknown id', { useSessions: sessionsHook({ byId: { other: { title: 'x' } } }).useSessions }],
    ['throwing hook', { useSessions: () => { throw new Error('the sessions store misbehaved') } }],
    ['non-function hook', { useSessions: 42 }],
  ]
  for (const [label, props] of cases) {
    let tree
    try {
      // Synchronous render is enough: the state under test is the row's own, not the async read.
      const form = readyForm('official-only')
      const applied = applyClient({ form, mutate: { calls: [] } })
      tree = runtime.render(runtime.React.createElement(applied.section.component, { t, ...props }))
      assert.ok(tree !== null)
    } catch (error) {
      throw new Error(`${label} threw during render: ${error.message}`)
    }
    void tree
  }
  // The driven version of the same property, with a ledger actually rendered.
  const unknown = sessionsHook({ byId: {} })
  await renderWithLedger(() => jsonResponse(LEDGER_BODY), async ({ tree }) => {
    const text = allText(tree)
    assert.ok(text.includes('sess-1'), 'the id row is missing')
    assert.deepEqual([...new Set(unknown.seen)].filter((value) => value !== undefined), [], 'an unknown id produced a title')
  }, { useSessions: unknown.useSessions })
  // An id the store does not know, a throwing hook and an absent hook all render the id alone.
  const throwing = sessionsHook({ byId: { 'sess-1': { title: 'never' } } })
  await renderWithLedger(() => jsonResponse(LEDGER_BODY), async ({ tree }) => {
    assert.ok(allText(tree).includes('sess-1'), 'the throwing-hook render lost the row')
  }, { useSessions: () => { throw new Error('throwing hook') } })
  await renderWithLedger(() => jsonResponse(LEDGER_BODY), async ({ tree }) => {
    assert.ok(allText(tree).includes('sess-1'), 'the hookless render lost the row')
  })
  void throwing
})

await checkAsync('SESSION NAMES: the hook call site is unconditional — stable across a late-arriving and a vanishing prop', async () => {
  // !! The REAL guarantee here is structural, not behavioural: neither this hand-written runtime nor
  // Node enforces React's rules of hooks, so no test in this file can *prove* hook order is stable.
  // What the runs below add is that the call site is reached on every render of every sequence and
  // that the invocation count per render does not change — evidence for the structure asserted after.
  const realFetch = globalThis.fetch
  const jsonResponse = { ok: true, status: 200, async json() { return LEDGER_BODY } }
  globalThis.fetch = async () => jsonResponse
  try {
    const form = readyForm('official-only')
    const applied = applyClient({ form, mutate: { calls: [] } })
    const renderWith = (props) => runtime.render(runtime.React.createElement(applied.section.component, { t, ...props }))
    const settleRender = async (props) => {
      let tree = renderWith(props)
      for (let attempt = 0; attempt < 25 && allText(tree).includes('upload.ledger.loading'); attempt++) {
        await settle()
        tree = renderWith(props)
      }
      return tree
    }

    // Sequence A: the hook is present on the first render and its prop VANISHES afterwards.
    const latchA = sessionsHook({ byId: { 'sess-1': { title: 'T1' }, 'sess-2': { title: 'T2' } } })
    let tree = await settleRender({ useSessions: latchA.useSessions })
    const rows = allText(tree).includes('sess-1') ? 2 : 0
    assert.ok(rows > 0, 'the ledger rows did not render')
    // One `render()` call may run the component more than once (my runtime flushes until quiescent),
    // so the property is the STABILITY of the per-render delta, not a magic number.
    const base = latchA.calls
    tree = renderWith({ useSessions: latchA.useSessions })
    const deltaWithProp = latchA.calls - base
    assert.ok(deltaWithProp > 0 && deltaWithProp % rows === 0, `delta with the prop was ${deltaWithProp} for ${rows} rows`)
    tree = renderWith({}) // the prop is gone
    const deltaWithoutProp = latchA.calls - base - deltaWithProp
    assert.equal(deltaWithoutProp, deltaWithProp, 'the invocation count per render changed when the prop vanished')
    assert.ok(allText(tree).includes('sess-1'), 'the row disappeared when the prop vanished')
    // Sequence B: no hook first, then the prop ARRIVES.
    const latchB = sessionsHook({ byId: { 'sess-1': { title: 'T1' } } })
    tree = await settleRender({})
    assert.equal(latchB.calls, 0, 'the arriving hook was called before it was passed')
    tree = renderWith({ useSessions: latchB.useSessions }) // the prop is now present
    assert.equal(latchB.calls, 0, 'the fallback was swapped for the arriving hook mid-mount (that is the hook-order change)')
    assert.ok(allText(tree).includes('sess-1'), 'the row disappeared when the prop arrived')
    // Every render reached the call site; nothing threw; the per-render invocation count never moved.
    console.log(`        latch: ${deltaWithProp} invocations per render with the prop, ${deltaWithoutProp} without it (2 rows)`)
  } finally {
    globalThis.fetch = realFetch
  }

  // The structure that makes the above true, asserted directly — this is the guarantee.
  const flat = CLIENT_SOURCE.replace(/\s+/g, ' ')
  assert.ok(flat.includes('const NO_SESSIONS = function () { return undefined; };'), 'the module-scope fallback is gone')
  // The slot hook is resolved ONCE per mount in the section and the same function is handed to every row.
  assert.ok(
    flat.includes('const sessionHook = React.useRef(undefined); if (sessionHook.current === undefined) { sessionHook.current = typeof props.useSessions === "function" ? props.useSessions : NO_SESSIONS; }'),
    'the per-mount latch in the section changed shape',
  )
  assert.ok(flat.includes('ledgerTable(ledgerSessions, t, sessionHook.current, showSessionNames === true)'), 'the rows no longer receive the latched hook')
  // The row's own fallback keeps the call unconditional even when rendered directly.
  assert.ok(flat.includes('const useSessions = typeof props.useSessions === "function" ? props.useSessions : NO_SESSIONS;'))
  // No `if` may guard the call site itself.
  assert.ok(CLIENT_SOURCE.includes('\t\t\t\tconst selected = useSessions(function (state) {'), 'the call is no longer unconditional')
  assert.equal(
    /if \([^)]*\) \{\s*const selected = useSessions\(/.test(CLIENT_SOURCE),
    false,
    'the hook call is guarded again',
  )
  // The OFF neutralisation still happens inside the selector, BEFORE any store read.
  const selector = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('const selected = useSessions(function (state) {'))
  const selectorBody = selector.slice(0, selector.indexOf('});'))
  assert.ok(
    selectorBody.indexOf('showSessionNames !== true') < selectorBody.indexOf('state.byId'),
    'the selector reads the store before checking the toggle',
  )
  console.log('        latch: the call site is unconditional and the hook identity is pinned per mount; OFF still short-circuits first')
})

check('CONSENT COPY: the dialog names the live destination and makes no brand claim it cannot honour', () => {
  const en = JSON.parse(readFileSync('locale/en.json', 'utf8'))
  const zh = JSON.parse(readFileSync('locale/zh.json', 'utf8'))
  // The dialog's own copy must contain no brand word: the destination is whatever is configured.
  for (const key of ['warnTitle', 'warnBody', 'destinationLabel']) {
    for (const [label, dictionary] of [['en', en], ['zh', zh]]) {
      assert.equal(
        /deepseek/i.test(dictionary.upload[key]),
        false,
        `${label} ${key} names a brand the plugin may not be posting to: ${dictionary.upload[key]}`,
      )
    }
  }
  // It must defer to the value on screen instead of asserting a destination of its own. The exact
  // wording is not pinned — only that it points AT the destination shown — so a plainer sentence is
  // still correct as long as it does not name a destination itself.
  assert.match(en.upload.warnBody, /destination below|destination named below/i)
  assert.match(zh.upload.warnBody, /下面写明的目标|目标/)
  // The substantive disclosures must all survive any rewording. These are the sentences a rewording
  // can silently drop, and dropping one turns a truthful dialog into a misleading one.
  for (const required of [/messages/i, /file paths/i, /other model providers/i, /leaves this machine/i, /train models/i, /cannot be undone/i]) {
    assert.match(en.upload.warnBody, required, `the English consent body lost a disclosure: ${required}`)
  }
  for (const required of [/消息/, /文件路径/, /其他模型供应商/, /离开这台机器/, /训练模型/, /无法撤回/]) {
    assert.match(zh.upload.warnBody, required, `the Chinese consent body lost a disclosure: ${required}`)
  }
  // …and neither language uses the em-dash aside construction this pass removed.
  assert.equal(en.upload.warnBody.includes('\u2014'), false, 'the English consent body still uses an em-dash aside')
  assert.equal(zh.upload.warnBody.includes('——'), false, 'the Chinese consent body still uses an em-dash aside')
  // Drive it: with a non-default endpoint the dialog names THAT endpoint, not the default and not a brand.
  const form = readyForm('official-only')
  form.snapshot = {
    status: 'ready',
    writable: true,
    value: { mode: 'official-only', endpoint: 'https://corp-gateway.example/anthropic/v1/messages', maxBytes: 8388608 },
  }
  const applied = applyClient({ form, mutate: { calls: [] } })
  let tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  click(radioFor(tree, 'any-model'))
  tree = runtime.render(runtime.React.createElement(applied.section.component, { t }))
  const panel = dialog(tree)
  assert.ok(panel !== null, 'the dialog did not open')
  const panelText = allText(panel)
  assert.ok(panelText.includes('https://corp-gateway.example/anthropic/v1/messages'), `the dialog did not name the configured destination: ${panelText}`)
  assert.equal(panelText.includes('api.deepseek.com'), false, 'the dialog named the default while a different destination is configured')
  assert.equal(/deepseek/i.test(panelText.replace(/upload\.[a-z.]+/gi, '')), false, `the dialog asserted a brand: ${panelText}`)
  // Hunt for any other user-visible string that implies a FIXED destination. Every brand-naming value
  // must be on this allowlist, whose members each describe the official API *as* the official one.
  const flatten = (object, prefix = '') =>
    Object.entries(object).flatMap(([key, value]) =>
      value !== null && typeof value === 'object' ? flatten(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]],
    )
  // Membership bar: a string belongs on this allowlist only if it names the brand as the OFFICIAL
  // MODEL/API, or as a party to a waiver — never as "the place your data definitely goes".
  // `upload.patterns*` qualifies the first way ("Models to treat as DeepSeek" is about recognising
  // which model a provider serves). `upload.noticeP1`/`P3` qualify the second: P1 names DeepSeek as the
  // DEFAULT destination and points at the settings for the real one, and P3's whole purpose is to name
  // who is released from liability, which it cannot do without naming them.
  const ALLOWED = {
    en: ['meta.description', 'upload.modes.officialOnly.label', 'upload.modes.officialOnly.detail', 'upload.modes.deepseekAnyProvider.label', 'upload.modes.deepseekAnyProvider.detail', 'upload.ledger.empty', 'upload.patternsLabel', 'upload.patternsHelp', 'upload.patternsEmpty', 'upload.noticeP1', 'upload.noticeP3'],
    zh: ['meta.description', 'upload.modes.officialOnly.detail', 'upload.modes.deepseekAnyProvider.label', 'upload.modes.deepseekAnyProvider.detail', 'upload.patternsLabel', 'upload.patternsHelp', 'upload.patternsEmpty', 'upload.noticeP1', 'upload.noticeP3'],
  }
  for (const [label, dictionary] of [['en', en], ['zh', zh]]) {
    const naming = flatten(dictionary)
      .filter(([, value]) => typeof value === 'string' && /deepseek/i.test(value))
      .map(([key]) => key)
      .sort()
    assert.deepEqual(naming, [...ALLOWED[label]].sort(), `${label} has a new string naming a destination brand: ${JSON.stringify(naming)}`)
  }
  // The one string that speaks for the whole plugin must state that the destination is settable.
  assert.match(en.meta.description, /official API or to a destination you set/i)
  assert.match(zh.meta.description, /官方 API 或你自设的目标/)
})

check('COPY: nothing user-visible calls the file a ledger or implies it holds the conversations', async () => {
  const flatten = (object, prefix = '') =>
    Object.entries(object).flatMap(([key, value]) =>
      value !== null && typeof value === 'object' ? flatten(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]],
    )
  const banned = /\u53f0\u8d26|\u8d26\u672c|ledger/i
  for (const file of ['locale/en.json', 'locale/zh.json']) {
    const values = flatten(JSON.parse(readFileSync(file, 'utf8'))).filter(([, value]) => typeof value === 'string')
    const hits = values.filter(([, value]) => banned.test(value))
    assert.deepEqual(hits.map(([key]) => key), [], `${file} still names a 台账/账本/ledger in a user-visible value`)
  }
  // The inline dictionary is the module's own fallback copy and must match: scan its string values.
  // NOTE: this is a regex over source text, not a parse, so `cond ? "upload.a" : "upload.b"`
  // looks like a `key: value` pair and the second key becomes the "value". A dotted key is a
  // reference to other copy, never user-visible text, so those pairs are dropped before scanning.
  const LOOKS_LIKE_A_KEY = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/
  const inlineValues = [...CLIENT_SOURCE.matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g)]
    .map(([, key, value]) => [key, value])
    .filter(([, value]) => !LOOKS_LIKE_A_KEY.test(value))
  const inlineHits = inlineValues.filter(([key, value]) => key.startsWith('upload.') && banned.test(value))
  assert.deepEqual(inlineHits.map(([key]) => key), [], 'the inline dictionary still has a banned word in a user-visible value')
  // The replacement wording must be present and must deny holding the conversations.
  const en = JSON.parse(readFileSync('locale/en.json', 'utf8')).upload
  const zh = JSON.parse(readFileSync('locale/zh.json', 'utf8')).upload
  assert.match(en.ledger.description, /An index of the Session logs/i)
  assert.match(en.ledger.description, /does not contain the log content/i)
  assert.match(zh.ledger.description, /索引/)
  assert.match(zh.ledger.description, /不含日志内容/)
  for (const key of ['loading', 'stateMissing', 'stateUnauthorized', 'stateMalformed', 'stateFailed']) {
    assert.match(en.ledger[key], /detailed log/i, `${key} should use the replacement wording`)
    assert.equal(banned.test(en.ledger[key]), false)
  }
  assert.match(en.ledger.directoryLabel, /detailed log/i)
})

check('HARNESS FIDELITY: the rules of hooks are enforced, so "does not throw" is not vacuous', () => {
  // The counterpart of client-fix's own guard proof: a deliberately conditional hook must be caught
  // with React's own complaint, otherwise every "it rendered without throwing" assertion in this file
  // would be silent about the failure mode this runtime exists to detect.
  const Conditional = (props) => {
    const [count] = runtime.React.useState(0)
    if (props.flag === true) runtime.React.useRef(null)
    return runtime.React.createElement('div', null, String(count))
  }
  runtime.render(runtime.React.createElement(Conditional, { flag: false }))
  let caught = null
  try {
    runtime.render(runtime.React.createElement(Conditional, { flag: true }))
  } catch (error) {
    caught = error
  }
  assert.ok(caught !== null, 'the runtime accepted a conditional hook call')
  assert.match(caught.message, /rules of hooks/, `unexpected error: ${caught.message}`)
  console.log(`        a conditional hook is caught: "${caught.message}"`)
})

check('navigation registrations: section + icon share the frozen id and order', () => {

  const applied = applyClient({ form: null, mutate: { calls: [] } })
  const section = applied.section.options
  const icon = applied.icon.options
  assert.equal(section.id, 'session-log-upload')
  assert.equal(section.order, 60)
  assert.equal(section.locale, 'settings.sessionLogUpload')
  assert.equal(typeof section.label, 'function')
  assert.equal(section.label(), 'upload.sectionTitle')
  assert.equal(icon.id, 'session-log-upload')
  assert.equal(icon.name, 'settings.section.icon')
  // INTERFACES.md §6 requires a `children` declaration; this implementation deliberately omits it.
  console.log(`        note: section.options.children = ${JSON.stringify(section.children)} (INTERFACES.md §6 asks for a settings.general.item declaration)`)
})

check('the client inject list is the frozen five', () => {
  assert.deepEqual(loaded.module.inject, ['slots', 'locale', 'configForms', 'remote', 'remote.settings'])
})

console.log(failures === 0 ? '\nPASS: the consent gate holds under every path exercised' : `\nFAIL: ${failures} check(s)`)
process.exitCode = failures === 0 ? 0 : 1
