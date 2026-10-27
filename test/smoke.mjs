/**
 * 模型接力 · 冒烟测试。
 *
 * 用假的 `ctx.llm` 跑真实的适配器代码，覆盖需求里的每一条行为：
 *   1. 第一个模型额度耗尽 → 先用它重发一次「继续」；
 *   2. 还是不行 → 切到下一个模型（并带上「继续」）直到任务跑完；
 *   3. 当天出过问题的模型，后面的任务不再从它开始；
 *   4. 跨过设定的重置时间后，重新从第一个模型开始尝试；
 *   5. 已经吐给用户的内容不会被换模型抹掉，也不会把两个模型的文字拼在一起。
 *
 * 顺带把宿主半身（index.js）的设置接口用假的 webServer 打一遍。
 *
 * 跑法：node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须早于任何 import —— store.js 的 dataDir() 读的是这个环境变量。
const HOME = mkdtempSync(join(tmpdir(), 'model-failover-test-'))
process.env.DSH_HOME = HOME

const { FailoverAdapter } = await import('../lib/adapter.js')
const { Catalog } = await import('../lib/catalog.js')
const { DailyHealth, normalizeState } = await import('../lib/health.js')
const { JsonFile } = await import('../lib/store.js')
const { DEFAULT_SETTINGS, ROUTE, routeKey } = await import('../lib/constants.js')
const { TurnNotes } = await import('../lib/notes.js')

// ── 假的宿主 ────────────────────────────────────────────────────────────────

/** 一段脚本化的模型行为。 */
const ok = (text) => async function* () {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

const quota = () => async function* () {
  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'insufficient balance' } } }
}

/** 想了一分钟才撞上额度墙 —— 最值得静默切换的情形。 */
const quotaAfterReasoning = () => async function* () {
  yield { type: 'reasoning-delta', index: 0, text: '让我想想' }
  yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: '让我想想' } }
  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'insufficient balance' } } }
}

/** 已经吐了半句才失败 —— 此时换模型会把两段文字拼起来，绝不能换。 */
const partialThenFail = () => async function* () {
  yield { type: 'text-delta', index: 0, text: '半句话' }
  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'insufficient balance' } } }
}

const aborted = () => async function* () {
  yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: '用户按了停止' } } }
}
const contextTooLong = () => async function* () {
  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: '上下文超长' } } }
}
const noAdapter = () => async function* () {
  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: '这条路由没挂适配器' } } }
}

/** 写到一半撞上输出上限：吐了正文，但 finish 是 max-tokens。 */
const truncated = (text = '写到一半') => async function* () {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'max-tokens' } }
}

/**
 * 一个字都没吐就撞上上限 —— 线上 13 条 `NO_VISIBLE_OUTPUT` 隔离全是这一种。
 *
 * 逐字对应 `lib/adapter.js` 里 `failureOf()` 合成的那句
 * 「模型以 max-tokens 结束，但整轮没有产出任何可见内容。」
 */
const truncatedSilent = () => async function* () {
  yield { type: 'finish', reason: { kind: 'max-tokens' } }
}

/**
 * 只想不写就撞上上限 —— 最容易触发同一个 bug 的真实形态。
 *
 * reasoning 的 `block-end` **不算**提交（见 `commitsAnswer`），所以整轮依然
 * 「没有可见内容」，会走进同一个 `NO_VISIBLE_OUTPUT` 分支。
 */
const truncatedAfterReasoning = () => async function* () {
  yield { type: 'reasoning-delta', index: 0, text: '让我想想' }
  yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: '让我想想' } }
  yield { type: 'finish', reason: { kind: 'max-tokens' } }
}

/** 本机 DNS 挂了 —— 逐字抄自 2026-10-14 的真实事件日志（code 是 SERVER）。 */
const localNetwork = () => async function* () {
  yield {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        code: 'SERVER',
        message: 'workbuddy: cannot resolve tunnel destination www.workbuddy.ai (ENOTFOUND): local name resolution failed',
      },
    },
  }
}

/** 链路层错误码，message 里什么都没说（模拟只给 code 的适配器）。 */
const transportFail = () => async function* () {
  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'trae: transport error' } } }
}

/** 远端 5xx：不是本机网络问题，该照常带「继续」重试。 */
const upstream5xx = () => async function* () {
  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'upstream returned 502 Bad Gateway' } } }
}

/**
 * 每个模型自己的思考强度档位表（真实宿主里由 `resolveModelInfo` 给出）。
 *
 * 刻意让各家不一样：alpha/one 只认 low/high，beta/one 只认 minimal/high，
 * beta/two 压根不支持档位 —— 这样才能验证「按各候选自己的表过滤」。
 * 没列在这里的模型 = `resolveModelInfo` 不返回 reasoning。
 */
const EFFORTS = new Map([
  [routeKey('alpha', 'one'), [{ id: 'low', name: '低' }, { id: 'high', name: '高' }]],
  [routeKey('beta', 'one'), [{ id: 'minimal', name: '最小' }, { id: 'high', name: '高' }]],
])

/**
 * 一个只实现本插件用到的那几个方法的假 llm 服务。
 * @param {Map<string, () => AsyncGenerator<any>>} scripts - routeKey -> 脚本
 */
function createLlm(scripts) {
  const routes = []
  const catalog = new Map()
  const calls = []
  return {
    calls,
    register(provider, models) {
      routes.push({ id: provider, name: `路由 ${provider}` })
      catalog.set(provider, models)
    },
    listProviders: () => routes,
    async listModels(provider) {
      return catalog.get(provider) ?? []
    },
    async resolveModelInfo(provider, model) {
      const info = { provider, id: model, name: model, context: { contextWindow: 8192 } }
      const efforts = EFFORTS.get(routeKey(provider, model))
      if (efforts !== undefined) info.reasoning = { efforts, defaultEffort: efforts[0].id }
      return info
    },
    stream(options) {
      const key = routeKey(options.provider, options.model)
      calls.push({
        key,
        messages: options.messages,
        // 记下来是为了盯「试连接」的花销：那边必须把输出上限压到个位数。
        maxTokens: options.maxTokens,
        // `hadEffort` 区分「没带这个字段」和「带了个 undefined」—— 后者会顺着
        // 展开把上一轮的档位漏给别的模型，是要专门防住的那种。
        effort: options.reasoningEffort,
        hadEffort: Object.prototype.hasOwnProperty.call(options, 'reasoningEffort'),
      })
      const script = scripts.get(key)
      return (async function* () {
        if (script === undefined) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: `没有为 ${key} 准备脚本` } } }
          return
        }
        yield* script(options)
      })()
    },
  }
}

/**
 * 搭一套真实适配器 + 假宿主。
 *
 * @param {object} spec
 * @param {Array<{provider: string, model: string}>} spec.order
 * @param {Map<string, () => AsyncGenerator<any>>} spec.scripts
 * @param {object} [spec.settings]
 * @param {number} [spec.at] - 初始「现在」。
 * @param {object} [spec.cacheFile] - 扫描缓存落盘用的 JsonFile（验跨启动延续时才给）。
 */
async function harness({ order, scripts, settings: overrides = {}, at = new Date(2026, 1, 14, 6, 0, 0).getTime(), cacheFile }) {
  const llm = createLlm(scripts)
  llm.register('alpha', [{ id: 'one', name: 'Alpha One' }, { id: 'two', name: 'Alpha Two' }])
  llm.register('beta', [{ id: 'one', name: 'Beta One' }, { id: 'two', name: 'Beta Two' }])
  // 插件自己的路由必须在清单里出现 —— 用来验证它会被排除，不会自我递归。
  llm.register(ROUTE, [{ id: 'auto', name: '自动接力' }])

  const clock = { ms: at }
  const settings = new JsonFile(join(HOME, `settings-${Math.random().toString(36).slice(2)}.json`), undefined,
    (raw) => ({ ...DEFAULT_SETTINGS, ...(raw !== null && typeof raw === 'object' ? raw : {}) }))
  // 测试里只关心「一条队列」，所以 order 在这里包成默认模板 —— 省得几十个
  // 用例都要写一遍模板对象。要验多模板时传 settings.templates 覆盖。
  const templates = Array.isArray(overrides.templates)
    ? overrides.templates
    : [{ id: 'default', name: '默认模板', order }]
  settings.replace({
    ...DEFAULT_SETTINGS,
    ...overrides,
    templates,
    editedTemplate: overrides.editedTemplate ?? templates[0].id,
  })

  const health = new DailyHealth(
    new JsonFile(join(HOME, `state-${Math.random().toString(36).slice(2)}.json`), undefined, normalizeState),
  )

  const catalog = new Catalog({ llm, hiddenProviders: () => [], logger: {}, cacheFile })
  await catalog.refresh()
  await catalog.fillModelFacts()

  const events = []
  // 真的等 5 秒会让整套测试慢得没法跑；记下每次等待的时长，立刻返回。
  const waits = []
  const notes = new TurnNotes()
  const adapter = new FailoverAdapter({
    llm,
    settings,
    health,
    catalog,
    notes,
    log: { warn: () => {}, push: (event) => events.push(event) },
    now: () => clock.ms,
    sleep: async (ms) => { waits.push(ms) },
  })

  return { llm, clock, settings, health, catalog, adapter, notes, events, waits }
}

/** 收集整条流。 */
async function drain(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
const finishOf = (chunks) => chunks.find((c) => c.type === 'finish')
const commands = (llm) => llm.calls.map((call) => call.key)
/** 一条最简的用户消息。 */
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
/** 一条消息里最后那段文本 —— 用来确认「继续」有没有真的发出去。 */
const lastUserText = (messages) => {
  const last = messages.at(-1)
  if (last === undefined) return ''
  if (typeof last.content === 'string') return last.content
  return last.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
}

// ── 测试 ────────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    const head = String(error?.stack ?? error).split('\n').slice(0, 12).join('\n      ')
    console.error(`  ✗ ${name}\n      ${head}`)
  }
}

console.log('模型接力 · 冒烟测试\n')

// 1 · 额度耗尽 → 重发「继续」→ 还是不行 → 切下一个 → 直到成功
await check('第一个模型额度耗尽：先重发「继续」，再切下一个，直到跑完', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }, { provider: 'beta', model: 'two' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), quota()],
      [routeKey('beta', 'one'), quota()],
      [routeKey('beta', 'two'), ok('跑完了')],
    ]),
  })

  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [{ role: 'user', content: [{ type: 'text', text: '帮我写个脚本' }] }] }))

  assert.equal(textOf(chunks), '跑完了', '最终应由第三个模型产出内容')
  assert.equal(finishOf(chunks)?.reason?.kind, 'stop', '结局应该是正常结束')

  // 调用序列：alpha/one 三次（首发 + 两次原样重发），beta/one 三次，beta/two 一次。
  assert.deepEqual(commands(h.llm), [
    routeKey('alpha', 'one'), routeKey('alpha', 'one'), routeKey('alpha', 'one'),
    routeKey('beta', 'one'), routeKey('beta', 'one'), routeKey('beta', 'one'),
    routeKey('beta', 'two'),
  ], '每个候选先原样试满 1+重试次数 次，第几个模型就带几条「继续」')

  // 「继续」确实进了消息，而不是只改了 provider/model。
  const betaCalls = h.llm.calls.filter((call) => call.key === routeKey('beta', 'one'))
  const countContinues = (call) => call.messages.filter((m) => m.role === 'user' && m.content?.[0]?.text === '继续').length
  assert.equal(countContinues(betaCalls[0]), 1, '切到第二个模型时应带上一条「继续」')
  assert.equal(countContinues(betaCalls[1]), 1, '同一模型的换账号重发要原样重发，不能越攒越多')
  const alphaCalls = h.llm.calls.filter((call) => call.key === routeKey('alpha', 'one'))
  assert.equal(countContinues(alphaCalls[2]), 0, '队首的重发不带「继续」')

  // 隔离与「已验证可用」
  const view = h.health.view(h.clock.ms, 1)
  assert.deepEqual(view.quarantined.map((row) => row.key).sort(), [routeKey('alpha', 'one'), routeKey('beta', 'one')].sort(), '两个坏模型应被隔离')
  assert.deepEqual(view.good.map((row) => row.key), [routeKey('beta', 'two')], '成功的模型应记为已验证可用')
})

// 2 · 扣住的内容在失败时整根丢掉
await check('失败前只有 reasoning：切模型，且不泄露上一轮的思考', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'two' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), quotaAfterReasoning()],
      [routeKey('beta', 'two'), ok('答案是 42')],
    ]),
  })

  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))

  assert.equal(textOf(chunks), '答案是 42')
  assert.equal(chunks.some((c) => c.type === 'reasoning-delta'), false, '上一轮的思考不该出现')
  assert.equal(chunks.some((c) => c.type === 'block-end' && c.block?.type === 'reasoning'), false)
})

// 3 · 已经吐给用户的内容 = 提交点，此后不再换模型
await check('已经吐给用户的半句话：原样交出，不切换、不隔离', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'two' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), partialThenFail()],
      [routeKey('beta', 'two'), ok('不该出现')],
    ]),
  })

  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))

  assert.equal(textOf(chunks), '半句话', '已提交的内容必须原样留在流里')
  assert.equal(finishOf(chunks)?.reason?.kind, 'error', '真实失败要交回调用方')
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one')], '提交以后不该再碰其它模型')
  assert.equal(h.health.view(h.clock.ms, 1).quarantined.length, 0, '提交过的模型不算坏')
})

// 4 · 用户中止 与 上下文超长 不换模型
await check('用户中止：原样交回，不切换', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'two' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), aborted()],
      [routeKey('beta', 'two'), ok('不该出现')],
    ]),
  })
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.equal(finishOf(chunks)?.reason?.kind, 'aborted')
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one')])
  assert.equal(h.health.view(h.clock.ms, 1).quarantined.length, 0)
})

await check('撞上限的同时用户按了停止：结局原样交回，不隔离也不换人', async () => {
  // 用户按停止的那一刻，适配器看到的 finish 完全可能正好是 max-tokens。
  // 这一跳必须原样收手：既不能当成「模型坏了」隔离掉，也不能换人去补。
  //
  // 注意这里**故意不吐任何可见内容** —— 吐了的话 `commitsAnswer` 会先把它判成
  // 「已提交」，测的就是另一条路径了（那样测不出任何东西）。
  const controller = new AbortController()
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'two' }],
    scripts: new Map([
      // 直接写成生成器函数（createLlm 会调 `script(options)`），不要写成
      // `() => async function* () {}` —— 那样交出去的是函数本身，不是生成器对象。
      [routeKey('alpha', 'one'), async function* () {
        controller.abort()
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
      }],
      [routeKey('beta', 'two'), ok('不该出现')],
    ]),
  })
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [], signal: controller.signal }))
  assert.equal(finishOf(chunks)?.reason?.kind, 'max-tokens', '结局要原样交回')
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one')], '中止了就不该再换人')
  assert.equal(h.health.view(h.clock.ms, 1).quarantined.length, 0, '撞上限不是「模型坏了」')
})

await check('上下文超长：交给 agent loop 去压缩，不切换', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'two' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), contextTooLong()],
      [routeKey('beta', 'two'), ok('不该出现')],
    ]),
  })
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.equal(finishOf(chunks)?.reason?.failure?.code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one')])
  assert.equal(h.health.view(h.clock.ms, 1).quarantined.length, 0)
})

// 5 · 当天隔离对后续任务生效
await check('当天隔离：下一个任务不再从坏模型开始', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'alpha', model: 'two' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), quota()],
      [routeKey('alpha', 'two'), quota()],
      [routeKey('beta', 'one'), ok('第二个任务')],
    ]),
  })

  await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.deepEqual(commands(h.llm).slice(-1), [routeKey('beta', 'one')])

  // 第二个任务：两个坏模型应该被直接跳过。
  h.llm.calls.length = 0
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.equal(textOf(chunks), '第二个任务')
  assert.deepEqual(commands(h.llm), [routeKey('beta', 'one')], '第二个任务应直接从已验证可用的模型起步')
})

// 5b · 失败一次、原样重发就写完：不算「今天不行」
await check('失败一次就原样重发：不隔离，并记成已验证可用', async () => {
  let turn = 0
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), (options) => (++turn === 1 ? quota()(options) : ok('补上后半句')(options))],
      [routeKey('beta', 'one'), ok('不该轮到我')],
    ]),
  })

  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [user('帮我写个脚本')] }))
  assert.equal(textOf(chunks), '补上后半句')
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one'), routeKey('alpha', 'one')], '这句重发不该把人换掉')
  assert.deepEqual(h.llm.calls[1].messages, h.llm.calls[0].messages, '重发必须与首发一模一样，多账号反代靠这个换账号')
  assert.equal(lastUserText(h.llm.calls.at(-1).messages), '帮我写个脚本', '重发不带「继续」—— 新账号没写过东西')

  const view = h.health.view(h.clock.ms, 1)
  assert.equal(view.quarantined.length, 0, '它产出内容了，不算今天出不了东西')
  assert.deepEqual(view.good.map((row) => row.key), [routeKey('alpha', 'one')], '应该记成当天已验证可用')
})

// 5d · 隔离按会话算：甲会话撞的墙，不该让乙会话跟着绕开
await check('隔离按会话分开：甲会话撞的墙，乙会话照样从队首开始', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), quota()],
      [routeKey('beta', 'one'), ok('乙会话的答案')],
    ]),
  })

  // 甲会话：alpha 撞墙 → 隔离 → 换到 beta。
  const first = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [], sessionId: 'sess-a' }))
  assert.equal(textOf(first), '乙会话的答案')
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one'), routeKey('alpha', 'one'), routeKey('alpha', 'one'), routeKey('beta', 'one')])

  // 乙会话：alpha 在甲那边坏了，但这边照旧从它开始试。
  h.llm.calls.length = 0
  await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [], sessionId: 'sess-b' }))
  assert.equal(commands(h.llm)[0], routeKey('alpha', 'one'), '别的会话不该被甲的隔离牵连')

  // 甲会话的下一个任务：alpha 被跳过。
  h.llm.calls.length = 0
  await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [], sessionId: 'sess-a' }))
  assert.deepEqual(commands(h.llm), [routeKey('beta', 'one')], '自己的会话里它仍然是被隔离的')

  const view = h.health.view(h.clock.ms, 1)
  assert.deepEqual(view.sessions.map((row) => row.sessionId).sort(), ['sess-a', 'sess-b'])
  const mine = view.sessions.find((row) => row.sessionId === 'sess-a')
  assert.deepEqual(mine.quarantined.map((row) => row.key), [routeKey('alpha', 'one')], '隔离挂在甲会话名下')
  assert.equal(mine.quarantined[0].sessionId, 'sess-a', '平铺列表里也要带会话号')
})

// 5e · 没有 sessionId 的调用（压缩、离线测试）落在同一桶里，互不影响真实的会话
await check('隔离：没有 sessionId 的调用自成一桶，不污染任何会话', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), quota()],
      [routeKey('beta', 'one'), ok('兜底')],
    ]),
  })

  await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  const view = h.health.view(h.clock.ms, 1)
  assert.deepEqual(view.sessions.map((row) => row.sessionId), [''])

  // 真有会话号的下一个任务：不该看到那一桶里的隔离。
  h.llm.calls.length = 0
  await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [], sessionId: 'sess-real' }))
  assert.equal(commands(h.llm)[0], routeKey('alpha', 'one'), '不分会话那一桶不该牵连真实会话')
})

await check('撞输出上限、一个字都没吐：原样交出 max-tokens，且**不隔离**', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), truncatedSilent()],
      [routeKey('beta', 'one'), ok('不该轮到我')],
    ]),
  })

  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [user('写一首诗')] }))
  // 结局必须原样是 max-tokens：agent loop 靠它落 turn/end，轮级的「自动继续」
  // 才认得出这是「还没写完」而不是「这一轮失败了」。
  assert.equal(finishOf(chunks)?.reason?.kind, 'max-tokens', 'finish 必须原样保留 max-tokens')
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one')], '撞上限不是换人的理由')

  const view = h.health.view(h.clock.ms, 1)
  assert.equal(view.quarantined.length, 0, '它在写，只是被截断了 —— 绝不能隔离')
  assert.equal(view.good.length, 0, '没吐出可见内容，也不算「已验证可用」')
})

await check('撞输出上限、只想了没写：同样不隔离（reasoning 的 block-end 不算提交）', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), truncatedAfterReasoning()],
      [routeKey('beta', 'one'), ok('不该轮到我')],
    ]),
  })

  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.equal(finishOf(chunks)?.reason?.kind, 'max-tokens')
  // 扣住的东西要原样放出来，不能把「想了一半」的推理吞掉。
  assert.equal(chunks.filter((c) => c.type === 'reasoning-delta').length, 1, '扣住的推理也要交出去')
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one')])
  assert.equal(h.health.view(h.clock.ms, 1).quarantined.length, 0)
})

await check('撞输出上限之后，下一个任务仍然从原来那个模型开始', async () => {
  // 这条是用户报的那个现象的直接回归：一旦被隔离，下一轮接力就从别人开始了，
  // 「用原模型补『继续』」再也无从谈起。
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), truncatedSilent()],
      [routeKey('beta', 'one'), ok('不该轮到我')],
    ]),
  })

  await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.equal(h.health.view(h.clock.ms, 1).quarantined.length, 0)

  // 第二个任务：队列的头仍然是 alpha。
  h.llm.calls.length = 0
  const second = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [user('第二个任务')] }))
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one')], '第二个任务必须还从 alpha 开始')
  assert.equal(finishOf(second)?.reason?.kind, 'max-tokens')
})

// 5b · 同一个模型**连着**撞上限 → 换队列里的下一个
//
// 用户报的现象：「输出撞到上限时，一直重复试验一个模型，不切换下一个模型」。
// 撞上限本身不是「模型坏了」，所以第一次照旧让它接着写；连着撞就说明它在这个
// 任务上写不完，该换人了。
const ceilingOpts = (sessionId) => ({ provider: ROUTE, model: 'auto', messages: [user('写一篇长的')], sessionId })

await check('第一次撞上限仍然用原模型，连着撞到第二次才换人', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), truncatedSilent()],
      [routeKey('beta', 'one'), ok('换我接着写')],
    ]),
  })
  const opts = ceilingOpts('s-rotate')

  // 第 1 轮：撞上限。这是「第一次」，不许换人。
  await drain(h.adapter.stream(opts))
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one')], '第一次撞上限不是换人的理由')

  // 第 2 轮（自动补发的「继续」）：还是 alpha，又撞 —— 账记到 2。
  h.llm.calls.length = 0
  await drain(h.adapter.stream(opts))
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one')], '第一句「继续」仍归原模型')

  // 第 3 轮：连着撞够两次，轮到 beta 接手。
  h.llm.calls.length = 0
  const third = await drain(h.adapter.stream(opts))
  assert.equal(commands(h.llm)[0], routeKey('beta', 'one'), '连着撞到第二次之后该换人了')
  assert.equal(textOf(third), '换我接着写')
  assert.equal(finishOf(third)?.reason?.kind, 'stop', '换了人并且写完了')

  // 「换人」这件事要能在事件日志里看见，否则用户只看到队首被莫名跳过。
  const rows = h.events.filter((event) => event.kind === 'ceiling-rotate')
  assert.equal(rows.length, 1, '攒够次数时记一条，且只记一条')
  assert.equal(rows[0].provider, 'alpha')
  assert.equal(rows[0].model, 'one')
  assert.equal(rows[0].to, 'beta/one')
  assert.equal(rows[0].count, 2)
})

await check('只撞了一次时，日志里不该有「跳过队首」的记录', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), truncatedSilent()],
      [routeKey('beta', 'one'), ok('不该轮到我')],
    ]),
  })
  await drain(h.adapter.stream(ceilingOpts('s-once')))
  assert.equal(h.events.filter((event) => event.kind === 'ceiling-rotate').length, 0)
})

await check('正常写完一轮就把撞上限的账清掉，下一个任务重新从队首数', async () => {
  const scripts = new Map([
    [routeKey('alpha', 'one'), truncatedSilent()],
    [routeKey('beta', 'one'), ok('不该轮到我')],
  ])
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts,
  })
  const opts = ceilingOpts('s-clear')

  await drain(h.adapter.stream(opts)) // 账 = 1
  scripts.set(routeKey('alpha', 'one'), ok('这一轮写完了'))
  await drain(h.adapter.stream(opts)) // 正常提交 → 账清空
  scripts.set(routeKey('alpha', 'one'), truncatedSilent())

  h.llm.calls.length = 0
  await drain(h.adapter.stream(opts))
  // 账要是没清，这里就已经攒到 3、该轮 beta 了。
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one')], '写完一轮之后重新从 1 开始数')
})

await check('连着撞就往前挪一格：每个模型试两次，然后轮到下一个', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), truncatedSilent()],
      [routeKey('beta', 'one'), truncatedSilent()],
    ]),
  })
  const opts = ceilingOpts('s-rotate-round')

  // 账按会话累加而不是按模型 —— 否则换到 beta 之后再撞一次就会「重置」，
  // 下一轮又回到 alpha，在两个模型之间来回打转。
  const picks = []
  for (let round = 0; round < 5; round += 1) {
    h.llm.calls.length = 0
    await drain(h.adapter.stream(opts))
    picks.push(commands(h.llm)[0])
  }
  assert.deepEqual(
    picks,
    [
      routeKey('alpha', 'one'),
      routeKey('alpha', 'one'),
      routeKey('beta', 'one'),
      routeKey('beta', 'one'),
      routeKey('alpha', 'one'),
    ],
    '每个模型连着试两次就该轮到下一个，转完一圈从头接上',
  )
})

await check('压缩会话 / 起标题这类内部调用不参与撞上限的账', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), truncatedSilent()],
      [routeKey('beta', 'one'), ok('不该轮到我')],
    ]),
  })
  const opts = { ...ceilingOpts('s-purpose'), purpose: 'session-title' }

  // 连着两次内部调用都撞上限：它们共用 sessionId，却和用户看到的这一轮无关。
  await drain(h.adapter.stream(opts))
  await drain(h.adapter.stream(opts))

  h.llm.calls.length = 0
  await drain(h.adapter.stream(ceilingOpts('s-purpose')))
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one')], '内部调用不该替用户把账记上')
})

await check('没有 sessionId 就不记账：宁可死磕一个模型，也不能把账算到别人头上', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), truncatedSilent()],
      [routeKey('beta', 'one'), ok('不该轮到我')],
    ]),
  })
  const opts = { provider: ROUTE, model: 'auto', messages: [user('写一篇长的')] }

  await drain(h.adapter.stream(opts))
  await drain(h.adapter.stream(opts))
  h.llm.calls.length = 0
  await drain(h.adapter.stream(opts))
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one')])
  assert.equal(h.adapter.ceiling.size, 0)
})

await check('队列里只剩一个候选时无处可换：不轮换，也不记假的换人日志', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    settings: { enabled: false },
    scripts: new Map([
      [routeKey('alpha', 'one'), truncatedSilent()],
      [routeKey('beta', 'one'), ok('不该轮到我')],
    ]),
  })
  const opts = ceilingOpts('s-single')
  await drain(h.adapter.stream(opts))
  await drain(h.adapter.stream(opts))
  h.llm.calls.length = 0
  await drain(h.adapter.stream(opts))
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one')], '总开关关掉时永远用队首')
  assert.equal(h.events.filter((event) => event.kind === 'ceiling-rotate').length, 0, '换不成人就不该写日志')
})

// 5c · 本机网络没通时不带「继续」
await check('本机网络故障：重试与换人都不带「继续」（网线没通，继续是空话）', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), localNetwork()],
      [routeKey('beta', 'one'), ok('网络回魂了')],
    ]),
  })

  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [user('写一首诗')] }))
  assert.equal(textOf(chunks), '网络回魂了')

  // 本机网络挂掉时，alpha 的两跳都不该带「继续」；换到 beta 也不该带。
  for (const call of h.llm.calls) {
    assert.equal(
      lastUserText(call.messages),
      '写一首诗',
      `${call.key} 不该带「继续」，实际最后一条是：${lastUserText(call.messages)}`,
    )
    assert.equal(call.messages.length, 1, `${call.key} 不该往请求里追加消息`)
  }
})

await check('链路层错误码（TRANSPORT）：同样不带「继续」', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), transportFail()],
      [routeKey('beta', 'one'), ok('好了')],
    ]),
  })

  await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [user('写一首诗')] }))
  for (const call of h.llm.calls) {
    assert.equal(lastUserText(call.messages), '写一首诗', `${call.key} 不该带「继续」`)
  }
})

await check('远端 5xx 照旧会被重试 —— 网络判据不能把该救的失败一起摁掉', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), upstream5xx()],
      [routeKey('beta', 'one'), ok('顶上了')],
    ]),
  })

  await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [user('写一首诗')] }))
  assert.deepEqual(commands(h.llm), [
    routeKey('alpha', 'one'),
    routeKey('alpha', 'one'),
    routeKey('alpha', 'one'),
    routeKey('beta', 'one'),
  ], '远端 5xx 仍应走「先原样重发，再换人」')

  // 同模型重发不带「继续」；换到第二个模型才带。
  assert.equal(lastUserText(h.llm.calls[1].messages), '写一首诗', '换账号重发要原样')
  assert.equal(lastUserText(h.llm.calls[3].messages), '继续', '换人这一跳才带「继续」')
})

await check('本机网络故障仍会隔离 —— 隔离语义没被这次改动动过', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), localNetwork()],
      [routeKey('beta', 'one'), ok('顶上')],
    ]),
  })

  await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [user('写一首诗')] }))
  const view = h.health.view(h.clock.ms, 1)
  assert.deepEqual(view.quarantined.map((row) => row.key), [routeKey('alpha', 'one')], '本机网络挂掉确实产不出东西，该隔离')
  // 隔离日志里的 continues 应该是 0 —— 它如实记录了「这一跳没带继续」。
  const row = h.events.find((event) => event.kind === 'quarantine')
  assert.equal(row.continues, 0, '日志要如实反映没带「继续」')
  assert.equal(row.code, 'SERVER')
})

// 6 · 跨过重置时间后复活
await check('跨过设定的重置时间：重新从第一个模型开始尝试', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), quota()],
      [routeKey('beta', 'one'), ok('今天的活')],
    ]),
  })

  await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.equal(h.health.view(h.clock.ms, 1).quarantined.length, 1)

  // 次日 00:30 —— 还没到 1 点，仍然算「今天」。
  h.clock.ms = new Date(2026, 1, 15, 0, 30, 0).getTime()
  h.llm.calls.length = 0
  await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.deepEqual(commands(h.llm), [routeKey('beta', 'one')], '重置时间之前隔离仍然有效')

  // 次日 01:05 —— 新的一天，坏模型复活。
  h.clock.ms = new Date(2026, 1, 15, 1, 5, 0).getTime()
  h.llm.calls.length = 0
  await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one'), routeKey('alpha', 'one'), routeKey('alpha', 'one'), routeKey('beta', 'one')],
    '过了重置时间应重新从第一个模型开始')
})

// 7 · 队列耗尽
await check('全部被隔离且不允许硬试：直接报错，不再打扰上游', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }],
    settings: { retryWhenAllQuarantined: false },
    scripts: new Map([[routeKey('alpha', 'one'), quota()]]),
  })

  await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  h.llm.calls.length = 0
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.equal(finishOf(chunks)?.reason?.failure?.code, 'NO_CANDIDATES')
  assert.deepEqual(commands(h.llm), [], '不允许硬试时一个上游请求都不该发')
})

await check('空队列：给出可操作的报错', async () => {
  const h = await harness({ order: [], scripts: new Map() })
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.equal(finishOf(chunks)?.reason?.failure?.code, 'NO_CANDIDATES')
  assert.match(finishOf(chunks)?.reason?.failure?.message ?? '', /还是空的/)
})

// 8 · 把同模型重试次数设成 0
await check('重试次数设 0：每换个模型只试一次', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    settings: { sameModelRetries: 0 },
    scripts: new Map([[routeKey('alpha', 'one'), quota()], [routeKey('beta', 'one'), ok('好')]]),
  })
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.equal(textOf(chunks), '好')
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one'), routeKey('beta', 'one')])
})

// 8.5 · 卡住超时：太久没有输出就当失败，换人
await check('卡住超时：连着设定的秒数一个字都不吐，就当失败换人', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    settings: { idleTimeoutSec: 1, sameModelRetries: 0 },
    // 挂着不回：既不吐 chunk 也不结束 —— 连接活着，但没有然后。
    scripts: new Map([
      [routeKey('alpha', 'one'), () => (async function* () {
        await new Promise((resolve) => { setTimeout(resolve, 5_000) })
      })()],
      [routeKey('beta', 'one'), ok('换我上')],
    ]),
  })
  const startedAt = Date.now()
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [user('写')] }))
  const elapsed = Date.now() - startedAt

  assert.equal(textOf(chunks), '换我上', '卡住的那个被换掉，下一个接着答')
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one'), routeKey('beta', 'one')])
  assert.ok(elapsed >= 900, `应该真的等满了 1 秒，实际 ${elapsed}ms`)
  assert.ok(elapsed < 4_000, `不该等满三秒多才动手，实际 ${elapsed}ms`)

  const rows = h.health.view(h.clock.ms, 1).quarantined
  assert.equal(rows.length, 1, '卡住的模型要进隔离名单')
  assert.equal(rows[0].code, 'IDLE_TIMEOUT')
  assert.match(rows[0].message, /超过 1 秒没有任何输出/)
})

await check('卡住超时：思考增量也算「还在动」，不打断', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }],
    settings: { idleTimeoutSec: 1, sameModelRetries: 0 },
    // 每 400ms 吐一个 reasoning 增量，连吐三次，正好跨过 1 秒的线。
    scripts: new Map([[routeKey('alpha', 'one'), () => (async function* () {
      for (let i = 0; i < 3; i += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 400) })
        yield { type: 'reasoning-delta', text: '嗯' }
      }
      yield { type: 'block-end', block: { type: 'reasoning' } }
      yield { type: 'text-delta', text: '想好了' }
      yield { type: 'block-end', block: { type: 'text' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()]]),
  })
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [user('写')] }))
  assert.equal(textOf(chunks), '想好了', '一直在动就不该被判成卡住')
  assert.equal(h.health.view(h.clock.ms, 1).quarantined.length, 0, '什么都没坏，不该隔离')
})

await check('卡住超时设 0 = 不管：愿意等多久就等多久', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }],
    settings: { idleTimeoutSec: 0, sameModelRetries: 0 },
    scripts: new Map([[routeKey('alpha', 'one'), () => (async function* () {
      await new Promise((resolve) => { setTimeout(resolve, 1_200) })
      yield { type: 'text-delta', text: '慢是慢，但来了' }
      yield { type: 'block-end', block: { type: 'text' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()]]),
  })
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [user('写')] }))
  assert.equal(textOf(chunks), '慢是慢，但来了')
  assert.equal(h.health.view(h.clock.ms, 1).quarantined.length, 0)
})

// 9 · 补发节奏：每次换人带「继续」之前先等一等
await check('补发节奏：每次「继续」之前都先等一等，首次请求不等', async () => {
  const h = await harness({
    order: [
      { provider: 'alpha', model: 'one' },
      { provider: 'beta', model: 'one' },
      { provider: 'beta', model: 'two' },
    ],
    settings: { sameModelRetries: 0 },
    scripts: new Map([
      [routeKey('alpha', 'one'), quota()],
      [routeKey('beta', 'one'), quota()],
      [routeKey('beta', 'two'), ok('好')],
    ]),
  })
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.equal(textOf(chunks), '好')
  // 两次带「继续」的跳（第二、三个模型），每跳之前各等一次；首发不等。
  assert.deepEqual(h.waits, [5000, 5000], '每个带「继续」的跳都该等一次')
})

await check('补发节奏：同模型原样重发不等，只有带「继续」的跳才等', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    settings: { sameModelRetries: 2 },
    scripts: new Map([[routeKey('alpha', 'one'), quota()], [routeKey('beta', 'one'), ok('好')]]),
  })
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.equal(textOf(chunks), '好')
  // alpha 首发 + 两次原样重发都不等（它们带 0 条「继续」）；换到 beta 那一跳才等一次。
  assert.deepEqual(commands(h.llm), [
    routeKey('alpha', 'one'), routeKey('alpha', 'one'), routeKey('alpha', 'one'),
    routeKey('beta', 'one'),
  ])
  assert.deepEqual(h.waits, [5000], '只有换人那一跳在等')
})

await check('补发节奏：0 秒 = 不等待，回到旧行为', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    settings: { continueDelaySec: 0 },
    scripts: new Map([[routeKey('alpha', 'one'), quota()], [routeKey('beta', 'one'), ok('好')]]),
  })
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.equal(textOf(chunks), '好')
  assert.deepEqual(h.waits, [], '设成 0 时一次都不该等')
})

await check('补发节奏：等待期间用户按了停止，不再打注定被取消的请求', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    settings: { continueDelaySec: 5 },
    scripts: new Map([[routeKey('alpha', 'one'), quota()], [routeKey('beta', 'one'), ok('不该出现')]]),
  })
  const controller = new AbortController()
  // 一睡下去就按停止 —— 醒来后必须立刻收手。
  const realSleep = h.adapter.sleep
  h.adapter.sleep = async (ms, signal) => { await realSleep(ms, signal); controller.abort() }
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [], signal: controller.signal }))
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one'), routeKey('alpha', 'one'), routeKey('alpha', 'one')], '中止后不该再碰下一个模型')
  assert.equal(finishOf(chunks)?.reason?.failure?.code, 'QUOTA', '交出的仍是上一个候选的真实结局')
  assert.equal(textOf(chunks), '', '不该出现下一个模型的文字')
})

// 10 · 总开关
await check('关掉接力：退化为只使用第一个模型', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    settings: { enabled: false },
    scripts: new Map([[routeKey('alpha', 'one'), ok('只有我')], [routeKey('beta', 'one'), ok('不该出现')]]),
  })
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.equal(textOf(chunks), '只有我')
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one')])
})

// 10 · 目录过滤
await check('插件自己的路由被排除在候选之外', async () => {
  const h = await harness({
    order: [{ provider: ROUTE, model: 'auto' }, { provider: 'alpha', model: 'one' }],
    scripts: new Map([[routeKey('alpha', 'one'), ok('正常')]]),
  })
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.equal(textOf(chunks), '正常')
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one')], '不该调用自己')
})

await check('清单里不存在的模型被跳过（换掉 provider 之后不留死路由）', async () => {
  const h = await harness({
    order: [{ provider: 'ghost', model: 'gone' }, { provider: 'alpha', model: 'one' }],
    scripts: new Map([[routeKey('alpha', 'one'), ok('还行')]]),
  })
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.equal(textOf(chunks), '还行')
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one')])
})

await check('路由确实没挂适配器（NO_ADAPTER）也算「这个模型现在不行」', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([[routeKey('alpha', 'one'), noAdapter()], [routeKey('beta', 'one'), ok('顶上了')]]),
  })
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.equal(textOf(chunks), '顶上了')
  assert.equal(h.health.view(h.clock.ms, 1).quarantined.length, 1)
})

// 11 · 适配器契约
await check('适配器契约：providerInfo / listModels / resolveModel / retryPolicy', async () => {
  const h = await harness({ order: [{ provider: 'alpha', model: 'one' }], scripts: new Map() })

  assert.deepEqual(h.adapter.providerInfo(ROUTE), { id: ROUTE, name: '模型接力' })

  const models = await h.adapter.listModels(ROUTE)
  assert.equal(models.length, 1)
  assert.equal(models[0].provider, ROUTE)
  assert.equal(models[0].id, 'default')
  assert.equal(models[0].name, '默认模板')
  assert.ok(Array.isArray(models[0].inputModalities))

  const info = await h.adapter.resolveModel(ROUTE, 'default')
  assert.equal(info.id, 'default')
  assert.equal(info.name, '默认模板')
  assert.equal(info.context.contextWindow, 8192, '应声明队列里最窄的上下文窗口')
  // 这条路由**一个档位都不声明**：它背后是一串各有各档位表的模型，报并集就是
  // 说谎 —— 报过的档位在队列变动（或目录还没扫完）之后失效，宿主会拿
  // UNSUPPORTED_REASONING_EFFORT 把整轮拒掉。档位整体缩回队列内部，见 `#effortFor`。
  assert.equal('reasoning' in info, false, '模板本身不该有档位表')

  const policy = h.adapter.providerRetryPolicy(ROUTE)
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.maxRetries, 0)
  // 形状必须是摊平的：宿主直接采用这个对象，llm-retry 读的是顶层字段。
  assert.equal(typeof policy.initialDelayMs, 'number')
  assert.equal(typeof policy.maxDelayMs, 'number')
  assert.equal(typeof policy.jitterRatio, 'number')
  assert.equal('backoff' in policy, false, '不能交出嵌套的 backoff 形状')

  const prepared = await h.adapter.prepareCall(ROUTE, 'default')
  assert.equal(prepared.model.id, 'default')
  assert.equal(typeof prepared.stream, 'function')
})

// 12 · 思考强度：每个候选按自己的档位表收档位
await check('思考强度：每个候选按自己的档位发，不认识的档位不发（也不留空键）', async () => {
  const h = await harness({
    order: [
      { provider: 'alpha', model: 'one', reasoningEffort: 'high' }, // 认识 → 发
      { provider: 'beta', model: 'one', reasoningEffort: 'low' }, // 不认识 → 不发
      { provider: 'beta', model: 'two', reasoningEffort: 'high' }, // 不支持档位 → 不发
    ],
    scripts: new Map([
      [routeKey('alpha', 'one'), quota()],
      [routeKey('beta', 'one'), quota()],
      [routeKey('beta', 'two'), ok('好了')],
    ]),
  })

  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [user('做点事')] }))
  assert.equal(textOf(chunks), '好了')

  const call = (key) => h.llm.calls.find((item) => item.key === key)
  assert.equal(call(routeKey('alpha', 'one')).effort, 'high', 'alpha/one 认识 high，应发下去')
  assert.equal(call(routeKey('beta', 'one')).hadEffort, false, 'beta/one 不认识 low，就不该带这个字段')
  assert.equal(call(routeKey('beta', 'two')).hadEffort, false, '不支持档位的模型完全不发档位')
})

await check('思考强度：路由级选择只在候选没专设、且它认识时生效', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), quota()],
      [routeKey('beta', 'one'), ok('好了')],
    ]),
  })

  // minimal 只有 beta/one 认识：轮到 alpha/one 时不该发，轮到 beta/one 时才发。
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', reasoningEffort: 'minimal', messages: [user('做点事')] }))
  assert.equal(textOf(chunks), '好了')

  const call = (key) => h.llm.calls.find((item) => item.key === key)
  assert.equal(call(routeKey('alpha', 'one')).hadEffort, false, 'alpha/one 不认识 minimal，不发')
  assert.equal(call(routeKey('beta', 'one')).effort, 'minimal', 'beta/one 认识 minimal，应发')
})

await check('思考强度：某个模型专设的档位优先于路由级的选择', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one', reasoningEffort: 'low' }],
    scripts: new Map([[routeKey('alpha', 'one'), ok('好了')]]),
  })

  await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', reasoningEffort: 'high', messages: [user('做点事')] }))
  assert.equal(h.llm.calls[0].effort, 'low', '专设优先，不被路由级盖掉')
})

// 12.5 · 队列模板：每个模板就是模型选择器里的一个模型
const twoTemplates = () => ([
  { id: 'default', name: '默认模板', order: [{ provider: 'alpha', model: 'one' }] },
  { id: 'spare', name: '备用模板', order: [{ provider: 'beta', model: 'one' }] },
])

await check('模板即模型：listModels 一条模板一个模型，名字就是模板名', async () => {
  const h = await harness({ order: [], scripts: new Map(), settings: { templates: twoTemplates() } })
  const models = await h.adapter.listModels(ROUTE)
  assert.deepEqual(models.map((row) => row.id), ['default', 'spare'])
  assert.deepEqual(models.map((row) => row.name), ['默认模板', '备用模板'])
  assert.ok(models.every((row) => row.provider === ROUTE))
})

await check('选了哪个模板就跑哪条队列：模型 id 就是模板 id', async () => {
  const h = await harness({
    order: [],
    scripts: new Map([[routeKey('alpha', 'one'), ok('默认模板跑的')], [routeKey('beta', 'one'), ok('备用模板跑的')]]),
    settings: { templates: twoTemplates() },
  })

  const spare = await drain(h.adapter.stream({ provider: ROUTE, model: 'spare', messages: [user('用备用那套')] }))
  assert.equal(textOf(spare), '备用模板跑的')
  assert.deepEqual(commands(h.llm), [routeKey('beta', 'one')], '备选模板只该碰它自己队列里的模型')

  const dflt = await drain(h.adapter.stream({ provider: ROUTE, model: 'default', messages: [user('用默认那套')] }))
  assert.equal(textOf(dflt), '默认模板跑的')
  assert.deepEqual(commands(h.llm), [routeKey('beta', 'one'), routeKey('alpha', 'one')])
})

await check('认不出的模板 id 退回第一个模板，不报错（删掉的模板 / 老的 auto）', async () => {
  const h = await harness({
    order: [],
    scripts: new Map([[routeKey('alpha', 'one'), ok('兜底')]]),
    settings: { templates: twoTemplates() },
  })
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [user('老会话')] }))
  assert.equal(textOf(chunks), '兜底')
  assert.equal(finishOf(chunks)?.reason?.kind, 'stop')
})

await check('隔离按「会话 × 模板」分开：默认模板撞的墙不影响备用模板', async () => {
  const h = await harness({
    order: [],
    scripts: new Map([
      [routeKey('alpha', 'one'), quota('默认模板的额度用完了')],
      [routeKey('beta', 'one'), ok('备用模板好着呢')],
    ]),
    settings: { templates: twoTemplates() },
  })

  const first = await drain(h.adapter.stream({ provider: ROUTE, model: 'default', messages: [user('先跑默认')], sessionId: 's1' }))
  assert.equal(finishOf(first)?.reason?.kind, 'error', '默认模板里唯一的候选挂了')

  const spare = await drain(h.adapter.stream({ provider: ROUTE, model: 'spare', messages: [user('再跑备用')], sessionId: 's1' }))
  assert.equal(textOf(spare), '备用模板好着呢', '同一个会话换模板不该被另一条模板的隔离挡住')
})

await check('红绿计数：失败一次记一次、成功一次记一次，跨会话合计', async () => {
  const alphaKey = routeKey('alpha', 'one')
  const scripts = new Map([[alphaKey, quota('额度没了')]])
  const h = await harness({ order: [{ provider: 'alpha', model: 'one' }], scripts })
  await drain(h.adapter.stream({ provider: ROUTE, model: 'default', messages: [user('会失败')], sessionId: 's1' }))

  // 换脚本让它成功：同一个模型、另一个会话，计数要累加。
  scripts.set(alphaKey, ok('成了'))
  await drain(h.adapter.stream({ provider: ROUTE, model: 'default', messages: [user('会成功')], sessionId: 's2' }))
  await drain(h.adapter.stream({ provider: ROUTE, model: 'default', messages: [user('再成功一次')], sessionId: 's2' }))

  const counts = h.health.view(h.clock.ms, 1).counts[alphaKey]
  assert.deepEqual(counts, { fail: 1, ok: 2 }, `实际是 ${JSON.stringify(counts)}`)
})

await check('输出速度：从第一个 token 到结束，排队与首字延迟不算进去', async () => {
  const alphaKey = routeKey('alpha', 'one')
  const scripts = new Map()
  const h = await harness({ order: [{ provider: 'alpha', model: 'one' }], scripts })
  // 先空转 5 秒：这一段是排队 + 等首字，属于延迟而不是速度。
  h.clock.ms += 5000
  scripts.set(alphaKey, async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '写完了' }
    // 真正在写字的 2 秒里吐了 100 个 token → 50 tok/s。
    h.clock.ms += 2000
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 100 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await drain(h.adapter.stream({ provider: ROUTE, model: 'default', messages: [user('写')], sessionId: 'sess-speed' }))

  const view = h.health.view(h.clock.ms, 1)
  const row = view.sessions.find((group) => group.sessionId === 'sess-speed')?.good?.[0]
  assert.equal(row?.speed?.tokens, 100, '要带上这一趟的输出 token 数')
  assert.equal(row?.speed?.ms, 2000, `2 秒，不是 7 秒 —— 实际 ${row?.speed?.ms}`)
  assert.equal(row?.speed?.runs, 1, '一趟就记一趟')
  assert.equal(view.speeds['sess-speed'][alphaKey].tokens, 100, '速度按会话存一份')

  // 第二趟：累计而不是覆盖。累计后再除，和 dsh 自己那个「输出速度（TPS）」
  // 一个口径 —— 每趟的速度取平均会让很短的样本权重过大。
  h.clock.ms += 1000
  scripts.set(alphaKey, async function* () {
    yield { type: 'text-delta', index: 0, text: '又写了一段' }
    h.clock.ms += 1000
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 50 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await drain(h.adapter.stream({ provider: ROUTE, model: 'default', messages: [user('再写')], sessionId: 'sess-speed' }))

  const after = h.health.view(h.clock.ms, 1).speeds['sess-speed'][alphaKey]
  assert.equal(after.tokens, 150, '第二趟要加上去，不是覆盖')
  assert.equal(after.ms, 3000, '毫秒也要加起来')
  assert.equal(after.runs, 2, '趟数跟着涨')
  assert.equal(Math.round(after.tokens / (after.ms / 1000)), 50, '累计下来是 50 tok/s')
})

await check('输出速度：一个 token 都没吐、或者没有 usage 的供应商，不留假数字', async () => {
  const alphaKey = routeKey('alpha', 'one')
  const scripts = new Map()
  const h = await harness({ order: [{ provider: 'alpha', model: 'one' }], scripts })
  h.clock.ms += 1000
  // 吐了字，但供应商没给 usage：算不出 token 数，就不该记。
  scripts.set(alphaKey, async function* () {
    yield { type: 'text-delta', index: 0, text: '写了但没报数' }
    h.clock.ms += 500
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await drain(h.adapter.stream({ provider: ROUTE, model: 'default', messages: [user('写')], sessionId: 'sess-nousage' }))

  const view = h.health.view(h.clock.ms, 1)
  const row = view.sessions.find((group) => group.sessionId === 'sess-nousage')?.good?.[0]
  assert.equal(row?.speed, undefined, '没有 usage 就不记速度')
  assert.equal(view.speeds['sess-nousage'], undefined)

  // 压缩会话这类内部调用同样不记：它跟用户等的那一轮无关，速度也不具代表性。
  scripts.set(alphaKey, async function* () {
    yield { type: 'text-delta', index: 0, text: '标题：写点什么' }
    h.clock.ms += 300
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 9 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await drain(h.adapter.stream({
    provider: ROUTE, model: 'default', messages: [user('写')], sessionId: 'sess-purpose', purpose: 'session-title',
  }))
  assert.equal(h.health.view(h.clock.ms, 1).speeds['sess-purpose'], undefined, '起标题的速度不该记账')
})

// 13 · 宿主半身的设置接口
await check('宿主半身：注册路由 + 设置接口读写 + 队列自动填充', async () => {
  const freshHome = mkdtempSync(join(tmpdir(), 'model-failover-host-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = freshHome
  try {
    const scripts = new Map([[routeKey('alpha', 'one'), ok('hi')]])
    const llm = createLlm(scripts)
    llm.register('alpha', [{ id: 'one', name: 'Alpha One' }])
    llm.register('beta', [{ id: 'one', name: 'Beta One' }])
    const registrations = []
    llm.registerAdapter = (providers, adapter) => {
      registrations.push({ providers, adapter })
      return () => {}
    }
    llm.registerConfigurableProviders = (entries) => ({ replace: () => {}, dispose: () => {}, entries })

    const registered = []
    const registeredServers = []
    const disposers = []
    const webServer = {
      register(route) {
        registered.push(route)
        return () => {}
      },
    }
    /** 假 composition 里的可选服务；测试用 `services.connection` 换进出。 */
    const services = {}
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      llm,
      get: (name) => services[name],
      fiber: { entry: { options: { id: 'model-failover' } } },
      effect(fn) {
        const out = fn()
        disposers.push(out)
        return out
      },
      inject(names, callback) {
        if (names.includes('webServer')) {
          callback({
            webServer,
            effect(fn) {
              const out = fn()
              disposers.push(out)
              return out
            },
          })
        }
      },
    }

    const mod = await import('../index.js')
    assert.equal(mod.name, 'model-failover')
    assert.deepEqual(mod.inject, ['llm'])

    mod.apply(ctx, {})

    assert.equal(registrations.length, 1, '应注册恰好一条路由')
    assert.deepEqual(registrations[0].providers, [ROUTE])
    assert.equal(registered.length, 1)
    assert.equal(registered[0].kind, 'prefix')
    assert.equal(registered[0].path, '/api/dsh-model-failover')

    // apply() 里的首次扫描是 fire-and-forget，等它跑完。
    await new Promise((resolve) => setTimeout(resolve, 100))

    const handler = registered[0].handler
    const LOOPBACK = { host: '127.0.0.1:19387' }
    const call = async (method, path, body, headers = LOOPBACK) => {
      const response = { status: 0, body: '', writeHead(status) { this.status = status }, end(payload) { this.body = payload ?? '' } }
      await handler({ method, url: path, headers, ...(body === undefined ? {} : { [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)) } }) }, response)
      return { status: response.status, json: JSON.parse(response.body) }
    }

    const state = await call('GET', '/api/dsh-model-failover/state')
    assert.equal(state.status, 200)
    assert.equal(state.json.ok, true)
    assert.equal(state.json.route.provider, ROUTE)
    assert.equal(state.json.settings.resetHour, 1)
    const catalogKeys = state.json.catalog.map((row) => routeKey(row.provider, row.model))
    assert.ok(catalogKeys.includes(routeKey('alpha', 'one')))
    assert.ok(catalogKeys.includes(routeKey('beta', 'one')))
    assert.equal(catalogKeys.includes(routeKey(ROUTE, 'auto')), false, '插件自己的路由不该出现在候选清单里')
    assert.deepEqual(state.json.settings.templates[0].order.map((item) => routeKey(item.provider, item.model)).sort(),
      [routeKey('alpha', 'one'), routeKey('beta', 'one')].sort(), '首次运行应把已接入的模型灌进队列')
    assert.equal(state.json.settings.templates[0].id, 'default')
    assert.equal(state.json.settings.editedTemplate, 'default')

    // 设置页要按每个模型自己的档位表画下拉框，所以清单行必须带上档位。
    const row = (provider, model) => state.json.catalog.find((item) => item.provider === provider && item.model === model)
    assert.deepEqual(row('alpha', 'one').efforts.map((effort) => effort.id), ['low', 'high'])
    assert.equal(row('alpha', 'one').effortsKnown, true)
    assert.deepEqual(row('beta', 'one').efforts.map((effort) => effort.id), ['minimal', 'high'])

    // 调整顺序（整条模板一起写回去：名字和队列是同一次请求）
    const reordered = await call('POST', '/api/dsh-model-failover/settings', {
      templates: [{
        id: 'default',
        name: '默认模板',
        order: [
          { provider: 'beta', model: 'one', reasoningEffort: 'minimal' },
          { provider: 'alpha', model: 'one' },
        ],
      }],
      resetHour: 5,
      continueText: '接着做',
    })
    assert.deepEqual(reordered.json.settings.templates[0].order.map((item) => item.provider), ['beta', 'alpha'])
    assert.equal(reordered.json.settings.templates[0].order[0].reasoningEffort, 'minimal', '每个候选的档位要能存下来')
    assert.equal('reasoningEffort' in reordered.json.settings.templates[0].order[1], false, '没设档位的候选不该多个空字段')
    assert.equal(reordered.json.settings.resetHour, 5)
    assert.equal(reordered.json.settings.continueText, '接着做')

    // 空白档位等于「没设」：下拉框回到「默认档位」时就是这条路径。
    const blank = await call('POST', '/api/dsh-model-failover/settings', {
      templates: [{ id: 'default', name: '默认模板', order: [{ provider: 'beta', model: 'one', reasoningEffort: '  ' }, { provider: 'alpha', model: 'one' }] }],
    })
    assert.equal('reasoningEffort' in blank.json.settings.templates[0].order[0], false, '空白档位应被收敛成「没设」')

    // 非法值被就地修好，而不是留给执行路径
    const clamped = await call('POST', '/api/dsh-model-failover/settings', { resetHour: 99, eventLogLimit: 0 })
    assert.equal(clamped.json.settings.resetHour, 1, '非法的重置时间应回落到默认值')
    assert.equal(clamped.json.settings.eventLogLimit, DEFAULT_SETTINGS.eventLogLimit)

    // 隔离名单 + 解除
    const quarantined = await call('POST', '/api/dsh-model-failover/reset', {})
    assert.equal(quarantined.json.quarantined.length, 0)

    // ── 会话页那一栏的轻量端点 ──────────────────────────────────────────────
    // 它只回隔离与当前模型，不该拖模型清单和事件下来：那一栏是轮询的。
    const sessions = await call('GET', '/api/dsh-model-failover/sessions')
    assert.equal(sessions.status, 200)
    assert.equal(sessions.json.ok, true)
    assert.equal(sessions.json.route.provider, ROUTE)
    assert.ok(Array.isArray(sessions.json.sessions), '必须有 sessions 数组')
    assert.equal('catalog' in sessions.json, false, '不该带上模型清单')
    assert.equal('events' in sessions.json, false, '不该带上事件日志')
    assert.equal(typeof sessions.json.day, 'string', '要带上当前逻辑日')
    // 外观：这一栏显示谁由设置页决定，判据在浏览器那边，所以宿主只把开关传过去。
    assert.deepEqual(sessions.json.view, { subagentSessions: false, foreignSessions: true }, '默认不显示子智能体、显示其他工作区')
    const viewPatch = await call('POST', '/api/dsh-model-failover/settings', {
      showSubagentSessions: true,
      showForeignSessions: false,
    })
    assert.equal(viewPatch.status, 200)
    assert.equal(viewPatch.json.settings.showSubagentSessions, true)
    assert.equal(viewPatch.json.settings.showForeignSessions, false)
    const viewAfter = await call('GET', '/api/dsh-model-failover/sessions')
    assert.deepEqual(viewAfter.json.view, { subagentSessions: true, foreignSessions: false }, '开关要能改、也要能读回来')
    // 改回去，免得影响后面的断言。
    await call('POST', '/api/dsh-model-failover/settings', { showSubagentSessions: false, showForeignSessions: true })

    // 现在还没跑过任何东西，所以是空的；跑一轮之后要能看到「正在用谁」。
    assert.equal(sessions.json.sessions.length, 0, '还没跑过时应该是空的')
    for await (const _ of registrations[0].adapter.stream({
      provider: ROUTE,
      model: 'auto',
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
      sessionId: 'sess-queue',
    })) { /* 把流跑完 */ }

    const after = await call('GET', '/api/dsh-model-failover/sessions')
    const mine = after.json.sessions.find((row) => row.sessionId === 'sess-queue')
    assert.ok(mine !== undefined, `跑过之后应出现这个会话：${JSON.stringify(after.json.sessions)}`)
    assert.equal(mine.active.provider, 'alpha', '应记下这个会话最后用的模型')
    assert.equal(mine.active.model, 'one')
    assert.equal(typeof mine.active.label, 'string', '宿主把显示名拼好给前端')
    // 队列上面刚被改成 beta 在前，而 beta 只注册在清单里、没有脚本 -> NO_ADAPTER，
    // 所以这一轮确实在 beta 上撞过一次。榜单要把它挂在 sess-queue 名下。
    const stuck = mine.quarantined.find((row) => row.key === routeKey('beta', 'one'))
    assert.ok(stuck !== undefined, `sess-queue 名下应有 beta/one：${JSON.stringify(mine.quarantined)}`)
    assert.equal(stuck.sessionId, 'sess-queue', '每一行都要带会话号')
    assert.equal(typeof stuck.label, 'string')

    // 换个会话问：那份隔离不该出现在别人名下。
    const other = await call('GET', '/api/dsh-model-failover/sessions')
    assert.equal(other.json.sessions.filter((row) => row.sessionId === 'sess-queue').length, 1, '同一会话只出现一次')

    // ── 按会话解除隔离（会话页那一栏的按钮） ────────────────────────────────
    // 先让第二个会话也撞同一堵墙：beta 仍然没有脚本。
    for await (const _ of registrations[0].adapter.stream({
      provider: ROUTE,
      model: 'auto',
      messages: [{ role: 'user', content: [{ type: 'text', text: '再跑一次' }] }],
      sessionId: 'sess-other',
    })) { /* 把流跑完 */ }

    const bothStuck = await call('GET', '/api/dsh-model-failover/sessions')
    const stuckSessions = bothStuck.json.sessions
      .filter((row) => row.quarantined.some((item) => item.key === routeKey('beta', 'one')))
      .map((row) => row.sessionId)
    assert.ok(stuckSessions.includes('sess-queue') && stuckSessions.includes('sess-other'), `两个会话都该挂着 beta/one：${JSON.stringify(stuckSessions)}`)

    const scoped = await call('POST', '/api/dsh-model-failover/reset?sessionId=sess-queue', {})
    assert.equal(scoped.status, 200)
    assert.equal(scoped.json.ok, true)
    assert.equal(scoped.json.sessionId, 'sess-queue')
    assert.equal(scoped.json.cleared, 1, '只该解除那一个会话的隔离')
    const afterScoped = scoped.json.sessions.find((row) => row.sessionId === 'sess-queue')
    assert.equal(afterScoped.quarantined.length, 0, '当前会话的隔离应被清空')
    const survivor = scoped.json.sessions.find((row) => row.sessionId === 'sess-other')
    assert.equal(survivor.quarantined.length, 1, '别的会话一条都不许动')
    assert.equal(survivor.quarantined[0].sessionId, 'sess-other')

    // 已经有隔离的会话再点一次：什么也没解除，但也不能报错。
    const again = await call('POST', '/api/dsh-model-failover/reset?sessionId=sess-queue', {})
    assert.equal(again.status, 200)
    assert.equal(again.json.cleared, 0, '没有隔离可解时返回 0')

    const unknown = await call('GET', '/api/dsh-model-failover/nope')
    assert.equal(unknown.status, 404)

    // ── 试连接 ──────────────────────────────────────────────────────────────
    // 走 ctx.llm 直连供应商，刻意**不经过本插件的接力路由**：体检不该把一个
    // 好好的模型记进隔离名单，也不该动撞上限那本账。
    const beforeProbe = await call('GET', '/api/dsh-model-failover/state')
    const callsBeforeProbe = llm.calls.length

    const goodProbe = await call('POST', '/api/dsh-model-failover/probe', { provider: 'alpha', model: 'one' })
    assert.equal(goodProbe.status, 200)
    assert.equal(goodProbe.json.ok, true)
    assert.equal(goodProbe.json.result.ok, true, 'alpha/one 有脚本，应当探通')
    assert.equal(goodProbe.json.result.provider, 'alpha')
    assert.equal(typeof goodProbe.json.result.ms, 'number')

    // beta/one 在这套假宿主里没有脚本 —— 正好当「探不通」的那一侧。
    const badProbe = await call('POST', '/api/dsh-model-failover/probe', { provider: 'beta', model: 'one' })
    assert.equal(badProbe.status, 200)
    assert.equal(badProbe.json.result.ok, false)
    assert.equal(badProbe.json.result.code, 'NO_ADAPTER', '失败要把错误码带回来')
    assert.match(badProbe.json.result.message, /没有为 .* 准备脚本/)

    const probeCalls = llm.calls.slice(callsBeforeProbe)
    assert.deepEqual(probeCalls.map((row) => row.key), [routeKey('alpha', 'one'), routeKey('beta', 'one')], '探测要直达供应商，不能借道 model-failover')
    for (const row of probeCalls) {
      // 花销：一句「hi」加 8 个 token 的输出上限。这两条一起才是「试连接很便宜」。
      assert.equal(row.maxTokens, 8, '试连接必须把输出上限压到个位数')
      assert.equal(row.messages.length, 1, '只发一句话，别把整段对话塞进去')
      assert.equal(row.messages[0].content[0].text, 'hi')
      // 试连接不指定档位：它只回答「连不连得上」，不该顺带改变档位语义。
      assert.equal(row.effort, undefined)
    }

    const afterProbe = await call('GET', '/api/dsh-model-failover/state')
    assert.deepEqual(afterProbe.json.counts, beforeProbe.json.counts, '试连接不该动红绿计数')
    assert.deepEqual(afterProbe.json.quarantined, beforeProbe.json.quarantined, '试连接不该隔离任何模型')
    assert.equal(afterProbe.json.events.length, beforeProbe.json.events.length, '试连接不该往事件日志里写东西')

    const incompleteProbe = await call('POST', '/api/dsh-model-failover/probe', { provider: 'alpha' })
    assert.equal(incompleteProbe.status, 400, '缺 model 必须拒绝，不能拿空字符串去探')
    assert.equal(incompleteProbe.json.ok, false)

    // ── 请求准入 ────────────────────────────────────────────────────────────
    // 本路由比内核的 `/api` 长，最长前缀胜出，所以内核那条里的鉴权不会跑；
    // 下面的用例盯的就是补在这一层里的信任围栏。
    const lan = await call('GET', '/api/dsh-model-failover/state', undefined, { host: '10.0.0.5:19387' })
    assert.equal(lan.status, 403, '非环回 Host 必须被拒')
    assert.equal(lan.json.ok, false)

    const noHost = await call('GET', '/api/dsh-model-failover/state', undefined, {})
    assert.equal(noHost.status, 403, '没有 Host 的请求必须被拒')

    const crossSite = await call('GET', '/api/dsh-model-failover/state', undefined, { ...LOOPBACK, 'sec-fetch-site': 'cross-site' })
    assert.equal(crossSite.status, 403, '跨站 fetch 必须被拒')

    const foreignOrigin = await call('GET', '/api/dsh-model-failover/state', undefined, { ...LOOPBACK, origin: 'http://evil.example' })
    assert.equal(foreignOrigin.status, 403, '异源 Origin 必须被拒')

    const sameOrigin = await call('GET', '/api/dsh-model-failover/state', undefined, {
      ...LOOPBACK, origin: 'http://127.0.0.1:19387', referer: 'http://127.0.0.1:19387/settings',
    })
    assert.equal(sameOrigin.status, 200, '同源 Origin/Referer 必须放行')
    assert.equal(sameOrigin.json.ok, true)

    const localhost = await call('GET', '/api/dsh-model-failover/state', undefined, { host: 'localhost:19387' })
    assert.equal(localhost.status, 200, 'localhost 也算环回')

    // composition 里有 connection 服务时，判定权交给它 —— 本插件不比应用更弱，
    // 也不比应用更严：它放行的 LAN 主机名在这里同样放行。
    services.connection = { admit: () => undefined }
    const viaService = await call('GET', '/api/dsh-model-failover/state', undefined, { host: '10.0.0.5:19387' })
    assert.equal(viaService.status, 200, 'connection 服务放行时应放行')

    services.connection = { admit: () => ({ rejection: 401 }) }
    const denied = await call('GET', '/api/dsh-model-failover/state')
    assert.equal(denied.status, 401, 'connection 服务拒绝时应原样转发它的状态码')

    // 老版本把同一判定发布为 requestRejection（返回裸状态码）。
    services.connection = { requestRejection: () => 403 }
    const legacy = await call('GET', '/api/dsh-model-failover/state')
    assert.equal(legacy.status, 403, 'requestRejection 的裸状态码也要认')

    // 挂掉的 Host 服务绝不能变成放行。
    services.connection = { admit: () => { throw new Error('服务炸了') } }
    const broken = await call('GET', '/api/dsh-model-failover/state')
    assert.equal(broken.status, 503, 'admit 抛错时应拒绝，绝不能放行')

    delete services.connection
    const recovered = await call('GET', '/api/dsh-model-failover/state')
    assert.equal(recovered.status, 200, '服务消失后退回复刻围栏，环回请求仍应放行')

    // 收摊
    for (const dispose of disposers.reverse()) {
      if (typeof dispose === 'function') dispose()
    }
  } finally {
    process.env.DSH_HOME = previous
    rmSync(freshHome, { recursive: true, force: true })
  }
})

// 13.4 · 扫描结果跨启动延续
// 「每次关掉 dsh 就重新扫一遍」既慢又没必要：清单一夜之间基本不变。这里验的
// 是落盘那一半 —— 第二个 Catalog 实例（相当于下一次启动）什么都不问，直接从
// 磁盘把清单、档位表、被隐藏的路由全拿回来。

await check('扫描结果落盘：下一个进程不再问宿主，清单与档位表原样回来', async () => {
  const cacheFile = new JsonFile(join(HOME, `catalog-${Math.random().toString(36).slice(2)}.json`), undefined, (raw) => raw)
  const llm = createLlm(new Map())
  llm.register('alpha', [{ id: 'one', name: 'Alpha One' }])
  llm.register('beta', [{ id: 'one', name: 'Beta One' }])
  // 宿主的 `resolveModelInfo` 把窗口放在 `context.contextWindow` 里（不是顶层）。
  llm.resolveModelInfo = async (provider, model) => (model === 'one'
    ? { provider, model, reasoning: { efforts: [{ id: 'low', name: '低' }], defaultEffort: 'low' }, context: { contextWindow: 128_000 } }
    : undefined)
  let asked = 0
  const counting = {
    listProviders: () => { asked += 1; return llm.listProviders() },
    listModels: (provider) => llm.listModels(provider),
    resolveModelInfo: (...args) => llm.resolveModelInfo(...args),
  }

  const first = new Catalog({ llm: counting, hiddenProviders: () => ['beta'], logger: {}, cacheFile })
  await first.refresh()
  await first.fillModelFacts()
  cacheFile.flush()
  assert.equal(asked, 1, '第一次当然要问')
  assert.deepEqual(first.providers.map((row) => `${row.id}:${row.hidden}`), ['alpha:false', 'beta:true'], '被隐藏的路由也要记下来')
  assert.equal(first.reasoningFor('alpha', 'one')?.efforts.length, 1, '档位表也该落盘')

  // 第二个实例 = 下一次启动：宿主还没挂完也不影响，清单从磁盘来。
  const second = new Catalog({ llm: counting, hiddenProviders: () => ['beta'], logger: {}, cacheFile })
  assert.equal(asked, 1, '恢复时不该再问宿主')
  // beta 被隐藏，所以它只在 providers 里留个记号，不进候选清单。
  assert.deepEqual(second.cached().map((row) => routeKey(row.provider, row.model)), [routeKey('alpha', 'one')])
  assert.equal(second.reasoningFor('alpha', 'one')?.efforts.length, 1, '档位表一起回来')
  assert.equal(second.contextWindow('alpha', 'one'), 128_000)
  assert.deepEqual(second.providers.map((row) => `${row.id}:${row.hidden}`), ['alpha:false', 'beta:true'])

  // 用户点了「重新扫描」才会真的再问一次。
  await second.refresh()
  assert.equal(asked, 2, 'refresh() 才去问宿主')
})

await check('扫描缓存坏了就当没有：不让一个写坏的 json 把清单清空', async () => {
  const cacheFile = new JsonFile(join(HOME, `catalog-${Math.random().toString(36).slice(2)}.json`), undefined, (raw) => raw)
  cacheFile.replace({ version: 999, entries: [{ provider: 'ghost', model: 'x' }] })
  cacheFile.flush()
  const llm = createLlm(new Map())
  llm.register('alpha', [{ id: 'one', name: 'Alpha One' }])
  const catalog = new Catalog({ llm, hiddenProviders: () => [], logger: {}, cacheFile })
  assert.deepEqual(catalog.cached(), [], '版本对不上就该当作没缓存')
  await catalog.refresh()
  assert.equal(catalog.cached().length, 1, '重新扫一遍就有了')
})

// 13.5 · 轮尾便签：适配器那一半的配对
// 轮尾小字要知道「这一轮是谁跑的」，而模型身份只有适配器知道（GenerateOptions 带
// sessionId、不带轮号），所以适配器负责按会话记下「最后真正产出内容的那个模型」。

await check('轮尾便签：适配器按会话记下最后产出内容的模型', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }],
    scripts: new Map([[routeKey('alpha', 'one'), ok('好')]]),
  })
  await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [user('写')], sessionId: 'sess-1' }))

  assert.equal(h.notes.latest('sess-1').provider, 'alpha')
  assert.equal(h.notes.latest('sess-1').model, 'one')
  assert.equal(h.notes.latest('sess-2'), undefined, '别的会话不该被顺带写上')
})

await check('轮尾便签：换人之后记的是最后接手的那个', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([[routeKey('alpha', 'one'), quota()], [routeKey('beta', 'one'), ok('换我上')]]),
  })
  await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [user('写')], sessionId: 'sess-1' }))

  assert.equal(h.notes.latest('sess-1').provider, 'beta', '半路换人时要记接手的那个')
})

await check('轮尾便签：撞输出上限也算这一轮的模型（那一轮确实跑过）', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }],
    scripts: new Map([[routeKey('alpha', 'one'), truncated('写到一半')]]),
  })
  await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [user('写')], sessionId: 'sess-1' }))

  assert.equal(h.notes.latest('sess-1').provider, 'alpha')
})

await check('轮尾便签：会话标题 / 压缩这类内部调用不记（它们共用 sessionId）', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }],
    scripts: new Map([[routeKey('alpha', 'one'), ok('标题')]]),
  })
  await drain(h.adapter.stream({
    provider: ROUTE, model: 'auto', messages: [user('起个标题')], sessionId: 'sess-1', purpose: 'session-title',
  }))

  assert.equal(h.notes.latest('sess-1'), undefined, '内部用途与用户看到的那一轮无关')
})

await check('轮尾便签：没有 sessionId 时什么都不记，也不炸', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }],
    scripts: new Map([[routeKey('alpha', 'one'), ok('好')]]),
  })
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [user('写')] }))
  assert.equal(textOf(chunks), '好')
  assert.equal(h.notes.forSession('sess-1').length, 0)
})

// 14 · 「自动继续」的宿主接线
await check('宿主半身：本轮失败 / 输出撞上限时自动补发「继续」', async () => {
  const freshHome = mkdtempSync(join(tmpdir(), 'model-failover-auto-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = freshHome
  try {
    // 「补发前先等几秒」在这里关掉：这一条验的是接线，不是节奏，真等 5 秒
    // 只会让断言跑在一次还没醒来的等待前面。节奏本身在 autocontinue.mjs
    // 用注入的假 sleep 单独验。
    mkdirSync(join(freshHome, 'dsh-model-failover'), { recursive: true })
    writeFileSync(join(freshHome, 'dsh-model-failover', 'settings.json'), JSON.stringify({ continueDelaySec: 0 }))

    const llm = createLlm(new Map())
    llm.register('alpha', [{ id: 'one', name: 'Alpha One' }])
    // 记下插件挂上来的那个适配器：下面要拿它走一遍真 stream，好把便签喂进去。
    let registered = null
    llm.registerAdapter = (routes, adapter) => { registered = { routes, adapter }; return () => {} }
    llm.registerConfigurableProviders = () => ({ replace: () => {}, dispose: () => {}, entries: [] })

    const sent = []
    const session = { id: 's1' }
    const agent = {
      status: 'idle',
      inbox: { hasPending: false },
      async whenIdle() {},
      followup: (message) => sent.push(message),
    }
    const agents = { get: (id) => (id === 's1' ? agent : undefined) }

    const listeners = new Map()
    const scoped = (extra) => ({
      ...extra,
      effect: (fn) => { fn(); return () => {} },
      on: (type, fn) => { listeners.set(type, fn); return () => listeners.delete(type) },
    })

    let sawAgentsInject = false
    let handler
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      llm,
      get: () => undefined,
      fiber: { entry: { options: { id: 'model-failover' } } },
      effect: (fn) => { fn(); return () => {} },
      inject(names, callback) {
        if (names.includes('webServer')) {
          callback(scoped({
            webServer: { register: (route) => { handler = route.handler; return () => {} } },
          }))
        }
        if (names.includes('agents')) {
          sawAgentsInject = true
          callback(scoped({ agents }))
        }
      },
    }

    const mod = await import('../index.js')
    mod.apply(ctx, {})
    await new Promise((resolve) => setTimeout(resolve, 100))

    assert.equal(sawAgentsInject, true, '应通过 ctx.inject 申请 agents 服务')
    assert.equal(typeof listeners.get('session/event'), 'function', '应挂上 session/event 监听')

    const LOOPBACK = { host: '127.0.0.1:19387' }
    const call = async (method, path, body, headers = LOOPBACK) => {
      const response = { status: 0, body: '', writeHead(status) { this.status = status }, end(payload) { this.body = payload ?? '' } }
      await handler({ method, url: path, headers, ...(body === undefined ? {} : { [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)) } }) }, response)
      return { status: response.status, json: JSON.parse(response.body) }
    }

    const fire = (type, data) => listeners.get('session/event')(session, { type, data })
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

    // 输出撞上限 → 补发
    fire('turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
    await settle()
    assert.equal(sent.length, 1, '输出撞上限时应补发一句')
    assert.equal(sent[0].role, 'user')
    assert.equal(sent[0].content[0].text, '继续')

    // 我们补发的那一轮开始并再次失败 → 再补发一次
    fire('turn/start', { turn: 2 })
    fire('turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'SERVER', message: 'boom' } } })
    await settle()
    assert.equal(sent.length, 2, '本轮运行失败时也应补发')

    // 第三轮正常收尾 → 一条都不该补
    fire('turn/start', { turn: 3 })
    fire('turn/end', { turn: 3, reason: { kind: 'completed' } })
    await settle()
    assert.equal(sent.length, 2, '正常结束不该补发')

    // 用户中止 → 一条都不该补
    fire('turn/end', { turn: 4, reason: { kind: 'aborted' } })
    await settle()
    assert.equal(sent.length, 2, '用户喊停后绝不能替他再发一句')

    // 本机网络没通 → 一条都不该补（网线没通，重发只是白烧一次上限）
    fire('turn/end', {
      turn: 5,
      reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'trae: transport error: fetch failed' } },
    })
    fire('turn/end', {
      turn: 6,
      reason: { kind: 'error', error: { code: 'SERVER', message: 'cannot resolve tunnel destination www.workbuddy.ai (ENOTFOUND): local name resolution failed' } },
    })
    await settle()
    assert.equal(sent.length, 2, '本机网络问题不该补发「继续」')

    // 但用户得能在事件日志里看见「为什么没继续」，否则会以为插件坏了。
    const afterNetwork = await call('GET', '/api/dsh-model-failover/state')
    assert.equal(afterNetwork.status, 200)
    const skipped = afterNetwork.json.events.filter((event) => event.kind === 'auto-continue-skipped')
    assert.equal(skipped.length, 2, '两次本机网络失败都该在日志里留痕')
    assert.equal(skipped[0].code, 'SERVER', '日志要带上原始的 code')
    assert.equal(skipped[0].trigger, 'network')
    assert.ok(skipped[0].message.includes('ENOTFOUND'), '日志要留下原始报错，便于排查')

    // 远端的问题照旧补发 —— 不能因为加了网络判据就把该救的失败一起摁掉。
    fire('turn/start', { turn: 7 })
    fire('turn/end', { turn: 7, reason: { kind: 'error', error: { code: 'SERVER', message: 'upstream returned 502 Bad Gateway' } } })
    await settle()
    assert.equal(sent.length, 3, '远端 5xx 仍应补发')

    // ── 设置真的能摁住它 ────────────────────────────────────────────────────
    const off = await call('POST', '/api/dsh-model-failover/settings', { autoContinue: false })
    assert.equal(off.status, 200)
    assert.equal(off.json.settings.autoContinue, false)

    fire('turn/start', { turn: 8 })
    fire('turn/end', { turn: 8, reason: { kind: 'max-tokens' } })
    fire('turn/end', { turn: 8, reason: { kind: 'error', error: { code: 'SERVER' } } })
    await settle()
    assert.equal(sent.length, 3, '总开关关掉后不该再补发')

    // 只关「输出撞上限」，失败照补。
    const partial = await call('POST', '/api/dsh-model-failover/settings', {
      autoContinue: true,
      autoContinueOnMaxTokens: false,
    })
    assert.equal(partial.status, 200)
    assert.equal(partial.json.settings.autoContinueOnMaxTokens, false)

    fire('turn/start', { turn: 9 })
    fire('turn/end', { turn: 9, reason: { kind: 'max-tokens' } })
    await settle()
    assert.equal(sent.length, 3, '分项关掉后撞上限不该补发')

    fire('turn/start', { turn: 10 })
    fire('turn/end', { turn: 10, reason: { kind: 'error', error: { code: 'SERVER' } } })
    await settle()
    assert.equal(sent.length, 4, '本轮失败仍应补发')
    assert.equal(sent[3].content[0].text, '继续')

    // ── 轮尾便签：真适配器 + 真监听 + 真 /notes 端点串一遍 ──────────────────
    // 这一段是整条链路的合龙测试：适配器按 sessionId 记下是谁跑的（它看得见
    // sessionId、看不见轮号），监听器在 turn/end 时补上轮号，/notes 再把它连同
    // 显示用的标签一起交出去。
    await call('POST', '/api/dsh-model-failover/settings', { autoContinue: true, autoContinueOnMaxTokens: true })
    assert.equal(typeof registered?.adapter?.stream, 'function', 'index.js 应把适配器挂到注册表上')
    // 真实的先后是 turn/start → 适配器跑 → turn/end，监听器靠这个顺序判断
    // 「这一轮到底是不是接力跑的」，所以这里也必须按真实顺序来。
    fire('turn/start', { turn: 21 })
    await drain(registered.adapter.stream({
      provider: 'model-failover',
      model: 'auto',
      messages: [user('写点东西')],
      sessionId: 's1',
    }))

    fire('turn/end', { turn: 21, reason: { kind: 'max-tokens' } })
    await settle()
    assert.equal(sent.length, 5, '第 21 轮撞上限仍应补发（上面刚把开关打开）')

    const notesRes = await call('GET', '/api/dsh-model-failover/notes?sessionId=s1')
    assert.equal(notesRes.status, 200)
    assert.equal(notesRes.json.ok, true)
    const mine = notesRes.json.notes.filter((row) => row.turn === 21)
    assert.equal(mine.length, 1, `/notes 里应该有第 21 轮：${JSON.stringify(notesRes.json)}`)
    assert.equal(mine[0].trigger, 'max-tokens')
    assert.equal(mine[0].provider, 'alpha')
    assert.equal(mine[0].model, 'one')
    assert.equal(typeof mine[0].label, 'string')
    assert.ok(mine[0].label.length > 0, '要有给用户看的标签')

    const stranger = await call('GET', '/api/dsh-model-failover/notes?sessionId=s-nobody')
    assert.equal(stranger.status, 200)
    assert.deepEqual(stranger.json.notes, [], '别的会话不该看见这条便签')
  } finally {
    process.env.DSH_HOME = previous
    rmSync(freshHome, { recursive: true, force: true })
  }
})

rmSync(HOME, { recursive: true, force: true })

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exitCode = failed === 0 ? 0 : 1
