/**
 * 模型接力（dsh-model-failover）· Host 半身。
 *
 * 这个插件只做一件事：往宿主 llm 服务里注册一条名为 `model-failover` 的
 * provider 路由，并在那条路由下挂一个模型（id `auto`）。用户在模型选择器里
 * 选中「模型接力 / 自动接力」以后，每次模型调用都会进入 lib/adapter.js 的
 * 队列：按设置页排好的优先级依次尝试真实模型，失败的按当日为单位隔离。
 *
 * 为什么是「注册一条路由」而不是「改写 agent loop 的默认模型」：
 *   - 模型选择器是路由导向的（分组严格按 provider 路由），注册路由就能让
 *     插件以「一个模型」的身份出现在设置里，正是需求要的形态；
 *   - 队列顺序属于用户的运行时状态，写进 profile 的 cordis 配置只会让
 *     「重置今天的隔离」变成一次配置热重载；
 *   - 宿主在 llm 层已经把「一次调用」抽象成一条流，包装整条流是唯一能保证
 *     「换模型对调用方不可见」的位置（见 lib/adapter.js 的提交点说明）。
 *
 * 设置页的读写在同一个 host 进程里通过插件自己的同源 HTTP 路由
 * `${API_PREFIX}/*` 完成 —— 浏览器半身（client.js）是一个手写的 ModuleLoader
 * bundle，它不走 Remote 绑定，只 fetch 这些路由。这条路径与 dsh 版本无关，
 * 也不依赖任何未公开的类型化接口。
 */

import { join } from 'node:path'

import { FailoverAdapter } from './lib/adapter.js'
import { AutoContinue } from './lib/autocontinue.js'
import { Catalog } from './lib/catalog.js'
import {
  API_PREFIX,
  DEFAULT_SETTINGS,
  DEFAULT_TEMPLATE_ID,
  DEFAULT_TEMPLATE_NAME,
  MAX_IDLE_TIMEOUT_SEC,
  MAX_TEMPLATES,
  MAX_SAME_MODEL_RETRIES,
  MAX_TEMPLATE_CANDIDATES,
  MAX_TEMPLATE_NAME,
  NAMESPACE,
  ROUTE,
  ROUTE_LABEL,
  emptyTemplate,
  routeKey,
  splitKey,
} from './lib/constants.js'
import { DailyHealth, nextResetAt, normalizeState } from './lib/health.js'
import { TurnNotes } from './lib/notes.js'
import { JsonFile, dataDir, removeFile } from './lib/store.js'
import { rejectionFor } from './lib/trust.js'

/** 插件名；与 cordis.patch.yml 的 id 无关，后者是挂载点的名字。 */
export const name = 'model-failover'
export const version = '1.0.0'

/**
 * `llm` 是硬依赖：没有它这个插件没有任何意义。
 *
 * `webServer` **故意不在这里** —— 它只影响设置页能不能连上后端，而 headless
 * 组合（TUI、离线测试）根本没有 HTTP 服务。把它写进 inject 会让整个插件在
 * 那些组合里静默不加载，连接力本身一起丢掉。它由下面的 ctx.inject 按需取得。
 */
export const inject = ['llm']

/** 设置页一次最多回看多少条事件。 */
const EVENTS_IN_SNAPSHOT = 80

/** 事件日志文件的读入上限；超出部分在 normalize 阶段丢弃。 */
const EVENT_LOG_HARD_LIMIT = 2000

/** 「继续」前的等待秒数上限：再多就不如让用户自己决定什么时候重试了。 */
const CONTINUE_DELAY_HARD_LIMIT = 300

/** 同一个模型额外重试几次的上限，和 lib/constants.js 的 MAX_SAME_MODEL_RETRIES 一致。 */
const SAME_MODEL_RETRIES_HARD_LIMIT = MAX_SAME_MODEL_RETRIES

/** 「多久没输出算卡住」的上限，和 lib/constants.js 的 MAX_IDLE_TIMEOUT_SEC 一致。 */
const IDLE_TIMEOUT_HARD_LIMIT = MAX_IDLE_TIMEOUT_SEC

/**
 * 试连接时的输出上限。
 *
 * 试连接只需要证明「连得上、能出字」，不需要它写完一句话。压到 8 个 token，
 * 一次探测的花销就跟用户随手打一句问候差不多；被截断也算通（说明它在正常
 * 写字），所以不会因为上限太小而误报失败。
 */
const PROBE_MAX_TOKENS = 8

/** 单个模型试连接的等待上限。超过就当作「连不上」，免得一个卡死的供应商拖住整轮测试。 */
const PROBE_TIMEOUT_MS = 15_000

/**
 * 一个会话最多回给浏览器几条「这一轮是谁在跑」的便签。
 *
 * 接力跑过的每一轮都会留一条，所以给得比较宽 —— 一次拉 200 条也就几十 KB，
 * 而漏掉更早的轮会让往上翻时小字整段消失。
 */
const NOTES_PER_SESSION = 200

/**
 * 把一份候选列表收敛成 `[{provider, model, reasoningEffort?}]`，顺便去重。
 *
 * 重复的候选只会让同一次失败被重复尝试两遍，而它的代价（多烧一次上游额度）
 * 远大于在这里多写四行。
 */
function normalizeCandidates(raw) {
  const order = []
  if (!Array.isArray(raw)) return order
  const seen = new Set()
  for (const item of raw) {
    if (order.length >= MAX_TEMPLATE_CANDIDATES) break
    if (item === null || typeof item !== 'object') continue
    const provider = typeof item.provider === 'string' ? item.provider.trim() : ''
    const model = typeof item.model === 'string' ? item.model.trim() : ''
    if (provider === '' || model === '') continue
    const key = routeKey(provider, model)
    if (seen.has(key)) continue
    seen.add(key)
    // 每个候选可以自带思考强度；空串与缺失同义，都表示「用这个模型自己的默认档位」。
    const reasoningEffort =
      typeof item.reasoningEffort === 'string' && item.reasoningEffort.trim() !== ''
        ? item.reasoningEffort.trim()
        : undefined
    order.push(reasoningEffort === undefined ? { provider, model } : { provider, model, reasoningEffort })
  }
  return order
}

/** 模板 id 会被当成模型 id 用，所以只收 URL / id 里安全的字符。 */
function normalizeTemplateId(raw, fallback) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  return /^[A-Za-z0-9_-]{1,32}$/.test(text) ? text : fallback
}

/**
 * 队列模板：至少一条、id 唯一。
 *
 * 老版本只有一个扁平的 `order`（这一层还没有模板）。读到那种设置时把它整份
 * 灌进默认模板 —— 升级之后队列还在，只是从「一条队列」变成「默认模板」。
 */
function normalizeTemplates(source) {
  const raw = Array.isArray(source.templates) ? source.templates : undefined
  const templates = []
  const seen = new Set()
  for (const item of raw ?? []) {
    if (templates.length >= MAX_TEMPLATES) break
    if (item === null || typeof item !== 'object') continue
    const fallback = `t${templates.length}`
    let id = normalizeTemplateId(item.id, fallback)
    if (seen.has(id)) id = fallback
    if (seen.has(id)) continue
    seen.add(id)
    const name =
      typeof item.name === 'string' && item.name.trim() !== ''
        ? item.name.trim().slice(0, MAX_TEMPLATE_NAME)
        : id === DEFAULT_TEMPLATE_ID
          ? DEFAULT_TEMPLATE_NAME
          : id
    templates.push({ id, name, order: normalizeCandidates(item.order) })
  }
  if (templates.length === 0) {
    templates.push({ ...emptyTemplate(), order: normalizeCandidates(source.order) })
  }
  return templates
}

/**
 * 把任意 JSON 收敛成设置形状。任何一项缺失或类型不对都回落到默认值。
 */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}

  const templates = normalizeTemplates(source)
  const editedTemplate = templates.some((template) => template.id === source.editedTemplate)
    ? source.editedTemplate
    : templates[0].id

  const hiddenProviders = Array.isArray(source.hiddenProviders)
    ? [...new Set(source.hiddenProviders.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.trim()))]
    : [...DEFAULT_SETTINGS.hiddenProviders]

  const resetHour =
    Number.isInteger(source.resetHour) && source.resetHour >= 0 && source.resetHour <= 23
      ? source.resetHour
      : DEFAULT_SETTINGS.resetHour

  const eventLogLimit =
    Number.isInteger(source.eventLogLimit) && source.eventLogLimit > 0
      ? Math.min(source.eventLogLimit, EVENT_LOG_HARD_LIMIT)
      : DEFAULT_SETTINGS.eventLogLimit

  // 这两个上限**不夹顶**：上限是给用户自己拿捏的 —— 有人就是想让一个长文档
  // 一直「继续」到写完，硬截在 20 反而把人拦住。`> 0` 之后原样收下。
  const autoContinueFailureLimit =
    Number.isInteger(source.autoContinueFailureLimit) && source.autoContinueFailureLimit > 0
      ? source.autoContinueFailureLimit
      : DEFAULT_SETTINGS.autoContinueFailureLimit

  const autoContinueMaxTokensLimit =
    Number.isInteger(source.autoContinueMaxTokensLimit) && source.autoContinueMaxTokensLimit > 0
      ? source.autoContinueMaxTokensLimit
      : DEFAULT_SETTINGS.autoContinueMaxTokensLimit

  // 允许 0（= 不等待，回到旧行为），所以判据是 `>= 0` 而不是 `> 0`。
  const continueDelaySec =
    Number.isInteger(source.continueDelaySec) && source.continueDelaySec >= 0
      ? Math.min(source.continueDelaySec, CONTINUE_DELAY_HARD_LIMIT)
      : DEFAULT_SETTINGS.continueDelaySec

  // 允许 0（= 每个模型只试一次）。**不再从 `retrySameModelOnce` 折算**：那个
  // 老开关管的是「用同一句『继续』再催一遍」，那件事已经整个没了；新键管的是
  // 「把请求原样重发去换账号」，是另一回事。硬把 false 折成 0 会让升级上来的
  // 人悄悄少掉换账号的机会 —— 本机就真发生过一次，功能上线当天就被迁成关。
  const sameModelRetries =
    Number.isInteger(source.sameModelRetries) && source.sameModelRetries >= 0
      ? Math.min(source.sameModelRetries, SAME_MODEL_RETRIES_HARD_LIMIT)
      : DEFAULT_SETTINGS.sameModelRetries

  // 同样允许 0（= 不管它卡多久）。判据用 `>= 0`，理由和 continueDelaySec 一样：
  // 0 是一个有意义的取值，不能悄悄回落到默认的 120 秒。
  const idleTimeoutSec =
    Number.isInteger(source.idleTimeoutSec) && source.idleTimeoutSec >= 0
      ? Math.min(source.idleTimeoutSec, IDLE_TIMEOUT_HARD_LIMIT)
      : DEFAULT_SETTINGS.idleTimeoutSec

  return {
    enabled: source.enabled !== false,
    bootstrapped: source.bootstrapped === true,
    templates,
    editedTemplate,
    resetHour,
    retrySameModelOnce: source.retrySameModelOnce !== false,
    sameModelRetries,
    continueText:
      typeof source.continueText === 'string' && source.continueText.trim() !== ''
        ? source.continueText.slice(0, 200)
        : DEFAULT_SETTINGS.continueText,
    hiddenProviders,
    retryWhenAllQuarantined: source.retryWhenAllQuarantined !== false,
    autoContinue: source.autoContinue !== false,
    autoContinueOnFailure: source.autoContinueOnFailure !== false,
    autoContinueOnMaxTokens: source.autoContinueOnMaxTokens !== false,
    autoContinueFailureLimit,
    autoContinueMaxTokensLimit,
    continueDelaySec,
    idleTimeoutSec,
    keepEventLog: source.keepEventLog !== false,
    eventLogLimit,
    // 会话页「隔离队列」显示谁：子智能体的会话默认不显示（那是委托出去的一次
    // 执行，不是你开的对话），别的工作区的会话默认显示（它们同样是你的对话）。
    showSubagentSessions: source.showSubagentSessions === true,
    showForeignSessions: source.showForeignSessions !== false,
  }
}

/** 事件日志文件形状。 */
function normalizeEventLog(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const events = Array.isArray(source.events)
    ? source.events.filter((event) => event !== null && typeof event === 'object' && !Array.isArray(event))
    : []
  return { events: events.slice(-EVENT_LOG_HARD_LIMIT) }
}

/** 把请求体读成一个 JSON 对象；空体当 `{}`。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1_000_000) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const parsed = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

/** 回一个 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 插件主体。
 *
 * @param {any} ctx - cordis 上下文；`ctx.llm` 由 inject 保证存在。
 * @param {any} _config - cordis.patch.yml 里 `config: {}` 传进来的东西，本插件不使用。
 */
export function apply(ctx, _config) {
  const logger = ctx.logger ?? console
  const dir = dataDir(NAMESPACE)

  const settingsFile = new JsonFile(join(dir, 'settings.json'), undefined, normalizeSettings)
  const stateFile = new JsonFile(join(dir, 'state.json'), undefined, normalizeState)
  const logFile = new JsonFile(join(dir, 'log.json'), undefined, normalizeEventLog)

  /** 追加一条事件。只在真正发生状态变化时调用，避免每次成功都写盘。 */
  const pushEvent = (event) => {
    const settings = settingsFile.get()
    if (settings.keepEventLog !== true) return
    const events = [...logFile.get().events, event]
    logFile.replace({ events: events.slice(-settings.eventLogLimit) })
  }

  const health = new DailyHealth(stateFile)
  health.onRollover = (from, to) => {
    // 跨过设定时间：昨天的隔离名单整体作废，重新从第一个模型开始尝试。
    pushEvent({ at: Date.now(), kind: 'rollover', from, to })
    logger.info?.(`model-failover: 新的一天（${from} → ${to}），隔离名单已清空`)
  }

  const catalog = new Catalog({
    llm: ctx.llm,
    hiddenProviders: () => settingsFile.get().hiddenProviders,
    logger: { warn: (message) => logger.warn?.(message) },
  })

  /**
   * 「这个会话刚才跑的是谁」的便签，只活在内存里。
   *
   * 适配器每跳写一次（它拿得到 sessionId 但拿不到轮号），轮级那层在 turn/end
   * 时读出来配上轮号（它拿得到轮号但看不见模型）。理由与形状见 lib/notes.js。
   */
  const notes = new TurnNotes()

  /** 把 `provider / model` 换成人看的名字；清单里查不到就原样回落。 */
  const labelOf = (provider, model) => {
    const hit = catalog.cached().find((row) => row.provider === provider && row.model === model)
    return hit === undefined ? `${provider} / ${model}` : `${hit.providerName} · ${hit.name}`
  }

  const adapter = new FailoverAdapter({
    llm: ctx.llm,
    settings: settingsFile,
    health,
    catalog,
    notes,
    log: {
      warn: (message) => logger.warn?.(`model-failover: ${message}`),
      push: (event) => pushEvent(event),
    },
  })

  // ── 注册路由：这就是用户在模型选择器里看到的那个「模型」 ──────────────────
  const registration = ctx.llm.registerAdapter([ROUTE], adapter)
  logger.info?.(`model-failover: 路由 ${ROUTE} 已注册（模型选择器里的「${ROUTE_LABEL}」）`)

  // ── 告诉模型设置页这条路由是可配置的 ─────────────────────────────────────
  // 纯尽力而为：老版本没有这个方法，或者本进程没有设置页，都不影响接力。
  try {
    const settingsNs = ctx.fiber?.entry?.options?.id ?? NAMESPACE
    ctx.llm.registerConfigurableProviders?.([
      { provider: ROUTE, displayName: ROUTE_LABEL, settingsNs, settingsPath: [] },
    ])
  } catch (error) {
    logger.warn?.(`model-failover: registerConfigurableProviders 失败（设置页里可能不显示这条路由）— ${String(error?.message ?? error)}`)
  }

  // ── 首次运行把「当前已接入 dsh 的所有模型」灌进队列 ───────────────────────
  // 只填一次：之后顺序由用户在设置页掌握，再自动追加只会覆盖用户的意图。
  const bootstrap = async () => {
    const current = settingsFile.get()
    if (current.bootstrapped) return
    const entries = await catalog.refresh()
    if (entries.length === 0) {
      // 一条路由都没扫到（llm 还没挂完、或全部读取失败）：不写 bootstrapped，
      // 留给下一次进程启动再试，免得用户看到一个永远空着的队列。
      logger.warn?.('model-failover: 扫描不到任何已接入的模型，队列暂时为空，稍后重启会再试一次')
      return
    }
    const latest = settingsFile.get()
    if (latest.bootstrapped) return
    const template = latest.templates[0]
    const seen = new Set(template.order.map((item) => routeKey(item.provider, item.model)))
    const order = [...template.order]
    for (const entry of entries) {
      const key = routeKey(entry.provider, entry.model)
      if (seen.has(key)) continue
      seen.add(key)
      order.push({ provider: entry.provider, model: entry.model })
    }
    settingsFile.update({ bootstrapped: true, templates: [{ ...template, order }, ...latest.templates.slice(1)] })
    settingsFile.flush()
    logger.info?.(`model-failover: 已把 ${order.length} 个已接入的模型排进「${template.name}」，可在设置页调整顺序`)
  }

  /** 扫完目录顺手补齐上下文窗口与档位表，失败不影响任何功能。 */
  const refresh = async () => {
    const entries = await catalog.refresh()
    await catalog.fillModelFacts()
    return entries
  }

  /**
   * 试一次「这个 provider + model 现在能不能出字」。
   *
   * 走 `ctx.llm` 直连供应商，**刻意不经过本插件的接力路由**：试连接是一次
   * 体检，把一个好好的模型记进隔离名单、或者动到撞上限那本账，都是副作用。
   *
   * 花销压到最低：一句「hi」加 8 个 token 的输出上限。撞到上限算成功 ——
   * 那恰恰说明它在正常写字；只有真报错才算不通。结果一律不落盘，页面关掉
   * 就没了。
   *
   * @param {{ provider: string, model: string }} target
   * @returns {Promise<{ ok: boolean, ms: number, code?: string, message?: string }>}
   */
  const probe = async (target) => {
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    let failure
    try {
      const stream = ctx.llm.stream({
        provider: target.provider,
        model: target.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        maxTokens: PROBE_MAX_TOKENS,
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (chunk?.type !== 'finish') continue
        const reason = chunk.reason ?? {}
        if (reason.kind === 'error') {
          failure = reason.failure ?? { code: 'UNKNOWN', message: '' }
        } else if (reason.kind === 'aborted' && controller.signal.aborted) {
          failure = { code: 'TIMEOUT', message: `超过 ${PROBE_TIMEOUT_MS / 1000} 秒没有回应` }
        }
        break
      }
    } catch (error) {
      // LlmError 把结构化的东西放在 `failure` 上；别的一律按普通错误读。
      const inner = error?.failure
      failure = inner !== undefined && typeof inner === 'object'
        ? { code: inner.code, message: inner.message }
        : {
            code: typeof error?.code === 'string' && error.code !== '' ? error.code : 'UNKNOWN',
            message: error?.message,
          }
    } finally {
      clearTimeout(timer)
    }
    const ms = Date.now() - started
    if (failure === undefined) return { ok: true, ms }
    return {
      ok: false,
      ms,
      code: typeof failure.code === 'string' && failure.code !== '' ? failure.code : 'UNKNOWN',
      message: String(failure.message ?? '').slice(0, 200),
    }
  }

  void refresh()
    .then(() => bootstrap())
    .catch((error) => {
      logger.warn?.(`model-failover: 启动扫描失败 — ${String(error?.message ?? error)}`)
    })

  // ── 设置页 API ────────────────────────────────────────────────────────────
  /**
   * 每个会话今天的隔离情况 + 正在用哪个模型。
   *
   * 三种来源拼起来：隔离名单知道「哪些会话撞过墙」，便签知道「哪些会话跑过」，
   * 适配器的实时表知道「哪些会话此刻正在跑」。只用前两个会漏掉「刚开始跑、
   * 还没跑完任何一趟」的会话 —— 而那恰恰是用户最想盯着看的那几秒。
   */
  const sessionRows = (now) => {
    const settings = settingsFile.get()
    const view = health.view(now, settings.resetHour)
    const decorate = (row) => ({ ...row, ...splitKey(row.key), label: labelOf(row.provider, row.model) })
    const templateName = (id) => settings.templates.find((template) => template.id === id)?.name ?? id ?? ''
    const table = new Map()
    const rowOf = (sessionId) => {
      let row = table.get(sessionId)
      if (row === undefined) {
        row = { sessionId, quarantined: [], good: [], active: undefined, running: undefined }
        table.set(sessionId, row)
      }
      return row
    }
    for (const group of view.sessions) {
      const row = rowOf(group.sessionId)
      row.quarantined = group.quarantined.map(decorate)
      row.good = group.good.map(decorate)
    }
    for (const [sessionId, hit] of notes.entries()) {
      rowOf(sessionId).active = {
        provider: hit.provider,
        model: hit.model,
        at: hit.at,
        label: labelOf(hit.provider, hit.model),
        templateId: hit.template,
        templateName: hit.template === undefined ? '' : templateName(hit.template),
      }
    }
    // 此刻正在跑的候选：单独一份，不覆盖 `active`（那是「上一趟跑的是谁」，
    // 两者在换人的那一瞬间会不一样，界面要能同时说清）。
    for (const [sessionId, hit] of adapter.liveSessions()) {
      const row = rowOf(sessionId)
      row.running = {
        provider: hit.provider,
        model: hit.model,
        at: hit.startedAt,
        label: labelOf(hit.provider, hit.model),
        templateId: hit.templateId,
        templateName: hit.templateId === undefined ? '' : templateName(hit.templateId),
      }
    }
    // 有事的会话排前面：隔离着的 → 正在跑的 → 其余。
    return [...table.values()].sort((left, right) => {
      const weight = (row) => (row.quarantined.length > 0 ? 0 : row.active !== undefined || row.running !== undefined ? 1 : 2)
      const delta = weight(left) - weight(right)
      if (delta !== 0) return delta
      const at = (row) => row.quarantined.at(-1)?.at ?? row.running?.at ?? row.active?.at ?? 0
      return at(right) - at(left)
    })
  }

  const snapshot = (now) => {
    const settings = settingsFile.get()
    const view = health.view(now, settings.resetHour)
    const entries = catalog.cached()
    const decorate = (row) => ({ ...row, ...splitKey(row.key), label: labelOf(row.provider, row.model) })
    return {
      ok: true,
      route: { provider: ROUTE, label: ROUTE_LABEL },
      now,
      day: view.day,
      nextResetAt: nextResetAt(now, settings.resetHour),
      settings,
      // 设置页要按每个模型自己的档位表画思考强度下拉框，所以清单行顺带把档位
      // 带上；effortsKnown 用来区分「不支持档位」和「还没问到」。
      catalog: entries.map((row) => {
        const known = catalog.reasoningFor(row.provider, row.model)
        return {
          ...row,
          efforts: known?.efforts ?? [],
          defaultEffort: known?.defaultEffort,
          effortsKnown: catalog.reasoningKnown(row.provider, row.model),
        }
      }),
      catalogErrors: catalog.errors,
      catalogScannedAt: catalog.at,
      quarantined: view.quarantined.map(decorate),
      good: view.good.map(decorate),
      // 每模型当天的失败/成功次数（所有会话、所有模板合计）——设置页队列前面
      // 那对红绿数字就是它。
      counts: view.counts,
      sessions: sessionRows(now),
      events: logFile.get().events.slice(-EVENTS_IN_SNAPSHOT).reverse(),
      dataDir: dir,
    }
  }

  /** 只接受设置里真实存在的键；其余一律忽略。 */
  const patchSettings = (patch) => {
    const current = settingsFile.get()
    const next = { ...current }
    if ('enabled' in patch) next.enabled = patch.enabled !== false
    if ('bootstrapped' in patch) next.bootstrapped = patch.bootstrapped === true
    if ('templates' in patch) next.templates = patch.templates
    if ('editedTemplate' in patch) next.editedTemplate = patch.editedTemplate
    if ('resetHour' in patch) next.resetHour = patch.resetHour
    if ('retrySameModelOnce' in patch) next.retrySameModelOnce = patch.retrySameModelOnce !== false
    if ('sameModelRetries' in patch) next.sameModelRetries = patch.sameModelRetries
    if ('continueText' in patch) next.continueText = patch.continueText
    if ('hiddenProviders' in patch) next.hiddenProviders = patch.hiddenProviders
    if ('retryWhenAllQuarantined' in patch) next.retryWhenAllQuarantined = patch.retryWhenAllQuarantined !== false
    if ('autoContinue' in patch) next.autoContinue = patch.autoContinue !== false
    if ('autoContinueOnFailure' in patch) next.autoContinueOnFailure = patch.autoContinueOnFailure !== false
    if ('autoContinueOnMaxTokens' in patch) next.autoContinueOnMaxTokens = patch.autoContinueOnMaxTokens !== false
    if ('autoContinueFailureLimit' in patch) next.autoContinueFailureLimit = patch.autoContinueFailureLimit
    if ('autoContinueMaxTokensLimit' in patch) next.autoContinueMaxTokensLimit = patch.autoContinueMaxTokensLimit
    if ('continueDelaySec' in patch) next.continueDelaySec = patch.continueDelaySec
    if ('idleTimeoutSec' in patch) next.idleTimeoutSec = patch.idleTimeoutSec
    if ('keepEventLog' in patch) next.keepEventLog = patch.keepEventLog !== false
    if ('eventLogLimit' in patch) next.eventLogLimit = patch.eventLogLimit
    if ('showSubagentSessions' in patch) next.showSubagentSessions = patch.showSubagentSessions === true
    if ('showForeignSessions' in patch) next.showForeignSessions = patch.showForeignSessions !== false
    // replace 会过一遍 normalizeSettings，所以非法值在这里被就地修好，
    // 而不是留给执行路径去踩。
    settingsFile.replace(next)
    settingsFile.flush()
    return settingsFile.get()
  }

  /**
   * 按请求惰性取 `connection` 服务：Web 应用在插件之后才发布它，一次性读取
   * 会把「缺席」冻结下来，于是整个进程都退回复刻围栏。`ctx.get()` 是
   * 机会式查询，服务不在时答 `undefined` 而不是抛错。
   */
  const optional = (service) => (typeof ctx.get === 'function' ? ctx.get(service) : undefined)

  const api = async (req, res) => {
    // 最长前缀胜出：本路由比内核的 `/api` 长，所以内核那条里的鉴权不会跑，
    // 必须在这里自己补上（见 lib/trust.js 的说明）。
    const rejected = rejectionFor(req, optional('connection'), (decision) => {
      logger.warn?.(
        `model-failover: 拒绝了一个设置接口请求（${decision.source}/${decision.reason} → HTTP ${decision.status}）`,
      )
    })
    if (rejected !== undefined) {
      sendJson(res, rejected, { ok: false, error: `请求未被信任（HTTP ${rejected}）` })
      return
    }

    let path = '/'
    let sessionId
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      path = url.pathname
      if (path.startsWith(API_PREFIX)) path = path.slice(API_PREFIX.length)
      if (path === '') path = '/'
      if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '')
      // 浏览器半身问「我这个会话里哪几轮是自动补发的」时带上它。
      const asked = url.searchParams.get('sessionId')
      if (asked !== null && asked !== '') sessionId = asked
    } catch (error) {
      sendJson(res, 400, { ok: false, error: `无法解析请求路径：${String(error?.message ?? error)}` })
      return
    }

    const now = Date.now()
    const method = (req.method ?? 'GET').toUpperCase()

    try {
      if (method === 'GET' && (path === '/' || path === '/state')) {
        sendJson(res, 200, snapshot(now))
        return
      }

      // 轮尾小字专用：只回这一个会话的几条便签，别的一律不带。
      //
      // 为什么不复用 /state：那个响应里有整个模型清单、隔离名单和几十条事件，
      // 而轮尾每挂一次就要问一次。为了一句小字拖几十 KB 下来不划算。
      if (method === 'GET' && path === '/notes') {
        const rows = notes.forSession(sessionId, NOTES_PER_SESSION).map((row) => ({
          ...row,
          label: labelOf(row.provider, row.model),
        }))
        sendJson(res, 200, { ok: true, notes: rows })
        return
      }

      // 会话页那一栏专用：全机器所有会话的隔离与当前模型，不带模型清单和事件。
      //
      // 和 /notes 一样，是为了不把整份 /state 拖到一个每几秒刷新一次的页面上。
      if (method === 'GET' && path === '/sessions') {
        sendJson(res, 200, {
          ok: true,
          now,
          day: health.view(now, settingsFile.get().resetHour).day,
          route: { provider: ROUTE, label: ROUTE_LABEL },
          // 会话页要显示「这个会话用的是哪个模板」，所以把 id → 名字的表一起带上
          // （这一份很小，不像 /state 那样驮着整个模型清单）。
          templates: settingsFile.get().templates.map((template) => ({ id: template.id, name: template.name })),
          // 这一栏显示谁，由设置页的「外观」决定；判据（哪个会话是子智能体、
          // 哪个会话属于别的工作区）只有浏览器那边拿得到，所以宿主只把开关传过去。
          view: {
            subagentSessions: settingsFile.get().showSubagentSessions === true,
            foreignSessions: settingsFile.get().showForeignSessions !== false,
          },
          sessions: sessionRows(now),
        })
        return
      }

      if (method === 'POST' && path === '/settings') {
        const patch = await readJsonBody(req)
        patchSettings(patch)
        sendJson(res, 200, snapshot(now))
        return
      }

      if (method === 'POST' && path === '/refresh') {
        await refresh()
        await bootstrap()
        sendJson(res, 200, snapshot(now))
        return
      }

      // 试连接：一次只探一个模型，让浏览器那边能各自记进度、各自显示结果。
      //
      // 一次全探完再回也可以，但一条模板动辄十几个模型、又串着网络等待，
      // 用户要盯着一动不动的列表等半分钟。按模型发就没这问题。
      if (method === 'POST' && path === '/probe') {
        const body = await readJsonBody(req)
        const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
        const model = typeof body?.model === 'string' ? body.model.trim() : ''
        if (provider === '' || model === '') {
          sendJson(res, 400, { ok: false, error: '试连接需要 provider 和 model' })
          return
        }
        const result = await probe({ provider, model })
        sendJson(res, 200, { ok: true, result: { provider, model, ...result } })
        return
      }

      if (method === 'POST' && path === '/reset') {
        // 带 sessionId 就只解除那一个会话的隔离；不带才是全局解除。
        //
        // 会话页那一栏按会话显示，所以它的按钮必须按会话生效 —— 在甲会话里
        // 点「解除」，凭什么让乙会话重新去撞同一堵墙。不带 sessionId 的全局
        // 路径留着给脚本和以后可能的「一键全解」用，界面上的入口已经撤掉了。
        if (sessionId !== undefined) {
          const settings = settingsFile.get()
          const cleared = health.clearSession(now, settings.resetHour, sessionId)
          stateFile.flush()
          pushEvent({
            at: now,
            kind: 'reset',
            cleared,
            sessionId,
            day: health.view(now, settings.resetHour).day,
          })
          sendJson(res, 200, {
            ok: true,
            cleared,
            sessionId,
            sessions: sessionRows(now),
          })
          return
        }
        const settings = settingsFile.get()
        const view = health.view(now, settings.resetHour)
        health.clear(now, settings.resetHour)
        stateFile.flush()
        pushEvent({ at: now, kind: 'reset', cleared: view.quarantined.length, day: view.day })
        sendJson(res, 200, snapshot(now))
        return
      }

      if (method === 'POST' && path === '/log/clear') {
        logFile.replace({ events: [] })
        logFile.flush()
        sendJson(res, 200, snapshot(now))
        return
      }

      if (method === 'POST' && path === '/forget') {
        // 「恢复出厂」：删掉状态文件，下一次调用重新从第一个模型开始。
        removeFile(join(dir, 'state.json'))
        stateFile.replace(undefined)
        pushEvent({ at: now, kind: 'forget' })
        sendJson(res, 200, snapshot(now))
        return
      }

      sendJson(res, 404, { ok: false, error: `未知的模型接力接口：${method} ${path}` })
    } catch (error) {
      logger.warn?.(`model-failover: 设置接口 ${method} ${path} 失败 — ${String(error?.message ?? error)}`)
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer
    scoped.effect(
      () => server.register({ kind: 'prefix', path: API_PREFIX, handler: api }),
      'model-failover: settings API',
    )
    logger.info?.(`model-failover: 设置接口已挂载到 ${API_PREFIX}`)
  })

  // ── 本轮失败 / 输出撞上限时，自动补一句「继续」 ────────────────────────────
  // `agents` 和 `webServer` 一样**故意不写进 inject**：headless 组合（TUI、
  // 离线测试）里没有它，写进去会让整个插件静默不加载，连接力一起丢掉。
  ctx.inject(['agents'], (scoped) => {
    const autoContinue = new AutoContinue({
      agents: scoped.agents,
      settings: settingsFile,
      notes,
      log: {
        info: (message) => logger.info?.(`model-failover: ${message}`),
        warn: (message) => logger.warn?.(`model-failover: ${message}`),
        push: (event) => pushEvent(event),
      },
    })
    scoped.effect(() => autoContinue.attach(scoped), 'model-failover: auto continue')
    logger.info?.('model-failover: 已接管「本轮失败 / 输出撞上限」时的自动「继续」')
  })

  // ── 收摊 ────────────────────────────────────────────────────────────────
  ctx.effect(
    () => () => {
      // 落盘是防抖的，不显式 flush 会把最后 200ms 的隔离记录丢掉。
      settingsFile.dispose()
      stateFile.dispose()
      logFile.dispose()
      try {
        registration?.()
      } catch {
        /* 已经随 fiber 卸载过了 */
      }
    },
    'model-failover: flush state and release route',
  )
}
