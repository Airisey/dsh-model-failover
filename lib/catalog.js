/**
 * 「当前已接入 dsh 的所有模型」的清单来源。
 *
 * 数据直接来自宿主 llm 服务：`listProviders()` 给出所有挂了适配器的路由，
 * `listModels(provider)` 给出每条路由当前能提供的模型。设置页拿这份清单
 * 让人勾选并排序；队列执行时按 model id 反查上下文窗口等元数据。
 *
 * 两个必须防的坑：
 *  1. 某些 provider 的 listModels 会打上游（发现型适配器）。所以结果带 TTL
 *     缓存，且永远不因为某一条路由抛错就丢整份清单。
 *  2. 插件自己的路由必须在清单里排除，否则「模型接力」会被自己当成候选，
 *     用户一勾选就是无限自我递归。
 */

import { ROUTE } from './constants.js'

const DEFAULT_TTL_MS = 60_000

/** 把一条模型的原始元数据收敛成清单条目。 */
function entryOf(provider, providerName, info) {
  return {
    provider,
    providerName,
    model: String(info.id),
    name: typeof info.name === 'string' && info.name !== '' ? info.name : String(info.id),
    description: typeof info.description === 'string' ? info.description : '',
  }
}

/**
 * 把宿主给的 `reasoning` 元数据收敛成 `{ efforts, defaultEffort? }`。
 *
 * 这是**模型自己的档位表** —— 也就是用户在模型设置页直接选这个模型时看到的
 * 那几档。设置页里给队列中每个模型选的思考强度，取值必须落在这张表里，
 * 否则宿主会以 UNSUPPORTED_REASONING_EFFORT 拒绝整个请求。
 *
 * @param {any} value - `LlmResolvedModelInfo.reasoning`
 * @returns {{efforts: {id: string, name: string, description?: string}[], defaultEffort?: string}|undefined}
 */
export function normalizeReasoning(value) {
  const source = Array.isArray(value?.efforts) ? value.efforts : []
  const efforts = []
  const seen = new Set()
  for (const effort of source) {
    if (effort === null || typeof effort !== 'object') continue
    const id = typeof effort.id === 'string' ? effort.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const name = typeof effort.name === 'string' && effort.name !== '' ? effort.name : id
    efforts.push(typeof effort.description === 'string'
      ? { id, name, description: effort.description }
      : { id, name })
  }
  if (efforts.length === 0) return undefined
  const fallback = typeof value?.defaultEffort === 'string' && seen.has(value.defaultEffort) ? value.defaultEffort : undefined
  return fallback === undefined ? { efforts } : { efforts, defaultEffort: fallback }
}

/**
 * @param {object} deps
 * @param {any} deps.llm - 宿主的 llm 服务。
 * @param {() => string[]} deps.hiddenProviders - 要排除的 provider id。
 * @param {{ warn?: (message: any) => void, info?: (message: any) => void }} [deps.logger]
 */
export class Catalog {
  constructor({ llm, hiddenProviders, logger }) {
    this.llm = llm
    this.hiddenProviders = hiddenProviders
    this.logger = logger ?? {}
    /** @type {{provider: string, providerName: string, model: string, name: string, description: string}[]} */
    this.entries = []
    /** @type {Map<string, number>} provider\u0000model -> contextWindow */
    this.contextWindows = new Map()
    /**
     * 每个模型自己的思考强度档位表（`resolveModelInfo` 才有，`listModels` 没有）。
     * @type {Map<string, {efforts: {id: string, name: string}[], defaultEffort?: string}>}
     */
    this.reasoning = new Map()
    /**
     * 已经问过 `resolveModelInfo` 的键。
     *
     * 与「有没有拿到值」分开记：模型**不支持**思考强度时问一百遍也还是不支持，
     * 而每次刷新都去打一遍上游（发现型适配器会真的发请求）纯属浪费。
     */
    this.asked = new Set()
    this.errors = []
    this.at = 0
    this.inflight = undefined
  }

  /** 隐藏名单 = 用户设置 + 插件自己的路由。 */
  #hidden() {
    const hidden = new Set(this.hiddenProviders?.() ?? [])
    // 无条件把插件自己摘掉：「模型接力」被当成候选就是无限自我递归，
    // 这不能指望用户在设置里手动排除，只能由代码保证。
    hidden.add(ROUTE)
    return hidden
  }

  /** 有缓存且未过期就直接用；否则等一次刷新。 */
  async list({ force = false, ttlMs = DEFAULT_TTL_MS } = {}) {
    const fresh = Date.now() - this.at < ttlMs && this.entries.length > 0
    if (!force && fresh) return this.entries
    return this.refresh()
  }

  /** 已缓存清单的同步视图（缓存为空时返回 []）。执行路径专用。 */
  cached() {
    return this.entries
  }

  /** 从缓存里取某个模型的上下文窗口；拿不到就返回 undefined。 */
  contextWindow(provider, model) {
    return this.contextWindows.get(`${provider}\u0000${model}`)
  }

  /** 重扫一遍宿主路由。并发调用共享同一次扫描。 */
  async refresh() {
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.#scan().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  async #scan() {
    const hidden = this.#hidden()
    const entries = []
    const errors = []
    const contextWindows = new Map()
    const seen = new Set()

    let providers = []
    try {
      providers = this.llm.listProviders() ?? []
    } catch (error) {
      errors.push({ provider: '', message: String(error?.message ?? error) })
      this.errors = errors
      this.entries = []
      this.at = Date.now()
      return entries
    }

    for (const provider of providers) {
      const id = String(provider?.id ?? '')
      if (id === '' || hidden.has(id)) continue
      const providerName = typeof provider?.name === 'string' && provider.name !== '' ? provider.name : id
      let models = []
      try {
        models = (await this.llm.listModels(id)) ?? []
      } catch (error) {
        // 一条路由挂了（key 没填、端点不通、配置坏了）不该让别的路由也消失。
        errors.push({ provider: id, message: String(error?.message ?? error) })
        continue
      }
      for (const info of models) {
        if (info === null || typeof info !== 'object' || typeof info.id !== 'string' || info.id === '') continue
        entries.push(entryOf(id, providerName, info))
        const key = `${id}\u0000${info.id}`
        seen.add(key)
        // listModels 不返回上下文窗口（那是 resolveModelInfo 的事），所以这里
        // 只能拿适配器顺手带的；拿不到就算了，执行路径会回落。
        if (Number.isFinite(info.contextWindow)) contextWindows.set(key, info.contextWindow)
      }
    }

    this.entries = entries
    this.errors = errors
    // listModels 拿不到窗口和档位，它们是问 resolveModelInfo 得来的；重扫时把
    // 还存在的模型的事实带过去，免得每刷新一次就重新问一遍上游、期间还会闪回
    // 「未知」。已经被移除的模型则连事实一起丢掉。
    const contextWindowsNext = contextWindows
    for (const [key, value] of this.contextWindows) {
      if (seen.has(key)) contextWindowsNext.set(key, value)
    }
    const reasoningNext = new Map()
    for (const [key, value] of this.reasoning) {
      if (seen.has(key)) reasoningNext.set(key, value)
    }
    this.contextWindows = contextWindowsNext
    this.reasoning = reasoningNext
    for (const key of [...this.asked]) {
      if (!seen.has(key)) this.asked.delete(key)
    }
    this.at = Date.now()
    if (errors.length > 0) {
      this.logger.warn?.(
        `model-failover: ${errors.length} 条路由的模型清单读取失败 — ${errors.map((row) => `${row.provider || '?'}: ${row.message}`).join('; ')}`,
      )
    }
    return entries
  }

  /** 队列里第一个候选的上下文窗口，作为「模型接力」这条路由对外声明的窗口。 */
  narrowestContextWindow(order) {
    let narrowest
    for (const item of order) {
      const window = this.contextWindow(item.provider, item.model)
      if (!Number.isFinite(window) || window <= 0) continue
      if (narrowest === undefined || window < narrowest) narrowest = window
    }
    return narrowest
  }

  /** 某模型自己的思考强度档位表；没问过或它不支持就返回 undefined。 */
  reasoningFor(provider, model) {
    return this.reasoning.get(`${provider}\u0000${model}`)
  }

  /**
   * 已经问过宿主、并且确认**没有**思考强度档位（而不是「还没问」）。
   *
   * 设置页要靠它区分两件事：这个模型根本不支持思考强度（不画控件），
   * 还是插件还没来得及问（画个禁用态的未档位）。
   */
  reasoningKnown(provider, model) {
    return this.asked.has(`${provider}\u0000${model}`)
  }

  /**
   * 队列里所有已知档位的并集，按第一次出现的顺序。
   *
   * 「模型接力」是一条路由，却要面对一串各有各档位表的模型，所以对外只能把
   * 大家认识的名字并起来 —— 用户在模型选择器里给这条路由选档位时，看到的就
   * 是队列里出现过的档位。真正下发给候选模型时会再按它自己的表过滤一次
   * （见 lib/adapter.js 的 `#effortFor`）。
   */
  effortsUnion(order) {
    const byId = new Map()
    for (const item of order ?? []) {
      const known = this.reasoningFor(item?.provider, item?.model)
      if (known === undefined) continue
      for (const effort of known.efforts) {
        if (!byId.has(effort.id)) byId.set(effort.id, effort)
      }
    }
    return [...byId.values()]
  }

  /**
   * 补齐 listModels 没给的上下文窗口和思考强度档位。
   *
   * `listModels` 的契约里没有这两样（那是 resolveModelInfo 的事），所以只靠它
   * 扫出来的窗口永远是空的 —— 而「模型接力」对外只能声明一个窗口，声明不出来，
   * 宿主就按自己的默认值管上下文，队列里换了个小窗口的模型时会撞墙；档位表同理，
   * 不知道某个模型认哪些档位，就只能不给它指定档位。
   *
   * 这里对**还没问过**的条目逐条问宿主，问过就记进 `asked`（见那里的注释：不支持
   * 也是答案，不能反复问）。整批不可用（发现型适配器打上游失败、老版本没有这个
   * 方法）就静默放弃：这些只是优化，缺了不影响接力本身。
   */
  async fillModelFacts(signal) {
    const resolve = this.llm.resolveModelInfo
    if (typeof resolve !== 'function') return
    for (const entry of this.entries) {
      if (signal?.aborted === true) return
      const key = `${entry.provider}\u0000${entry.model}`
      if (this.asked.has(key)) continue
      try {
        const info = await resolve.call(this.llm, entry.provider, entry.model, signal)
        const window = info?.context?.contextWindow
        if (Number.isFinite(window) && window > 0) this.contextWindows.set(key, window)
        const reasoning = normalizeReasoning(info?.reasoning)
        if (reasoning !== undefined) this.reasoning.set(key, reasoning)
        this.asked.add(key)
      } catch {
        /* 单条问不出来就算了 —— 见上面的取舍 */
      }
    }
  }
}
