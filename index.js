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
import { Catalog } from './lib/catalog.js'
import {
  API_PREFIX,
  DEFAULT_SETTINGS,
  MODEL_ID,
  NAMESPACE,
  ROUTE,
  ROUTE_LABEL,
  routeKey,
  splitKey,
} from './lib/constants.js'
import { DailyHealth, nextResetAt, normalizeState } from './lib/health.js'
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

/**
 * 把任意 JSON 收敛成设置形状。任何一项缺失或类型不对都回落到默认值。
 *
 * 队列顺序顺便在这里去重：重复的候选只会让同一次失败被重复尝试两遍，
 * 而它的代价（多烧一次上游额度）远大于在这里多写四行。
 */
function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}

  const order = []
  if (Array.isArray(source.order)) {
    const seen = new Set()
    for (const item of source.order) {
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
  }

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

  return {
    enabled: source.enabled !== false,
    bootstrapped: source.bootstrapped === true,
    order,
    resetHour,
    retrySameModelOnce: source.retrySameModelOnce !== false,
    continueText:
      typeof source.continueText === 'string' && source.continueText.trim() !== ''
        ? source.continueText.slice(0, 200)
        : DEFAULT_SETTINGS.continueText,
    hiddenProviders,
    retryWhenAllQuarantined: source.retryWhenAllQuarantined !== false,
    keepEventLog: source.keepEventLog !== false,
    eventLogLimit,
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

  const adapter = new FailoverAdapter({
    llm: ctx.llm,
    settings: settingsFile,
    health,
    catalog,
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
    const seen = new Set(latest.order.map((item) => routeKey(item.provider, item.model)))
    const order = [...latest.order]
    for (const entry of entries) {
      const key = routeKey(entry.provider, entry.model)
      if (seen.has(key)) continue
      seen.add(key)
      order.push({ provider: entry.provider, model: entry.model })
    }
    settingsFile.update({ bootstrapped: true, order })
    settingsFile.flush()
    logger.info?.(`model-failover: 已把 ${order.length} 个已接入的模型排进队列，可在设置页调整顺序`)
  }

  /** 扫完目录顺手补齐上下文窗口与档位表，失败不影响任何功能。 */
  const refresh = async () => {
    const entries = await catalog.refresh()
    await catalog.fillModelFacts()
    return entries
  }

  void refresh()
    .then(() => bootstrap())
    .catch((error) => {
      logger.warn?.(`model-failover: 启动扫描失败 — ${String(error?.message ?? error)}`)
    })

  // ── 设置页 API ────────────────────────────────────────────────────────────
  const snapshot = (now) => {
    const settings = settingsFile.get()
    const view = health.view(now, settings.resetHour)
    const entries = catalog.cached()
    const labelOf = (provider, model) => {
      const hit = entries.find((row) => row.provider === provider && row.model === model)
      return hit === undefined ? `${provider} / ${model}` : `${hit.providerName} · ${hit.name}`
    }
    const decorate = (row) => ({ ...row, ...splitKey(row.key), label: labelOf(row.provider, row.model) })
    return {
      ok: true,
      route: { provider: ROUTE, model: MODEL_ID, label: ROUTE_LABEL },
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
    if ('order' in patch) next.order = patch.order
    if ('resetHour' in patch) next.resetHour = patch.resetHour
    if ('retrySameModelOnce' in patch) next.retrySameModelOnce = patch.retrySameModelOnce !== false
    if ('continueText' in patch) next.continueText = patch.continueText
    if ('hiddenProviders' in patch) next.hiddenProviders = patch.hiddenProviders
    if ('retryWhenAllQuarantined' in patch) next.retryWhenAllQuarantined = patch.retryWhenAllQuarantined !== false
    if ('keepEventLog' in patch) next.keepEventLog = patch.keepEventLog !== false
    if ('eventLogLimit' in patch) next.eventLogLimit = patch.eventLogLimit
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
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      path = url.pathname
      if (path.startsWith(API_PREFIX)) path = path.slice(API_PREFIX.length)
      if (path === '') path = '/'
      if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '')
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

      if (method === 'POST' && path === '/reset') {
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
