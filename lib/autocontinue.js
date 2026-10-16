/**
 * 「这一轮跑完之后，自动再补一句『继续』」。
 *
 * ── 为什么这件事必须在「轮」这一层，而不是适配器里接流 ──────────────────
 *
 * 适配器（lib/adapter.js）只活在**一次模型调用**里：它看得见「这个模型这次
 * 没吐东西」，但看不见「这一轮结束了」。用户说的两件事都是轮级结局：
 *
 *   - `finish.kind === 'max-tokens'`：输出撞到上限。dsh 把它记成
 *     `turn/end { reason: { kind: 'max-tokens' } }`（dsh-agent-loop
 *     lib/index.js:1151 判定、:1027 落事件），然后这一轮就结束了 —— 模型被
 *     截在半句话上，等的是用户再敲一句「继续」。
 *   - 本轮运行失败：`turn/end { reason: { kind: 'error', error } }`
 *     （同文件 :1017）。适配器此时已经用完队列里所有候选，轮到 agent loop
 *     把它报给用户。
 *
 * 这两件事在适配器内部**看不见**，所以只能在事件这一层做。反过来，这一层
 * 也正好是用户要的语义：GUI 里发一条消息走的就是 `agent.followup(message)`
 * （dsh-api-session-controller lib/index.js:876-883）。我们照抄同一条路径，
 * 于是这是一条**真的**「继续」消息：渲染、计数、上下文、下一步行为，与用户
 * 亲手敲进去的完全一致，不掺任何私货。
 *
 * ── 无限循环是怎么被摁住的 ────────────────────────────────────────────
 *
 * 「失败 → 继续 → 又失败」是个天然的发散结构，靠三道闸：
 *
 *   1. `autoContinueLimit`：同一段连续失败里，最多自动补几次。用满就停。
 *   2. 用户自己发消息会**重置**计数（`turn/start` 时发现不是我们发起的轮
 *      就清零），所以「停手以后用户再试一次」不会因为历史计数被拒。
 *   3. 轮到 `completed` 一律清零。
 *
 * 另外 `aborted`（用户按了停止）永远不触发：用户喊停的时候，替他再发一句
 * 是十足的冒犯。
 *
 * ── 本机网络问题为什么不补发 ──────────────────────────────────────────
 *
 * 用户的要求：模型是因为**本机网络**原因出不了东西时，不要发「继续」。
 *
 * 道理很直白：「继续」能救的是「模型答到一半被打断」——它已经读懂上下文，只差
 * 把话说完。而本机网络没通时，请求连模型都没送到，重发一百遍得到的还是同一句
 * DNS/连接错误，只是在事件日志里堆一串没意义的「继续」，还把 autoContinueLimit
 * 白烧掉，让后面真正需要的那次补发用不出来。
 *
 * 判据见 {@link isLocalNetworkFailure}：链路层错误码 + message 特征。这里只强调
 * 一个反直觉的点 —— **不能只看 code**。同一个本机 DNS 故障，各家适配器报出来的
 * code 是不一样的（实测见该函数的注释），真正的证据在 message 里。
 */

import { randomUUID } from 'node:crypto'

import { isLocalNetworkFailure } from './network.js'

/**
 * 这些错误码下「继续」是纯浪费 —— 重发一次只会再撞同一堵墙，白烧一次额度。
 *
 * 注意这里**故意不包含**额度/限流类错误（QUOTA / ACCOUNT_QUOTA / RATE_LIMIT /
 * SERVER）：它们正是用户看到「本轮运行失败」以后手敲「继续」能救回来的那批。
 * 次数上限负责兜底。
 *
 * 网络类错误不在这里 —— 它们走 {@link isLocalNetworkFailure}，因为「是不是本机
 * 网络的问题」光看 code 判不出来（见 lib/network.js）。本机网络类同样不触发。
 */
export const AUTO_CONTINUE_SKIP_CODES = new Set([
  /** 上下文超长：正确做法是让 agent loop 去压缩会话，不是重发。 */
  'CONTEXT_WINDOW_EXCEEDED',
  /** 装配/凭证问题：重发一百次也是同样的报错。 */
  'NO_ADAPTER',
  'INVALID_CREDENTIAL',
])

/**
 * 「这一轮是我们排进去的」这个标记的有效期。
 *
 * 正常情况下一排进 followup，驱动立刻就开始这一轮、`turn/start` 马上到，标记
 * 也就随即被认领。给个期限是为了兜住异常：万一这条 followup 根本没跑起来
 * （会话被关、驱动忙着别的），标记会一直挂着，于是用户下一次亲手发言会被
 * 误判成「我们自己发起的轮」，连续计数就不清零了 —— 用户会看到插件莫名
 * 不肯继续。过了期限一概当作陌生轮处理，宁可多给一次机会。
 */
const PENDING_TTL_MS = 60_000

/**
 * 这一轮的结局要不要补一句「继续」。
 *
 * @param {any} reason - `turn/end` 事件里的 reason。
 * @param {any} settings - 已归一的设置。
 * @returns {'max-tokens' | 'error' | undefined} 命中的触发原因；不触发时为 undefined。
 */
export function autoContinueTrigger(reason, settings) {
  if (reason === null || typeof reason !== 'object') return undefined
  if (settings?.autoContinue !== true) return undefined

  if (reason.kind === 'max-tokens') {
    return settings.autoContinueOnMaxTokens === false ? undefined : 'max-tokens'
  }

  if (reason.kind === 'error') {
    if (settings.autoContinueOnFailure === false) return undefined
    const code = typeof reason.error?.code === 'string' ? reason.error.code : ''
    if (AUTO_CONTINUE_SKIP_CODES.has(code)) return undefined
    // 本机网络没通：重发救不回来，只会白烧一次上限。
    if (isLocalNetworkFailure(reason.error)) return undefined
    return 'error'
  }

  return undefined
}

/**
 * 构造一条「继续」用户消息。
 *
 * 手工拼而不用 `createUserMessage()`：插件是 link 进 profile 的，Node 按
 * 真实路径解析依赖，`@deepseek-ai/dsh-llm` 并不在插件的祖先 node_modules 里。
 * 这里需要的形状极小，而 dsh 那边也就是
 * `{ ...input, id: brandString(randomUUID()), role: 'user' }`
 * （dsh-llm lib/types/message.js:34-58），其中 brandString 在运行时是恒等
 * 函数（dsh-brand lib/index.js）。
 *
 * @param {string} text - 补发的内容。
 * @returns {{id: string, role: 'user', content: {type: 'text', text: string}[], source: {kind: 'user'}}}
 */
export function continueUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * 默认的等待实现。
 *
 * @param {number} ms - 等待毫秒数。
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 监听 `turn/end`，在「本轮失败」和「输出撞上限」两种结局下自动补一句「继续」。
 */
export class AutoContinue {
  #agents
  #settings
  #log
  #notes
  #now
  #pendingTtlMs
  #sleep
  /** 每个会话**连续**自动补发了几次。用户自己发言的 `turn/start` 与 `completed` 会清零。 */
  #counts = new Map()
  /** 已排进队列、等 `turn/start` 认领的会话 → 排入时刻。用来区分「这轮是我们发起的」。 */
  #pending = new Map()
  /**
   * 每个会话的「对话世代」。用户自己发言、或某一轮正常收尾时 +1。
   *
   * 用来兜住等待间隔里的一个窄窗口：等完 5 秒回来时，用户可能已经自己发了一句、
   * 而且那一轮还跑完了（status 又回到 idle、收件箱也空了），只靠「还闲着吗」是
   * 判不出来的。世代对不上就说明这一等已经过期，别再补发。
   */
  #epoch = new Map()
  /**
   * 每个会话「哪一轮是我们自动补发出来的」→ 轮号。
   *
   * `#pending` 只活到 `turn/start`（认领完就删），但轮尾小字要等到 `turn/end`
   * 才知道那一轮是谁跑的。所以认领时把轮号留在这里，收尾时取用。
   */
  #ourTurns = new Map()
  /**
   * 每个会话在「这一轮开始之前」的便签快照（`lib/notes.js` 的 `latest()` 返回值）。
   *
   * `turn/end` 时拿它比对：不是同一个对象就说明适配器在这一轮里 `remember` 过，
   * 也就是**这一轮确实是接力跑的**。只靠「便签里有没有模型」判断不行 —— 那个模型
   * 会一直挂在上一轮的结论上，用户下一轮手动挑个具体模型时就会指错人。
   */
  #turnMarks = new Map()
  /** 卸载后置位；已经睡着的等待醒来时靠它收手。 */
  #disposed = false

  /**
   * @param {object} options
   * @param {any} options.agents - cordis 的 `agents` 服务（提供 `get(sessionId)`）。
   * @param {any} options.settings - `JsonFile` 形状的设置读取器（`get()`）。
   * @param {any} options.log - `{info?, warn?, push?}`。
   * @param {any} [options.notes] - 「这个会话刚才跑的是谁」的便签（lib/notes.js）。
   * @param {() => number} [options.now] - 取当前时刻；测试用。
   * @param {number} [options.pendingTtlMs] - 标记有效期；测试用。
   * @param {(ms: number) => Promise<void>} [options.sleep] - 等待实现；测试用。
   */
  constructor({ agents, settings, log, notes, now = Date.now, pendingTtlMs = PENDING_TTL_MS, sleep = defaultSleep }) {
    this.#agents = agents
    this.#settings = settings
    this.#log = log
    this.#notes = notes
    this.#now = now
    this.#pendingTtlMs = pendingTtlMs
    this.#sleep = sleep
  }

  /** 当前各会话的连续补发次数；给设置页和测试看。 */
  counts() {
    return new Map(this.#counts)
  }

  /**
   * 挂到 cordis 上。
   *
   * @param {any} ctx - 插件上下文。
   * @returns {() => void} 卸载函数。
   */
  attach(ctx) {
    // 重新挂载时清掉上一次卸载留下的标记（cordis 的 effect 可能重跑）。
    this.#disposed = false
    const off = ctx.on('session/event', (session, event) => {
      this.observe(session, event)
    })
    return () => {
      // 卸载之后已经睡着的等待醒过来时不该再发消息。
      this.#disposed = true
      off()
    }
  }

  /**
   * 观察一条会话事件。**同步**返回 —— `session.append()` 的调用方不该等我们。
   *
   * @param {any} session - 事件主体（会话）。
   * @param {any} event - `{ type, data, seq }`。
   */
  observe(session, event) {
    const sessionId = typeof session?.id === 'string' ? session.id : undefined
    if (sessionId === undefined) return
    const type = event?.type

    if (type === 'turn/start') {
      const queuedAt = this.#pending.get(sessionId)
      this.#pending.delete(sessionId)
      // 未过期 → 这就是我们刚排进去的那一轮，计数接着累加。
      // 其余情况（用户自己敲的，或标记已烂尾）→ 从头计数。
      const ours = queuedAt !== undefined && this.#now() - queuedAt <= this.#pendingTtlMs
      if (!ours) {
        this.#counts.delete(sessionId)
        // 用户自己开了新的一轮：正在等的那个「继续」已经过期了。
        this.#epoch.set(sessionId, (this.#epoch.get(sessionId) ?? 0) + 1)
      }
      // 记下这一轮的归属，`turn/end` 时按它决定要不要写轮尾小字。
      if (ours) this.#ourTurns.set(sessionId, event?.data?.turn)
      else this.#ourTurns.delete(sessionId)
      // 记下这一轮**开始之前**的便签。`turn/end` 时拿它比对：只要对象变了，
      // 就说明这一轮确实是接力跑的（适配器 remember 过），该显示小字。
      //
      // 不能只看「便签里有没有模型」—— 上一轮用接力跑过一次之后，那个模型会一直
      // 挂在那里；用户下一轮手动挑了个具体模型，便签还是旧的，照它显示就会指错人。
      if (this.#notes === undefined) this.#turnMarks.delete(sessionId)
      else this.#turnMarks.set(sessionId, this.#notes.latest(sessionId))
      return
    }

    if (type !== 'turn/end') return

    const turn = event?.data?.turn
    const ours = turn !== undefined && this.#ourTurns.get(sessionId) === turn
    if (ours) this.#ourTurns.delete(sessionId)

    const mark = this.#turnMarks.get(sessionId)
    this.#turnMarks.delete(sessionId)
    const hit = this.#notes?.latest(sessionId)
    /** 这一轮是接力跑的。比对对象引用：`remember` 每次写的都是新对象。 */
    const relayed = hit !== undefined && hit !== mark

    /**
     * 记一条轮尾便签：模型由适配器写进 `#notes.latest()`，这里只负责配上轮号。
     *
     * 配在 `turn/end` 而不是 `#deliver` 里 —— 这条事件紧跟在适配器返回之后落，
     * 此刻 `latest()` 里放着的正是这一轮真正跑完的那个候选；等完那几秒再配的话，
     * 中间任何一次别的调用都会把它冲掉。
     *
     * @param {string | undefined} kind - 触发补发的原因；我们自己补发出来的那一轮
     *   没有任何触发原因，传 undefined，便签里记 `'auto'`。
     */
    const note = (kind) => {
      if (turn === undefined || !relayed) return
      this.#notes?.note(sessionId, turn, kind ?? (ours ? 'auto' : 'relay'), this.#now())
    }

    const reason = event?.data?.reason
    if (reason?.kind === 'completed') {
      note()
      this.#counts.delete(sessionId)
      this.#epoch.set(sessionId, (this.#epoch.get(sessionId) ?? 0) + 1)
      return
    }

    const settings = this.#settings.get()
    const trigger = autoContinueTrigger(reason, settings)
    if (trigger === undefined) {
      note()
      // 本机网络没通时刻意不补发 —— 但要让用户在事件日志里看见「为什么没继续」，
      // 否则他会以为插件坏了，然后手敲十遍「继续」。
      //
      // 只在「本来会补发、仅仅因为网络才没补」时记录：总开关或失败开关被用户
      // 关掉时沉默是应该的，不该刷日志。
      const wouldContinue = settings?.autoContinue === true && settings.autoContinueOnFailure !== false
      if (wouldContinue && reason?.kind === 'error' && isLocalNetworkFailure(reason.error)) {
        this.#log?.warn?.(
          `本轮是本机网络问题（${reason.error?.code ?? 'UNKNOWN'}），不补发「继续」：先把网络接通再重试`,
        )
        this.#log?.push?.({
          at: Date.now(),
          kind: 'auto-continue-skipped',
          trigger: 'network',
          sessionId,
          turn: event?.data?.turn,
          code: reason.error?.code ?? 'UNKNOWN',
          message: String(reason.error?.message ?? ''),
        })
      }
      return
    }

    const used = this.#counts.get(sessionId) ?? 0
    if (used >= settings.autoContinueLimit) {
      note()
      // 用满了：不清零，等一个 completed 或用户自己发话的 turn/start 再放行。
      this.#log?.warn?.(
        `自动继续已达上限（${settings.autoContinueLimit} 次），这一轮不再补发（${trigger}）`,
      )
      return
    }
    this.#counts.set(sessionId, used + 1)

    // 把「谁在跑」和「第几轮」配成一条便签，浏览器半身拿它在那一轮下面显示小字。
    note(trigger)

    const epoch = this.#epoch.get(sessionId) ?? 0
    void this.#deliver(sessionId, trigger, settings, event?.data?.turn, epoch)
  }

  /**
   * 把「继续」送进会话。
   *
   * @param {string} sessionId - 目标会话。
   * @param {string} trigger - `'max-tokens'` 或 `'error'`。
   * @param {any} settings - 已归一的设置。
   * @param {number | undefined} turn - 刚刚结束的那一轮，仅用于记日志。
   * @param {number} epoch - 发起这次补发时的对话世代，用来发现「等的时候情况变了」。
   */
  async #deliver(sessionId, trigger, settings, turn, epoch) {
    const text = typeof settings.continueText === 'string' && settings.continueText.trim() !== ''
      ? settings.continueText
      : '继续'

    try {
      const agent = this.#agents?.get?.(sessionId)
      if (agent === undefined || agent === null) return

      // 事件是在 runTurn 的 finally 里落的，此时这一轮还在收尾（驱动还没把
      // 阶段放回 idle）。等它真的闲下来再排下一轮，否则 followup 只会把消息
      // 挂在收件箱里、没有任何人去叫醒驱动。
      await agent.whenIdle?.()

      // 刚撞完墙就贴上去再敲一遍，等来的几乎总是同一个错：限流还没松、上游抖动
      // 还没过去。本机实测里最难看的一段是 9 秒内落了 12 条隔离、相邻两条只隔
      // 0.0～1.3 秒。第一次失败也一样等 —— 这一等正是「刚失败完、正要补继续」
      // 的那个瞬间，没有漏掉第一次。
      const delayMs = Number.isInteger(settings.continueDelaySec) && settings.continueDelaySec > 0
        ? settings.continueDelaySec * 1000
        : 0
      if (delayMs > 0) {
        this.#log?.info?.(`等 ${settings.continueDelaySec} 秒再补发「${text}」`)
        await this.#sleep(delayMs)
      }
      if (this.#disposed) return

      // 等的时候用户可能把会话关了、自己已经发了下一句、或者干脆跑完了完整的一轮。
      if (this.#agents.get(sessionId) !== agent) return
      if ((this.#epoch.get(sessionId) ?? 0) !== epoch) return
      if (typeof agent.status === 'string' && agent.status !== 'idle') return
      if (agent.inbox?.hasPending === true) return

      this.#pending.set(sessionId, this.#now())
      agent.followup(continueUserMessage(text))
      this.#log?.info?.(
        `本轮${trigger === 'max-tokens' ? '输出撞到上限' : '运行失败'}，已自动补发「${text}」（第 ${this.#counts.get(sessionId) ?? 1} 次）`,
      )
      this.#log?.push?.({
        at: Date.now(),
        kind: 'auto-continue',
        trigger,
        sessionId,
        turn,
        text,
      })
    } catch (error) {
      this.#pending.delete(sessionId)
      this.#log?.warn?.(`自动补发「继续」失败 — ${String(error?.message ?? error)}`)
    }
  }
}
