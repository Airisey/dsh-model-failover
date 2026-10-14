/**
 * 真宿主契约测试：把插件挂进**真的** `@deepseek-ai/dsh-llm` 注册表，用真注册表、
 * 真 waterfall、真校验函数跑一次完整交接。
 *
 * 为什么需要它：`test/smoke.mjs` 里的 `ctx.llm` 是手写的替身，它**不会**替宿主做
 * 校验。dsh 对适配器返回值的检查（`INVALID_ADAPTER` / `INVALID_CATALOG` /
 * `INVALID_MODEL_INFO` / `INVALID_MODEL_CONTEXT` / `UNSUPPORTED_REASONING_EFFORT`）
 * 只有真 LlmRuntime 才会执行；形状写错时插件是**装不进去**的，而不是跑错结果。
 * 这个测试把「装得进去 + 交得下去」这件事钉死。
 *
 * 依赖：本机 `_dsh-research/` 下从 app.asar 里解出来的 dsh 包（含 cordis）。
 * 找不到时整份跳过并以 0 退出——它不是插件运行时的依赖，只是一层额外校验。
 * 用 `DSH_LLM_HOST_DIR` 指向包含 `@deepseek-ai/` 的那个 node_modules 目录即可换位置。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DIRS = [
  process.env.DSH_LLM_HOST_DIR,
  'C:/Users/superv/Documents/deepseek-harness/default-workspace/_dsh-research/dsh/node_modules',
].filter((dir) => typeof dir === 'string' && dir !== '')

const hostDir = DIRS.find((dir) =>
  existsSync(join(dir, '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')) &&
  existsSync(join(dir, '@deepseek-ai', 'cordis', 'lib', 'index.js')),
)

if (hostDir === undefined) {
  console.log('真宿主契约测试：跳过（没找到解出来的 @deepseek-ai/cordis + @deepseek-ai/dsh-llm）')
  console.log(`  找过：${DIRS.join('、')}`)
  console.log('  想跑的话，把 DSH_LLM_HOST_DIR 指向包含 @deepseek-ai/ 的 node_modules 目录。')
  process.exit(0)
}

const base = pathToFileURL(join(hostDir, '@deepseek-ai')).href + '/'
const { Context } = await import(`${base}cordis/lib/index.js`)
const { LlmAdapter, LlmRuntime } = await import(`${base}dsh-llm/lib/index.js`)
const plugin = await import(new URL('../index.js', import.meta.url).href)

const ROUTE = 'model-failover'

let passed = 0
let failed = 0
async function check(name, body) {
  try {
    await body()
    passed += 1
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ❌ ${name}`)
    console.log(`     ${error?.message ?? error}`)
  }
}

/** 一个只吐脚本结果的适配器，同时记录自己被怎么调用。 */
class StubAdapter extends LlmAdapter {
  constructor(label, script) {
    super()
    this.label = label
    this.script = script
    this.calls = []
  }
  providerInfo(provider) {
    return { id: provider, name: `Stub ${provider}` }
  }
  async listModels(provider) {
    return this.models.map((id) => ({ provider, id, name: `${provider} ${id}` }))
  }
  async resolveModel(provider, model) {
    const info = { provider, id: model, name: `${provider} ${model}`, context: { contextWindow: 128000 } }
    // 每个候选自己的思考强度档位表（真实适配器由它自己声明）。
    if (this.efforts !== undefined) info.reasoning = { efforts: this.efforts, defaultEffort: this.efforts[0].id }
    return info
  }
  async *stream(options) {
    this.calls.push(options)
    const outcome = this.script(options, this.calls.length)
    if (outcome.kind === 'error') {
      yield { type: 'finish', reason: { kind: 'error', failure: outcome.failure } }
      return
    }
    if (outcome.partial !== undefined) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: outcome.partial }
    }
    if (outcome.kind === 'after-partial-error') {
      yield { type: 'finish', reason: { kind: 'error', failure: outcome.failure } }
      return
    }
    yield { type: 'block-start', index: outcome.partial === undefined ? 0 : 1, blockType: 'text' }
    yield { type: 'text-delta', index: outcome.partial === undefined ? 0 : 1, text: outcome.text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const QUOTA = { kind: 'error', failure: { message: '余额不足', code: 'QUOTA' } }
const OK = (text) => ({ kind: 'text', text })

/** 本机 DNS 挂了 —— message 逐字抄自 2026-10-14 的真实事件日志，code 却是 SERVER。 */
const LOCAL_NETWORK = {
  kind: 'error',
  failure: {
    message: 'workbuddy: cannot resolve tunnel destination www.workbuddy.ai (ENOTFOUND): local name resolution failed',
    code: 'SERVER',
  },
}

/** 远端 5xx：不是本机网络问题，该照常带「继续」。 */
const UPSTREAM_5XX = { kind: 'error', failure: { message: 'upstream returned 502 Bad Gateway', code: 'SERVER' } }

const lastText = (messages) =>
  messages
    .at(-1)
    .content.filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')

const shape = (messages) =>
  messages.map((message) => `${message.role}:${message.content.map((b) => b.text ?? b.type).join('+')}`).join(' → ')

/**
 * 起一个真注册表：两个候选 provider + 插件自己。
 * @param {{order: Array<{provider: string, model: string}>, adapters: Record<string, StubAdapter>, settings?: object, efforts?: Record<string, Array<{id: string, name?: string}>>}} spec
 */
async function boot(spec) {
  const home = mkdtempSync(join(tmpdir(), 'failover-real-'))
  const dataDir = join(home, 'dsh-model-failover')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(
    join(dataDir, 'settings.json'),
    JSON.stringify({
      enabled: true,
      bootstrapped: true,
      order: spec.order,
      resetHour: 1,
      continueText: '继续',
      retrySameModelOnce: true,
      ...spec.settings,
    }),
  )

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const app = new Context()
  new LlmRuntime(app)
  for (const [provider, adapter] of Object.entries(spec.adapters)) {
    adapter.models = ['one', 'two']
    adapter.efforts = spec.efforts?.[provider]
    app.llm.registerAdapter([provider], adapter)
  }
  app.plugin(plugin)
  await new Promise((resolve) => setTimeout(resolve, 50))

  return {
    app,
    dataDir,
    async stream(model = 'auto', extra = {}) {
      const chunks = []
      for await (const chunk of app.llm.stream({
        provider: ROUTE,
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: '写一首诗' }] }],
        ...extra,
      })) {
        chunks.push(chunk)
      }
      return {
        chunks,
        text: chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''),
        finish: chunks.at(-1),
      }
    },
    state() {
      return JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))
    },
    dispose() {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    },
  }
}

console.log(`真宿主契约测试（${hostDir}）`)

await check('真注册表：路由挂得上，目录条目也报得出来', async () => {
  const alpha = new StubAdapter('alpha', () => OK('不该到这里'))
  const h = await boot({ order: [{ provider: 'alpha', model: 'one' }], adapters: { alpha } })
  try {
    const providers = await h.app.llm.listProviders()
    assert.ok(
      providers.some((p) => p.id === ROUTE && p.name === '模型接力'),
      `注册表里没有 ${ROUTE}：${JSON.stringify(providers)}`,
    )
    const directory = h.app.llm.listConfigurableProviders()
    assert.ok(
      directory.some((e) => e.provider === ROUTE && e.displayName === '模型接力'),
      `目录里没有接力路由：${JSON.stringify(directory)}`,
    )
  } finally {
    h.dispose()
  }
})

await check('真注册表：宿主校验放行 listModels / resolveModelInfo / retryPolicy', async () => {
  const alpha = new StubAdapter('alpha', () => OK('好'))
  const h = await boot({ order: [{ provider: 'alpha', model: 'one' }], adapters: { alpha } })
  try {
    const models = await h.app.llm.listModels(ROUTE)
    assert.equal(models.length, 1)
    assert.equal(models[0].id, 'auto')

    const info = await h.app.llm.resolveModelInfo(ROUTE, 'auto')
    assert.equal(info.id, 'auto')
    assert.equal(info.context.contextWindow, 128000, '应报队列里最窄的上下文窗口')

    // 宿主把适配器给的 retryPolicy 原样采用，llm-retry 读的是顶层字段。
    const policy = h.app.llm.providerRetryPolicy(ROUTE)
    assert.equal(policy.mode, 'normal')
    assert.equal(policy.maxRetries, 0)
    assert.equal(typeof policy.initialDelayMs, 'number')
    assert.equal(typeof policy.maxDelayMs, 'number')
    assert.equal(typeof policy.jitterRatio, 'number')
    assert.equal('backoff' in policy, false)
  } finally {
    h.dispose()
  }
})

await check('真宿主：队列的档位并集过得了宿主校验，不认识的档位被宿主挡下', async () => {
  const alpha = new StubAdapter('alpha', () => OK('好'))
  const beta = new StubAdapter('beta', () => OK('好'))
  const h = await boot({
    order: [
      { provider: 'alpha', model: 'one' },
      { provider: 'beta', model: 'one' },
    ],
    adapters: { alpha, beta },
    efforts: {
      alpha: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }],
      beta: [{ id: 'minimal', name: '最小' }],
    },
  })
  try {
    // 这条路由要面对一串各有各档位表的模型，所以对外声明的是并集 —— 下面这段
    // 交给宿主的**真**校验器（resolveCallConfig / UNSUPPORTED_REASONING_EFFORT）
    // 去判，形状写错的话插件是装不进去的。
    const info = await h.app.llm.resolveModelInfo(ROUTE, 'auto')
    assert.deepEqual(
      info.reasoning.efforts.map((effort) => effort.id),
      ['low', 'high', 'minimal'],
      `对外应声明队列里出现过的档位并集：${JSON.stringify(info.reasoning)}`,
    )

    const prepared = await h.app.llm.prepareCall({ provider: ROUTE, model: 'auto', reasoningEffort: 'minimal' })
    assert.equal(prepared.config.reasoningEffort, 'minimal', '队列里出现过的档位应放行')

    await assert.rejects(
      () => h.app.llm.prepareCall({ provider: ROUTE, model: 'auto', reasoningEffort: '不存在的档位' }),
      (error) => {
        assert.equal(error?.code, 'UNSUPPORTED_REASONING_EFFORT', `挡下时的错误码不对：${error?.code} ${error?.message}`)
        return true
      },
    )
  } finally {
    h.dispose()
  }
})

await check('真宿主：每个候选只收到它自己认识的档位，别的模型不会收到漏过来的档位', async () => {
  const alpha = new StubAdapter('alpha', () => QUOTA)
  const beta = new StubAdapter('beta', () => OK('换我上'))
  const h = await boot({
    order: [
      { provider: 'alpha', model: 'one', reasoningEffort: 'high' },
      // beta 只认 minimal：给它设的 high 不该发下去，也不该被「继续」那一轮带过去。
      { provider: 'beta', model: 'one', reasoningEffort: 'high' },
    ],
    adapters: { alpha, beta },
    efforts: {
      alpha: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }],
      // 真宿主会拒掉没有 name 的档位（INVALID_MODEL_REASONING），所以替身适配器
      // 也必须像真适配器那样每个档位都带名字。
      beta: [{ id: 'minimal', name: '最小' }],
    },
  })
  try {
    const result = await h.stream()
    assert.equal(result.text, '换我上')

    assert.equal(alpha.calls.length, 2)
    assert.equal(alpha.calls[0].reasoningEffort, 'high', 'alpha 认识 high，应原样收到')
    assert.equal(alpha.calls[1].reasoningEffort, 'high', '「继续」那一轮也还是这个档位')

    assert.equal(beta.calls.length, 1)
    // 宿主会把候选模型**自己的** defaultEffort 落到 options 上，所以即使我们删掉
    // 这个字段，beta 仍可能收到它自己的默认档位（minimal）—— 那正是「不指定就用
    // 它平时的档位」的等价物。这里要钉死的是：它绝不会收到别人家的档位。
    assert.notEqual(beta.calls[0].reasoningEffort, 'high', 'beta 不认识 high，绝不能收到这个值')
    assert.ok(
      beta.calls[0].reasoningEffort === undefined || beta.calls[0].reasoningEffort === 'minimal',
      `beta 只该收到自己声明的档位，实际收到 ${beta.calls[0].reasoningEffort}`,
    )
  } finally {
    h.dispose()
  }
})

await check('真宿主：路由级的档位只在候选没专设、且它认识时下发', async () => {
  const alpha = new StubAdapter('alpha', () => QUOTA)
  const beta = new StubAdapter('beta', () => OK('换我上'))
  const h = await boot({
    order: [
      { provider: 'alpha', model: 'one' },
      { provider: 'beta', model: 'one' },
    ],
    adapters: { alpha, beta },
    efforts: {
      alpha: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }],
      // 真宿主会拒掉没有 name 的档位（INVALID_MODEL_REASONING），所以替身适配器
      // 也必须像真适配器那样每个档位都带名字。
      beta: [{ id: 'minimal', name: '最小' }],
    },
  })
  try {
    // 调用方（模型选择器）给「模型接力」选了 minimal：alpha 不认，beta 认。
    const result = await h.stream('auto', { reasoningEffort: 'minimal' })
    assert.equal(result.text, '换我上')

    // alpha 不认识 minimal：绝不能收到它（宿主会把 alpha 自己的默认档位补上，
    // 那是等价的，所以这里只钉「收到的绝不是别人家的档位」）。
    assert.notEqual(alpha.calls[0].reasoningEffort, 'minimal', 'alpha 不认识 minimal，不该发')
    assert.ok(
      alpha.calls[0].reasoningEffort === undefined || alpha.calls[0].reasoningEffort === 'low',
      `alpha 只该收到自己声明的档位，实际收到 ${alpha.calls[0].reasoningEffort}`,
    )
    assert.equal(beta.calls[0].reasoningEffort, 'minimal', 'beta 认识 minimal，应收到')
  } finally {
    h.dispose()
  }
})

await check('真注册表：一个模型两次不行就换下一个，两次都带「继续」且保留原始请求', async () => {
  const alpha = new StubAdapter('alpha', () => QUOTA)
  const beta = new StubAdapter('beta', () => OK('beta 顶上'))
  const h = await boot({
    order: [
      { provider: 'alpha', model: 'one' },
      { provider: 'beta', model: 'one' },
    ],
    adapters: { alpha, beta },
  })
  try {
    const result = await h.stream()
    assert.equal(result.text, 'beta 顶上')
    assert.deepEqual(result.finish, { type: 'finish', reason: { kind: 'stop' } })

    assert.equal(alpha.calls.length, 2, `alpha 应被叫两次（首发 + 一次「继续」），实际 ${alpha.calls.length}`)
    assert.equal(beta.calls.length, 1)

    // 首发是干净的原始请求，重试与换人都在原请求后面追加「继续」。
    assert.equal(shape(alpha.calls[0].messages), 'user:写一首诗')
    assert.equal(shape(alpha.calls[1].messages), 'user:写一首诗 → user:继续')
    assert.equal(shape(beta.calls[0].messages), 'user:写一首诗 → user:继续')
  } finally {
    h.dispose()
  }
})

await check('真注册表：换人按队列顺序走，前一个模型被隔离', async () => {
  const alpha = new StubAdapter('alpha', () => QUOTA)
  const beta = new StubAdapter('beta', (_options, turn) => (turn === 1 ? QUOTA : OK('轮到我了')))
  const h = await boot({
    order: [
      { provider: 'alpha', model: 'one' },
      { provider: 'beta', model: 'one' },
      { provider: 'beta', model: 'two' },
    ],
    adapters: { alpha, beta },
  })
  try {
    const result = await h.stream()
    assert.equal(result.text, '轮到我了')
    assert.equal(alpha.calls.length, 2)
    assert.equal(beta.calls.length, 2, 'beta/one 两次，然后成功')

    const state = h.state()
    assert.ok(state.quarantine[`${'alpha'}\u0000one`], `当天隔离里应有 alpha/one：${JSON.stringify(state)}`)
    assert.ok(state.good[`${'beta'}\u0000one`], 'beta/one 应记成已验证可用')
    assert.equal(state.quarantine[`${'beta'}\u0000one`], undefined, '成功的模型不该被隔离')
  } finally {
    h.dispose()
  }
})

await check('真注册表：当天被判定不行的模型，下一个任务不再从它开始', async () => {
  const alpha = new StubAdapter('alpha', () => QUOTA)
  const beta = new StubAdapter('beta', () => OK('我还是顶上'))
  const h = await boot({
    order: [
      { provider: 'alpha', model: 'one' },
      { provider: 'beta', model: 'one' },
    ],
    adapters: { alpha, beta },
  })
  try {
    await h.stream()
    assert.equal(alpha.calls.length, 2)

    const second = await h.stream()
    assert.equal(second.text, '我还是顶上')
    assert.equal(alpha.calls.length, 2, '同一天里第二个任务不该再碰 alpha')
    assert.equal(beta.calls.length, 2)
    // 第二个任务是从「验证过能用」的那一个直接开始的，不必先带「继续」。
    assert.equal(shape(beta.calls[1].messages), 'user:写一首诗')
  } finally {
    h.dispose()
  }
})

await check('真注册表：已经吐出正文之后就不换人了，错误照实上报', async () => {
  const gamma = new StubAdapter('gamma', () => ({
    kind: 'after-partial-error',
    partial: '我先写了一半',
    failure: { message: '上游断了', code: 'SERVER' },
  }))
  const delta = new StubAdapter('delta', () => OK('不该轮到我'))
  const h = await boot({
    order: [
      { provider: 'gamma', model: 'one' },
      { provider: 'delta', model: 'one' },
    ],
    adapters: { gamma, delta },
  })
  try {
    const result = await h.stream()
    assert.equal(result.text, '我先写了一半')
    assert.equal(result.finish.reason.kind, 'error')
    assert.equal(result.finish.reason.failure.code, 'SERVER')
    assert.equal(delta.calls.length, 0, '正文已经出去了，换人会把两段话拼在一起')
  } finally {
    h.dispose()
  }
})

await check('真注册表：本机网络故障时不带「继续」，但远端 5xx 照带', async () => {
  const alpha = new StubAdapter('alpha', () => LOCAL_NETWORK)
  const beta = new StubAdapter('beta', () => OK('网络回魂了'))
  const h = await boot({
    order: [
      { provider: 'alpha', model: 'one' },
      { provider: 'beta', model: 'one' },
    ],
    adapters: { alpha, beta },
  })
  try {
    const result = await h.stream()
    assert.equal(result.text, '网络回魂了')

    // 本机网络没通：alpha 的两跳、以及换到 beta 的那一跳，都不该带「继续」。
    for (const call of [...alpha.calls, ...beta.calls]) {
      assert.equal(shape(call.messages), 'user:写一首诗', '本机网络故障时不该往请求里追加「继续」')
    }
  } finally {
    h.dispose()
  }

  // 对照组：同样 code=SERVER，但 message 是远端 5xx —— 该照常带「继续」。
  const gamma = new StubAdapter('gamma', () => UPSTREAM_5XX)
  const delta = new StubAdapter('delta', () => OK('顶上了'))
  const h2 = await boot({
    order: [
      { provider: 'gamma', model: 'one' },
      { provider: 'delta', model: 'one' },
    ],
    adapters: { gamma, delta },
  })
  try {
    const result = await h2.stream()
    assert.equal(result.text, '顶上了')
    assert.equal(shape(gamma.calls[1].messages), 'user:写一首诗 → user:继续', '远端 5xx 该带「继续」重发')
    assert.equal(shape(delta.calls[0].messages), 'user:写一首诗 → user:继续', '换人也该带「继续」')
  } finally {
    h2.dispose()
  }
})

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
