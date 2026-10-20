/**
 * 当日模型隔离名单 —— **按会话分别记**。
 *
 * 需求：「当天如果一个模型出现额度耗尽之类的问题，其他任务就不要再从这个
 * 模型开始了，直接用当前验证过能用的最靠前的模型跑，直到第二天设定时间
 * 之后才重新从第一个模型开始尝试。」
 *
 * 后来又改了口径：隔离是**这一个会话**的事，不是整台机器的事。同一个模型在
 * 甲会话里被额度墙挡住，不等于它在乙会话里也不行 —— 各会话的上下文、附件、
 * 已用额度都不一样。全局隔离的后果是：一个会话撞了一次墙，所有正在跑的任务
 * 都跟着绕开那个模型，用户完全看不出为什么队首的模型被跳过了。
 *
 * 所以状态按会话分桶：
 *
 *   { day, sessions: { [sessionId]: { quarantine: {...}, good: {...} } } }
 *
 * 没有 sessionId 的调用（压缩上下文、离线测试、headless）落在**空串**这个桶
 * 里，它们在语义上就是「不分会话」，共用一份名单正合适。
 *
 * 关键在「当天」怎么算。用户看到的不是日历日，而是「过了设定时间才算新的一
 * 天」——凌晨 1 点重置，就意味着 00:30 仍属于昨天。所以这里用逻辑日：
 * 本地时间早于 resetHour 时回溯一个日历日。
 *
 * 名单只在内存里做一次比对，跨过边界就整体清空；不需要定时器，任何一次
 * 模型调用都会顺手触发滚动。整棵 sessions 树最多活一个逻辑日，不会无限长。
 */

import { splitKey } from './constants.js'

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
 * 把任意 JSON 收敛成状态形状。
 *
 * 旧版本（全局隔离）存的是扁平的 `{ day, quarantine, good }`。升级上来时会
 * 读到这种形状：里面的条目没有任何会话归属，硬塞进哪个桶都是错的，所以
 * 直接丢弃 —— 隔离名单本来就活不过下一个重置时刻，丢了最多让模型多试一次。
 */
function normalizeState(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const day = typeof source.day === 'string' ? source.day : ''
  const sessions = {}
  if (source.sessions !== null && typeof source.sessions === 'object') {
    for (const [scope, bucket] of Object.entries(source.sessions)) {
      if (bucket === null || typeof bucket !== 'object') continue
      sessions[scope] = normalizeBucket(bucket)
    }
  }
  return { day, sessions }
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
    const next = this.file.replace({ day, sessions: {} })
    if (previous !== '') this.onRollover?.(previous, day)
    return next
  }

  /**
   * 一次模型调用开始时的快照。顺序即优先级；隔离的排到最后，被直接跳过。
   *
   * @param {number} now
   * @param {number} resetHour
   * @param {string} [sessionId] - 这次调用属于哪个会话；缺省落在「不分会话」桶。
   * @returns {{day: string, quarantined: Set<string>, good: Set<string>}}
   */
  snapshot(now, resetHour, sessionId) {
    const state = this.#aligned(now, resetHour)
    const bucket = state.sessions[sessionScope(sessionId)] ?? emptyBucket()
    return {
      day: state.day,
      quarantined: new Set(Object.keys(bucket.quarantine)),
      good: new Set(Object.keys(bucket.good)),
    }
  }

  /** 今天在这个会话里、这个模型上失败过 —— 把它隔离到下一个逻辑日。 */
  markBroken(key, { code, message, at, sessionId }) {
    const scope = sessionScope(sessionId)
    const state = this.file.get()
    const bucket = state.sessions[scope] ?? emptyBucket()
    const previous = bucket.quarantine[key]
    const { provider, model } = splitKey(key)
    this.file.update({
      sessions: {
        ...state.sessions,
        [scope]: {
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
    })
    return true
  }

  /** 这个模型确实产出了内容——记为这个会话里当天已验证可用。 */
  markGood(key, at, sessionId) {
    const scope = sessionScope(sessionId)
    const state = this.file.get()
    const bucket = state.sessions[scope] ?? emptyBucket()
    if (bucket.quarantine[key] !== undefined) return false
    if (bucket.good[key] !== undefined) return false
    this.file.update({
      sessions: {
        ...state.sessions,
        [scope]: {
          quarantine: bucket.quarantine,
          good: { ...bucket.good, [key]: at },
        },
      },
    })
    return true
  }

  /** 设置页的「立刻解除今天的隔离」—— 所有会话一起解除。 */
  clear(now, resetHour) {
    const day = logicalDayKey(now, resetHour)
    this.file.replace({ day, sessions: {} })
  }

  /**
   * 读视图：把内部结构摊平成数组。
   *
   * 同时给出两种形状：
   *   - `quarantined` / `good`：不分会话的平铺列表，设置页用（每行带 sessionId）；
   *   - `sessions`：按会话分组的列表，会话页那一栏用。
   *
   * @param {number} now
   * @param {number} resetHour
   */
  view(now, resetHour) {
    const state = this.#aligned(now, resetHour)
    const quarantined = []
    const good = []
    const sessions = []
    for (const [sessionId, bucket] of Object.entries(state.sessions)) {
      const mineQuarantine = Object.entries(bucket.quarantine)
        .map(([key, entry]) => ({ key, sessionId, ...entry }))
        .sort((left, right) => left.at - right.at)
      const mineGood = Object.entries(bucket.good)
        .map(([key, at]) => ({ key, at, sessionId, ...splitKey(key) }))
        .sort((left, right) => left.at - right.at)
      if (mineQuarantine.length > 0 || mineGood.length > 0) {
        sessions.push({ sessionId, quarantined: mineQuarantine, good: mineGood })
      }
      quarantined.push(...mineQuarantine)
      good.push(...mineGood)
    }
    quarantined.sort((left, right) => left.at - right.at)
    good.sort((left, right) => left.at - right.at)
    return { day: state.day, quarantined, good, sessions }
  }
}

export { normalizeState }
