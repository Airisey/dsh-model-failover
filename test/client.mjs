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

const payloadResponse = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) })

const initialState = () => ({
  ok: true,
  route: { provider: 'model-failover', label: '模型接力' },
  now: at,
  day: '2026-11-27',
  nextResetAt: at + 3 * 3600_000,
  settings: {
    enabled: true,
    bootstrapped: true,
    templates: [
      {
        id: 'default',
        name: '默认模板',
        order: [
          { provider: 'alpha', model: 'one' },
          { provider: 'beta', model: 'one' },
          { provider: 'gamma', model: 'two' },
        ],
      },
      { id: 'spare', name: '备用模板', order: [] },
    ],
    editedTemplate: 'default',
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
  // 红绿数字：全机器合计，跨会话跨模板都算在同一个模型头上。
  counts: {
    [KEY('alpha', 'one')]: { fail: 0, ok: 7 },
    [KEY('beta', 'one')]: { fail: 3, ok: 1 },
    [KEY('gamma', 'two')]: { fail: 12, ok: 0 },
  },
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
    route: { provider: 'model-failover', label: '模型接力' },
    // 隔离条目上只带模板 id，名字得从这里换。
    templates: [{ id: 'default', name: '默认模板' }, { id: 'spare', name: '备用模板' }],
    sessions,
  }),
})

const sessionRow = (overrides) => ({
  sessionId: 's-alpha',
  quarantined: [],
  good: [],
  active: { provider: 'alpha', model: 'one', at, label: '硅基流动 · Alpha One', templateId: 'default', templateName: '默认模板' },
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

await check('隔离队列：当前会话那一行排到最前面，其余会话顺序不变', async () => {
  const fresh = new Runtime()
  const saved = globalThis.fetch
  globalThis.fetch = async () => sessionsPayload([
    sessionRow({ sessionId: 's-a' }),
    sessionRow({ sessionId: 's-b' }),
    sessionRow({ sessionId: 's-mine' }),
  ])
  let cards
  try {
    await fresh.mount(queue({ sessionId: 's-mine', t }))
    cards = fresh.nodes.filter((node) => String(node.props?.className ?? '').startsWith('mf-qv-session'))
  } finally {
    globalThis.fetch = saved
  }
  assert.equal(cards.length, 3, '三个会话各一张卡')
  assert.equal(cards[0].props.className, 'mf-qv-session mf-mine', '自己那个会话置顶')
  assert.deepEqual(
    cards.slice(1).map((node) => node.props.className),
    ['mf-qv-session', 'mf-qv-session'],
    '别的会话保持宿主给的顺序',
  )
})

await check('隔离队列：每个会话那行写明它在用哪个模板', async () => {
  const fresh = new Runtime()
  const saved = globalThis.fetch
  globalThis.fetch = async () => sessionsPayload([
    sessionRow({ sessionId: 's-mine', active: { provider: 'alpha', model: 'one', at, label: '硅基流动 · Alpha One', templateId: 'spare', templateName: '备用模板' } }),
    sessionRow({ sessionId: 's-other' }),
  ])
  let flat
  try {
    flat = fresh.text(await fresh.mount(queue({ sessionId: 's-mine', t })))
  } finally {
    globalThis.fetch = saved
  }
  assert.ok(flat.includes('备用模板'), '当前会话用的是备用模板，要写出来')
  assert.ok(flat.includes('默认模板'), '另一个会话仍写它的模板名')
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

// ── 解除隔离的按钮（只在会话页那一栏，只解当前会话） ─────────────────────────

/** 有隔离的会话行，用来喂「解除本会话隔离」那个按钮。 */
const stuckRow = (sessionId, overrides) => sessionRow({
  sessionId,
  quarantined: [{ key: KEY('beta', 'one'), provider: 'beta', model: 'one', code: 'QUOTA', message: '余额不足', at, sessionId, label: 'Code99 · Beta One' }],
  ...overrides,
})

await check('设置页不再有「解除今日隔离」按钮：那件事挪到会话页去了，且只解当前会话', () => {
  const labels = runtime.nodes.filter((node) => node.tag === 'button').map((node) => node.text)
  assert.equal(labels.includes('解除今日隔离'), false, '设置页那个全局解除按钮应当已经撤掉')
})

await check('隔离队列：解除按钮只解当前会话，请求带 sessionId 且只解那一个', async () => {
  const fresh = new Runtime()
  const asked = []
  const saved = globalThis.fetch
  let payload = [stuckRow('s-mine'), stuckRow('s-other')]
  globalThis.fetch = async (url, options) => {
    const target = String(url)
    asked.push({ url: target, method: options?.method ?? 'GET' })
    if ((options?.method ?? 'GET') === 'POST') {
      // 宿主只解这一个会话：响应里回来的列表就是「我干净了、别人还挂着」。
      payload = [sessionRow({ sessionId: 's-mine' }), stuckRow('s-other')]
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          now: at,
          day: '2026-11-27',
          cleared: 1,
          sessionId: 's-mine',
          sessions: payload,
        }),
      }
    }
    return sessionsPayload(payload)
  }
  let flat
  try {
    await fresh.mount(queue({ sessionId: 's-mine', t }))
    await fresh.button('解除本会话隔离').props.onClick()
    await fresh.mount(queue({ sessionId: 's-mine', t }))
    flat = fresh.text(await fresh.mount(queue({ sessionId: 's-mine', t })))
  } finally {
    globalThis.fetch = saved
  }
  const posted = asked.filter((row) => row.method === 'POST')
  assert.equal(posted.length >= 1, true, '按钮应当真的发一次 POST')
  assert.equal(posted.every((row) => row.url.includes('/reset')), true, `只该打 /reset，实际：${JSON.stringify(posted.map((row) => row.url))}`)
  assert.equal(
    posted.every((row) => row.url.includes('sessionId=s-mine')),
    true,
    `必须带上当前会话号，否则会变成全局解除：${JSON.stringify(posted.map((row) => row.url))}`,
  )
  // 别人的隔离还在，所以那一行仍然写着 Code99 · Beta One。
  assert.ok(flat.includes('Code99 · Beta One'), `别的会话的隔离不该被顺手清掉，实际：${flat.slice(0, 400)}`)
})

await check('隔离队列：本会话没被隔离时解除按钮是灰的，按不动', async () => {
  const fresh = new Runtime()
  const saved = globalThis.fetch
  globalThis.fetch = async () => sessionsPayload([
    sessionRow({ sessionId: 's-mine' }),
    stuckRow('s-other'),
  ])
  try {
    await fresh.mount(queue({ sessionId: 's-mine', t }))
  } finally {
    globalThis.fetch = saved
  }
  const button = fresh.button('解除本会话隔离')
  assert.equal(button.props.disabled, true, '自己没有隔离可解时不该能按')
  assert.throws(() => fresh.enabledButton('解除本会话隔离'), /没有找到/, '不该存在可用的解除按钮')
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
      if (Array.isArray(body.templates)) {
        // 模拟宿主 normalizeTemplates：只留 id/name/order，档位只保留真正设了的。
        current.settings.templates = body.templates.map((template) => ({
          id: template.id,
          name: template.name,
          order: (template.order ?? []).map((item) => (item.reasoningEffort === undefined
            ? { provider: item.provider, model: item.model }
            : { provider: item.provider, model: item.model, reasoningEffort: item.reasoningEffort })),
        }))
      }
      if (typeof body.editedTemplate === 'string') current.settings.editedTemplate = body.editedTemplate
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

await check('队列行上不再画隔离/可用徽标：那是按会话算的，一行一个模型答不了', () => {
  const badges = runtime.nodes.filter(
    (node) => typeof node.props.className === 'string' && node.props.className.startsWith('mf-badge'),
  )
  // 「隔离中」在甲会话成立、在乙会话不成立，摆在队列行上只会误导。剩下的徽标
  // 只该是隔离名单每行右边的那个时间戳：数量与展开箭头对得上，且不带悬停说明
  // （带 title 的正是被撤掉的那种「隔离中 / 已验证」徽标）。
  const rowsWithStamp = runtime.nodes.filter(
    (node) => node.tag === 'button' && node.props['aria-expanded'] !== undefined,
  )
  assert.equal(badges.length, rowsWithStamp.length, `徽标只该出现在名单行上，实际：${JSON.stringify(badges.map((node) => node.text))}`)
  assert.equal(
    badges.filter((node) => String(node.props.title ?? '') !== '').length,
    0,
    '队列徽标那种带悬停说明的徽标不该再有了',
  )
})

// ── 隔离名单已经撤掉 ────────────────────────────────────────────────────────
//
// 设置页不再有「今日隔离名单」那张卡：隔离按「会话 × 模板」算，一页全局表格
// 既说不清是谁撞的墙，也容易被当成「解除了就处处生效」。明细在这里只剩会话页
// 的「隔离队列」一栏，本轮用例也搬去了那边。

await check('设置页不再有「今日隔离名单」卡片，那件事只剩会话页那一栏', async () => {
  const real = new Runtime()
  const saved = globalThis.fetch
  globalThis.fetch = async () => payloadResponse(initialState())
  let flat
  try {
    flat = real.text(await real.mount(page({ close() {}, t: (key) => String(dictZh[key] ?? key) })))
  } finally {
    globalThis.fetch = saved
  }
  assert.equal(flat.includes('今日隔离名单'), false, '名单卡片应当已经撤掉')
  assert.equal(flat.includes('解除今日隔离'), false, '解除按钮也不该在设置页')
  assert.ok(flat.includes('今日隔离'), '「今日状态」那一格还在，只是只剩个数')
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
    templates: [
      {
        id: 'default',
        name: '默认模板',
        order: [
          { provider: 'alpha', model: 'one', reasoningEffort: 'high' },
          { provider: 'beta', model: 'one' },
          { provider: 'gamma', model: 'two' },
        ],
      },
      { id: 'spare', name: '备用模板', order: [] },
    ],
  }, '档位只落在被改的那一项上，顺序原样带上；两个模板整份写回去')

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
  assert.equal('reasoningEffort' in body.templates[0].order[0], false, '「默认档位」= 不发这个字段，用模型平时的档位')
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
    templates: [
      {
        id: 'default',
        name: '默认模板',
        order: [
          { provider: 'beta', model: 'one' },
          { provider: 'alpha', model: 'one' },
          { provider: 'gamma', model: 'two' },
        ],
      },
      { id: 'spare', name: '备用模板', order: [] },
    ],
  })
  assert.deepEqual(current.settings.templates[0].order.map((row) => row.provider), ['beta', 'alpha', 'gamma'])
})

await check('✕ 把这一行移出队列', async () => {
  const before = requests.length
  // 模板行上也有一个 ✕（删模板），所以按 data-role 认按钮，不能只看字形。
  const remove = runtime.nodes.find((node) => node.props['data-role'] === 'queue-remove' && node.props.disabled !== true)
  assert.ok(remove !== undefined, '队列行上应该有可用的移出按钮')
  await remove.props.onClick()
  await runtime.mount(page(props))

  const posts = requests.slice(before).filter((row) => row.method === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].body.templates[0].order.map((row) => row.provider), ['alpha', 'gamma'])
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

await check('按会话解除隔离的事件写明是哪个会话，全局解除仍是老文案', async () => {
  const fresh = new Runtime()
  const saved = globalThis.fetch
  const state = initialState()
  state.events = [
    { at: Date.now(), kind: 'reset', cleared: 2, sessionId: 'sess-a556ae8f', day: '2026-11-27' },
    { at: Date.now() - 1000, kind: 'reset', cleared: 5, day: '2026-11-27' },
  ]
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(state) })
  let flat
  try {
    flat = fresh.text(await fresh.mount(page(props)))
  } finally {
    globalThis.fetch = saved
  }
  assert.ok(flat.includes('evResetSession'), `带会话号的解除要走专属文案，实际：${flat.slice(-260)}`)
  assert.ok(flat.includes('evReset'), '全局解除那条照旧')
  const zh = dictionaries.get('settings.modelFailover').zh
  assert.ok(zh.evResetSession.includes('{session}') && zh.evResetSession.includes('{count}'), '文案要留出会话号与条数')
  assert.ok(dictionaries.get('settings.modelFailover').en.evResetSession.length > 0, '英文文案不能缺')
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


// ── 队列行上的红绿数字 ─────────────────────────────────────────────────────

await check('队列行前显示今日失败/成功次数：宿主没给就写 0，不显示 undefined', () => {
  const tallies = runtime.nodes.filter((node) => node.props?.className === 'mf-tally')
  assert.ok(tallies.length > 0, '队列里每行模型都该有一组数字')
  const texts = tallies.map((node) => [].concat(node.props.children ?? []).map((child) => String(child?.props?.children ?? '')).join('/'))
  for (const text of texts) {
    assert.match(text, /^\d+\/\d+$/, `红/绿两个数都要有，实际是 ${text}`)
    assert.equal(text.includes('undefined'), false, '宿主没给计数时写 0，不是 undefined')
  }
  // alpha 今天的账是 0 失败 / 7 成功（见 initialState 的 counts）。
  assert.ok(texts.includes('0/7'), `alpha 那行应显示 0/7，实际 ${JSON.stringify(texts)}`)

  const fail = runtime.nodes.filter((node) => node.props?.className === 'mf-fail')
  const good = runtime.nodes.filter((node) => node.props?.className === 'mf-good')
  assert.equal(fail.length, tallies.length)
  assert.equal(good.length, tallies.length)
  assert.equal(fail[0].props.title, 'failCountHint')
  assert.equal(good[0].props.title, 'goodCountHint')
})

// ── 队列模板 ────────────────────────────────────────────────────────────────

await check('队列模板：一条模板一行，正在编辑的那行标出来，只剩一个时不许删', () => {
  const removes = runtime.nodes.filter((node) => node.props?.['data-role'] === 'template-delete')
  assert.equal(removes.length, 2, `一条模板一个删除按钮，实际 ${removes.length}`)

  const inputs = runtime.nodes.filter((node) => node.props?.['data-name'] === 'templateName')
  assert.deepEqual(inputs.map((node) => node.props.value), ['默认模板', '备用模板'], '名字就是模板名')
  assert.deepEqual(inputs.map((node) => node.props.disabled), [false, false])

  const edits = runtime.nodes.filter((node) => node.props?.['data-role'] === 'template-select')
  assert.equal(edits.length, 2)
  assert.equal(edits[0].props.disabled, true, '正在编辑的那个不用再点')
  assert.equal(edits[0].text, 'templateEditing')
  assert.equal(edits[1].props.disabled, false, '另一个可以切过去')
  assert.equal(edits[1].text, 'templateEdit')

  const remove = runtime.nodes.filter((node) => node.props?.['data-role'] === 'template-delete')
  assert.deepEqual(remove.map((node) => node.props.disabled), [false, false], '两个模板时可以删')
  assert.equal(remove[0].props.title, 'templateDelete')
})

await check('队列模板：改名字只在失焦时提交，且只提交这一条的 order', async () => {
  const before = requests.length
  const input = runtime.nodes.filter((node) => node.props?.['data-name'] === 'templateName')[0]
  // 边打字边提交会把「默认模」这种半截名字写进设置里，所以只在失焦/回车时发。
  await input.props.onChange({ target: { value: '主力' } })
  await runtime.mount(page(props))
  assert.equal(requests.slice(before).filter((row) => row.method === 'POST').length, 0, '打字时不提交')

  const again = runtime.nodes.filter((node) => node.props?.['data-name'] === 'templateName')[0]
  await again.props.onBlur()
  await runtime.mount(page(props))

  const posts = requests.slice(before).filter((row) => row.method === 'POST')
  assert.equal(posts.length, 1, '失焦后应只发一个 POST')
  const body = posts[0].body
  assert.equal(body.templates[0].name, '主力', '名字改了')
  assert.equal(body.templates[1].name, '备用模板', '别的模板原样带回去')
  assert.equal(body.templates[1].order.length, 0, '别的模板的队列不该被动')
  assert.equal(body.editedTemplate, undefined, '改名不该顺手切换正在编辑的模板')
})

await check('队列模板：切到另一个模板，队列卡换成它的 queue，队列为空也不报错', async () => {
  const before = requests.length
  const target = runtime.nodes.filter((node) => node.props?.['data-role'] === 'template-select' && node.props.disabled !== true)[0]
  await target.props.onClick()
  await runtime.mount(page(props))

  const posts = requests.slice(before).filter((row) => row.method === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].body, { editedTemplate: 'spare' })
})

await check('队列模板：新建模板给一个新 id 并自动切过去', async () => {
  const before = requests.length
  const add = runtime.nodes.filter((node) => node.props?.['data-role'] === 'template-add')[0]
  assert.equal(add.props.disabled, false, '两个模板远没到上限')
  await add.props.onClick()
  await runtime.mount(page(props))

  const posts = requests.slice(before).filter((row) => row.method === 'POST')
  assert.equal(posts.length, 1, '新建应该一次写清：新数组 + 新的编辑目标')
  const body = posts[0].body
  assert.equal(Array.isArray(body.templates), true)
  assert.equal(body.templates.length, 3, '原来两条 + 新建一条')
  const created = body.templates[2]
  assert.match(created.id, /^[A-Za-z0-9_-]{1,32}$/, `id 要能被宿主接受，实际是 ${created.id}`)
  // 字典在测试里是 key 回声，所以名字长这样；真实界面是「新模板 3」。
  assert.match(created.name, /^templateNewName \d+$/, `实际是 ${created.name}`)
  assert.deepEqual(created.order, [])
  assert.equal(body.editedTemplate, created.id, '建完自动切过去')
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
