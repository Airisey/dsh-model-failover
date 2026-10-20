/**
 * 当日模型隔离名单 —— **按「会话 × 队列模板」分别记**。
 *
 * 需求：「当天如果一个模型出现额度耗尽之类的问题，其他任务就不要再从这个
 * 模型开始了，直接用当前验证过能用的最靠前的模型跑，直到第二天设定时间
 * 之后才重新从第一个模型开始尝试。」
 *
 * 口径改过两次：
 *
 * 1. 先是全局一份名单。问题是同一个模型在甲会话里被额度墙挡住，不等于它在
 *    乙会话里也不行 —— 各会话的上下文、附件、已用额度都不一样。全局隔离的
 *    后果是：一个会话撞了一次墙，所有正在跑的任务都跟着绕开那个模型。
 * 2. 然后是「按会话」。现在队列本身也能有多个模板，每个模板是独立的一条
 *    队列，所以隔离必须再按模板分开：默认模板里撞的墙，不该让「备用模板」
 *    里的同一个模型也被跳过 —— 那两张名单回答的是不同的问题。
 *
 * 所以状态长这样：
 *
 *   {
 *     day,
 *     sessions: { [sessionId]: { templates: { [templateId]: { quarantine, good } } } },
 *     counts:   { [routeKey]: { fail, ok } },
 *   }
 *
 * `counts` 是唯一**不分会话、不分模板**的部分：它是「今天这个模型在全机器上
 * 失败了几次、成功了几次」，纯粹给设置页队列前面那两个数字用，不参与任何
 * 路由决策。
 *
 * 没有 sessionId 的调用（压缩上下文、离线测试、headless）落在**空串**这个桶
 * 里，它们在语义上就是「不分会话」，共用一份名单正合适。
 *
 * 关键在「当天」怎么算。用户看到的不是日历日，而是「过了设定时间才算新的一
 * 天」——凌晨 1 点重置，就意味着 00:30 仍属于昨天。所以这里用逻辑日：
 * 本地时间早于 resetHour 时回溯一个日历日。
 *
 * 名单只在内存里做一次比对，跨过边界就整体清空；不需要定时器，任何一次
 * 模型调用都会顺手触发滚动。整棵树最多活一个逻辑日，不会无限长。
 */

import { DEFAULT_TEMPLATE_ID, splitKey } from './constants.js'

/**
 * 当前逻辑日的 `YYYY-MM-DD` 键。
 *
 * @param {number} now - 毫秒时间戳。
 * @param {number} resetHour - 0-23 的本地小时；该时刻起算新的一天。
 * @returns {string}
 */
export function logicalDayKey(now, resetHour) {
  const at = new Date(now)
  const hour = Number.isInteger(resetHour) ? Math.min(23, Math.max(0, resetHour)) : 1
  if (at.getHours() < hour) at.setDate(at.getDate() - 1)
  const y = at.getFullYear()
  const m = String(at.getMonth() + 1).padStart(2, '0')
  const d = String(at.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 下一次重置的毫秒时间戳，设置页用来显示「还有多久重置」。 */
export function nextResetAt(now, resetHour) {
  const hour = Number.isInteger(resetHour) ? Math.min(23, Math.max(0, resetHour)) : 1
  const at = new Date(now)
  at.setHours(hour, 0, 0, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

/**
 * 一次调用属于哪个会话桶。
 *
 * 空串是「不分会话」那一桶：`options.sessionId` 缺失时用它，语义上正好是
 * 「这些调用之间本来就不区分彼此」。
 *
 * @param {unknown} sessionId
 * @returns {string}
 */
export function sessionScope(sessionId) {
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId : ''
}

/**
 * 一次调用属于哪个模板桶。
 *
 * 缺省（以及任何不是非空字符串的东西）落到默认模板：那条路由**一定**有一个
 * 默认模板，所以这里不会出现「找不到桶」的情况。
 *
 * @param {unknown} templateId
 * @returns {string}
 */
export function templateScope(templateId) {
  return typeof templateId === 'string' && templateId !== '' ? templateId : DEFAULT_TEMPLATE_ID
}

/** 一个空桶。每次返回新对象，避免多处共享同一个引用。 */
function emptyBucket() {
  return { quarantine: {}, good: {} }
}

/** 把任意 JSON 收敛成「一个会话桶」。 */
function normalizeBucket(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const quarantine = {}
  if (source.quarantine !== null && typeof source.quarantine === 'object') {
    for (const [key, entry] of Object.entries(source.quarantine)) {
      if (entry === null || typeof entry !== 'object') continue
      const { provider, model } = splitKey(key)
      quarantine[key] = {
        provider,
        model,
        at: Number.isFinite(entry.at) ? entry.at : 0,
        code: typeof entry.code === 'string' ? entry.code : 'UNKNOWN',
        message: typeof entry.message === 'string' ? entry.message.slice(0, 400) : '',
        attempts: Number.isFinite(entry.attempts) ? entry.attempts : 1,
      }
    }
  }
  const good = {}
  if (source.good !== null && typeof source.good === 'object') {
    for (const [key, at] of Object.entries(source.good)) {
      if (Number.isFinite(at)) good[key] = at
    }
  }
  return { quarantine, good }
}

/**
 * 把任意 JSON 收敛成「一个会话」。
 *
 * 上一版存的是 `{ [sessionId]: { quarantine, good } }`（没有 templates 这一层）。
 * 读到那种形状时整份塞进默认模板 —— 那时候只有一条队列，它就是默认模板。
 */
function normalizeSession(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const templates = {}
  if (source.templates !== null && typeof source.templates === 'object') {
    for (const [templateId, bucket] of Object.entries(source.templates)) {
      if (bucket === null || typeof bucket !== 'object') continue
      templates[templateId] = normalizeBucket(bucket)
    }
  } else if (source.quarantine !== null || source.good !== null) {
    templates[DEFAULT_TEMPLATE_ID] = normalizeBucket(source)
  }
  return { templates }
}

/** 把任意 JSON 收敛成「每模型当天的失败/成功计数」。 */
function normalizeCounts(raw) {
  const counts = {}
  if (raw === null || typeof raw !== 'object') return counts
  for (const [key, entry] of Object.entries(raw)) {
    if (entry === null || typeof entry !== 'object') continue
    const fail = Number.isFinite(entry.fail) && entry.fail > 0 ? Math.floor(entry.fail) : 0
    const ok = Number.isFinite(entry.ok) && entry.ok > 0 ? Math.floor(entry.ok) : 0
    if (fail === 0 && ok === 0) continue
    counts[key] = { fail, ok }
  }
  return counts
}

/**
 * 把任意 JSON 收敛成状态形状。
 *
 * 更早的版本（全局隔离）存的是扁平的 `{ day, quarantine, good }`。升级上来时
 * 会读到这种形状：里面的条目没有任何会话归属，硬塞进哪个桶都是错的，所以
 * 直接丢弃 —— 隔离名单本来就活不过下一个重置时刻，丢了最多让模型多试一次。
 */
function normalizeState(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const day = typeof source.day === 'string' ? source.day : ''
  const sessions = {}
  if (source.sessions !== null && typeof source.sessions === 'object') {
    for (const [scope, session] of Object.entries(source.sessions)) {
      if (session === null || typeof session !== 'object') continue
      sessions[scope] = normalizeSession(session)
    }
  }
  return { day, sessions, counts: normalizeCounts(source.counts) }
}

/** 读某会话某模板的桶（不存在就给个空的，不改状态）。 */
function bucketOf(state, sessionId, templateId) {
  return state.sessions[sessionScope(sessionId)]?.templates?.[templateScope(templateId)] ?? emptyBucket()
}

/** 记一笔当天的失败/成功；返回新的 counts 对象。 */
function tallyCount(counts, key, field) {
  const previous = counts[key] ?? { fail: 0, ok: 0 }
  return { ...counts, [key]: { fail: previous.fail, ok: previous.ok, [field]: previous[field] + 1 } }
}

/**
 * 当天的隔离名单与「已验证可用」名单。
 */
export class DailyHealth {
  /**
   * @param {import('./store.js').JsonFile<ReturnType<typeof normalizeState>>} file
   */
  constructor(file) {
    this.file = file
    /** 名单被清空/新增时通知外层写事件日志。 */
    this.onRollover = undefined
  }

  /**
   * 让状态与「当前逻辑日」对齐，返回当天状态。
   * @param {number} now
   * @param {number} resetHour
   */
  #aligned(now, resetHour) {
    const day = logicalDayKey(now, resetHour)
    const state = this.file.get()
    if (state.day === day) return state
    const previous = state.day
    // 跨日时计数也一起归零：红绿两个数字说的都是「今天」。
    const next = this.file.replace({ day, sessions: {}, counts: {} })
    if (previous !== '') this.onRollover?.(previous, day)
    return next
  }

  /**
   * 一次模型调用开始时的快照。隔离的候选会被队列跳过。
   *
   * @param {number} now
   * @param {number} resetHour
   * @param {string} [sessionId] - 这次调用属于哪个会话；缺省落在「不分会话」桶。
   * @param {string} [templateId] - 这次调用用的是哪个模板；缺省是默认模板。
   * @returns {{day: string, quarantined: Set<string>, good: Set<string>}}
   */
  snapshot(now, resetHour, sessionId, templateId) {
    const state = this.#aligned(now, resetHour)
    const bucket = bucketOf(state, sessionId, templateId)
    return {
      day: state.day,
      quarantined: new Set(Object.keys(bucket.quarantine)),
      good: new Set(Object.keys(bucket.good)),
    }
  }

  /** 今天在这个会话、这个模板里，这个模型失败过 —— 把它隔离到下一个逻辑日。 */
  markBroken(key, { code, message, at, sessionId, templateId }) {
    const scope = sessionScope(sessionId)
    const template = templateScope(templateId)
    const state = this.file.get()
    const session = state.sessions[scope] ?? { templates: {} }
    const bucket = session.templates[template] ?? emptyBucket()
    const previous = bucket.quarantine[key]
    const { provider, model } = splitKey(key)
    this.file.update({
      sessions: {
        ...state.sessions,
        [scope]: {
          templates: {
            ...session.templates,
            [template]: {
              quarantine: {
                ...bucket.quarantine,
                [key]: {
                  provider,
                  model,
                  at,
                  code,
                  message: typeof message === 'string' ? message.slice(0, 400) : '',
                  attempts: (previous?.attempts ?? 0) + 1,
                },
              },
              // 同一个模型不可能既坏又好；后一次判定覆盖前一次。
              good: Object.fromEntries(Object.entries(bucket.good).filter(([seen]) => seen !== key)),
            },
          },
        },
      },
      counts: tallyCount(state.counts, key, 'fail'),
    })
    return true
  }

  /**
   * 这个模型确实产出了内容——记为这个会话、这个模板里当天已验证可用。
   *
   * **成功计数每跑成一趟就加一**，哪怕这个模型今天早就被记成「验证过」了：
   * 队列前面那个绿数字说的是「今天成了几次」，不是「有没有成过」。隔离名单
   * 那边维持原样，同一个模型只记一条。
   */
  markGood(key, at, sessionId, templateId) {
    const scope = sessionScope(sessionId)
    const template = templateScope(templateId)
    const state = this.file.get()
    const session = state.sessions[scope] ?? { templates: {} }
    const bucket = session.templates[template] ?? emptyBucket()
    const counts = tallyCount(state.counts, key, 'ok')
    if (bucket.quarantine[key] !== undefined || bucket.good[key] !== undefined) {
      this.file.update({ counts })
      return false
    }
    this.file.update({
      sessions: {
        ...state.sessions,
        [scope]: {
          templates: {
            ...session.templates,
            [template]: { quarantine: bucket.quarantine, good: { ...bucket.good, [key]: at } },
          },
        },
      },
      counts,
    })
    return true
  }

  /** 立刻解除所有会话、所有模板的隔离。计数留着（它只是统计）。 */
  clear(now, resetHour) {
    const day = logicalDayKey(now, resetHour)
    this.file.replace({ day, sessions: {}, counts: this.file.get().counts })
  }

  /**
   * 只解除**一个**会话的隔离，其余会话原样不动。
   *
   * 这是会话页那一栏的按钮，所以它必须只影响按下去的那一栏：隔离本来就是按
   * 会话算的，在甲会话里点了「解除」，凭什么让乙会话也重新去撞同一堵墙。
   *
   * 会话里所有模板的隔离一起解：按钮说的是「这个会话」，用户不该先想清楚
   * 「我现在这个模板的墙解了没有」。
   *
   * @param {number} now
   * @param {number} resetHour
   * @param {string} [sessionId] - 缺省落在「不分会话」那一桶。
   * @returns {number} 这个会话被解除掉几条。
   */
  clearSession(now, resetHour, sessionId) {
    const state = this.#aligned(now, resetHour)
    const scope = sessionScope(sessionId)
    const session = state.sessions[scope]
    // 这个会话本来就没撞过墙：别写盘，也别把别的会话顺手重排一遍。
    if (session === undefined) return 0
    let removed = 0
    for (const bucket of Object.values(session.templates)) removed += Object.keys(bucket.quarantine).length
    if (removed === 0) return 0
    const sessions = { ...state.sessions }
    // 只清隔离，**不动** good：那些是今天已经验证过能用的记录，跟「解除隔离」
    // 是两件事。留着一个空桶也比顺手删掉别人刚攒下的验证结果安全。
    sessions[scope] = {
      templates: Object.fromEntries(
        Object.entries(session.templates).map(([template, bucket]) => [template, { quarantine: {}, good: bucket.good }]),
      ),
    }
    this.file.replace({ day: state.day, sessions, counts: state.counts })
    return removed
  }

  /**
   * 读视图：把内部结构摊平成数组。
   *
   * 同时给出三种形状：
   *   - `quarantined` / `good`：不分会话的平铺列表，每行带 `sessionId` 与 `templateId`；
   *   - `sessions`：按会话分组的列表，会话页那一栏用；
   *   - `counts`：每模型当天的失败/成功次数，设置页队列前面那对红绿数字用。
   *
   * @param {number} now
   * @param {number} resetHour
   */
  view(now, resetHour) {
    const state = this.#aligned(now, resetHour)
    const quarantined = []
    const good = []
    const sessions = []
    for (const [sessionId, session] of Object.entries(state.sessions)) {
      const mineQuarantine = []
      const mineGood = []
      for (const [templateId, bucket] of Object.entries(session.templates)) {
        for (const [key, entry] of Object.entries(bucket.quarantine)) {
          mineQuarantine.push({ key, sessionId, templateId, ...entry })
        }
        for (const [key, at] of Object.entries(bucket.good)) {
          mineGood.push({ key, at, sessionId, templateId, ...splitKey(key) })
        }
      }
      mineQuarantine.sort((left, right) => left.at - right.at)
      mineGood.sort((left, right) => left.at - right.at)
      if (mineQuarantine.length > 0 || mineGood.length > 0) {
        sessions.push({
          sessionId,
          templateIds: Object.keys(session.templates),
          quarantined: mineQuarantine,
          good: mineGood,
        })
      }
      quarantined.push(...mineQuarantine)
      good.push(...mineGood)
    }
    quarantined.sort((left, right) => left.at - right.at)
    good.sort((left, right) => left.at - right.at)
    return { day: state.day, quarantined, good, sessions, counts: state.counts }
  }
}

export { normalizeState }
