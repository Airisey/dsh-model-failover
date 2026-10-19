/**
 * 「自动继续」（lib/autocontinue.js）的行为测试。
 *
 * 全部是纯内存桩：一个假会话、一个假 agents 服务、一个假设置读取器。
 * 这里验的是**判定与节流**，不碰网络也不碰 dsh 内核。
 *
 * 跑法：node test/autocontinue.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须早于任何 import —— store.js 的 dataDir() 读的是这个环境变量。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'model-failover-auto-'))

const { AutoContinue, autoContinueTrigger, autoContinueLimitFor, continueUserMessage, AUTO_CONTINUE_SKIP_CODES } =
  await import('../lib/autocontinue.js')
const { LOCAL_NETWORK_CODES, isLocalNetworkFailure } = await import('../lib/network.js')
const { TurnNotes } = await import('../lib/notes.js')
const { DEFAULT_SETTINGS } = await import('../lib/constants.js')
const { normalizeSettings } = await import('../index.js')

// ── 小工具 ──────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    process.stdout.write(`  ✓ ${name}\n`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    process.stdout.write(`  ✗ ${name}\n      ${error?.message ?? error}\n`)
  }
}

/** 让 `void this.#deliver(...)` 里的 await 全部落定。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const settingsOf = (overrides = {}) => ({ ...DEFAULT_SETTINGS, ...overrides })

/**
 * 造一套最小可用的桩：会话 + agents 服务 + 设置读取器。
 *
 * @param {object} [options]
 * @param {any} [options.settings] - 覆盖后的设置。
 * @param {'idle' | 'running'} [options.status] - 会话此刻的阶段。
 * @param {boolean} [options.hasPending] - 收件箱里是否已经有用户消息。
 * @param {() => number} [options.now] - 覆盖时钟。
 * @param {number} [options.pendingTtlMs] - 覆盖标记有效期。
 * @param {(ms: number) => Promise<void>} [options.sleep] - 覆盖等待实现。
 * @param {any} [options.notes] - 轮尾便签收集器（TurnNotes）；不传就不记。
 */
function makeHarness({ settings = settingsOf(), status = 'idle', hasPending = false, now, pendingTtlMs, sleep, notes } = {}) {
  const session = { id: 's1' }
  const sent = []
  const agent = {
    status,
    inbox: { get hasPending() { return hasPending } },
    idleWaited: 0,
    async whenIdle() { this.idleWaited += 1 },
    followup(message) { sent.push(message) },
  }
  const agents = {
    get: (id) => (id === session.id ? agent : undefined),
  }
  const events = []
  const warnings = []
  // 真的等 5 秒会让整套测试慢得没法跑；记下每次等待的时长，立刻返回。
  const waits = []
  const auto = new AutoContinue({
    agents,
    settings: { get: () => settings },
    log: { info: () => {}, warn: (m) => warnings.push(m), push: (e) => events.push(e) },
    ...(now === undefined ? {} : { now }),
    ...(pendingTtlMs === undefined ? {} : { pendingTtlMs }),
    ...(notes === undefined ? {} : { notes }),
    sleep: sleep ?? (async (ms) => { waits.push(ms) }),
  })
  const end = (reason, turn = 1) => ({ type: 'turn/end', data: { turn, reason } })
  /** 驱动开始跑一轮 —— 我们的 followup 和用户手敲的消息都会产生它。 */
  const start = (turn = 1) => ({ type: 'turn/start', data: { turn } })
  return { session, agent, agents, sent, events, warnings, auto, end, start, settings, waits }
}

// ── 触发判定（纯函数） ──────────────────────────────────────────────────────

process.stdout.write('autocontinue: 触发判定\n')

await check('输出撞上限 → 触发，原因是 max-tokens', () => {
  assert.equal(autoContinueTrigger({ kind: 'max-tokens' }, settingsOf()), 'max-tokens')
})

await check('本轮报错 → 触发，原因是 error', () => {
  assert.equal(autoContinueTrigger({ kind: 'error', error: { code: 'RATE_LIMIT' } }, settingsOf()), 'error')
})

await check('正常结束 / 被用户中止 / 空 reason → 都不触发', () => {
  assert.equal(autoContinueTrigger({ kind: 'completed' }, settingsOf()), undefined)
  assert.equal(autoContinueTrigger({ kind: 'aborted' }, settingsOf()), undefined)
  assert.equal(autoContinueTrigger(undefined, settingsOf()), undefined)
  assert.equal(autoContinueTrigger(null, settingsOf()), undefined)
})

await check('总开关关掉后，两种触发都失效', () => {
  const off = settingsOf({ autoContinue: false })
  assert.equal(autoContinueTrigger({ kind: 'max-tokens' }, off), undefined)
  assert.equal(autoContinueTrigger({ kind: 'error', error: { code: 'RATE_LIMIT' } }, off), undefined)
})

await check('两个分项开关各自独立生效', () => {
  const noMax = settingsOf({ autoContinueOnMaxTokens: false })
  assert.equal(autoContinueTrigger({ kind: 'max-tokens' }, noMax), undefined)
  assert.equal(autoContinueTrigger({ kind: 'error', error: { code: 'SERVER' } }, noMax), 'error')

  const noErr = settingsOf({ autoContinueOnFailure: false })
  assert.equal(autoContinueTrigger({ kind: 'error', error: { code: 'SERVER' } }, noErr), undefined)
  assert.equal(autoContinueTrigger({ kind: 'max-tokens' }, noErr), 'max-tokens')
})

await check('上下文超长 / 没有适配器 / 凭证无效 → 不触发（重发也是同样的报错）', async () => {
  for (const code of AUTO_CONTINUE_SKIP_CODES) {
    assert.equal(
      autoContinueTrigger({ kind: 'error', error: { code } }, settingsOf()),
      undefined,
      `${code} 不该触发`,
    )
  }
  // 额度/限流类恰恰是要救回来的那批，必须在触发集合里。
  // 注意 TIMEOUT / TRANSPORT 不在此列 —— 它们是链路层失败，走本机网络那条规则。
  for (const code of ['QUOTA_EXCEEDED', 'ACCOUNT_QUOTA_EXCEEDED', 'RATE_LIMIT', 'SERVER', 'EMPTY_RESPONSE']) {
    assert.equal(autoContinueTrigger({ kind: 'error', error: { code } }, settingsOf()), 'error', `${code} 应该触发`)
  }
})

// ── 本机网络问题不补发 ──────────────────────────────────────────────────────

process.stdout.write('autocontinue: 本机网络问题不补发「继续」\n')

await check('链路层错误码（TRANSPORT）→ 不触发', () => {
  for (const code of LOCAL_NETWORK_CODES) {
    assert.equal(isLocalNetworkFailure({ code }), true, `${code} 应判为本机网络`)
    assert.equal(
      autoContinueTrigger({ kind: 'error', error: { code } }, settingsOf()),
      undefined,
      `${code} 不该触发补发`,
    )
  }
})

await check('TIMEOUT 不算本机网络 —— 握手都成功了，更像远端太慢', () => {
  assert.equal(isLocalNetworkFailure({ code: 'TIMEOUT' }), false)
  assert.equal(isLocalNetworkFailure({ code: 'TIMEOUT', message: 'stream idle timeout after 300000ms' }), false)
  assert.equal(
    autoContinueTrigger({ kind: 'error', error: { code: 'TIMEOUT' } }, settingsOf()),
    'error',
    'TIMEOUT 应该照常补发',
  )
})

await check('实测过的本机故障文本 → 不触发（哪怕 code 是 SERVER / UNKNOWN）', () => {
  // 这些字符串逐字抄自 2026-10-14 的真实事件日志。
  const real = [
    ['SERVER', 'workbuddy: {"error":"cannot resolve tunnel destination www.workbuddy.ai (ENOTFOUND): local name resolution failed — the local resolver may be unreachable or taken over by another DNS service (VPN/MagicDNS); route egress through an upstream proxy to have the destination resolved remotely","code":"tunnel_destination_denied","detail":"unresolvable"}'],
    ['SERVER', 'raccoon: code=tunnel_destination_denied cannot resolve tunnel destination xiaohuanxiong.com (ENOTFOUND): local name resolution failed'],
    ['TRANSPORT', 'trae: transport error: fetch failed'],
    ['UNKNOWN', 'CodeArts token request network error: TypeError: fetch failed'],
    ['SERVER', '502 "cannot resolve tunnel destination api.qnaigc.com (ENOTFOUND): local name resolution failed"'],
    ['TRANSPORT', 'qoder: transport error: fetch failed'],
    ['SERVER', 'zcode: HTTP 502：{"error":"cannot resolve tunnel destination zcode.z.ai (ENOTFOUND)"'],
  ]
  for (const [code, message] of real) {
    const failure = { code, message }
    assert.equal(isLocalNetworkFailure(failure), true, `应判为本机网络：${message.slice(0, 60)}`)
    assert.equal(
      autoContinueTrigger({ kind: 'error', error: failure }, settingsOf()),
      undefined,
      `不该触发补发：${message.slice(0, 60)}`,
    )
  }
})

await check('本机证书拦截（这台机器上真实存在）→ 不触发', () => {
  const failure = {
    code: 'TRANSPORT',
    message: 'fetch failed: unable to verify the first certificate; if the root CA is installed locally, try running Node.js with --use-system-ca',
  }
  assert.equal(isLocalNetworkFailure(failure), true)
  assert.equal(autoContinueTrigger({ kind: 'error', error: failure }, settingsOf()), undefined)
})

await check('连接被本机拒掉 / 掐断 → 不触发', () => {
  for (const message of [
    'connect ECONNREFUSED 127.0.0.1:7890',
    'socket hang up',
    'other side closed',
    'premature close',
  ]) {
    assert.equal(isLocalNetworkFailure({ code: 'TRANSPORT', message }), true, message)
  }
  assert.equal(isLocalNetworkFailure({ code: 'SERVER', message: 'read ECONNRESET' }), true)
})

await check('远端的问题不能被误判成本机网络（否则会漏掉该救的失败）', () => {
  const remote = [
    ['SERVER', 'upstream returned 502 Bad Gateway'],
    ['RATE_LIMIT', 'rate limit exceeded, retry after 20s'],
    ['QUOTA', 'insufficient balance'],
    ['EMPTY_RESPONSE', 'model returned no content'],
    ['SERVER', 'model is overloaded, please try again'],
    ['UNKNOWN', 'the model produced an invalid tool call'],
    ['SERVER', 'proxy returned a malformed response body'],
    // 裸的 timeout / 超时不算 —— 握手已经成功，重发一次是有意义的。
    ['TIMEOUT', 'request timed out after 300s'],
    ['SERVER', 'connect ETIMEDOUT 1.2.3.4:443'],
  ]
  for (const [code, message] of remote) {
    assert.equal(isLocalNetworkFailure({ code, message }), false, `不该判为本机网络：${message}`)
    assert.equal(
      autoContinueTrigger({ kind: 'error', error: { code, message } }, settingsOf()),
      'error',
      `应该照常补发：${message}`,
    )
  }
})

await check('形状异常时安全返回 false（不抛异常）', () => {
  assert.equal(isLocalNetworkFailure(undefined), false)
  assert.equal(isLocalNetworkFailure(null), false)
  assert.equal(isLocalNetworkFailure('ECONNREFUSED'), false)
  assert.equal(isLocalNetworkFailure({}), false)
  assert.equal(isLocalNetworkFailure({ code: 'SERVER' }), false)
  assert.equal(isLocalNetworkFailure({ message: 'ENOTFOUND' }), true, '没有 code 时只看 message')
})

await check('撞上限不受本机网络规则影响（它压根不是 error）', () => {
  assert.equal(autoContinueTrigger({ kind: 'max-tokens' }, settingsOf()), 'max-tokens')
})

// ── 消息形状 ────────────────────────────────────────────────────────────────

process.stdout.write('autocontinue: 补发的消息形状\n')

await check('是一条 role=user 的文本消息，带唯一 id 与 source.kind=user', () => {
  const a = continueUserMessage('继续')
  const b = continueUserMessage('继续')
  assert.equal(a.role, 'user')
  assert.deepEqual(a.content, [{ type: 'text', text: '继续' }])
  assert.deepEqual(a.source, { kind: 'user' })
  assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.notEqual(a.id, b.id)
})

// ── 端到端（桩） ────────────────────────────────────────────────────────────

process.stdout.write('autocontinue: 通过 attach 监听会话事件\n')

await check('attach 返回卸载函数，且监听的是 session/event', () => {
  const h = makeHarness()
  const listeners = new Map()
  const ctx = {
    on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) },
  }
  const off = h.auto.attach(ctx)
  assert.equal(typeof off, 'function')
  assert.ok(listeners.has('session/event'))

  listeners.get('session/event')(h.session, h.end({ kind: 'max-tokens' }))
  off()
  assert.equal(listeners.size, 0)
})

await check('输出撞上限 → 自动补发一条「继续」', async () => {
  const h = makeHarness()
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }))
  await settle()
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].content[0].text, '继续')
  assert.equal(h.sent[0].role, 'user')
  assert.equal(h.agent.idleWaited, 1, '必须等会话空闲再排下一轮')
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0].kind, 'auto-continue')
  assert.equal(h.events[0].trigger, 'max-tokens')
  assert.equal(h.events[0].turn, 1)
})

await check('本轮运行失败 → 自动补发一条「继续」', async () => {
  const h = makeHarness()
  h.auto.observe(h.session, h.end({ kind: 'error', error: { code: 'SERVER', message: 'boom' } }))
  await settle()
  assert.equal(h.sent.length, 1)
  assert.equal(h.events[0].trigger, 'error')
})

await check('正常结束 / 用户中止 → 一条都不发', async () => {
  const h = makeHarness()
  h.auto.observe(h.session, h.end({ kind: 'completed' }))
  h.auto.observe(h.session, h.end({ kind: 'aborted' }))
  await settle()
  assert.equal(h.sent.length, 0)
  assert.equal(h.events.length, 0)
})

await check('自定义 continueText 原样发出', async () => {
  const h = makeHarness({ settings: settingsOf({ continueText: '接着写' }) })
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }))
  await settle()
  assert.equal(h.sent[0].content[0].text, '接着写')
})

await check('continueText 是空白 → 退回默认「继续」', async () => {
  const h = makeHarness({ settings: settingsOf({ continueText: '   ' }) })
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }))
  await settle()
  assert.equal(h.sent[0].content[0].text, '继续')
})

// ── 补发节奏 ────────────────────────────────────────────────────────────────

process.stdout.write('autocontinue: 补发之前先等一等\n')

/**
 * 一个能卡住的假 sleep：记录时长，直到 `release()` 被调用才返回。
 *
 * 用真的定时器没法在「睡到一半」插进一条用户消息，而这段逻辑的全部价值
 * 恰恰在于睡醒之后发现情况变了。
 */
function gateSleep() {
  const waits = []
  let release = null
  const sleep = (ms) => new Promise((resolve) => { waits.push(ms); release = resolve })
  return { sleep, waits, release: () => release?.() }
}

await check('第一次失败也一样等：等完才把「继续」发出去', async () => {
  const gate = gateSleep()
  const h = makeHarness({ sleep: gate.sleep })
  h.auto.observe(h.session, h.end({ kind: 'error', error: { code: 'SERVER', message: 'boom' } }))
  await settle()
  assert.deepEqual(gate.waits, [5000], '默认等 5 秒')
  assert.equal(h.sent.length, 0, '还在等，不该已经发出去')

  gate.release()
  await settle()
  assert.equal(h.sent.length, 1, '等完之后照常补发')
})

await check('撞 token 上限同样要等', async () => {
  const gate = gateSleep()
  const h = makeHarness({ sleep: gate.sleep })
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }))
  await settle()
  assert.deepEqual(gate.waits, [5000])
  gate.release()
  await settle()
  assert.equal(h.sent.length, 1)
})

await check('等待时长跟着设置走；设成 0 就不等', async () => {
  const gate = gateSleep()
  const slow = makeHarness({ settings: settingsOf({ continueDelaySec: 30 }), sleep: gate.sleep })
  slow.auto.observe(slow.session, slow.end({ kind: 'error', error: { code: 'SERVER', message: 'boom' } }))
  await settle()
  assert.deepEqual(gate.waits, [30000])
  gate.release()

  const fast = makeHarness({ settings: settingsOf({ continueDelaySec: 0 }) })
  fast.auto.observe(fast.session, fast.end({ kind: 'error', error: { code: 'SERVER', message: 'boom' } }))
  await settle()
  assert.deepEqual(fast.waits, [], '设成 0 时一次都不该等')
  assert.equal(fast.sent.length, 1, '不等也要照常补发')
})

await check('等待期间用户自己发了一句 → 收手，不再补「继续」', async () => {
  const gate = gateSleep()
  const h = makeHarness({ sleep: gate.sleep })
  h.auto.observe(h.session, h.end({ kind: 'error', error: { code: 'SERVER', message: 'boom' } }))
  await settle()
  assert.deepEqual(gate.waits, [5000])

  // 用户不等我们，自己敲了一句 —— 这一轮由他发起。
  h.auto.observe(h.session, h.start(2))
  gate.release()
  await settle()
  assert.equal(h.sent.length, 0, '用户已经接手，再补一句就是往对话里灌噪音')
})

await check('等待期间那一轮已经跑完了 → 收手（此时 status 又回到 idle，光看它判不出来）', async () => {
  const gate = gateSleep()
  const h = makeHarness({ sleep: gate.sleep })
  h.auto.observe(h.session, h.end({ kind: 'error', error: { code: 'SERVER', message: 'boom' } }))
  await settle()

  // 会话自己接着跑完了一轮：状态回到 idle、收件箱也空了，只有世代能发现。
  h.auto.observe(h.session, h.end({ kind: 'completed' }, 2))
  assert.equal(h.agent.status, 'idle')
  gate.release()
  await settle()
  assert.equal(h.sent.length, 0)
})

await check('等待期间插件被卸载 → 收手', async () => {
  const gate = gateSleep()
  const h = makeHarness({ sleep: gate.sleep })
  const listeners = new Map()
  const off = h.auto.attach({ on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) } })
  listeners.get('session/event')(h.session, h.end({ kind: 'error', error: { code: 'SERVER', message: 'boom' } }))
  await settle()
  assert.deepEqual(gate.waits, [5000])

  off()
  gate.release()
  await settle()
  assert.equal(h.sent.length, 0, '卸载之后不该再往会话里塞消息')
})

// ── 节流 ────────────────────────────────────────────────────────────────────

process.stdout.write('autocontinue: 节流与计数\n')

await check('连着撞上限时最多补发 autoContinueMaxTokensLimit 次', async () => {
  const h = makeHarness({ settings: settingsOf({ autoContinueMaxTokensLimit: 3 }) })
  for (let i = 0; i < 5; i += 1) {
    h.auto.observe(h.session, h.end({ kind: 'max-tokens' }, i + 1))
    await settle()
  }
  assert.equal(h.sent.length, 3, '第 4、5 次必须停手')
  assert.equal(h.events.length, 3)
  assert.ok(h.warnings.some((w) => w.includes('上限')), '停手时要留下一条警告')
  assert.equal(h.auto.counts().get('s1')?.['max-tokens'], 3, '计数停在用满的位置，不清零')
})

await check('连着失败时最多补发 autoContinueFailureLimit 次（默认只补 1 次）', async () => {
  const h = makeHarness({ settings: settingsOf({ autoContinueFailureLimit: 1 }) })
  for (let i = 0; i < 4; i += 1) {
    h.auto.observe(h.session, h.end({ kind: 'error', error: { code: 'SERVER', message: 'upstream returned 502 Bad Gateway' } }, i + 1))
    await settle()
  }
  assert.equal(h.sent.length, 1, '失败只补一次，默认就是这个数')
  assert.equal(h.auto.counts().get('s1')?.error, 1)
  assert.equal(h.auto.counts().get('s1')?.['max-tokens'], undefined, '没撞过上限，那个桶就不该有')
})

await check('两个计数各算各的：撞上限用满 10 次，失败那 1 次仍然给', async () => {
  const h = makeHarness({ settings: settingsOf({ autoContinueMaxTokensLimit: 10, autoContinueFailureLimit: 1 }) })
  for (let i = 0; i < 12; i += 1) {
    h.auto.observe(h.session, h.end({ kind: 'max-tokens' }, i + 1))
    await settle()
  }
  assert.equal(h.sent.length, 10, '撞上限那 10 次用满')
  assert.equal(h.auto.counts().get('s1')?.['max-tokens'], 10)

  // 紧接着这一轮真失败了 —— 失败自己的额度一次都没用过，必须还给用户。
  h.auto.observe(h.session, h.end({ kind: 'error', error: { code: 'SERVER', message: 'upstream returned 502 Bad Gateway' } }, 13))
  await settle()
  assert.equal(h.sent.length, 11, '撞上限用满不该吃掉失败那一次')
  assert.equal(h.auto.counts().get('s1')?.error, 1)
})

await check('反过来也一样：失败用满之后，撞上限的次数还没动过', async () => {
  const h = makeHarness({ settings: settingsOf({ autoContinueMaxTokensLimit: 2, autoContinueFailureLimit: 1 }) })
  h.auto.observe(h.session, h.end({ kind: 'error', error: { code: 'SERVER', message: 'upstream returned 502 Bad Gateway' } }, 1))
  await settle()
  assert.equal(h.sent.length, 1)
  // 再失败一次：失败额度用满。
  h.auto.observe(h.session, h.end({ kind: 'error', error: { code: 'SERVER', message: 'upstream returned 502 Bad Gateway' } }, 2))
  await settle()
  assert.equal(h.sent.length, 1, '失败额度已用满')

  // 撞上限是另一份额度，一次都还没用过。
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }, 3))
  await settle()
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }, 4))
  await settle()
  assert.equal(h.sent.length, 3, '撞上限那两次都要补')
  assert.equal(h.auto.counts().get('s1')?.error, 1, '失败那个桶不动')
})

await check('autoContinueLimitFor 按触发原因取各自的数，坏设置回落到 1', () => {
  const s = settingsOf({ autoContinueMaxTokensLimit: 7, autoContinueFailureLimit: 2 })
  assert.equal(autoContinueLimitFor(s, 'max-tokens'), 7)
  assert.equal(autoContinueLimitFor(s, 'error'), 2)
  assert.equal(autoContinueLimitFor({}, 'max-tokens'), 1, '设置缺失时宁可少补')
  assert.equal(autoContinueLimitFor({ autoContinueFailureLimit: 0 }, 'error'), 1, '0 不是合法上限')
  assert.equal(autoContinueLimitFor({ autoContinueMaxTokensLimit: '9' }, 'max-tokens'), 1, '字符串不认')
})

await check('用户自己发下一句（turn/start）会重新计数', async () => {
  const h = makeHarness({ settings: settingsOf({ autoContinueMaxTokensLimit: 1 }) })
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }))
  await settle()
  // 驱动开始跑我们排进去的那一轮 —— 这一轮的 turn/start 是我们的。
  h.auto.observe(h.session, h.start(2))
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }))
  await settle()
  assert.equal(h.sent.length, 1, '第二次被上限拦住')

  // 用户手敲了一句 → 全新一轮。
  h.auto.observe(h.session, h.start(3))
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }))
  await settle()
  assert.equal(h.sent.length, 2, '用户发言之后应该又能补发')
})

await check('我们自己发起的那一轮不会把自己的计数清零', async () => {
  const h = makeHarness({ settings: settingsOf({ autoContinueMaxTokensLimit: 2 }) })
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }))
  await settle()
  h.auto.observe(h.session, h.start(2))
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }))
  await settle()
  assert.equal(h.sent.length, 2)
  // 第三次必须停手 —— 说明计数是连着累加的，没被自己的 turn/start 清掉。
  h.auto.observe(h.session, h.start(3))
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }))
  await settle()
  assert.equal(h.sent.length, 2)
})

await check('排进去的那一轮始终没跑起来 → 标记过期后不再算作「我们的轮」', async () => {
  let clock = 1_000_000
  const h = makeHarness({ settings: settingsOf({ autoContinueMaxTokensLimit: 1 }), now: () => clock })
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }))
  await settle()
  assert.equal(h.sent.length, 1)

  // 一分钟过去，那条 followup 根本没被执行（会话被关、驱动忙别的）。
  clock += 120_000
  h.auto.observe(h.session, h.start(2))
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }))
  await settle()
  assert.equal(h.sent.length, 2, '烂尾标记不该继续压着计数')
})

await check('一轮正常结束会把计数清零', async () => {
  const h = makeHarness({ settings: settingsOf({ autoContinueMaxTokensLimit: 1 }) })
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }))
  await settle()
  assert.equal(h.auto.counts().get('s1')?.['max-tokens'], 1)

  h.auto.observe(h.session, h.end({ kind: 'completed' }))
  assert.equal(h.auto.counts().has('s1'), false)

  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }))
  await settle()
  assert.equal(h.sent.length, 2)
})

await check('计数是按会话分开的', async () => {
  const h = makeHarness({ settings: settingsOf({ autoContinueMaxTokensLimit: 1 }) })
  const other = { id: 's2' }
  const otherSent = []
  // 必须是**同一个**对象 —— #deliver 会拿 agents.get() 的结果和手里的 agent 比对。
  const otherAgent = {
    status: 'idle',
    inbox: { hasPending: false },
    async whenIdle() {},
    followup: (m) => otherSent.push(m),
  }
  const original = h.agents.get
  h.agents.get = (id) => (id === 's2' ? otherAgent : original(id))

  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }))
  h.auto.observe(other, h.end({ kind: 'max-tokens' }))
  await settle()
  assert.equal(h.sent.length, 1)
  assert.equal(otherSent.length, 1, 's2 的额度不该被 s1 用掉')
})

// ── 不该打扰的情形 ──────────────────────────────────────────────────────────

process.stdout.write('autocontinue: 不该补发的情形\n')

await check('会话还在跑 / 收件箱里已经排了消息 → 不发', async () => {
  const running = makeHarness({ status: 'running' })
  running.auto.observe(running.session, running.end({ kind: 'max-tokens' }))
  await settle()
  assert.equal(running.sent.length, 0, '阶段不是 idle 就闭嘴')

  const queued = makeHarness({ hasPending: true })
  queued.auto.observe(queued.session, queued.end({ kind: 'max-tokens' }))
  await settle()
  assert.equal(queued.sent.length, 0, '用户已经排了下一句就别插队')
})

await check('会话已经不在 agents 服务里 → 不发', async () => {
  const h = makeHarness()
  h.agents.get = () => undefined
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }))
  await settle()
  assert.equal(h.sent.length, 0)
})

await check('followup 抛错不会把事件回调带崩', async () => {
  const h = makeHarness()
  h.agent.followup = () => { throw new Error('驱动已经关了') }
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }))
  await settle()
  assert.ok(h.warnings.some((w) => w.includes('驱动已经关了')))
})

await check('没有 id 的事件主体直接忽略', async () => {
  const h = makeHarness()
  h.auto.observe({}, h.end({ kind: 'max-tokens' }))
  await settle()
  assert.equal(h.sent.length, 0)
})

// ── 轮尾便签 ────────────────────────────────────────────────────────────────
// 便签要等 turn/end 才知道那一轮是谁跑的，而模型身份只有适配器知道（GenerateOptions
// 带 sessionId 不带轮号），所以是两段式配对：适配器 remember → 这里 note。

process.stdout.write('autocontinue: 轮尾便签\n')

const noteOf = (rows, index) => rows.map((row) => row.turn + ':' + row.trigger + ':' + row.provider + '/' + row.model)[index]

await check('触发补发的那一轮，记的是「谁跑到半截」', () => {
  const notes = new TurnNotes()
  const h = makeHarness({ notes })
  notes.remember('s1', { provider: 'alpha', model: 'one', at: 1 })
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }, 1))

  const rows = notes.forSession('s1')
  assert.equal(rows.length, 1)
  assert.equal(noteOf(rows, 0), '1:max-tokens:alpha/one')
})

await check('补发出来的那一轮，记的是「接手的是谁」', async () => {
  const notes = new TurnNotes()
  const h = makeHarness({ notes })
  notes.remember('s1', { provider: 'alpha', model: 'one', at: 1 })
  h.auto.observe(h.session, h.end({ kind: 'error', error: { code: 'RATE_LIMIT' } }, 1))
  await settle()
  assert.equal(h.sent.length, 1, '应该真的补发了')

  h.auto.observe(h.session, h.start(2))
  notes.remember('s1', { provider: 'beta', model: 'two', at: 2 })
  h.auto.observe(h.session, h.end({ kind: 'completed' }, 2))

  const rows = notes.forSession('s1')
  assert.equal(rows.length, 2)
  assert.equal(noteOf(rows, 1), '2:auto:beta/two')
})

await check('上一轮跑过接力，这一轮你手动挑了别的模型：不许指错人', () => {
  const notes = new TurnNotes()
  const h = makeHarness({ notes })
  notes.remember('s1', { provider: 'alpha', model: 'one', at: 1 })
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }, 1))
  assert.equal(notes.forSession('s1').length, 1, '第一轮补发，记了一条')

  // 第二轮用户自己挑了个具体模型：适配器不会再 remember，便签得原地不动。
  h.auto.observe(h.session, h.start(5))
  h.auto.observe(h.session, h.end({ kind: 'completed' }, 5))
  const rows = notes.forSession('s1')
  assert.equal(rows.length, 1, '不能拿上一轮的结论去标这一轮')
  assert.equal(noteOf(rows, 0), '1:max-tokens:alpha/one')
})

await check('接力没跑过的轮不写小字（这一轮压根没走适配器）', () => {
  const notes = new TurnNotes()
  const h = makeHarness({ notes })
  h.auto.observe(h.session, h.start(6))
  h.auto.observe(h.session, h.end({ kind: 'completed' }, 6))
  assert.deepEqual(notes.forSession('s1'), [])
})

await check('用接力跑完、一切正常的一轮也写小字', () => {
  const notes = new TurnNotes()
  const h = makeHarness({ notes })
  h.auto.observe(h.session, h.start(7))
  notes.remember('s1', { provider: 'alpha', model: 'one', at: 7 })
  h.auto.observe(h.session, h.end({ kind: 'completed' }, 7))
  const rows = notes.forSession('s1')
  assert.equal(rows.length, 1)
  assert.equal(noteOf(rows, 0), '7:relay:alpha/one')
})

await check('本机网络故障没补发，小字照写（用户得知道刚才是谁在跑）', () => {
  const notes = new TurnNotes()
  const h = makeHarness({ notes })
  h.auto.observe(h.session, h.start(8))
  notes.remember('s1', { provider: 'alpha', model: 'one', at: 8 })
  h.auto.observe(h.session, h.end({ kind: 'error', error: { code: 'TRANSPORT', message: 'fetch failed' } }, 8))
  assert.equal(h.sent.length, 0, '本机网络问题不该补发')
  const rows = notes.forSession('s1')
  assert.equal(rows.length, 1)
  assert.equal(noteOf(rows, 0), '8:relay:alpha/one')
})

await check('便签按会话分开', () => {
  const notes = new TurnNotes()
  const h = makeHarness({ notes })
  const other = { id: 's2' }
  notes.remember('s1', { provider: 'alpha', model: 'one', at: 1 })
  notes.remember('s2', { provider: 'beta', model: 'two', at: 2 })
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }, 1))
  h.auto.observe(other, h.end({ kind: 'max-tokens' }, 1))
  assert.equal(notes.forSession('s1')[0].provider, 'alpha')
  assert.equal(notes.forSession('s2')[0].provider, 'beta')
})

await check('没有便签收集器时不该炸（宿主可以不给）', async () => {
  const h = makeHarness()
  h.auto.observe(h.session, h.end({ kind: 'max-tokens' }, 1))
  await settle()
  assert.equal(h.sent.length, 1, '没便签也该照常补发')
  assert.equal(h.warnings.length, 0)
})

// ── 设置归一 ────────────────────────────────────────────────────────────────

process.stdout.write('autocontinue: 设置归一\n')

await check('默认值：开、两种触发都开、失败补 1 次、撞上限补 10 次、失败后先等 5 秒', () => {
  const s = normalizeSettings({})
  assert.equal(s.autoContinue, true)
  assert.equal(s.autoContinueOnFailure, true)
  assert.equal(s.autoContinueOnMaxTokens, true)
  assert.equal(s.autoContinueFailureLimit, DEFAULT_SETTINGS.autoContinueFailureLimit)
  assert.equal(s.autoContinueFailureLimit, 1, '失败再问一遍多半还是同一个结局，默认只补一次')
  assert.equal(s.autoContinueMaxTokensLimit, DEFAULT_SETTINGS.autoContinueMaxTokensLimit)
  assert.equal(s.autoContinueMaxTokensLimit, 10, '撞上限只是没写完，可以多给几次')
  assert.equal(s.continueDelaySec, DEFAULT_SETTINGS.continueDelaySec)
  assert.equal(s.continueDelaySec, 5)
})

await check('关掉用 false 表达；"false" 这种字符串也算关（与既有开关同一套口径）', () => {
  assert.equal(normalizeSettings({ autoContinue: false }).autoContinue, false)
  assert.equal(normalizeSettings({ autoContinueOnFailure: false }).autoContinueOnFailure, false)
  assert.equal(normalizeSettings({ autoContinueOnMaxTokens: false }).autoContinueOnMaxTokens, false)
})

await check('两个上限都必须是正整数，各自夹在 1..20，互不影响', () => {
  assert.equal(normalizeSettings({ autoContinueFailureLimit: 7 }).autoContinueFailureLimit, 7)
  assert.equal(normalizeSettings({ autoContinueFailureLimit: 7 }).autoContinueMaxTokensLimit, 10, '改一个不动另一个')
  assert.equal(normalizeSettings({ autoContinueFailureLimit: 0 }).autoContinueFailureLimit, 1, '0 非法 → 回默认')
  assert.equal(normalizeSettings({ autoContinueFailureLimit: -2 }).autoContinueFailureLimit, 1)
  assert.equal(normalizeSettings({ autoContinueFailureLimit: 2.5 }).autoContinueFailureLimit, 1)
  assert.equal(normalizeSettings({ autoContinueFailureLimit: 999 }).autoContinueFailureLimit, 20, '夹到硬上限')
  assert.equal(normalizeSettings({ autoContinueFailureLimit: '4' }).autoContinueFailureLimit, 1, '字符串不认')

  assert.equal(normalizeSettings({ autoContinueMaxTokensLimit: 15 }).autoContinueMaxTokensLimit, 15)
  assert.equal(normalizeSettings({ autoContinueMaxTokensLimit: 0 }).autoContinueMaxTokensLimit, 10)
  assert.equal(normalizeSettings({ autoContinueMaxTokensLimit: 999 }).autoContinueMaxTokensLimit, 20)
  assert.equal(normalizeSettings({ autoContinueMaxTokensLimit: '4' }).autoContinueMaxTokensLimit, 10)
})

await check('旧设置里的 autoContinueLimit 不再被认，两个新键各自回默认', () => {
  // 老版本写盘的键：留着不删也无妨，但它不该再影响任何一次补发。
  const s = normalizeSettings({ autoContinueLimit: 9 })
  assert.equal('autoContinueLimit' in s, false, '归一出参里不该再有这个键')
  assert.equal(s.autoContinueFailureLimit, 1)
  assert.equal(s.autoContinueMaxTokensLimit, 10)
})

await check('上限值能被往返序列化（走一遍 JSON 仍相等）', () => {
  const s = normalizeSettings({ autoContinueFailureLimit: 5, autoContinueMaxTokensLimit: 6, autoContinue: false })
  const back = normalizeSettings(JSON.parse(JSON.stringify(s)))
  assert.equal(back.autoContinueFailureLimit, 5)
  assert.equal(back.autoContinueMaxTokensLimit, 6)
  assert.equal(back.autoContinue, false)
})

await check('等待秒数：0 合法（= 不等），负数 / 小数 / 字符串回默认，超上限夹到 300', () => {
  assert.equal(normalizeSettings({ continueDelaySec: 12 }).continueDelaySec, 12)
  assert.equal(normalizeSettings({ continueDelaySec: 0 }).continueDelaySec, 0, '0 是「不等待」，必须存得进去')
  assert.equal(normalizeSettings({ continueDelaySec: -1 }).continueDelaySec, 5, '负数非法 → 回默认')
  assert.equal(normalizeSettings({ continueDelaySec: 2.5 }).continueDelaySec, 5, '小数不认')
  assert.equal(normalizeSettings({ continueDelaySec: '5' }).continueDelaySec, 5, '字符串不认')
  assert.equal(normalizeSettings({ continueDelaySec: 999 }).continueDelaySec, 300, '夹到硬上限')
  assert.equal(normalizeSettings({ continueDelaySec: null }).continueDelaySec, 5)
})

await check('等待秒数能被往返序列化，且 0 不会在往返里变回默认值', () => {
  const s = normalizeSettings({ continueDelaySec: 0 })
  const back = normalizeSettings(JSON.parse(JSON.stringify(s)))
  assert.equal(back.continueDelaySec, 0)
  assert.equal(normalizeSettings({ continueDelaySec: 30 }).continueDelaySec, 30)
})

// ── 收尾 ────────────────────────────────────────────────────────────────────

process.stdout.write(`\nautocontinue: ${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  for (const { name, error } of failures) {
    process.stdout.write(`\n✗ ${name}\n${error?.stack ?? error}\n`)
  }
  process.exitCode = 1
}
