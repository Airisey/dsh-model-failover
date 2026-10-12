/**
 * 当日模型隔离名单。
 *
 * 需求：「当天如果一个模型出现额度耗尽之类的问题，其他任务就不要再从这个
 * 模型开始了，直接用当前验证过能用的最靠前的模型跑，直到第二天设定时间
 * 之后才重新从第一个模型开始尝试。」
 *
 * 关键在「当天」怎么算。用户看到的不是日历日，而是「过了设定时间才算新的一
 * 天」——凌晨 1 点重置，就意味着 00:30 仍属于昨天。所以这里用逻辑日：
 * 本地时间早于 resetHour 时回溯一个日历日。
 *
 * 名单只在内存里做一次比对，跨过边界就整体清空；不需要定时器，任何一次
 * 模型调用都会顺手触发滚动。
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

/** 把任意 JSON 收敛成状态形状。 */
function normalizeState(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const day = typeof source.day === 'string' ? source.day : ''
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
  return { day, quarantine, good }
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
    const next = this.file.replace({ day, quarantine: {}, good: {} })
    if (previous !== '') this.onRollover?.(previous, day)
    return next
  }

  /**
   * 一次模型调用开始时的快照。顺序即优先级；隔离的排到最后，被直接跳过。
   *
   * @param {number} now
   * @param {number} resetHour
   * @returns {{day: string, quarantined: Set<string>, good: Set<string>}}
   */
  snapshot(now, resetHour) {
    const state = this.#aligned(now, resetHour)
    return {
      day: state.day,
      quarantined: new Set(Object.keys(state.quarantine)),
      good: new Set(Object.keys(state.good)),
    }
  }

  /** 今天在这个模型上失败过——把它隔离到下一个逻辑日。 */
  markBroken(key, { code, message, at }) {
    const state = this.file.get()
    const { provider, model } = splitKey(key)
    const previous = state.quarantine[key]
    this.file.update({
      quarantine: {
        ...state.quarantine,
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
      good: Object.fromEntries(Object.entries(state.good).filter(([seen]) => seen !== key)),
    })
    return true
  }

  /** 这个模型确实产出了内容——记为当天已验证可用。 */
  markGood(key, at) {
    const state = this.file.get()
    if (state.quarantine[key] !== undefined) return false
    if (state.good[key] !== undefined) return false
    this.file.update({ good: { ...state.good, [key]: at } })
    return true
  }

  /** 设置页的「立刻解除今天的隔离」。 */
  clear(now, resetHour) {
    const day = logicalDayKey(now, resetHour)
    this.file.replace({ day, quarantine: {}, good: {} })
  }

  /** 设置页读的视图：把内部 Map 形状摊平成数组，按隔离时间排序。 */
  view(now, resetHour) {
    const state = this.#aligned(now, resetHour)
    const quarantined = Object.entries(state.quarantine)
      .map(([key, entry]) => ({ key, ...entry }))
      .sort((left, right) => left.at - right.at)
    const good = Object.entries(state.good)
      .map(([key, at]) => ({ key, at, ...splitKey(key) }))
      .sort((left, right) => left.at - right.at)
    return { day: state.day, quarantined, good }
  }
}

export { normalizeState }
