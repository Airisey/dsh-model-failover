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

/**
 * 落盘形状的版本号。
 *
 * 换形状时把这里 +1，老文件会被当成「没有缓存」直接忽略 —— 与其猜怎么迁移，
 * 不如让下一次扫描重新填一遍，代价只是多扫一次。
 */
const CACHE_VERSION = 1

/**
 * 把落盘的东西收敛回内存形状。
 *
 * 任何一项不合法就当它不存在：这份文件只是缓存，读坏了顶多多扫一次，
 * 绝不能因为一个脏字段把插件拖崩。
 */
function normalizeCache(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  if (source.version !== CACHE_VERSION) return undefined
  if (!Array.isArray(source.entries) || source.entries.length === 0) return undefined
  const entries = []
  for (const row of source.entries) {
    if (row === null || typeof row !== 'object') continue
    if (typeof row.provider !== 'string' || row.provider === '') continue
    if (typeof row.model !== 'string' || row.model === '') continue
    entries.push({
      provider: row.provider,
      providerName: typeof row.providerName === 'string' && row.providerName !== '' ? row.providerName : row.provider,
      model: row.model,
      name: typeof row.name === 'string' && row.name !== '' ? row.name : row.model,
      description: typeof row.description === 'string' ? row.description : '',
    })
  }
  if (entries.length === 0) return undefined
  const contextWindows = new Map()
  for (const [key, value] of Object.entries(source.contextWindows ?? {})) {
    if (Number.isFinite(value) && value > 0) contextWindows.set(key, value)
  }
  const reasoning = new Map()
  for (const [key, value] of Object.entries(source.reasoning ?? {})) {
    const normalized = normalizeReasoning(value)
    if (normalized !== undefined) reasoning.set(key, normalized)
  }
  const asked = Array.isArray(source.asked)
    ? source.asked.filter((key) => typeof key === 'string' && key !== '')
    : []
  const errors = Array.isArray(source.errors)
    ? source.errors.filter((row) => row !== null && typeof row === 'object')
    : []
  const providers = []
  for (const row of Array.isArray(source.providers) ? source.providers : []) {
    if (row === null || typeof row !== 'object') continue
    if (typeof row.id !== 'string' || row.id === '') continue
    providers.push({
      id: row.id,
      name: typeof row.name === 'string' && row.name !== '' ? row.name : row.id,
      hidden: row.hidden === true,
    })
  }
  return {
    entries,
    providers,
    contextWindows,
    reasoning,
    asked,
    errors,
    at: Number.isFinite(source.at) ? source.at : 0,
  }
}

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
 * @param {import('./store.js').JsonFile} [deps.cacheFile] - 扫描结果的落盘位置。
 */
export class Catalog {
  constructor({ llm, hiddenProviders, logger, cacheFile }) {
    this.llm = llm
    this.hiddenProviders = hiddenProviders
    this.logger = logger ?? {}
    this.cacheFile = cacheFile
    /** @type {{provider: string, providerName: string, model: string, name: string, description: string}[]} */
    this.entries = []
    /**
     * 所有路由（含被隐藏的）：`{ id, name, hidden }`。
     *
     * 只记清单里出现过的路由是不够的 —— 被隐藏的路由恰恰不在清单里，
     * 而设置页正需要把它们列出来让人撤销隐藏。
     * @type {{id: string, name: string, hidden: boolean}[]}
     */
    this.providers = []
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
     *
     * 但这不是永久结论：宿主的答案会随配置变（用户在 `cordis.patch.yml` 里
     * 补上 `reasoningEfforts` 之后它就改口了），所以用户点「重新扫描」时要用
     * {@link forgetAsked} 把它清掉重问。
     */
    this.asked = new Set()
    this.errors = []
    this.at = 0
    this.inflight = undefined
    this.#restore()
  }

  /**
   * 把上一次进程留下的扫描结果捡回来。
   *
   * 为什么不干脆每次启动重扫：有些 provider（qoder / qodercn 这类）的
   * `listModels` 要打上游、还要等账号池，冷启动那几秒里清单是空的 ——
   * 设置页于是显示「没有可添加的模型」，用户以为模型丢了。文件在、且没过期，
   * 就先用它顶着；等真正扫完再整体覆盖。
   */
  #restore() {
    const file = this.cacheFile
    if (file === undefined) return
    // 一定要过一遍 `normalizeCache`：`JsonFile` 那边只做了 JSON 解析，
    // 版本号、字段形状都得在这里校验。少这一道，一份上个版本写的缓存
    // 就会被当成这个版本的数据直接用，症状是清单里冒出已经不存在的模型。
    const cached = normalizeCache(file.get())
    if (cached === undefined) return
    this.entries = cached.entries
    this.providers = cached.providers
    this.contextWindows = cached.contextWindows
    this.reasoning = cached.reasoning
    this.asked = new Set(cached.asked)
    this.errors = cached.errors
    this.at = cached.at
  }

  /** 把当前扫描结果写回磁盘（失败只记一条警告，不影响任何功能）。 */
  #persist() {
    const file = this.cacheFile
    if (file === undefined) return
    try {
      file.replace({
        version: CACHE_VERSION,
        entries: this.entries,
        providers: this.providers,
        contextWindows: Object.fromEntries(this.contextWindows),
        reasoning: Object.fromEntries(this.reasoning),
        asked: [...this.asked],
        errors: this.errors,
        at: this.at,
      })
      file.flush()
    } catch (error) {
      this.logger.warn?.(`model-failover: 扫描结果写盘失败 — ${String(error?.message ?? error)}`)
    }
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

  /**
   * 忘掉「已经问过宿主」这件事，让下一次 `fillModelFacts` 重新问一遍。
   *
   * `asked` 的本意是「别对同一个模型反复问」，但宿主的答案会变：用户在
   * `cordis.patch.yml` 里补上 `reasoningEfforts` 之后，宿主就会开始报档位，
   * 而旧答案还压在 `asked` 里 —— 问过就再也不问，档位永远停在「无」。
   * 所以用户显式点「重新扫描」时必须连这份记忆一起清掉，否则那次重扫
   * 只是把清单重列了一遍，档位表和窗口一个都不会更新。
   *
   * 不清 `reasoning` / `contextWindows`：那是**已知**的事实，重问一遍会覆盖，
   * 但问不到的间隙里还得靠它顶着，否则列表会闪一下「无档位」。
   */
  forgetAsked() {
    if (this.asked.size === 0) return 0
    const dropped = this.asked.size
    this.asked = new Set()
    this.#persist()
    return dropped
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
    /** 所有路由（含被隐藏的），设置页要靠它画出「哪些被隐藏了」。 */
    const providerRows = []

    let providers = []
    try {
      providers = this.llm.listProviders() ?? []
    } catch (error) {
      errors.push({ provider: '', message: String(error?.message ?? error) })
      this.errors = errors
      this.at = Date.now()
      // 宿主整个问不出来（llm 还没挂完、服务在重启）时**不清空**手上这份：
      // 清空等于把用户刚才还在用的清单变成一片空白，而下一次扫描马上又会填回来。
      this.#persist()
      return this.entries
    }

    for (const provider of providers) {
      const id = String(provider?.id ?? '')
      if (id === '') continue
      const providerName = typeof provider?.name === 'string' && provider.name !== '' ? provider.name : id
      // 连隐藏的一起记下来：设置页要能把这些路由列出来让人撤销隐藏，
      // 而「被隐藏」这件事恰恰意味着它们的模型不在清单里，无从推断。
      if (!providerRows.some((row) => row.id === id)) {
        providerRows.push({ id, name: providerName, hidden: hidden.has(id) })
      }
      if (hidden.has(id)) continue
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
    this.providers = providerRows
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
    this.#persist()
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
   * 补齐 listModels 没给的上下文窗口和思考强度档位。
   *
   * `listModels` 的契约里没有这两样（那是 resolveModelInfo 的事），所以只靠它
   * 扫出来的窗口永远是空的 —— 而「模型接力」对外只能声明一个窗口，声明不出来，
   * 宿主就按自己的默认值管上下文，队列里换了个小窗口的模型时会撞墙；档位表同理，
   * 不知道某个模型认哪些档位，就只能不给它指定档位。
   *
   * 这里对**还没问过**的条目逐条问宿主，问过就记进 `asked`（见那里的注释：不支持
   * 也是答案，不能反复问 —— 但用户点「重新扫描」时会清掉这份记忆重问一遍）。
   * 整批不可用（发现型适配器打上游失败、老版本没有这个方法）就静默放弃：这些
   * 只是优化，缺了不影响接力本身。
   */
  async fillModelFacts(signal) {
    const resolve = this.llm.resolveModelInfo
    if (typeof resolve !== 'function') return
    let learned = false
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
        learned = true
      } catch {
        /* 单条问不出来就算了 —— 见上面的取舍 */
      }
    }
    // 只在这一轮真的问到东西时才写盘：档位表和窗口都是慢慢攒出来的，
    // 每攒到一点就存一次，下次启动就不用再逐条去问上游。
    if (learned) this.#persist()
  }
}
