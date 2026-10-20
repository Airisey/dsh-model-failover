/**
 * 「自动补发的那一轮，到底是哪个模型在跑」——只活在内存里的便签。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 *
 * 用户看得到「继续」这条气泡，却看不到它背后是谁在写。接力的全部意义就是
 * 「悄悄换人」，于是换没换、换成了谁，用户只能靠猜。这一层便签把答案带出来，
 * 交给浏览器半身在那一轮的小字里显示。
 *
 * ── 为什么两段式 ──────────────────────────────────────────────────────
 *
 * 适配器知道「这次用了哪个候选」，但**不知道这是第几轮**：`GenerateOptions`
 * 里只有 `sessionId`（dsh-llm/lib/typert.host.js 的 `sessionId?: Branded<'SessionId'>`，
 * 由 dsh-agent-loop 的 `buildRequest` 填成 `this.session.id`），没有 turn。
 * 轮级那一层（lib/autocontinue.js）恰好相反：它拿得到 `turn/end` 的 turn 号，
 * 却看不见模型。
 *
 * 所以两边各出一半：适配器每跳都 {@link TurnNotes.remember} 一下「这个会话刚
 * 才跑的是谁」，轮级在 `turn/end` 时用 {@link TurnNotes.note} 把它和 turn 号
 * 配成一条记录。`turn/end` 紧跟在适配器返回之后落，配对是准的。
 *
 * ── 为什么不落盘 ──────────────────────────────────────────────────────
 *
 * 它纯粹是显示用的：进程重启之后旧的小字消失，不会影响接力、隔离、计数中的
 * 任何一项。为它写一个文件只会让状态目录多一份需要清理、需要迁移、还可能写坏
 * 的东西。真要留证据，事件日志里那条 `auto-continue` 已经带了 provider/model。
 */

/**
 * 内存里最多留几条；超出就从最旧的开始丢。
 *
 * 留得比较宽：接力跑过的**每一轮**都要留一条（不只是补发的那几轮），一轮对话动辄
 * 几十上百轮，200 条会在长会话里把开头的小字顶掉。一条记录只有六个字段。
 */
const TURN_NOTE_LIMIT = 2000

/**
 * 每个会话「最近一次跑的是哪个模型」，以及「哪几轮是接力在跑的」。
 */
export class TurnNotes {
  /** sessionId → `{provider, model, template, at}`；被适配器不断覆盖。 */
  #latest = new Map()
  /** 定长环形缓冲：`{sessionId, turn, trigger, provider, model, template, at}`。 */
  #turns = []
  #limit

  /**
   * @param {{limit?: number}} [options]
   */
  constructor({ limit = TURN_NOTE_LIMIT } = {}) {
    this.#limit = Number.isInteger(limit) && limit > 0 ? limit : TURN_NOTE_LIMIT
  }

  /**
   * 适配器每试完一个候选就调一次。
   *
   * 每次都覆盖是有意的：一轮里可能连着换好几个候选，最后写进来的那个就是真正
   * 产出内容（或者被截断在半句话上）的模型。反过来，某个候选一旦提交内容，
   * 适配器立刻 `return`，后面不会再有人覆盖它。
   *
   * @param {unknown} sessionId - `GenerateOptions.sessionId`；缺席时整条丢弃。
   * @param {{provider: string, model: string, template?: string, at?: number}} hit
   */
  remember(sessionId, { provider, model, template, at }) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (typeof provider !== 'string' || typeof model !== 'string') return
    this.#latest.set(sessionId, {
      provider,
      model,
      template: typeof template === 'string' ? template : undefined,
      at: Number.isFinite(at) ? at : Date.now(),
    })
  }

  /** 这个会话最近一次跑的是谁；没跑过就是 undefined。 */
  latest(sessionId) {
    return this.#latest.get(sessionId)
  }

  /**
   * 所有「跑过东西」的会话，最近活动的在前。
   *
   * 会话页那一栏要列出**不同会话**各自正在用哪个模型，所以必须能一次拿到全部
   * —— 隔离名单那边只知道「被隔离的会话」，没被隔离的会话只能从这里补。
   *
   * @returns {Array<[string, {provider: string, model: string, at: number}]>}
   */
  entries() {
    return [...this.#latest.entries()].sort((left, right) => (right[1].at ?? 0) - (left[1].at ?? 0))
  }

  /**
   * 轮级那一层在决定补发时调一次，把「谁跑的」和「第几轮」配起来。
   *
   * @param {string} sessionId
   * @param {unknown} turn - `turn/end` 事件里的 turn 号。
   * @param {string} trigger - `'max-tokens'` 或 `'error'`。
   * @param {number} at
   * @returns {object | undefined} 记下的那条；没有模型可配时返回 undefined。
   */
  note(sessionId, turn, trigger, at) {
    const hit = this.#latest.get(sessionId)
    if (hit === undefined) return undefined
    const entry = {
      sessionId,
      turn: Number.isFinite(turn) ? turn : undefined,
      trigger,
      provider: hit.provider,
      model: hit.model,
      template: hit.template,
      at: Number.isFinite(at) ? at : Date.now(),
    }
    this.#turns.push(entry)
    if (this.#turns.length > this.#limit) this.#turns.splice(0, this.#turns.length - this.#limit)
    return entry
  }

  /**
   * 某个会话的便签，按时间从旧到新。设置接口按 sessionId 取这一份。
   *
   * @param {unknown} sessionId
   * @param {number} [limit]
   */
  forSession(sessionId, limit = 50) {
    if (typeof sessionId !== 'string' || sessionId === '') return []
    const all = this.#turns.filter((row) => row.sessionId === sessionId)
    return all.slice(-Math.max(1, limit))
  }
}
