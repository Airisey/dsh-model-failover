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
    autoContinueLimit: 3,
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
    { key: KEY('beta', 'one'), provider: 'beta', model: 'one', code: 'QUOTA', message: '余额不足', at: at - 60_000, label: 'Code99 · Beta One' },
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

  assert.equal(sections.length, 1)
  assert.equal(sections[0].slot, 'settings.section')
  assert.equal(sections[0].definition.name, 'settings.section')
  assert.equal(sections[0].definition.id, 'model-failover')
  assert.equal(typeof sections[0].definition.order, 'number')
  assert.equal(sections[0].definition.locale, 'settings.modelFailover')
  assert.equal(typeof sections[0].definition.label, 'function')
  assert.equal(typeof sections[0].definition.label(), 'string')
  assert.equal(typeof sections[0].component, 'function')
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
      for (const key of ['enabled', 'retrySameModelOnce', 'continueText', 'resetHour', 'keepEventLog', 'eventLogLimit', 'retryWhenAllQuarantined', 'autoContinue', 'autoContinueOnFailure', 'autoContinueOnMaxTokens', 'autoContinueLimit']) {
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

await check('自动「继续」：三个开关 + 次数上限都在，且反映宿主设置', () => {
  const toggle = (label) => runtime.find((node) => node.props['aria-label'] === label)
  for (const label of ['optAutoContinue', 'optAutoOnFailure', 'optAutoOnMaxTokens']) {
    assert.equal(toggle(label).props['aria-pressed'], 'true', `${label} 应反映当前设置`)
    assert.equal(toggle(label).props.disabled, false, `${label} 在总开关打开时应可点`)
  }
  const limit = runtime.find(
    (node) => node.tag === 'input' && node.props.min === 1 && node.props.max === 20,
  )
  assert.equal(limit.props.value, '3', '次数上限应显示宿主的值')
})

await check('自动「继续」总开关关掉后，两个分项和次数上限一起置灰', async () => {
  const before = requests.length
  await runtime.find((node) => node.props['aria-label'] === 'optAutoContinue').props.onClick()
  await runtime.mount(page(props))

  const posts = requests.slice(before).filter((row) => row.method === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].body, { autoContinue: false })

  const toggle = (label) => runtime.find((node) => node.props['aria-label'] === label)
  assert.equal(toggle('optAutoOnFailure').props.disabled, true, '总开关关了，分项没意义')
  assert.equal(toggle('optAutoOnMaxTokens').props.disabled, true)
  const limit = runtime.find(
    (node) => node.tag === 'input' && node.props.min === 1 && node.props.max === 20,
  )
  assert.equal(limit.props.disabled, true)

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

await check('次数上限失焦后 POST autoContinueLimit，超范围夹到 1-20', async () => {
  const limitInput = () => runtime.find(
    (node) => node.tag === 'input' && node.props.min === 1 && node.props.max === 20,
  )
  const before = requests.length
  limitInput().props.onChange({ target: { value: '99' } })
  await runtime.mount(page(props))
  assert.equal(limitInput().props.value, '99', '输入框应保留用户敲进去的草稿')
  limitInput().props.onBlur()
  await runtime.mount(page(props))

  const posts = requests.slice(before).filter((row) => row.method === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].body, { autoContinueLimit: 20 })
  assert.equal(current.settings.autoContinueLimit, 20)
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
