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
import { mkdtempSync, rmSync } from 'node:fs'
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
 */
async function harness({ order, scripts, settings: overrides = {}, at = new Date(2026, 1, 14, 6, 0, 0).getTime() }) {
  const llm = createLlm(scripts)
  llm.register('alpha', [{ id: 'one', name: 'Alpha One' }, { id: 'two', name: 'Alpha Two' }])
  llm.register('beta', [{ id: 'one', name: 'Beta One' }, { id: 'two', name: 'Beta Two' }])
  // 插件自己的路由必须在清单里出现 —— 用来验证它会被排除，不会自我递归。
  llm.register(ROUTE, [{ id: 'auto', name: '自动接力' }])

  const clock = { ms: at }
  const settings = new JsonFile(join(HOME, `settings-${Math.random().toString(36).slice(2)}.json`), undefined,
    (raw) => ({ ...DEFAULT_SETTINGS, ...(raw !== null && typeof raw === 'object' ? raw : {}) }))
  settings.replace({ ...DEFAULT_SETTINGS, ...overrides, order })

  const health = new DailyHealth(
    new JsonFile(join(HOME, `state-${Math.random().toString(36).slice(2)}.json`), undefined, normalizeState),
  )

  const catalog = new Catalog({ llm, hiddenProviders: () => [], logger: {} })
  await catalog.refresh()
  await catalog.fillModelFacts()

  const events = []
  const adapter = new FailoverAdapter({
    llm,
    settings,
    health,
    catalog,
    log: { warn: () => {}, push: (event) => events.push(event) },
    now: () => clock.ms,
  })

  return { llm, clock, settings, health, catalog, adapter, events }
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
    const head = String(error?.stack ?? error).split('\n').slice(0, 3).join('\n      ')
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

  // 调用序列：alpha/one 两次（原始 + 继续），beta/one 两次，beta/two 一次。
  assert.deepEqual(commands(h.llm), [
    routeKey('alpha', 'one'), routeKey('alpha', 'one'),
    routeKey('beta', 'one'), routeKey('beta', 'one'),
    routeKey('beta', 'two'),
  ], '每个候选都是先试一次、再带「继续」试一次；第几个模型就带几条「继续」')

  // 「继续」确实进了消息，而不是只改了 provider/model。
  const betaCalls = h.llm.calls.filter((call) => call.key === routeKey('beta', 'one'))
  const countContinues = (call) => call.messages.filter((m) => m.role === 'user' && m.content?.[0]?.text === '继续').length
  assert.equal(countContinues(betaCalls[0]), 1, '切到第二个模型时应带上一条「继续」')
  assert.equal(countContinues(betaCalls[1]), 2, '第二个模型的自身重试应再多一条「继续」')

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

// 5b · 失败一次、被「继续」叫起来接着写完：不算「今天不行」
await check('失败一次、补一句「继续」就写完：不隔离，并记成已验证可用', async () => {
  let turn = 0
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    scripts: new Map([
      [routeKey('alpha', 'one'), (options) => (++turn === 1 ? quota()(options) : ok('补上后半句')(options))],
      [routeKey('beta', 'one'), ok('不该轮到我')],
    ]),
  })

  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.equal(textOf(chunks), '补上后半句')
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one'), routeKey('alpha', 'one')], '这句「继续」不该把人换掉')
  assert.equal(lastUserText(h.llm.calls.at(-1).messages), '继续', '重试时应该带着「继续」')

  const view = h.health.view(h.clock.ms, 1)
  assert.equal(view.quarantined.length, 0, '它产出内容了，不算今天出不了东西')
  assert.deepEqual(view.good.map((row) => row.key), [routeKey('alpha', 'one')], '应该记成当天已验证可用')
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
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one'), routeKey('alpha', 'one'), routeKey('beta', 'one')],
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
  assert.match(finishOf(chunks)?.reason?.failure?.message ?? '', /队列还是空的/)
})

// 8 · 关掉「同模型重发一次」
await check('关掉重发：每换个模型只试一次', async () => {
  const h = await harness({
    order: [{ provider: 'alpha', model: 'one' }, { provider: 'beta', model: 'one' }],
    settings: { retrySameModelOnce: false },
    scripts: new Map([[routeKey('alpha', 'one'), quota()], [routeKey('beta', 'one'), ok('好')]]),
  })
  const chunks = await drain(h.adapter.stream({ provider: ROUTE, model: 'auto', messages: [] }))
  assert.equal(textOf(chunks), '好')
  assert.deepEqual(commands(h.llm), [routeKey('alpha', 'one'), routeKey('beta', 'one')])
})

// 9 · 总开关
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
  assert.equal(models[0].id, 'auto')
  assert.ok(Array.isArray(models[0].inputModalities))

  const info = await h.adapter.resolveModel(ROUTE, 'auto')
  assert.equal(info.id, 'auto')
  assert.equal(info.context.contextWindow, 8192, '应声明队列里最窄的上下文窗口')
  // 这条路由要面对一串各有各档位表的模型，所以对外只能声明并集；缺省档位留给
  // 每个候选自己的适配器决定（那才是它「正常使用」时的表现）。
  assert.deepEqual(info.reasoning.efforts.map((effort) => effort.id), ['low', 'high'], '应声明队列里出现过的档位并集')
  assert.equal('defaultEffort' in info.reasoning, false, '不替候选声明缺省档位')

  const policy = h.adapter.providerRetryPolicy(ROUTE)
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.maxRetries, 0)
  // 形状必须是摊平的：宿主直接采用这个对象，llm-retry 读的是顶层字段。
  assert.equal(typeof policy.initialDelayMs, 'number')
  assert.equal(typeof policy.maxDelayMs, 'number')
  assert.equal(typeof policy.jitterRatio, 'number')
  assert.equal('backoff' in policy, false, '不能交出嵌套的 backoff 形状')

  const prepared = await h.adapter.prepareCall(ROUTE, 'auto')
  assert.equal(prepared.model.id, 'auto')
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
    assert.deepEqual(state.json.settings.order.map((item) => routeKey(item.provider, item.model)).sort(),
      [routeKey('alpha', 'one'), routeKey('beta', 'one')].sort(), '首次运行应把已接入的模型灌进队列')

    // 设置页要按每个模型自己的档位表画下拉框，所以清单行必须带上档位。
    const row = (provider, model) => state.json.catalog.find((item) => item.provider === provider && item.model === model)
    assert.deepEqual(row('alpha', 'one').efforts.map((effort) => effort.id), ['low', 'high'])
    assert.equal(row('alpha', 'one').effortsKnown, true)
    assert.deepEqual(row('beta', 'one').efforts.map((effort) => effort.id), ['minimal', 'high'])

    // 调整顺序
    const reordered = await call('POST', '/api/dsh-model-failover/settings', {
      order: [
        { provider: 'beta', model: 'one', reasoningEffort: 'minimal' },
        { provider: 'alpha', model: 'one' },
      ],
      resetHour: 5,
      continueText: '接着做',
    })
    assert.deepEqual(reordered.json.settings.order.map((item) => item.provider), ['beta', 'alpha'])
    assert.equal(reordered.json.settings.order[0].reasoningEffort, 'minimal', '每个候选的档位要能存下来')
    assert.equal('reasoningEffort' in reordered.json.settings.order[1], false, '没设档位的候选不该多个空字段')
    assert.equal(reordered.json.settings.resetHour, 5)
    assert.equal(reordered.json.settings.continueText, '接着做')

    // 空白档位等于「没设」：下拉框回到「默认档位」时就是这条路径。
    const blank = await call('POST', '/api/dsh-model-failover/settings', {
      order: [{ provider: 'beta', model: 'one', reasoningEffort: '  ' }, { provider: 'alpha', model: 'one' }],
    })
    assert.equal('reasoningEffort' in blank.json.settings.order[0], false, '空白档位应被收敛成「没设」')

    // 非法值被就地修好，而不是留给执行路径
    const clamped = await call('POST', '/api/dsh-model-failover/settings', { resetHour: 99, eventLogLimit: 0 })
    assert.equal(clamped.json.settings.resetHour, 1, '非法的重置时间应回落到默认值')
    assert.equal(clamped.json.settings.eventLogLimit, DEFAULT_SETTINGS.eventLogLimit)

    // 隔离名单 + 解除
    const quarantined = await call('POST', '/api/dsh-model-failover/reset', {})
    assert.equal(quarantined.json.quarantined.length, 0)

    const unknown = await call('GET', '/api/dsh-model-failover/nope')
    assert.equal(unknown.status, 404)

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

// 14 · 「自动继续」的宿主接线
await check('宿主半身：本轮失败 / 输出撞上限时自动补发「继续」', async () => {
  const freshHome = mkdtempSync(join(tmpdir(), 'model-failover-auto-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = freshHome
  try {
    const llm = createLlm(new Map())
    llm.register('alpha', [{ id: 'one', name: 'Alpha One' }])
    llm.registerAdapter = () => () => {}
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

    // ── 设置真的能摁住它 ────────────────────────────────────────────────────
    const off = await call('POST', '/api/dsh-model-failover/settings', { autoContinue: false })
    assert.equal(off.status, 200)
    assert.equal(off.json.settings.autoContinue, false)

    fire('turn/start', { turn: 5 })
    fire('turn/end', { turn: 5, reason: { kind: 'max-tokens' } })
    fire('turn/end', { turn: 5, reason: { kind: 'error', error: { code: 'SERVER' } } })
    await settle()
    assert.equal(sent.length, 2, '总开关关掉后不该再补发')

    // 只关「输出撞上限」，失败照补。
    const partial = await call('POST', '/api/dsh-model-failover/settings', {
      autoContinue: true,
      autoContinueOnMaxTokens: false,
    })
    assert.equal(partial.status, 200)
    assert.equal(partial.json.settings.autoContinueOnMaxTokens, false)

    fire('turn/start', { turn: 6 })
    fire('turn/end', { turn: 6, reason: { kind: 'max-tokens' } })
    await settle()
    assert.equal(sent.length, 2, '分项关掉后撞上限不该补发')

    fire('turn/start', { turn: 7 })
    fire('turn/end', { turn: 7, reason: { kind: 'error', error: { code: 'SERVER' } } })
    await settle()
    assert.equal(sent.length, 3, '本轮失败仍应补发')
    assert.equal(sent[2].content[0].text, '继续')
  } finally {
    process.env.DSH_HOME = previous
    rmSync(freshHome, { recursive: true, force: true })
  }
})

rmSync(HOME, { recursive: true, force: true })

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exitCode = failed === 0 ? 0 : 1
