/**
 * 模型接力 · 浏览器半身冒烟测试。
 *
 * 不需要真浏览器：这里完全按 dsh 客户端加载器的方式调用
 * `window.__ModuleLoader__.load({ id, factory })`，用一个极小的 React 替身
 * （只有 createElement + 六个 hook）把设置页**真的渲染出来**，再把宿主接口
 * 换成一个记账的 fetch。于是「页面会不会崩、按了按钮会不会发出正确的请求」
 * 都变成可断言的事实，而不是「看起来写对了」。
 *
 * 覆盖：
 *   1. bundle 契约：id / factory / exports.apply / exports.inject / exports.name；
 *   2. apply()：注册中英字典、注入样式表、往 settings.section 插一条设置页；
 *   3. 首帧（state 还是 null）渲染加载态、请求失败渲染错误态，都不抛错；
 *   4. 拿到数据之后：队列顺序、隔离徽标、「今天可用」徽标、事件日志都在树上；
 *   5. 交互：↑ / ✕ / 开关 / 数字输入各自发出内容正确的 POST，越界值被夹回。
 *
 * 跑法：node test/client.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = await readFile(join(here, '..', 'client.js'), 'utf8')

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// ── 极小的 React 替身 ───────────────────────────────────────────────────────

function sameDeps(a, b) {
  if (a === undefined || b === undefined) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

/**
 * 一个同步的、够用的函数组件渲染器。
 *
 * 只实现 dsh 客户端真正会用到的部分：createElement、useState / useEffect /
 * useMemo / useRef / useCallback、函数组件与数组子节点。没有 DOM diff ——
 * 状态一变就整棵重渲染，hook 以「在树中的位置 + 组件名」为键存在 Map 里，
 * 这样 unmount/remount 时 hook 现场的行为和 React 一致（同一个位置 = 同一份状态）。
 */
class Runtime {
  constructor() {
    this.hooks = new Map()
    this.stack = []
    this.cursor = 0
    this.path = []
    this.pending = []
    this.nodes = []
    this.dirty = false
  }

  // ── hooks ────────────────────────────────────────────────────────────────
  cell(kind, make) {
    const index = this.cursor
    this.cursor += 1
    const slot = this.stack
    if (slot[index] === undefined) slot[index] = make()
    const existing = slot[index]
    if (existing.kind !== kind) {
      throw new Error(`hook 顺序在第 ${index} 个变了：${existing.kind} → ${kind}`)
    }
    return existing
  }

  useState(initial) {
    const cell = this.cell('state', () => ({
      kind: 'state',
      value: typeof initial === 'function' ? initial() : initial,
    }))
    return [cell.value, (next) => {
      const value = typeof next === 'function' ? next(cell.value) : next
      if (Object.is(value, cell.value)) return
      cell.value = value
      this.dirty = true
    }]
  }

  useRef(initial) {
    return this.cell('ref', () => ({ kind: 'ref', box: { current: initial } })).box
  }

  useMemo(fn, deps) {
    const cell = this.cell('memo', () => ({ kind: 'memo', deps, value: fn() }))
    if (!sameDeps(cell.deps, deps)) {
      cell.deps = deps
      cell.value = fn()
    }
    return cell.value
  }

  useCallback(fn, deps) {
    const cell = this.cell('callback', () => ({ kind: 'callback', deps, value: fn }))
    if (!sameDeps(cell.deps, deps)) {
      cell.deps = deps
      cell.value = fn
    }
    return cell.value
  }

  useEffect(fn, deps) {
    const index = this.cursor
    this.cursor += 1
    const slot = this.stack
    const previous = slot[index]
    if (previous !== undefined && previous.kind !== 'effect') {
      throw new Error(`hook 顺序在第 ${index} 个变了：${previous.kind} → effect`)
    }
    if (previous === undefined || !sameDeps(previous.deps, deps)) {
      slot[index] = { kind: 'effect', deps, cleanup: previous?.cleanup }
      this.pending.push({ slot, index, fn })
    }
  }

  // ── 渲染 ─────────────────────────────────────────────────────────────────
  render(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return this.children(node)
    if (typeof node !== 'object' || !('type' in node)) throw new Error(`渲染到非法节点：${String(node)}`)
    const { type, props } = node
    if (typeof type === 'function') return this.component(type, props)
    if (type === FRAGMENT) return this.children(props.children)
    if (typeof type === 'string') this.nodes.push({ tag: type, props, text: this.text(props.children) })
    return this.children(props.children)
  }

  children(children) {
    const list = children === undefined || children === null
      ? []
      : (Array.isArray(children) ? children : [children])
    return list.map((child, index) => {
      this.path.push(String(index))
      try {
        return this.render(child)
      } finally {
        this.path.pop()
      }
    })
  }

  component(type, props) {
    const label = `@${type.name || 'anonymous'}`
    const key = `${this.path.join('/')}${label}`
    this.path.push(label)
    const slot = this.hooks.get(key) ?? []
    this.hooks.set(key, slot)
    const outerStack = this.stack
    const outerCursor = this.cursor
    this.stack = slot
    this.cursor = 0
    try {
      return this.children(type(props))
    } finally {
      this.stack = outerStack
      this.cursor = outerCursor
      this.path.pop()
    }
  }

  /** 把一棵（可能还没渲染的）子树里的纯文本拼起来，用来认按钮。 */
  text(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map((child) => this.text(child)).join('')
    if (typeof node === 'object' && 'type' in node) {
      if (typeof node.type === 'function') return ''
      return this.text(node.props.children)
    }
    return ''
  }

  /**
   * 渲染到收敛：渲染 → 跑 effect → effect 改了状态就再来一轮。
   * 每轮之后都把 effect 里发起的请求放行（两个 tick 足够排空微任务）。
   */
  async mount(element) {
    const outer = activeRuntime
    activeRuntime = this
    try {
      for (let pass = 0; pass < 12; pass += 1) {
        this.dirty = false
        this.pending = []
        this.nodes = []
        this.path = []
        const tree = this.render(element)
        await this.runEffects()
        if (!this.dirty) return tree
        await tick()
      }
    } finally {
      activeRuntime = outer
    }
    throw new Error('渲染 12 轮之后仍在更新状态，疑似死循环')
  }

  async runEffects() {
    const pending = this.pending
    this.pending = []
    for (const { slot, index, fn } of pending) {
      const cell = slot[index]
      if (typeof cell.cleanup === 'function') {
        const cleanup = cell.cleanup
        cell.cleanup = undefined
        cleanup()
      }
      const cleanup = fn()
      cell.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
    await tick()
    await tick()
  }

  /** 按条件找元素（渲染树里的，不是 DOM）。 */
  find(predicate) {
    const hit = this.nodes.find(predicate)
    if (hit === undefined) throw new Error('渲染树里没有找到符合条件的元素')
    return hit
  }

  /** 按纯文本找按钮。 */
  button(text) {
    return this.find((node) => node.tag === 'button' && node.text === text)
  }

  /** 按纯文本找**可用**的按钮（首行的 ↑ 是禁用的，要找的是第二行的）。 */
  enabledButton(text) {
    return this.find((node) => node.tag === 'button' && node.text === text && node.props.disabled !== true)
  }
}

// ── react 替身的对外表面 ────────────────────────────────────────────────────
// client.js 在**模块加载时**就把 hooks 解构走了，所以这里不能把 hooks 绑死在
// 某一个渲染器上：用一层转发指向「当前正在渲染的那个」，于是同一个 bundle 可以
// 在多个互相独立的渲染器上跑，每个用例一个干净的 hook 现场。

const FRAGMENT = Symbol('Fragment')

function buildElement(type, props, children) {
  if (typeof type !== 'string' && typeof type !== 'function' && type !== FRAGMENT) {
    throw new Error(`createElement 收到了不支持的 type：${String(type)}`)
  }
  const merged = {}
  if (props !== null && props !== undefined) {
    if (typeof props !== 'object') throw new Error('createElement 的 props 不是对象')
    for (const key of Object.keys(props)) merged[key] = props[key]
  }
  if (children.length === 1) merged.children = children[0]
  else if (children.length > 1) merged.children = children
  return { type, props: merged }
}

let activeRuntime = null

function rendering() {
  if (activeRuntime === null) throw new Error('hook 在渲染之外被调用')
  return activeRuntime
}

const REACT = {
  createElement: (type, props, ...children) => buildElement(type, props, children),
  Fragment: FRAGMENT,
  useState: (initial) => rendering().useState(initial),
  useEffect: (fn, deps) => rendering().useEffect(fn, deps),
  useMemo: (fn, deps) => rendering().useMemo(fn, deps),
  useRef: (initial) => rendering().useRef(initial),
  useCallback: (fn, deps) => rendering().useCallback(fn, deps),
}

// ── 宿主返回的数据 ──────────────────────────────────────────────────────────
// 形状与 host 半身 index.js 的 snapshot() 完全一致。

const KEY = (provider, model) => `${provider}\u0000${model}`
const at = Date.now()

/**
 * 一条长报错：前半段是线上真实出现过的那种 DNS 隧道失败，末尾那个标记故意放在
 * 160 字符之后 —— 摘要行截断到 160，展开时才该看到它。
 */
const TAIL_MARK = '『尾部标记·只有展开才看得见』'
const LONG_ERROR = `workbuddy: {"error":"cannot resolve tunnel destination www.workbuddy.ai (ENOTFOUND): local name resolution failed — the local resolver may be unreachable or taken over by another DNS service (VPN/MagicDNS); route egress through an upstream proxy to have the destination resolved remotely","code":"tunnel_destination_denied","detail":"unresolvable"} ${TAIL_MARK}`

const initialState = () => ({
  ok: true,
  route: { provider: 'model-failover', model: 'auto', label: '模型接力' },
  now: at,
  day: '2026-11-27',
  nextResetAt: at + 3 * 3600_000,
  settings: {
    enabled: true,
    bootstrapped: true,
    order: [
      { provider: 'alpha', model: 'one' },
      { provider: 'beta', model: 'one' },
      { provider: 'gamma', model: 'two' },
    ],
    resetHour: 1,
    retrySameModelOnce: true,
    continueText: '继续',
    hiddenProviders: [],
    retryWhenAllQuarantined: true,
    autoContinue: true,
    autoContinueOnFailure: true,
    autoContinueOnMaxTokens: true,
    autoContinueFailureLimit: 1,
    autoContinueMaxTokensLimit: 10,
    continueDelaySec: 5,
    keepEventLog: true,
    eventLogLimit: 200,
  },
  catalog: [
    // 档位表来自每个模型自己（host 侧 resolveModelInfo 的 reasoning）；三种情形
    // 各有代表：认档位、明确不支持、还没问到。
    {
      provider: 'alpha', providerName: '硅基流动', model: 'one', name: 'Alpha One', description: '',
      efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low', effortsKnown: true,
    },
    { provider: 'beta', providerName: 'Code99', model: 'one', name: 'Beta One', description: '', efforts: [], effortsKnown: true },
    { provider: 'gamma', providerName: 'FutureHub', model: 'two', name: 'Gamma Two', description: '', efforts: [], effortsKnown: false },
    {
      provider: 'delta', providerName: '未来枢纽', model: 'three', name: 'Delta Three', description: '',
      efforts: [{ id: 'minimal', name: '最小' }], effortsKnown: true,
    },
  ],
  catalogErrors: [],
  catalogScannedAt: at,
  quarantined: [
    // 宿主 view() 按判定时间升序排，这里也照这个顺序摆。
    // 隔离按会话算，所以两行挂在不同会话名下 —— 这也是设置页名单的常态。
    { key: KEY('beta', 'one'), provider: 'beta', model: 'one', code: 'QUOTA', message: '余额不足', at: at - 90_000, label: 'Code99 · Beta One', sessionId: 'sess-alpha' },
    { key: KEY('gamma', 'two'), provider: 'gamma', model: 'two', code: 'TRANSPORT', message: LONG_ERROR, at: at - 60_000, label: 'FutureHub · Gamma Two', sessionId: 'sess-long-name' },
  ],
  good: [{ key: KEY('alpha', 'one'), at, provider: 'alpha', model: 'one', label: '硅基流动 · Alpha One' }],
  events: [
    { at: at - 60_000, kind: 'quarantine', provider: 'beta', model: 'one', code: 'QUOTA' },
    { at: at - 120_000, kind: 'good', provider: 'alpha', model: 'one' },
    { at: at - 180_000, kind: 'rollover', from: '2026-11-26', to: '2026-11-27' },
  ],
  dataDir: 'C:\\Users\\superv\\.dsh\\dsh-model-failover',
})

// ── 加载 bundle ─────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}`)
    console.log(`      ${String(error?.message ?? error).split('\n').join('\n      ')}`)
    if (process.env.VERBOSE) console.log(error)
  }
}

console.log('\n模型接力 · 浏览器半身（client.js）\n')

const runtime = new Runtime()

// 客户端全局：加载器、document、navigator。
const loaded = []
const styleSheets = []
const documentStub = {
  baseURI: 'http://127.0.0.1:19387/',
  documentElement: { lang: 'zh-CN' },
  head: { appendChild: (node) => styleSheets.push(node) },
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
}

// setInterval 换成不排程的替身：真实定时器会把这个测试进程挂住。
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

const execute = new Function('window', 'document', 'navigator', SOURCE)
execute(
  { __ModuleLoader__: { load: (entry) => loaded.push(entry) } },
  documentStub,
  { language: 'zh-CN' },
)

const bundle = loaded[0]
const client = bundle.factory((name) => {
  if (name === 'react') return REACT
  throw new Error(`bundle 请求了未提供的模块：${name}`)
})

// ── 假的客户端 ctx ──────────────────────────────────────────────────────────

const dictionaries = new Map()
const effects = []
const sections = []

function makeCtx() {
  return {
    effect(fn, label) {
      const out = fn()
      effects.push({ label, out })
      return out
    },
    locale: {
      register(ns, dict) {
        dictionaries.set(ns, dict)
        return () => dictionaries.delete(ns)
      },
      bind(ns) {
        return (key) => {
          const raw = dictionaries.get(ns)?.zh?.[key]
          return typeof raw === 'string' ? raw : key
        }
      },
    },
    slots: {
      inject(name, callback) {
        sections.push({ slot: name })
        return callback()
      },
      register(definition, component) {
        const row = sections[sections.length - 1]
        row.definition = definition
        row.component = component
        return () => {}
      },
    },
    remote: { $on: () => () => {} },
    on: () => () => {},
    get: () => undefined,
  }
}

const ctx = makeCtx()

// ── bundle 契约 ─────────────────────────────────────────────────────────────

await check('bundle 以 __ModuleLoader__.load 自注册，id 与 manifest 一致', () => {
  assert.equal(loaded.length, 1, '应该只 load 一次')
  assert.equal(bundle.id, 'dsh-model-failover')
  assert.equal(typeof bundle.factory, 'function')
})

await check('exports 契约：apply / inject / name', () => {
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(client.inject, ['slots', 'locale'])
  assert.equal(client.name, 'model-failover')
})

await check('apply() 注册中英字典、注入样式表、插一条 settings.section', () => {
  client.apply(ctx)

  assert.ok(dictionaries.has('settings.modelFailover'), '应注册设置页命名空间的字典')
  const dict = dictionaries.get('settings.modelFailover')
  assert.ok(dict.zh && typeof dict.zh === 'object', '应有中文')
  assert.ok(dict.en && typeof dict.en === 'object', '应有英文（en 是回退语言）')
  for (const key of Object.keys(dict.zh)) {
    assert.ok(dict.en[key] !== undefined, `英文缺少 ${key}`)
  }

  assert.equal(styleSheets.length, 1, '应注入一张样式表')
  assert.equal(styleSheets[0].textContent.includes('.mf-root'), true)

  assert.equal(sections.length, 3, '设置页一条 + 轮尾小字一条 + 会话页隔离队列一条')
  assert.equal(sections[0].slot, 'settings.section')
  assert.equal(sections[0].definition.name, 'settings.section')
  assert.equal(sections[0].definition.id, 'model-failover')
  assert.equal(typeof sections[0].definition.order, 'number')
  assert.equal(sections[0].definition.locale, 'settings.modelFailover')
  assert.equal(typeof sections[0].definition.label, 'function')
  assert.equal(typeof sections[0].definition.label(), 'string')
  assert.equal(typeof sections[0].component, 'function')

  // 第二条挂的是轮尾小字。turnTail 是 ui-chat 自己声明的子插槽，我们只往里塞条目，
  // 所以注册时不能再声明 children，否则真机上会抛「slot is already declared」。
  assert.equal(sections[1].slot, 'conversation.chat.turnTail')
  assert.equal(sections[1].definition.name, 'conversation.chat.turnTail')
  assert.equal(sections[1].definition.id, 'model-failover:relay-tail')
  assert.equal(typeof sections[1].definition.order, 'number')
  assert.equal(sections[1].definition.locale, 'settings.modelFailover')
  assert.equal(sections[1].definition.children, undefined, '不能重复声明 ui-chat 的子插槽')
  assert.equal(sections[1].definition.label, undefined, '轮尾小字没有 label')
  assert.equal(typeof sections[1].component, 'function')

  assert.equal(typeof dict.zh.tailModel, 'string', '轮尾小字要有中文文案')

  // 第三条是会话页顶部的「隔离队列」。它是 conversation.view 的一条，宿主靠
  // 枚举这个槽位生成顶部 tab，所以 label 必须有 —— 没有 label 的条目会被跳过，
  // 那一栏就不会出现。
  assert.equal(sections[2].slot, 'conversation.view')
  assert.equal(sections[2].definition.name, 'conversation.view')
  assert.equal(sections[2].definition.id, 'model-failover:quarantine')
  assert.equal(typeof sections[2].definition.order, 'number')
  assert.ok(sections[2].definition.order > 10, '排在 chat(0) 与详情(10) 右边')
  assert.equal(sections[2].definition.locale, 'settings.modelFailover')
  assert.equal(typeof sections[2].definition.label, 'function')
  assert.equal(typeof sections[2].definition.label(), 'string')
  assert.equal(sections[2].definition.children, undefined, '不重复声明宿主的子插槽')
  assert.equal(typeof sections[2].component, 'function')
})

// ── 轮尾小字（conversation.chat.turnTail 里的那一条） ────────────────────────

const tail = sections[1].component

/** 用真字典（而不是 key 回声）来渲染，这样漏了字典键会当场露馅。 */
const dictZh = dictionaries.get('settings.modelFailover').zh
const t = (key, params) => {
  let out = String(dictZh[key] ?? key)
  for (const [name, value] of Object.entries(params ?? {})) {
    out = out.split(`{${name}}`).join(String(value))
  }
  return out
}

const notesPayload = (notes) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ ok: true, notes }),
})

await check('轮尾小字：接力插过手的轮显示宿主给的标签，且问的是轻量 /notes 而不是 /state', async () => {
  const fresh = new Runtime()
  const asked = []
  const saved = globalThis.fetch
  globalThis.fetch = async (url) => {
    asked.push(String(url))
    return notesPayload([
      { sessionId: 's-tail', turn: 7, trigger: 'max-tokens', provider: 'beta', model: 'one', at, label: 'Code99 · Beta One' },
    ])
  }
  try {
    const tree = await fresh.mount(tail({ sessionId: 's-tail', turn: 7, t }))
    assert.equal(fresh.text(tree), '本轮：Code99 · Beta One')
    assert.equal(asked.length, 1)
    assert.ok(asked[0].includes('/api/dsh-model-failover/notes'), `应问便签端点，实际是：${asked[0]}`)
    assert.ok(asked[0].includes('sessionId=s-tail'), '应带上当前会话 id')
    assert.ok(!asked[0].includes('/state'), '不该为一句小字去拉整份状态')
  } finally {
    globalThis.fetch = saved
  }
})

await check('轮尾小字：我们没插手的轮什么都不显示', async () => {
  const fresh = new Runtime()
  const saved = globalThis.fetch
  globalThis.fetch = async () => notesPayload([
    { sessionId: 's-quiet', turn: 4, trigger: 'error', provider: 'alpha', model: 'one', at, label: '硅基流动 · Alpha One' },
  ])
  try {
    const tree = await fresh.mount(tail({ sessionId: 's-quiet', turn: 5, t }))
    assert.equal(fresh.text(tree), '', '没有对应便签时应渲染成空')
    assert.equal(fresh.nodes.length, 0, '不该留一个空壳 div')
  } finally {
    globalThis.fetch = saved
  }
})

await check('轮尾小字：缺会话 id 或轮号非法时既不发请求也不渲染', async () => {
  const fresh = new Runtime()
  const asked = []
  const saved = globalThis.fetch
  globalThis.fetch = async (url) => { asked.push(String(url)); return notesPayload([]) }
  try {
    assert.equal(fresh.text(await fresh.mount(tail({ turn: 3, t }))), '', '没有 sessionId')
    assert.equal(fresh.text(await fresh.mount(tail({ sessionId: 's-x', t }))), '', '没有 turn')
    assert.equal(fresh.text(await fresh.mount(tail({ sessionId: 's-x', turn: '7', t }))), '', 'turn 不是数字')
    assert.equal(asked.length, 0, '这几种情形都不该发请求')
  } finally {
    globalThis.fetch = saved
  }
})

await check('轮尾小字：3 秒 TTL 内不重复问，换一个轮号才会再问', async () => {
  const fresh = new Runtime()
  const asked = []
  const saved = globalThis.fetch
  globalThis.fetch = async (url) => {
    asked.push(String(url))
    return notesPayload([
      { sessionId: 's-cache', turn: 3, trigger: 'error', provider: 'alpha', model: 'one', at, label: '硅基流动 · Alpha One' },
    ])
  }
  try {
    await fresh.mount(tail({ sessionId: 's-cache', turn: 3, t }))
    assert.equal(asked.length, 1)
    await fresh.mount(tail({ sessionId: 's-cache', turn: 9, t }))
    assert.equal(asked.length, 2, '换轮号说明缓存里没有，得再问一次')
    await fresh.mount(tail({ sessionId: 's-cache', turn: 3, t }))
    assert.equal(asked.length, 2, '回到已经问过的轮号，TTL 内不该再问')
  } finally {
    globalThis.fetch = saved
  }
})

// ── 会话页顶部的「隔离队列」一栏（conversation.view 里的那一条） ─────────────

const queue = sections[2].component

/** `/sessions` 的假后端。 */
const sessionsPayload = (sessions, day = '2026-11-27') => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({
    ok: true,
    now: at,
    day,
    route: { provider: 'model-failover', model: 'auto', label: '模型接力' },
    sessions,
  }),
})

const sessionRow = (overrides) => ({
  sessionId: 's-alpha',
  quarantined: [],
  good: [],
  active: { provider: 'alpha', model: 'one', at, label: '硅基流动 · Alpha One' },
  ...overrides,
})

await check('隔离队列：注册成 conversation.view，排在 chat 与详情右边，标题走字典', () => {
  const definition = sections[2].definition
  assert.equal(definition.name, 'conversation.view')
  assert.equal(definition.id, 'model-failover:quarantine')
  assert.ok(definition.order > 10, `要排在详情(10)后面，实际是 ${definition.order}`)
  assert.equal(typeof definition.label, 'function')
  assert.equal(definition.label(), '隔离队列')
  assert.equal(typeof dictZh.viewQuarantine, 'string')
  assert.equal(typeof dictionaries.get('settings.modelFailover').en.viewQuarantine, 'string')
})

await check('隔离队列：问的是轻量 /sessions，按会话列出「正在用」与「已隔离」', async () => {
  const fresh = new Runtime()
  const asked = []
  const saved = globalThis.fetch
  globalThis.fetch = async (url) => {
    asked.push(String(url))
    return sessionsPayload([
      sessionRow({
        sessionId: 's-alpha',
        quarantined: [
          { key: KEY('beta', 'one'), provider: 'beta', model: 'one', code: 'QUOTA', message: '余额不足', at: at - 90_000, label: 'Code99 · Beta One', sessionId: 's-alpha' },
        ],
        good: [{ key: KEY('alpha', 'one'), provider: 'alpha', model: 'one', at, label: '硅基流动 · Alpha One', sessionId: 's-alpha' }],
      }),
      sessionRow({ sessionId: 's-beta', active: { provider: 'gamma', model: 'two', at, label: 'FutureHub · Gamma Two' } }),
    ])
  }
  let flat
  try {
    flat = fresh.text(await fresh.mount(queue({ sessionId: 's-other', t })))
  } finally {
    globalThis.fetch = saved
  }

  assert.equal(asked.length >= 1, true, '至少要问一次')
  assert.ok(asked[0].includes('/api/dsh-model-failover/sessions'), `应问 /sessions，实际是：${asked[0]}`)
  assert.equal(asked.some((url) => url.includes('/state')), false, '不该为这一栏拉整份状态')

  assert.ok(flat.includes('隔离队列'), '标题要在')
  assert.ok(flat.includes('正在用'), '要有「正在用」一栏')
  assert.ok(flat.includes('已隔离'), '要有「已隔离」一栏')
  // 第一个会话：用 alpha/one，隔离了 beta/one。
  assert.ok(flat.includes('硅基流动 · Alpha One'), '应列出这个会话正在用的模型')
  assert.ok(flat.includes('Code99 · Beta One'), '应列出被隔离的模型')
  assert.ok(flat.includes('额度/余额耗尽'), '隔离项要带人话错误码')
  // 报错原文挂在 title 上（悬停才看得见），不在纯文本里 —— 从节点上断言。
  const titled = fresh.nodes.filter((node) => String(node.props?.className ?? '').includes('mf-qv-item mf-bad'))
  assert.equal(titled.length, 1, '隔离项渲染成一个红色胶囊')
  assert.equal(titled[0].props.title, '余额不足')
  // 第二个会话：没有隔离，只显示一句「没有出过问题」。
  assert.ok(flat.includes('FutureHub · Gamma Two'), '第二个会话有它自己的当前模型')
  assert.ok(flat.includes('今天没有出过问题的模型'), '没有隔离时说清楚')
})

await check('隔离队列：当前会话那一行有标记，别的会话没有', async () => {
  const fresh = new Runtime()
  const saved = globalThis.fetch
  globalThis.fetch = async () => sessionsPayload([
    sessionRow({ sessionId: 's-mine' }),
    sessionRow({ sessionId: 's-other', active: { provider: 'beta', model: 'one', at, label: 'Code99 · Beta One' } }),
  ])
  try {
    await fresh.mount(queue({ sessionId: 's-mine', t }))
    const badges = fresh.nodes.filter((node) => node.props?.className === 'mf-badge mf-ok')
    assert.equal(badges.length, 1, '只有当前会话那一行该带标记')
    assert.equal(badges[0].text, '当前会话')
    const mine = fresh.nodes.filter((node) => String(node.props?.className ?? '').includes('mf-mine'))
    assert.equal(mine.length, 1, '当前会话那一行应换上高亮描边')
  } finally {
    globalThis.fetch = saved
  }
})

await check('隔离队列：会话标题取自宿主，宿主没给就退回会话号前缀', async () => {
  const fresh = new Runtime()
  const saved = globalThis.fetch
  globalThis.fetch = async () => sessionsPayload([
    sessionRow({ sessionId: 's-titled' }),
    sessionRow({ sessionId: 's-untitled', active: undefined }),
  ])
  // 宿主注入的 hook：按 selector 读会话表。
  const useSessions = (select) => select({ byId: { 's-titled': { id: 's-titled', displayTitle: '排障会话' } } })
  let flat
  try {
    flat = fresh.text(await fresh.mount(queue({ sessionId: 's-titled', useSessions, t })))
  } finally {
    globalThis.fetch = saved
  }
  assert.ok(flat.includes('排障会话'), '有标题就用标题')
  // 会话号前缀始终作为副标题留着：标题可能重名，号才是唯一的。
  assert.ok(flat.includes('s-titled'.slice(0, 8)), '会话号前缀作为副标题保留')
  assert.ok(flat.includes('未命名会话'), '没跑过东西的会话也要有标题兜底')
  assert.ok(flat.includes('s-untitl'), '标题缺失时退回会话号前缀')
})

await check('隔离队列：一个会话都没有时给出空态，首帧给加载态', async () => {
  const fresh = new Runtime()
  const saved = globalThis.fetch
  globalThis.fetch = async () => sessionsPayload([])
  let flat
  try {
    flat = fresh.text(await fresh.mount(queue({ sessionId: 's-x', t })))
  } finally {
    globalThis.fetch = saved
  }
  assert.ok(flat.includes('还没有任何会话跑过'), `应是空态，实际：${flat.slice(0, 200)}`)

  const slow = new Runtime()
  globalThis.fetch = () => new Promise(() => {})
  try {
    const tree = await slow.mount(queue({ sessionId: 's-x', t }))
    assert.ok(slow.text(tree).includes('读取中'), '数据还没到时先给加载态')
  } finally {
    globalThis.fetch = saved
  }
})

await check('隔离队列：不分会话那一桶不叫「未命名会话」，免得像是真有一个对话', async () => {
  const fresh = new Runtime()
  const saved = globalThis.fetch
  globalThis.fetch = async () => sessionsPayload([
    sessionRow({ sessionId: '', active: { provider: 'alpha', model: 'one', at, label: '硅基流动 · Alpha One' } }),
  ])
  let flat
  try {
    flat = fresh.text(await fresh.mount(queue({ sessionId: 's-mine', t })))
  } finally {
    globalThis.fetch = saved
  }
  assert.ok(flat.includes('后台任务'), `空会话号应说明它是后台任务，实际：${flat.slice(0, 200)}`)
  assert.equal(flat.includes('未命名会话'), false, '不该把它当成一个没起名字的对话')
})

await check('隔离队列：手动刷新再问一次 /sessions，不会改任何设置', async () => {
  const fresh = new Runtime()
  const asked = []
  const saved = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    asked.push({ url: String(url), method: options?.method ?? 'GET' })
    return sessionsPayload([sessionRow({})])
  }
  try {
    await fresh.mount(queue({ sessionId: 's-alpha', t }))
    const idle = asked.length
    await fresh.button('刷新').props.onClick()
    await fresh.mount(queue({ sessionId: 's-alpha', t }))
    const freshCalls = asked.slice(idle)
    assert.equal(freshCalls.length >= 1, true, '刷新按钮应该重新拉一次')
    assert.equal(freshCalls.every((row) => row.method === 'GET'), true, '这一栏只读，不该发 POST')
    assert.equal(asked.every((row) => row.url.includes('/sessions')), true, '只问 /sessions')
  } finally {
    globalThis.fetch = saved
  }
})

// ── 首帧 / 错误态（各自一个全新的渲染器，避免和别的用例串味） ────────────────

const page = sections[0].component
const props = { close() {}, t: (key) => key }

await check('首帧（还没拿到数据）渲染加载态，不抛错', async () => {
  const fresh = new Runtime()
  const saved = globalThis.fetch
  globalThis.fetch = () => new Promise(() => {}) // 永远不返回：停在加载态
  try {
    const tree = await fresh.mount(page(props))
    const flat = fresh.text(tree)
    assert.ok(flat.includes('busy'), `应显示加载文案，实际是：${flat.slice(0, 200)}`)
    assert.ok(!flat.includes('loadFailed'), '不该显示错误')
  } finally {
    globalThis.fetch = saved
  }
})

await check('宿主报错时渲染错误态，不白屏', async () => {
  const fresh = new Runtime()
  const saved = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    text: async () => JSON.stringify({ ok: false, error: '磁盘满了' }),
  })
  try {
    const tree = await fresh.mount(page(props))
    const flat = fresh.text(tree)
    assert.ok(flat.includes('loadFailed'), `应显示失败文案，实际是：${flat.slice(0, 200)}`)
  } finally {
    globalThis.fetch = saved
  }
})

// ── 正常路径 ────────────────────────────────────────────────────────────────

const current = initialState()
const requests = []

globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET'
  const body = init.body === undefined ? undefined : JSON.parse(init.body)
  requests.push({ url: String(url), method, body })
  if (method === 'POST') {
    if (String(url).endsWith('/settings') && body !== undefined) {
      if (Array.isArray(body.order)) {
        // 模拟宿主 normalizeSettings：只留 provider/model/reasoningEffort，
        // 没设档位的项不补空字段。
        current.settings.order = body.order.map((item) => (item.reasoningEffort === undefined
          ? { provider: item.provider, model: item.model }
          : { provider: item.provider, model: item.model, reasoningEffort: item.reasoningEffort }))
      }
      for (const key of ['enabled', 'retrySameModelOnce', 'continueText', 'resetHour', 'keepEventLog', 'eventLogLimit', 'retryWhenAllQuarantined', 'autoContinue', 'autoContinueOnFailure', 'autoContinueOnMaxTokens', 'autoContinueFailureLimit', 'autoContinueMaxTokensLimit', 'continueDelaySec']) {
        if (body[key] !== undefined) current.settings[key] = body[key]
      }
    }
    if (String(url).endsWith('/log/clear')) current.events = []
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(current) }
}

const tree = await runtime.mount(page(props))

await check('挂载后自动 GET /state，并把队列、提供者名、数据目录渲染出来', () => {
  assert.deepEqual(
    requests.filter((row) => row.method === 'GET').map((row) => row.url),
    ['/api/dsh-model-failover/state'],
  )
  const flat = runtime.text(tree)
  assert.ok(flat.includes('Alpha One'), '应显示第一个候选的模型名')
  assert.ok(flat.includes('Beta One'))
  assert.ok(flat.includes('Gamma Two'))
  assert.ok(flat.includes('硅基流动'), '应显示 provider 的中文名')
  assert.ok(flat.includes('模型接力'), '应显示自己的路由名')
  assert.ok(flat.includes('C:\\Users\\superv\\.dsh\\dsh-model-failover'), '应显示数据目录')
})

await check('今天隔离的模型带红色徽标，昨天验证可用的带绿色徽标', () => {
  const badges = runtime.nodes.filter(
    (node) => typeof node.props.className === 'string' && node.props.className.startsWith('mf-badge'),
  )
  assert.ok(badges.some((node) => node.props.className.includes('mf-bad')), '应有隔离徽标')
  assert.ok(badges.some((node) => node.props.className.includes('mf-ok')), '应有可用徽标')
  assert.ok(
    badges.some((node) => String(node.props.title ?? '').includes('QUOTA')),
    '隔离徽标应带着错误码，方便一眼看出是额度问题还是别的问题',
  )
})

// ── 隔离名单：展开看完整报错 ────────────────────────────────────────────────

/** 隔离名单里那几行的展开按钮（名单之外的按钮不带 aria-expanded）。 */
const expanders = (rt = runtime) => rt.nodes.filter(
  (node) => node.tag === 'button' && node.props['aria-expanded'] !== undefined,
)

await check('隔离名单每行都有一个展开箭头，默认是收起的', () => {
  const buttons = expanders()
  assert.equal(buttons.length, 2, '隔离了几个模型就有几个箭头')
  assert.ok(buttons.every((node) => node.props['aria-expanded'] === 'false'), '默认都收起')
  assert.equal(buttons[0].text, '▸')
  assert.equal(buttons[0].props.title, 'expand', '收起时提示「展开」')
  assert.equal(runtime.nodes.filter((node) => node.props.className === 'mf-detail').length, 0, '收起时不该有详情块')
})

await check('摘要行只给截断后的报错，尾部标记先藏着', () => {
  const subs = runtime.nodes.filter((node) => node.props.className === 'mf-sub' && String(node.text).includes('tunnel'))
  assert.equal(subs.length, 1, '两条隔离里只有 gamma 那条带着长报错')
  assert.ok(subs[0].text.includes('cannot resolve tunnel destination'), '摘要里应保留报错开头')
  assert.ok(!subs[0].text.includes(TAIL_MARK), '摘要行该把 160 字符之后的内容截掉')
  const flat = runtime.text(tree)
  assert.ok(!flat.includes(TAIL_MARK), '收起状态下整棵树里都不该出现尾部标记')
})

await check('点开箭头：摊出错误码、路由、尝试次数、判定时间和完整报错原文', async () => {
  await expanders()[1].props.onClick()
  await runtime.mount(page(props))

  const buttons = expanders()
  assert.equal(buttons[1].props['aria-expanded'], 'true', '点过的那一行变成展开')
  assert.equal(buttons[1].text, '▾')
  assert.equal(buttons[1].props.title, 'collapse', '展开后提示变成「收起」')
  assert.equal(buttons[0].props['aria-expanded'], 'false', '别的行不受影响 —— 展开状态是按行各记一份')

  const details = runtime.nodes.filter((node) => node.props.className === 'mf-detail')
  assert.equal(details.length, 1, '只摊开了一行')
  const rows = Object.fromEntries(
    runtime.nodes
      .filter((node) => node.props.className === 'mf-detail-row')
      .map((node) => [node.props.key, node.text]),
  )
  assert.equal(rows.detailCode, 'detailCode网络中断  TRANSPORT', '错误码既给人话也留原始值')
  assert.equal(rows.detailRoute, 'detailRoutegamma / two')
  assert.equal(rows.detailAttempts, 'detailAttempts1')
  assert.match(rows.detailAt, /^detailAt\d\d-\d\d \d\d:\d\d$/, '判定时间跟一个 MM-DD HH:MM 时间戳')
  // 同一张名单里同一个模型可能挂在若干个会话名下，所以「是哪个会话撞的」必须写得出来。
  assert.equal(rows.detailSession, 'detailSessionsess-long-name', '要点名隔离挂在哪个会话名下')
  assert.ok(rows.detailMessage.includes(TAIL_MARK), '展开就是为了看被截掉的那半句')
  assert.ok(rows.detailMessage.startsWith('detailMessage'), '带一行「报错原文」的标签')
  // 收起时摘要行也给一句会话提示：一行行摊开看才知道是谁撞的，太费事。
  // 这一页的 t() 是回声版（只回 key），所以这里认的是 key 而不是译文；插值另外验。
  const summaries = runtime.nodes.filter((node) => node.props.className === 'mf-sub')
  assert.ok(summaries.some((node) => node.text === 'rowSession'), '摘要行要带一段会话提示')
})

await check('设置页的隔离摘要用真字典渲染时，会话号前缀真的插进去了', async () => {
  const fresh = new Runtime()
  const saved = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(initialState()) })
  try {
    const tree = await fresh.mount(sections[0].component({ close() {}, t }))
    const flat = fresh.text(tree)
    assert.ok(flat.includes('会话 sess-lon…'), `摘要行应带会话号前缀，实际：${flat.slice(0, 400)}`)
    assert.ok(flat.includes('会话 sess-alp…'), '两行挂在不同会话下，各写各的')
  } finally {
    globalThis.fetch = saved
  }
})

await check('再点一下箭头就收回去，详情块整个消失', async () => {
  await expanders()[1].props.onClick()
  await runtime.mount(page(props))
  assert.equal(expanders()[1].props['aria-expanded'], 'false')
  assert.equal(runtime.nodes.filter((node) => node.props.className === 'mf-detail').length, 0)
  assert.ok(!runtime.text(tree).includes(TAIL_MARK), '收回去之后尾部标记也一起藏好')
})

await check('宿主没留下报错文本时，展开显示的是「没有留下」而不是空白', async () => {
  const fresh = new Runtime()
  const saved = globalThis.fetch
  const blank = initialState()
  blank.quarantined = [
    { key: KEY('beta', 'one'), provider: 'beta', model: 'one', code: 'UNKNOWN', message: '', at, label: 'Code99 · Beta One' },
  ]
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(blank) })
  try {
    const page2 = sections[0].component
    await fresh.mount(page2(props))
    await expanders(fresh)[0].props.onClick()
    await fresh.mount(page2(props))
    const rows = fresh.nodes.filter((node) => node.props.className === 'mf-detail-row')
    assert.ok(rows.some((node) => node.text === 'detailMessagedetailNoMessage'), '空报错要有一句说明')
    assert.equal(expanders(fresh)[0].props['aria-expanded'], 'true')
  } finally {
    globalThis.fetch = saved
  }
})

await check('每行按模型自己的档位表画思考强度下拉框：认档位 / 不支持 / 还没问到', () => {
  const selects = runtime.nodes.filter((node) => node.props.className === 'mf-effort')
  const none = runtime.nodes.filter((node) => node.props.className === 'mf-effort-none')
  const options = (node) => [].concat(node.props.children ?? []).map((child) => [child.props.value, child.props.children])

  // beta/one 明确不支持档位：画一行说明文字，不画控件。
  assert.equal(none.length, 1, '不支持的模型显示「无档位」而不是空下拉框')
  assert.equal(none[0].text, 'effortNone')

  // alpha/one 支持 low/high（名字用的是模型自己给的名字）；gamma/two 还没扫到。
  assert.equal(selects.length, 2, '支持和未扫描的模型各有一个下拉框')
  assert.deepEqual(options(selects[0]), [['', 'effortDefault'], ['low', '低'], ['high', '高']], '第一行就是它的档位表')
  assert.equal(selects[0].props.disabled, false)
  assert.equal(selects[0].props.value, '', '没设过档位时停在「默认档位」')
  assert.deepEqual(options(selects[1]), [['', 'effortUnknown']], '还没扫到档位表就先给个禁用态，不凭空造档位')
  assert.equal(selects[1].props.disabled, true)
})

await check('改档位：POST 整个新顺序，只有这一项带 reasoningEffort', async () => {
  const before = requests.length
  const select = runtime.nodes.filter((node) => node.props.className === 'mf-effort' && node.props.disabled !== true)[0]
  await select.props.onChange({ target: { value: 'high' } })
  await runtime.mount(page(props))

  const posts = requests.slice(before).filter((row) => row.method === 'POST')
  assert.equal(posts.length, 1, '应只发一个 POST')
  assert.equal(posts[0].url, '/api/dsh-model-failover/settings')
  assert.deepEqual(posts[0].body, {
    order: [
      { provider: 'alpha', model: 'one', reasoningEffort: 'high' },
      { provider: 'beta', model: 'one' },
      { provider: 'gamma', model: 'two' },
    ],
  }, '档位只落在被改的那一项上，顺序原样带上')

  const after = runtime.nodes.filter((node) => node.props.className === 'mf-effort' && node.props.disabled !== true)[0]
  assert.equal(after.props.value, 'high', '控件显示宿主确认下来的值')
})

await check('把档位改回「默认档位」：这一项不再带 reasoningEffort', async () => {
  const before = requests.length
  const select = runtime.nodes.filter((node) => node.props.className === 'mf-effort' && node.props.disabled !== true)[0]
  assert.equal(select.props.value, 'high', '前提：上一步把它设成了 high')
  await select.props.onChange({ target: { value: '' } })
  await runtime.mount(page(props))

  const body = requests.slice(before).filter((row) => row.method === 'POST')[0].body
  assert.equal('reasoningEffort' in body.order[0], false, '「默认档位」= 不发这个字段，用模型平时的档位')
})

await check('↑ 把第二个候选与第一个交换，并 POST 完整的新顺序', async () => {
  const before = requests.length
  assert.equal(runtime.button('↑').props.disabled, true, '第一行的 ↑ 应该是禁用的')
  await runtime.enabledButton('↑').props.onClick()
  await runtime.mount(page(props))

  const posts = requests.slice(before).filter((row) => row.method === 'POST')
  assert.equal(posts.length, 1, '应只发一个 POST')
  assert.equal(posts[0].url, '/api/dsh-model-failover/settings')
  assert.deepEqual(posts[0].body, {
    order: [
      { provider: 'beta', model: 'one' },
      { provider: 'alpha', model: 'one' },
      { provider: 'gamma', model: 'two' },
    ],
  })
  assert.deepEqual(current.settings.order.map((row) => row.provider), ['beta', 'alpha', 'gamma'])
})

await check('✕ 把这一行移出队列', async () => {
  const before = requests.length
  await runtime.enabledButton('✕').props.onClick()
  await runtime.mount(page(props))

  const posts = requests.slice(before).filter((row) => row.method === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].body.order.map((row) => row.provider), ['alpha', 'gamma'])
})

await check('总开关能关掉，POST 的是布尔值', async () => {
  const before = requests.length
  const toggle = runtime.find((node) => node.props['aria-label'] === 'optEnabled')
  assert.equal(toggle.props['aria-pressed'], 'true', '开关应反映当前设置')
  await toggle.props.onClick()
  await runtime.mount(page(props))

  const posts = requests.slice(before).filter((row) => row.method === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].body, { enabled: false })
})

const hourInput = () => runtime.find(
  (node) => node.tag === 'input' && node.props.min === 0 && node.props.max === 23,
)

await check('改成 5 点重置：输入框失焦后 POST resetHour', async () => {
  const before = requests.length
  hourInput().props.onChange({ target: { value: '5' } })
  await runtime.mount(page(props))
  assert.equal(hourInput().props.value, '5', '输入框应显示草稿值')
  hourInput().props.onBlur()
  await runtime.mount(page(props))

  const posts = requests.slice(before).filter((row) => row.method === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].body, { resetHour: 5 })
  assert.equal(current.settings.resetHour, 5)
})

await check('超范围的重置时间被夹回 0-23，不会把脏值发给宿主', async () => {
  const before = requests.length
  hourInput().props.onChange({ target: { value: '42' } })
  await runtime.mount(page(props))
  assert.equal(hourInput().props.value, '42', '输入框应保留用户敲进去的草稿')
  hourInput().props.onBlur()
  await runtime.mount(page(props))

  const posts = requests.slice(before).filter((row) => row.method === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].body, { resetHour: 23 })
  assert.equal(current.settings.resetHour, 23)
})

await check('乱敲的重置时间被丢弃，不会发 POST', async () => {
  const before = requests.length
  hourInput().props.onChange({ target: { value: 'abc' } })
  await runtime.mount(page(props))
  hourInput().props.onBlur()
  await runtime.mount(page(props))

  const posts = requests.slice(before).filter((row) => row.method === 'POST')
  assert.equal(posts.length, 0, '非整数应该被丢掉，而不是把 NaN 发给宿主')
  assert.equal(hourInput().props.value, '23', '输入框应回滚到宿主的值')
})

// 同一张卡片里现在有两个 min=1 max=20 的数字框（失败上限 / 撞上限次数），
// 光靠上下界认不出来，改用宿主渲染到 input 上的 data-name 区分。
const nameInput = (name) => () => runtime.find(
  (node) => node.tag === 'input' && node.props['data-name'] === name,
)
const failureLimitInput = nameInput('failureLimit')
const maxTokensLimitInput = nameInput('maxTokensLimit')

await check('DSH 异常：三个开关 + 两个分开的次数上限 + 等待秒数都在，且反映宿主设置', () => {
  const toggle = (label) => runtime.find((node) => node.props['aria-label'] === label)
  for (const label of ['optAutoContinue', 'optAutoOnFailure', 'optAutoOnMaxTokens']) {
    assert.equal(toggle(label).props['aria-pressed'], 'true', `${label} 应反映当前设置`)
    assert.equal(toggle(label).props.disabled, false, `${label} 在总开关打开时应可点`)
  }
  assert.equal(failureLimitInput().props.value, '1', '失败上限应显示宿主的值')
  assert.equal(maxTokensLimitInput().props.value, '10', '撞上限的次数应显示宿主的值')

  const delay = runtime.find(
    (node) => node.tag === 'input' && node.props.min === 0 && node.props.max === 300,
  )
  assert.equal(delay.props.value, '5', '等待秒数应显示宿主的值')
  assert.equal(delay.props.disabled, false)
})

await check('DSH 异常总开关关掉后，两个分项、两个上限和等待秒数一起置灰', async () => {
  const before = requests.length
  await runtime.find((node) => node.props['aria-label'] === 'optAutoContinue').props.onClick()
  await runtime.mount(page(props))

  const posts = requests.slice(before).filter((row) => row.method === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].body, { autoContinue: false })

  const toggle = (label) => runtime.find((node) => node.props['aria-label'] === label)
  assert.equal(toggle('optAutoOnFailure').props.disabled, true, '总开关关了，分项没意义')
  assert.equal(toggle('optAutoOnMaxTokens').props.disabled, true)
  assert.equal(failureLimitInput().props.disabled, true)
  assert.equal(maxTokensLimitInput().props.disabled, true)
  const delay = runtime.find(
    (node) => node.tag === 'input' && node.props.min === 0 && node.props.max === 300,
  )
  assert.equal(delay.props.disabled, true, '总开关关了，等待秒数也没意义')

  // 恢复，免得影响后面的用例。
  await toggle('optAutoContinue').props.onClick()
  await runtime.mount(page(props))
})

await check('关掉「输出撞上限」这一项，POST 的是它自己的键', async () => {
  const before = requests.length
  await runtime.find((node) => node.props['aria-label'] === 'optAutoOnMaxTokens').props.onClick()
  await runtime.mount(page(props))

  const posts = requests.slice(before).filter((row) => row.method === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].body, { autoContinueOnMaxTokens: false })

  await runtime.find((node) => node.props['aria-label'] === 'optAutoOnMaxTokens').props.onClick()
  await runtime.mount(page(props))
})

await check('失败上限失焦后 POST autoContinueFailureLimit，超范围夹到 1-20', async () => {
  const before = requests.length
  failureLimitInput().props.onChange({ target: { value: '99' } })
  await runtime.mount(page(props))
  assert.equal(failureLimitInput().props.value, '99', '输入框应保留用户敲进去的草稿')
  failureLimitInput().props.onBlur()
  await runtime.mount(page(props))

  const posts = requests.slice(before).filter((row) => row.method === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].body, { autoContinueFailureLimit: 20 }, '夹到硬上限 20')
  assert.equal(current.settings.autoContinueFailureLimit, 20)
  assert.equal(current.settings.autoContinueMaxTokensLimit, 10, '两个计数各算各的，不能串')

  // 恢复，免得影响后面的用例。
  failureLimitInput().props.onChange({ target: { value: '1' } })
  await runtime.mount(page(props))
  failureLimitInput().props.onBlur()
  await runtime.mount(page(props))
})

await check('撞上限次数失焦后 POST autoContinueMaxTokensLimit，且不碰失败那个上限', async () => {
  const before = requests.length
  maxTokensLimitInput().props.onChange({ target: { value: '42' } })
  await runtime.mount(page(props))
  assert.equal(maxTokensLimitInput().props.value, '42', '输入框应保留用户敲进去的草稿')
  maxTokensLimitInput().props.onBlur()
  await runtime.mount(page(props))

  const posts = requests.slice(before).filter((row) => row.method === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].body, { autoContinueMaxTokensLimit: 20 }, '夹到硬上限 20')
  assert.equal(current.settings.autoContinueMaxTokensLimit, 20)
  assert.equal(current.settings.autoContinueFailureLimit, 1, '两个计数各算各的，不能串')

  // 恢复，免得影响后面的用例。
  maxTokensLimitInput().props.onChange({ target: { value: '10' } })
  await runtime.mount(page(props))
  maxTokensLimitInput().props.onBlur()
  await runtime.mount(page(props))
})

await check('等待秒数失焦后 POST continueDelaySec，超范围夹到 0-300', async () => {
  const delayInput = () => runtime.find(
    (node) => node.tag === 'input' && node.props.min === 0 && node.props.max === 300,
  )
  const before = requests.length
  delayInput().props.onChange({ target: { value: '999' } })
  await runtime.mount(page(props))
  assert.equal(delayInput().props.value, '999', '输入框应保留用户敲进去的草稿')
  delayInput().props.onBlur()
  await runtime.mount(page(props))

  const posts = requests.slice(before).filter((row) => row.method === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].body, { continueDelaySec: 300 })
  assert.equal(current.settings.continueDelaySec, 300)

  // 0 是「不等待」，必须能存进去 —— 夹取的下界不能把它弹回默认值。
  const beforeZero = requests.length
  delayInput().props.onChange({ target: { value: '0' } })
  await runtime.mount(page(props))
  delayInput().props.onBlur()
  await runtime.mount(page(props))
  const zeroPosts = requests.slice(beforeZero).filter((row) => row.method === 'POST')
  assert.equal(zeroPosts.length, 1)
  assert.deepEqual(zeroPosts[0].body, { continueDelaySec: 0 })

  // 恢复，免得影响后面的用例。
  delayInput().props.onChange({ target: { value: '5' } })
  await runtime.mount(page(props))
  delayInput().props.onBlur()
  await runtime.mount(page(props))
})

await check('自动补发事件在日志里有自己的文案，不会漏出裸 kind', async () => {
  // 必须开一个全新的 Runtime：hook 单元按「路径 + 类型名」跨 mount 复用，
  // 老的 Runtime 里那次 GET 早已跑过，改 current.events 再 mount 也刷不出来。
  const fresh = new Runtime()
  const saved = globalThis.fetch
  const state = initialState()
  state.events = [
    { at: Date.now(), kind: 'auto-continue', trigger: 'max-tokens', sessionId: 's1', turn: 3, text: '继续' },
    { at: Date.now(), kind: 'auto-continue', trigger: 'error', sessionId: 's1', turn: 4, text: '继续' },
  ]
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(state) })
  let flat
  try {
    flat = fresh.text(await fresh.mount(page(props)))
  } finally {
    globalThis.fetch = saved
  }

  assert.ok(flat.includes('evAutoContinue'), `auto-continue 应走专属文案，实际：${flat.slice(-260)}`)
  assert.equal(flat.includes('auto-continue'), false, '不该把裸的 kind 直接摊给用户看')

  // 这个桩里的 t() 只回 key，插值得直接查字典。
  const zh = dictionaries.get('settings.modelFailover').zh
  assert.ok(zh.evAutoContinue.includes('{trigger}'), '文案要留出触发原因的插槽')
  assert.ok(zh.trigMaxTokens.includes('上限'))
  assert.ok(zh.trigError.length > 0)
})

await check('本机网络跳过补发的事件也有专属文案，带上原始 code', async () => {
  const fresh = new Runtime()
  const saved = globalThis.fetch
  const state = initialState()
  state.events = [
    { at: Date.now(), kind: 'auto-continue-skipped', trigger: 'network', sessionId: 's1', turn: 5, code: 'TRANSPORT', message: 'trae: transport error: fetch failed' },
    { at: Date.now(), kind: 'auto-continue-skipped', trigger: 'network', sessionId: 's1', turn: 6, code: 'SERVER', message: 'ENOTFOUND' },
  ]
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(state) })
  let flat
  try {
    flat = fresh.text(await fresh.mount(page(props)))
  } finally {
    globalThis.fetch = saved
  }

  assert.ok(flat.includes('evAutoContinueSkipped'), `应走专属文案，实际：${flat.slice(-260)}`)
  assert.equal(flat.includes('auto-continue-skipped'), false, '不该把裸的 kind 直接摊给用户看')

  const zh = dictionaries.get('settings.modelFailover').zh
  assert.ok(zh.evAutoContinueSkipped.includes('{code}'), '文案要留出 code 的插槽')
  assert.ok(zh.evAutoContinueSkipped.includes('网络'), '要让用户一眼看出是本机网络的问题')
  assert.ok(dictionaries.get('settings.modelFailover').en.evAutoContinueSkipped.length > 0, '英文文案不能缺')
})

await check('清空事件日志走 /log/clear', async () => {
  const before = requests.length
  const clear = runtime.button('clearLog')
  assert.equal(clear.props.disabled, false, '有事件时清空按钮应可用')
  await clear.props.onClick()
  await runtime.mount(page(props))

  const posts = requests.slice(before).filter((row) => row.method === 'POST')
  assert.equal(posts.length, 1)
  assert.equal(posts[0].url, '/api/dsh-model-failover/log/clear')
})

await check('扫描按钮走 /refresh', async () => {
  const before = requests.length
  await runtime.button('refresh').props.onClick()
  await runtime.mount(page(props))

  const posts = requests.slice(before).filter((row) => row.method === 'POST')
  assert.equal(posts.length, 1)
  assert.equal(posts[0].url, '/api/dsh-model-failover/refresh')
})

await check('卸载时 effect 的清理函数把样式表收回去', () => {
  const labels = effects.map((row) => row.label).filter((label) => typeof label === 'string')
  assert.ok(labels.includes('model-failover: dictionaries'))
  assert.ok(labels.includes('model-failover: styles'))
  assert.equal(typeof styleSheets[0].remove, 'function')
  styleSheets[0].remove()
})

globalThis.setInterval = realSetInterval
globalThis.clearInterval = realClearInterval

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exitCode = failed === 0 ? 0 : 1
