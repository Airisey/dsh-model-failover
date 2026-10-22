/**
 * 「模型接力」这条 provider 路由的适配器。
 *
 * 契约（宿主 @deepseek-ai/dsh-llm 的 LlmAdapter）：
 *   providerInfo(provider) -> { id, name }
 *   providerRetryPolicy(provider) -> ResolvedRetryPolicy | undefined
 *   imageRequestPricing(provider, model) -> undefined
 *   listModels(provider) -> Promise<LlmModelInfo[]>
 *   resolveModel(provider, model, signal) -> Promise<LlmResolvedModelInfo>
 *   prepareCall(provider, model, signal) -> Promise<{ model, stream(options) }>
 *   stream(options) -> AsyncIterable<StreamChunk>
 *
 * 本插件是「包装路由」（wrapper route）：在自己的 stream() 体内再调用一次
 * ctx.llm.stream()，把 provider/model 换成队列里的真实模型。modlens、
 * vision-router 用的都是这个模式，dsh-cost-meter 的注释里把它写得很明确。
 *
 * 整个设计的关键只有一条 —— **提交点**：
 * 候选模型产出的 chunk 先全部扣在手里，直到出现「用户会看见的答案内容」
 * （非空白 text-delta、tool-call-delta，或非 reasoning 的 block-end）才整批
 * 放行。在此之前失败，这一整轮就被整根丢掉，调用方一个字节都没看见，于是
 * 换模型是无声的、不会把两个模型的文字拼在一起。
 *
 * reasoning 的 delta 故意不算提交点：「思考了一分钟然后撞上额度墙」正是最
 * 值得切换的情形，扣住的思考跟着这一轮一起丢，调用方根本不知道发生过。
 */

import {
  CODE_NO_VISIBLE_OUTPUT,
  DEFAULT_TEMPLATE_ID,
  MAX_SAME_MODEL_RETRIES,
  MAX_TEMPLATE_CANDIDATES,
  MODEL_DESCRIPTION,
  NON_FAILOVER_CODES,
  ROUTE,
  ROUTE_LABEL,
  routeKey,
} from './constants.js'
import { isLocalNetworkFailure } from './network.js'

/** 自动补发的「继续」最多堆几条，防止候选很多时把会话撑长。 */
const MAX_CONTINUES = 3

/**
 * 同一个模型最多试几次（含第一次）。
 *
 * 旧配置里只有一个布尔开关 `retrySameModelOnce`，它表达的是「多试一次」；
 * 现在这件事要能调，因为同一个模型背后可能是好几个账号。没设过新键时按
 * 老开关折算：关掉过就是只试一次，否则用默认值。
 */
function sameModelTries(settings) {
  const raw = settings?.sameModelRetries
  if (Number.isInteger(raw) && raw >= 0) return Math.min(raw, MAX_SAME_MODEL_RETRIES) + 1
  return (settings?.retrySameModelOnce === false ? 0 : 2) + 1
}

/**
 * 同一个模型连着撞几次输出上限之后，就不让它接着写，换队列里的下一个。
 *
 * 撞上限本身不算「这个模型坏了」—— 它只是还没写完，让它接着说最省事，所以
 * **第一次**照旧用原模型补「继续」。但如果它连着撞，那就是「这个模型在这个
 * 任务上写不完」：要么上下文已经撑满，要么它习惯性收不住。这时候继续在它身上
 * 耗着，用户看到的只是同一句半截话被反复截断，不如换个人接手 —— 队列里的下
 * 一个模型读到的是同一段对话（含半截回答），接着往下写。
 *
 * 取 2 的语义：第 1 次撞上限用原模型补一次；第 2 次还撞，下一次调用就轮到
 * 队列里的下一个。写成常量而不是设置项，是不想让设置页再多一行 —— 想调随时
 * 改这里。
 */
const CEILING_STREAK_BEFORE_ROTATE = 2

/**
 * 宿主默认的 backoff 值，抄自 dsh-llm 的 retry-policy 默认。
 *
 * 注意形状：这只是**过桥的原料**。适配器必须交出 resolveRetryPolicy() 的
 * 返回值形状 —— 也就是把 initialDelayMs / maxDelayMs / jitterRatio 摊平在顶层
 * （见 dsh-llm/lib/types/retry-policy.js:110-115 和 84-91）。配置文件里的
 * `backoff: {...}` 嵌套形状是**另一种**形状，只属于 RetryPolicySchema 输入；
 * 把嵌套形状交给宿主，llm-retry 读到的 delay 全是 undefined，退避时间直接变
 * 成 NaN 并把持久化事件写坏。
 */
const DEFAULT_BACKOFF = { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1 }

/**
 * 一个永远不会匹配任何真实错误码的哨兵。
 *
 * resolveRetryPolicy 有一条「retryableCodes 不能为空」的校验，而适配器的返回值
 * **不经过**这道校验（dsh-llm/lib/index.js:1867 是 `??` 直接采用）。用哨兵而不是
 * 空数组，是为了万一将来有一层替我们再校验一次也不至于把插件整挂。
 */
const NEVER_RETRY = '__model-failover-never__'

/**
 * 这个 chunk 是否代表「调用方已经看见了答案」。
 *
 * 判据与宿主 assistant-stream 的可见性定义对齐：只有非空白的文本才是答案，
 * 流式工具调用一旦开始就意味着这轮已经有产品，reasoning 与它的 block-end
 * 都不算 —— 让 reasoning 的 block-end 提交，会把队列钉死在它本该熬过去的
 * 那次失败之前一个 chunk。
 */
export function commitsAnswer(chunk) {
  if (chunk === null || typeof chunk !== 'object') return false
  if (chunk.type === 'text-delta') return typeof chunk.text === 'string' && chunk.text.trim() !== ''
  if (chunk.type === 'tool-call-delta') return true
  if (chunk.type !== 'block-end') return false
  if (chunk.block?.type === 'reasoning') return false
  if (chunk.block?.type === 'text') return typeof chunk.block.text === 'string' && chunk.block.text.trim() !== ''
  return true
}

/** 把一次 finish 或一个异常收敛成 `{ code, message, status? }`。 */
export function failureOf(finish, error) {
  if (error !== undefined && error !== null) {
    return {
      code: typeof error.code === 'string' && error.code !== '' ? error.code : 'UNKNOWN',
      message: String(error.message ?? error),
      status: Number.isFinite(error.status) ? error.status : undefined,
    }
  }
  const reason = finish?.reason
  if (reason?.kind === 'error' || reason?.kind === 'aborted') {
    return {
      code: typeof reason.failure?.code === 'string' && reason.failure.code !== '' ? reason.failure.code : reason.kind.toUpperCase(),
      message: String(reason.failure?.message ?? ''),
      status: Number.isFinite(reason.failure?.status) ? reason.failure.status : undefined,
    }
  }
  if (finish?.type === 'finish') {
    return {
      code: CODE_NO_VISIBLE_OUTPUT,
      message: `模型以 ${String(reason?.kind ?? 'unknown')} 结束，但整轮没有产出任何可见内容。`,
    }
  }
  return { code: CODE_NO_VISIBLE_OUTPUT, message: '模型没有产出任何内容。' }
}

/** 一条 `RequestUserInput`；宿主 Message 联合类型里唯一允许不带 id/source 的形态。 */
export function continueMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

/**
 * 默认的等待实现。可以用 `--use-system-ca` 之外的方式覆盖（测试会注入假实现）。
 *
 * 带 abort 支持：用户在等待期间按了停止，这一轮该立刻收摊，而不是等满再往下试。
 *
 * @param {number} ms - 等待毫秒数。
 * @param {AbortSignal | undefined} signal - 调用方给的取消信号。
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  if (signal?.aborted === true) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener?.('abort', done, { once: true })
  })
}

/**
 * @param {object} deps
 * @param {any} deps.llm - 宿主 llm 服务（借它做嵌套调用）。
 * @param {import('./store.js').JsonFile<any>} deps.settings
 * @param {import('./health.js').DailyHealth} deps.health
 * @param {import('./catalog.js').Catalog} deps.catalog
 * @param {{ push: (event: object) => void, warn: (message: string) => void }} deps.log
 * @param {() => number} [deps.now]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [deps.sleep] - 等待实现；测试用。
 */
export class FailoverAdapter {
  constructor({ llm, settings, health, catalog, log, notes, now = Date.now, sleep: wait = sleep }) {
    this.llm = llm
    this.settings = settings
    this.health = health
    this.catalog = catalog
    this.log = log
    /**
     * 「这个会话刚才跑的是谁」的便签（lib/notes.js）。可以缺席 —— 缺席时只是
     * 不显示小字，接力本身一个字节都不受影响。
     */
    this.notes = notes
    this.now = now
    this.sleep = wait
    /**
     * 会话 → `{ hits, key, provider, model }`：这个会话**连着**撞了几次输出上限。
     *
     * `hits` 每撞一次加一，成功写完一轮就整条删掉。它是「换人」的唯一依据：
     * 每攒够 CEILING_STREAK_BEFORE_ROTATE 次，队列就往前挪一格。账按会话累加
     * 而不是按模型，否则换过人之后下一轮又会回到队首，在两个模型之间来回打转。
     *
     * 只在内存里。撞上限这件事只有适配器自己看得见 —— 轮级那层只拿到一个
     * `{ kind: 'max-tokens' }`，不知道是谁跑的。
     */
    this.ceiling = new Map()
    /**
     * 会话 → `{ provider, model, key, startedAt }`：此刻**正在**跑的那个候选。
     *
     * 会话页那一栏靠它做两件事：把正在跑的会话列出来（哪怕它还没跑完任何一趟、
     * 因此既没隔离也没验证记录），以及在有人跑着的时候把轮询间隔从 15 秒压到
     * 2 秒 —— 用户盯着看的就是这一刻，15 秒的刷新等于没在更新。
     *
     * 同样是内存态：进程重启之后没人「正在跑」，本来也不该留着。
     */
    this.live = new Map()
  }

  /**
   * 这个会话此刻正在跑的候选，没有就 undefined。
   *
   * @param {string} [sessionId]
   */
  liveFor(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    return this.live.get(sessionId)
  }

  /** 所有正在跑的会话，`Map<sessionId, {provider, model, key, startedAt}>`。 */
  liveSessions() {
    return this.live
  }

  // ── 适配器契约 ─────────────────────────────────────────────────────────────

  providerInfo(provider) {
    return { id: provider, name: ROUTE_LABEL }
  }

  /**
   * 接力队列自己做重试与切换，所以这条路由对外声明「不做重试」。
   *
   * 否则 llm-retry 会把整条队列再跑一遍：每一轮都要等每个坏模型各自超时，
   * 延迟成倍放大，而队列本身已经把「所有候选都试过」这件事做完了。
   */
  providerRetryPolicy(_provider) {
    return { mode: 'normal', maxRetries: 0, retryableCodes: [NEVER_RETRY], ...DEFAULT_BACKOFF }
  }

  imageRequestPricing(_provider, _model) {
    return undefined
  }

  /**
   * 这条路由下的「模型」就是队列模板：一个模板一条队列。
   *
   * 用户在模型选择器里挑中哪个模板，那个会话就用哪条队列 —— 模板 id 会原样
   * 出现在 `GenerateOptions.model` 里，`stream()` 拿它选队列。
   */
  async listModels(provider) {
    const settings = this.settings.get()
    const templates = Array.isArray(settings.templates) ? settings.templates : []
    return templates.map((template) => ({
      provider,
      id: template.id,
      name: template.name,
      description: MODEL_DESCRIPTION,
      inputModalities: ['text', 'image'],
    }))
  }

  /**
   * `model` 就是模板 id。
   *
   * 找不到时退回第一个模板而不是报错：模板可能刚被删掉，而一个还挂着旧 id 的
   * 会话总得能继续跑下去。老版本里那条路由下只有 `auto` 一个模型，它也会落到
   * 这里，正好落到默认模板上。
   */
  templateFor(settings, modelId) {
    const templates = Array.isArray(settings.templates) ? settings.templates : []
    if (templates.length === 0) return undefined
    const hit = templates.find((template) => template.id === modelId)
    return hit ?? templates[0]
  }

  async resolveModel(provider, model, _signal) {
    const settings = this.settings.get()
    const template = this.templateFor(settings, model)
    const order = Array.isArray(template?.order) ? template.order : []
    const narrowest = this.catalog.narrowestContextWindow(order)
    // 队列里每个模型各有各的档位表，而这是**一条**路由，所以对外只能把队列里
    // 出现过的档位并起来（宿主会拿这张表校验请求里的 reasoningEffort）。真正
    // 下发给某个候选时会按它自己的表再过滤一次 —— 见 `#effortFor`。
    const efforts = this.catalog.effortsUnion(order)
    return {
      provider,
      id: model,
      name: template?.name ?? model,
      description: MODEL_DESCRIPTION,
      // 图片交给真正的目标模型去判断：这里若声明成纯文本，宿主会在我的
      // stream() 之前就把图片压成文字，目标模型再也没机会用视觉能力。
      inputModalities: ['text', 'image'],
      // 队列可能落到任何一个候选上，所以对外声明的是**最窄**的那个窗口：
      // 由宿主提前压缩，好过在某个小窗口模型上撞 CONTEXT_WINDOW_EXCEEDED。
      ...narrowest === undefined ? {} : { context: { contextWindow: narrowest } },
      // 故意不声明 defaultEffort：缺省档位应该由每个候选自己的适配器决定
      // （也就是它「正常使用」时的表现），这条路由替它选一个反而是越权。
      ...efforts.length === 0 ? {} : { reasoning: { efforts } },
    }
  }

  async prepareCall(provider, model, _signal) {
    const info = await this.resolveModel(provider, model)
    return {
      model: info,
      stream: (options) => this.stream(options),
    }
  }

  // ── 队列执行 ───────────────────────────────────────────────────────────────

  /**
   * 把设置里的顺序 + 当日隔离名单合成一条可执行的候选序列。
   *
   * 优先尝试「今天还没出过问题」的模型，保持用户排的优先级；全都出过问题
   * 时按用户设置决定是硬着头皮再试一遍还是直接放弃。
   *
   * @param {object} settings
   * @param {object | undefined} template - 这次调用用的模板；队列来自它的 `order`。
   * @param {{quarantined: Set<string>}} snapshot
   * @param {number} [skip] - 从队首跳过几个候选再开始（会按队列长度取模）。
   *   用于「同一个模型连着撞输出上限」时把队列往前挪一格换人接手。
   */
  chain(settings, template, snapshot, skip = 0) {
    const hidden = new Set(settings.hiddenProviders ?? [])
    const known = this.catalog.cached()
    const knownKeys = known.length === 0 ? undefined : new Set(known.map((item) => routeKey(item.provider, item.model)))
    const ordered = []
    for (const item of Array.isArray(template?.order) ? template.order : []) {
      if (ordered.length >= MAX_TEMPLATE_CANDIDATES) break
      if (item === null || typeof item !== 'object') continue
      const provider = String(item.provider ?? '')
      const model = String(item.model ?? '')
      if (provider === '' || model === '') continue
      if (provider === ROUTE || hidden.has(provider)) continue
      // 清单是冷的就不筛（fail-open）：宁可让宿主回一个 NO_ADAPTER 被跳过，
      // 也不要在目录还没扫完时把用户整条队列清空。
      if (knownKeys !== undefined && !knownKeys.has(routeKey(provider, model))) continue
      // 每个候选自带的思考强度跟着它一起走：换到下一个模型时，用的是**那个**
      // 模型自己的档位，不是上一个的。
      const reasoningEffort =
        typeof item.reasoningEffort === 'string' && item.reasoningEffort.trim() !== ''
          ? item.reasoningEffort.trim()
          : undefined
      ordered.push(reasoningEffort === undefined ? { provider, model } : { provider, model, reasoningEffort })
    }
    // 总开关关掉时这条路由仍然能跑，只是退化成「永远用优先级最高的那一个」，
    // 不再重试、不再切换、也不再隔离 —— 排查问题时这样最干净。
    let candidates
    if (settings.enabled === false) {
      candidates = ordered.slice(0, 1)
    } else {
      const usable = ordered.filter((item) => !snapshot.quarantined.has(routeKey(item.provider, item.model)))
      if (usable.length > 0) candidates = usable
      else candidates = settings.retryWhenAllQuarantined === false ? [] : ordered
    }
    if (!Number.isInteger(skip) || skip <= 0 || candidates.length < 2) return candidates
    // 取模是为了让队列真的转起来：跳过头了就从头接上，而不是原地不动。
    const at = ((skip % candidates.length) + candidates.length) % candidates.length
    if (at === 0) return candidates
    return [...candidates.slice(at), ...candidates.slice(0, at)]
  }

  /**
   * 把候选序列展开成执行步骤。
   *
   * 「继续」的条数 = 已经失败过的轮数：第 0 个模型第一次就是原始请求，之后
   * 每退让一步就多带一条「继续」—— 用户要求的「重试这个模型发继续」「切换到
   * 下一个模型发继续」都落在这一步上。
   */
  plan(settings, template, snapshot, skip) {
    const chain = this.chain(settings, template, snapshot, skip)
    const tries = sameModelTries(settings)
    const steps = []
    for (let index = 0; index < chain.length; index += 1) {
      // 退到队列里第 index 个模型时带几条「继续」：第 0 个是原始请求，每多换
      // 一次模型就多带一条 —— 用户要的「换下一个模型时发继续」落在这里。
      const continues = Math.min(index, MAX_CONTINUES)
      // 同一个模型的每次尝试发**完全相同的请求**。
      //
      // 一是为了换账号：只有重发原请求，`dsh-our-free-model` 这类多账号反代
      // 才会重新进一次账号池，把刚才那个坏账号换掉。二是新账号压根没写过东西，
      // 收到「继续」只会莫名其妙。
      for (let attempt = 0; attempt < tries; attempt += 1) {
        steps.push({ candidate: chain[index], continues })
      }
    }
    return steps
  }

  /**
   * 完整的一轮模型调用。
   * @param {any} options - 宿主给你的 GenerateOptions。
   */
  async * stream(options) {
    const at = this.now()
    const settings = this.settings.get()
    // 隔离名单按会话分桶 —— 先把 sessionId 取出来，快照就要它。
    //
    // 压缩会话、起标题这类内部调用共用同一个 sessionId，它们**照样**进这个
    // 会话的桶（它们确实是在为这个会话干活，撞上的墙也是这个会话的墙）；
    // 但它们不参与「撞上限换人」的记账，因为那个账是给用户看的轮准备的。
    const sessionId = typeof options?.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : undefined
    // 模型 id 就是模板 id。老会话里存的可能是 `auto`，`templateFor` 会把它接到
    // 第一个模板上，不至于因为升级而整条队列失效。
    const template = this.templateFor(settings, options?.model)
    const templateId = template?.id ?? DEFAULT_TEMPLATE_ID
    const snapshot = this.health.snapshot(at, settings.resetHour, sessionId, templateId)
    const userFacing = options?.purpose === undefined
    const streak = userFacing && sessionId !== undefined ? this.ceiling.get(sessionId) : undefined
    const skip = streak === undefined ? 0 : Math.floor(streak.hits / CEILING_STREAK_BEFORE_ROTATE)
    const steps = this.plan(settings, template, snapshot, skip)

    if (steps.length === 0) {
      yield errorFinish(
        'NO_CANDIDATES',
        (Array.isArray(template?.order) ? template.order : []).length === 0
          ? `「模型接力」的模板「${template?.name ?? templateId}」还是空的：到 设置 → 模型 → 模型接力 里给它勾选并排序要用的模型。`
          : `模板「${template?.name ?? templateId}」里今天已经没有可用模型了（其余都被隔离），到会话页的「隔离队列」可以立刻解除这个会话的隔离。`,
      )
      return
    }

    const continueText = typeof settings.continueText === 'string' && settings.continueText.trim() !== ''
      ? settings.continueText
      : '继续'

    /**
     * 每次补「继续」之前先安静等这么久。
     *
     * 为什么要有这一步：紧贴着上一次失败再敲一遍，等来的几乎总是同一个错误。
     * 本机实测（2026-10-14 的事件日志）里最难看的一段是 **9 秒内落了 12 条隔离**，
     * 相邻两条只隔 0.0～1.3 秒 —— 限流还没来得及松、上游抖动还没过去，就又被戳了
     * 一遍，除了把队列挨个隔离掉没有任何收益。
     *
     * 第一次失败也照样等：`plan()` 里第一个候选的首跳 continues 是 0，只有失败之后
     * 才排得出带「继续」的那一跳，所以这一等正好落在「刚失败完、正要补继续」的
     * 那个瞬间，没有漏掉第一次。
     */
    const delayMs = Number.isInteger(settings.continueDelaySec) && settings.continueDelaySec > 0
      ? settings.continueDelaySec * 1000
      : 0

    const attempted = []
    let held = []
    let finish
    let failure
    /**
     * 上一跳是不是栽在**本机网络**上。
     *
     * 栽在网络上的话，后面几跳都不该再带「继续」：上一个模型连请求都没收到，没有
     * 任何「写到一半」的东西可以接着写，补一句「继续」只是往请求里灌噪音。
     *
     * 只改「带几条继续」，**不动**隔离与换人的判断。这里刻意不把「同模型重发一次」
     * 那一跳整个跳过 —— 跳过后 `markBroken` 就轮不到这个候选，它今天不会被隔离，
     * 下一个任务还会从它开始再撞一次，比多发一次请求更浪费。
     */
    let networkDown = false

    for (const [index, step] of steps.entries()) {
      const { provider, model } = step.candidate
      const key = routeKey(provider, model)
      const continues = networkDown ? 0 : step.continues

      // 带「继续」的那一跳之前先等一等 —— 等的是上一次失败留下的余波。
      // 不带的跳（每个候选的首发）不欠这一等，否则第一次调用就会平白慢 5 秒。
      if (continues > 0 && delayMs > 0) {
        await this.sleep(delayMs, options?.signal)
        // 等待期间用户按了停止：别再打一个注定被取消的请求。
        if (options?.signal?.aborted === true) {
          for (const chunk of held) yield chunk
          return
        }
      }

      const messages = continues === 0
        ? options.messages
        : [...options.messages, ...Array.from({ length: continues }, () => continueMessage(continueText))]

      const effort = this.#effortFor(step.candidate, options?.reasoningEffort)
      // 标记「此刻正在跑的就是这一跳」，会话页据此把这一栏刷得快一点、并把还没
      // 跑完任何一趟的会话也列出来。只包住真正的请求：上面等待和下面记账都不算
      // 「正在跑」，否则用户会看到一行永远亮着的「运行中」。
      if (sessionId !== undefined) {
        this.live.set(sessionId, { provider, model, key, startedAt: this.now() })
      }
      let result
      try {
        result = yield * this.#attempt(step.candidate, options, messages, effort)
      } finally {
        if (sessionId !== undefined) this.live.delete(sessionId)
      }
      attempted.push({ provider, model, continues })
      // 记下「这个会话刚才跑的是谁」，供轮级那层在 turn/end 时与轮号配对。
      //
      // 每跳都覆盖是有意的：一轮里可能连着换好几个候选，最后写进来的那个才是
      // 真正产出内容（或截断在半句话上）的模型；而候选一旦提交内容，下面立刻
      // 就 return，不会再有人覆盖它。
      //
      // 压缩会话、起标题这类**不是用户在等**的调用要排除：它们共用同一个
      // sessionId，却和用户看到的这一轮无关，会把便签指到错的人身上。
      if (options?.purpose === undefined) {
        this.notes?.remember(options?.sessionId, { provider, model, template: templateId, at: this.now() })
      }
      held = result.held
      finish = result.finish
      failure = result.failure
      networkDown = failure !== undefined && isLocalNetworkFailure(failure)
      // 输出速度记在会话页那一栏的胶囊上。和上面那条便签同样的理由排除内部
      // 调用：起标题只吐十几个字，量出来的速度没有参考价值。
      if (userFacing && sessionId !== undefined && result.speed !== undefined) {
        this.health.recordSpeed(sessionId, key, { ...result.speed, at: this.now() })
      }

      if (result.committed) {
        // 这一轮正常写完了：撞上限的旧账一笔勾销，下一个任务还从队首开始。
        if (userFacing && sessionId !== undefined) this.ceiling.delete(sessionId)
        // 这个模型今天被验证过能用了；下一个任务从它开始。
        const recorded = this.health.markGood(key, this.now(), sessionId, templateId)
        this.health.file.flush()
        if (recorded) this.log.push({ at: this.now(), kind: 'good', provider, model, attempts: index + 1 })
        return
      }

      // 撞到输出上限：**不是**「这个模型坏了」，是「它还没写完」。
      //
      // 必须在这里就把扣住的东西原样交出去并收手，绝不能让它掉进下面的隔离分支
      // —— 那正是用户报的问题：模型一到 token 上限就被隔离，下一轮接力从别人
      // 开始，「继续」再也落不回原来那个模型头上。
      //
      // 交出去的 finish 仍带着 `kind: 'max-tokens'`，agent loop 会把它记成
      // `turn/end { kind: 'max-tokens' }`（dsh-agent-loop lib/index.js:1151 判定、
      // :1027 落事件），轮级的「自动继续」随即用**同一个模型**接着写。
      //
      // 但同一个模型连着撞就不该再惯着它（见 CEILING_STREAK_BEFORE_ROTATE）：
      // 记一笔账，攒够了下一次调用就从队里的下一个开始。
      //
      // 放在「中止」判断之前还是之后无所谓：两者都是把同一个 `held` 原样交出去
      // 然后 return，顺序不影响任何可观察行为。
      if (result.truncated) {
        if (userFacing && sessionId !== undefined) {
          // 账按**会话**累加，不按模型：接力换过人之后账要接着往下数，否则下一
          // 次调用又会回到队首、在原来那个模型上再撞两下，来回打转。
          const previous = this.ceiling.get(sessionId)
          const hits = (previous?.hits ?? 0) + 1
          this.ceiling.set(sessionId, { hits, key, provider, model })
          // 攒够一轮就该换人了：下一次调用 `skip` 加一，队列从下一个候选开始。
          // 日志里说清楚，否则用户只看到排在最前面的那个模型莫名其妙被跳过。
          if (hits % CEILING_STREAK_BEFORE_ROTATE === 0) {
            const next = this.chain(settings, template, snapshot, hits / CEILING_STREAK_BEFORE_ROTATE)[0]
            if (next !== undefined && routeKey(next.provider, next.model) !== key) {
              this.log.push({
                at: this.now(),
                kind: 'ceiling-rotate',
                provider,
                model,
                to: `${next.provider}/${next.model}`,
                count: CEILING_STREAK_BEFORE_ROTATE,
              })
            }
          }
        }
        for (const chunk of result.held) yield chunk
        return
      }

      // 用户自己按了停止：换模型救不回来，把真实结局原样交出去。
      if (options?.signal?.aborted === true || failure?.code === 'ABORTED') {
        for (const chunk of held) yield chunk
        return
      }

      // 请求本身的问题（上下文超长之类）：换模型只会再撞一次墙。
      if (failure !== undefined && NON_FAILOVER_CODES.has(failure.code)) {
        for (const chunk of held) yield chunk
        this.log.warn(`model-failover: ${provider}/${model} 以不可切换的错误结束 (${failure.code})`)
        return
      }

      // 这个候选还有一次「继续」没用完：先别判它今天不行。
      //
      // 隔离的语义是「今天它出不了东西」，而这要等它的重试都用完才能下结论：
      // 失败一次、被一句「继续」叫起来接着写完的模型是**能用**的，把它隔离掉
      // 反而会让今天的任务从这里绕开一个明明好好的模型。只有队列里的下一个
      // 步骤换人了（或者没有下一步了），才说明这个候选这次真的交不出东西。
      const next = steps[index + 1]
      if (next !== undefined && next.candidate.provider === provider && next.candidate.model === model) continue

      // 这个候选今天出了问题 —— 隔离到下一个逻辑日，后面的任务不会再从它开始。
      this.health.markBroken(key, {
        code: failure?.code,
        message: failure?.message,
        at: this.now(),
        sessionId,
        templateId,
      })
      this.health.file.flush()
      this.log.push({
        at: this.now(),
        kind: 'quarantine',
        provider,
        model,
        // 事件日志里也带上会话：隔离是按会话算的，没有这个字段就分不清某一行
        // 是哪个会话撞的墙。模板同理 —— 一个模板一条队列。
        sessionId,
        templateId,
        code: failure?.code ?? CODE_NO_VISIBLE_OUTPUT,
        message: failure?.message ?? '',
        // 如实记录这一跳**实际**带了几条「继续」—— 本机网络没通时它是 0，
        // 而不是 plan() 里排的那个数。事件日志是排查问题的依据，不能写计划值。
        continues,
      })
      this.log.warn(
        `model-failover: ${provider}/${model} 无法输出 (${failure?.code ?? CODE_NO_VISIBLE_OUTPUT})，隔离到明天 ${settings.resetHour} 点`,
      )
    }

    // 队列走完了。把最后一轮扣住的东西交出去，让用户看见真实报错。
    for (const chunk of held) yield chunk
    if (finish === undefined) {
      yield errorFinish(
        failure?.code ?? CODE_NO_VISIBLE_OUTPUT,
        failure?.message ?? '队列里的模型都没能产出内容。',
        attempted,
      )
    }
  }

  /**
   * 这一轮该给这个候选带什么思考强度。
   *
   * 规则只有一条：**只发这个模型自己声明支持的档位**。
   *
   * 宿主在调用适配器之前会拿我对外声明的档位表（队列的并集）校验一次性
   * `reasoningEffort`，但候选模型各自的小表才算数 —— 把一个它不认识的枚举值
   * 发下去，适配器会以 UNSUPPORTED_REASONING_EFFORT 拒绝整个请求，那等于把
   * 一个本来好好的模型判成「今天出不了东西」而被隔离。
   *
   * 认不出来（还没问到档位表，或确实不支持）就不发，让目标模型用自己的默认
   * 档位 —— 也就是它平时的表现。
   *
   * 优先级：队列里给这个模型设的档位 > 调用方给「模型接力」这条路由选的档位。
   * 前者是这个模型的专属选择，后者是「这一轮大家统一用哪个档位」的意图，所以
   * 用户为某个模型明确设过的值不会被它盖掉；反过来，没设过的模型会跟着路由
   * 的档位走，而不是默默用默认档位。
   */
  #effortFor(candidate, requested) {
    const known = this.catalog.reasoningFor(candidate.provider, candidate.model)
    const supported = (value) => known !== undefined && known.efforts.some((effort) => effort.id === value)
    const configured =
      typeof candidate.reasoningEffort === 'string' && candidate.reasoningEffort !== ''
        ? candidate.reasoningEffort
        : undefined
    if (configured !== undefined) {
      if (supported(configured)) return configured
      this.log.warn(
        `model-failover: ${candidate.provider}/${candidate.model} 不认识档位「${configured}」，这一轮改用它的默认档位`,
      )
      return undefined
    }
    const wanted = typeof requested === 'string' && requested !== '' ? requested : undefined
    return wanted !== undefined && supported(wanted) ? wanted : undefined
  }

  /**
   * 一次候选尝试：把 chunk 拉进来，扣住，直到出现提交点才放行。
   *
   * 返回 `{ committed, truncated, finish, failure, held, speed }`。`held` 在未提交时
   * 交还给调用方 —— 队列还有下一个候选就丢掉它，队列走完了就原样放出去。
   * `speed` 是这一趟的输出速度（`{ tokens, ms }`），没跑出东西时是 `undefined`。
   *
   * `truncated` 单独拎出来，是因为「撞到输出上限」既不是成功也不是失败：
   * 见下面 `failureOf` 之前的注释。
   */
  async * #attempt(candidate, options, messages, effort) {
    const nested = { ...options, provider: candidate.provider, model: candidate.model, messages }
    // 调用方给「模型接力」这条路由选的档位不能原样透给候选：它是在队列的并集上
    // 校验过的，候选未必认识。这一轮该不该带档位由 `#effortFor` 决定，所以这里
    // 显式删掉，避免它顺着 `...options` 漏下去。
    if (effort === undefined) delete nested.reasoningEffort
    else nested.reasoningEffort = effort
    let iterator
    try {
      iterator = this.llm.stream(nested)[Symbol.asyncIterator]()
    } catch (error) {
      return { committed: false, finish: undefined, failure: failureOf(undefined, error), held: [] }
    }

    const held = []
    let committed = false
    let finish
    let failure
    let drained = false
    // 输出速度的两个端点：第一个真的在写字（或想事情）的 chunk，和收到 finish
    // 的那一刻。**不含**排队与首字延迟 —— 那是延迟，不是速度，混进来会让一个
    // 「想很久但写得很快」的推理模型显得很慢。
    let firstDeltaAt
    let finishedAt
    let outputTokens

    try {
      for (;;) {
        let row
        try {
          row = await iterator.next()
        } catch (error) {
          drained = true
          failure = failureOf(undefined, error)
          break
        }
        if (row.done === true) {
          drained = true
          break
        }
        const chunk = row.value
        if (chunk !== null && typeof chunk === 'object') {
          if (chunk.type === 'finish') {
            finish = chunk
            finishedAt = this.now()
          } else if (chunk.type === 'usage') {
            if (Number.isFinite(chunk.usage?.outputTokens)) outputTokens = chunk.usage.outputTokens
          } else if (
            firstDeltaAt === undefined &&
            (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta')
          ) {
            firstDeltaAt = this.now()
          }
        }
        if (committed) {
          yield chunk
          continue
        }
        held.push(chunk)
        if (commitsAnswer(chunk)) {
          committed = true
          for (const pending of held) yield pending
          held.length = 0
        }
      }
    } finally {
      // 消费方提前中断（用户按停止）时必须显式向下游传播 return()，否则上游
      // HTTP 流会继续跑完 —— 供应商照常计满 token，chunk 却没人接。
      if (!drained) {
        try {
          await iterator.return?.()
        } catch {
          /* 关闭失败无关紧要 */
        }
      }
    }

    // 撞到输出上限（`finish.reason.kind === 'max-tokens'`）**不是**「这个模型坏了」。
    // 它明明在写，只是被截断在半句话上。判据必须放在 failureOf 之前：否则它会被
    // 收敛成 `NO_VISIBLE_OUTPUT`，再被当成「今天它出不了东西」隔离掉。
    //
    // 线上事件日志（`$DSH_HOME/dsh-model-failover/log.json`）里 13 条
    // `NO_VISIBLE_OUTPUT` 隔离，去重后**只有一条**原文：
    // 「模型以 max-tokens 结束，但整轮没有产出任何可见内容。」—— 全部出自这一条
    // 路径。模型被冤枉，而下一轮接力的起点也从此换成了别人，于是用户看到的正是
    // 「撞了上限之后，插件不再用原来那个模型补『继续』」。
    const truncated = !committed && finish?.reason?.kind === 'max-tokens'
    if (!committed && failure === undefined && !truncated) failure = failureOf(finish, undefined)
    // 速度只在「这一趟真的收到了 finish，并且吐过 token」时才算数：中途报错、
    // 一个 token 都没吐、或者根本没有 usage 的供应商，都不该在界面上留下一个
    // 假的数字。
    const speed =
      firstDeltaAt !== undefined &&
      finishedAt !== undefined &&
      finishedAt > firstDeltaAt &&
      Number.isFinite(outputTokens) &&
      outputTokens > 0
        ? { tokens: outputTokens, ms: finishedAt - firstDeltaAt }
        : undefined
    return {
      committed,
      truncated,
      finish,
      failure: committed || truncated ? undefined : failure,
      held: committed ? [] : held,
      speed,
    }
  }
}

/** 合成一个终止用的 finish chunk。 */
export function errorFinish(code, message, attempted) {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        code,
        message: attempted === undefined || attempted.length === 0
          ? message
          : `${message}（已尝试：${attempted.map((row) => `${row.provider}/${row.model}`).join(' → ')}）`,
      },
    },
  }
}
