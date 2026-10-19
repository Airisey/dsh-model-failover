/**
 * 全局常量与配置默认值。
 *
 * 这些字符串同时被 Host 半身、浏览器半身和设置页 API 使用；浏览器半身是
 * 手写的 ModuleLoader bundle，不能 import 这个文件，因此改动时必须同步
 * client.js 顶部的镜像常量。
 */

/** 插件注册的 provider 路由 id。用户在模型选择器里看到的「模型」来自这里。 */
export const ROUTE = 'model-failover'

/** 这条路由下唯一的模型 id；选中它即启用接力队列。 */
export const MODEL_ID = 'auto'

/** 设置页与模型选择器里显示的 provider 名。 */
export const ROUTE_LABEL = '模型接力'

/** 模型选择器里显示的模型名。 */
export const MODEL_LABEL = '自动接力'

/** 模型选择器里显示的一行说明。 */
export const MODEL_DESCRIPTION = '按设置页里的优先级顺序依次尝试已接入的模型，失败自动切换。'

/** 设置页 API 的路径前缀。 */
export const API_PREFIX = '/api/dsh-model-failover'

/** 设置命名空间 / 配置文件目录名。 */
export const NAMESPACE = 'dsh-model-failover'

/** 设置默认值。任何一项在设置文件里缺失或类型不对时回落到这里。 */
export const DEFAULT_SETTINGS = {
  /** 总开关；关掉时队列直接交给第一个候选模型。 */
  enabled: true,
  /** 是否已用当前目录完成过一次自动填充。 */
  bootstrapped: false,
  /** 优先级顺序：索引 0 最先尝试。 */
  order: [],
  /** 每天几点（本地时间，0-23）解除隔离、重新从第一个模型开始尝试。 */
  resetHour: 1,
  /** 同一个模型失败后是否先用它重发一次「继续」。 */
  retrySameModelOnce: true,
  /** 自动重发的内容。 */
  continueText: '继续',
  /** 队列里要隐藏的 provider（默认隐藏插件自己，避免自我递归）。 */
  hiddenProviders: [],
  /** 全部候选都被隔离时，是否仍然按原顺序硬着头皮试一遍。 */
  retryWhenAllQuarantined: true,
  /**
   * 一轮结束时是否自动再补一句「继续」（见 lib/autocontinue.js）。
   *
   * 这是**整个 DSH** 的行为，不限于「模型接力」这条路由：监听器挂在
   * `session/event` 上，任何模型跑出来的轮都会经过它。设置页里那一节叫
   * 「DSH 异常」，就是为了不让人以为只有接力模型才管用。
   */
  autoContinue: true,
  /** 触发条件之一：dsh 报了「本轮运行失败」。 */
  autoContinueOnFailure: true,
  /** 触发条件之一：输出撞到 token 上限被截断。 */
  autoContinueOnMaxTokens: true,
  /**
   * 运行失败时最多自动补发几次。
   *
   * 默认只补一次：失败往往意味着"这个任务现在做不下去"（模型不肯、工具报错、
   * 上下文被拒），再问一遍得到的常是同一个结局，补十次只是把同一段错误刷十遍。
   * 撞 token 上限完全不同 —— 那是**没写完**，接着写就好，所以那边给到 10。
   */
  autoContinueFailureLimit: 1,
  /** 输出撞到 token 上限时最多自动补发几次。截断是"没写完"，多补几次是常态。 */
  autoContinueMaxTokensLimit: 10,
  /**
   * 每次失败之后、真正把「继续」发出去之前，先安静等这么多秒。
   *
   * 两个补发口子共用这一个间隔：适配器里「换个候选 / 同模型重发」的那一跳，
   * 以及轮级 `lib/autocontinue.js` 里补的那一句。**第一次失败也一样等** ——
   * 刚撞了限流或上游抖动的模型，隔 0.2 秒再戳一次只会再撞一次。
   * 0 表示不等（回到旧行为）。
   */
  continueDelaySec: 5,
  /** 每次切换/隔离都记进事件日志。 */
  keepEventLog: true,
  /** 事件日志最多保留多少条。 */
  eventLogLimit: 200,
}

/**
 * 不该触发切换的错误码 —— 它们是**请求**的问题，不是模型的问题。
 *
 * - `ABORTED`   用户自己按了停止（Esc / 停止按钮）。换了模型也是一样的结局，
 *               而且把用户已经扣住的半截输出换掉更糟，所以原样交回真实结局。
 * - `CONTEXT_*` 上下文超长。换模型只会再撞一次墙，正确做法是把这次失败交回
 *               给 agent loop，让它去压缩会话。
 *
 * 其余一切错误码都当作「这个模型现在不行」：隔离到下一个逻辑日，接着试队列
 * 里的下一个。这包括额度（QUOTA / ACCOUNT_QUOTA）、凭证（INVALID_CREDENTIAL）、
 * 空响应（EMPTY_RESPONSE）、限流与网络（RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT），
 * 也包括「这条路由根本没挂适配器」这类装配问题 —— 对使用者来说它们一模一样：
 * 这个模型现在产不出东西。
 */
export const NON_FAILOVER_CODES = new Set(['ABORTED', 'CONTEXT_WINDOW_EXCEEDED'])

/** 等待队列里出现可用候选时，事件日志里用的原因码。 */
export const CODE_NO_VISIBLE_OUTPUT = 'NO_VISIBLE_OUTPUT'

/** 把 (provider, model) 合成一个可当 Map 键、可写进 JSON 的字符串。 */
export function routeKey(provider, model) {
  return `${provider}\u0000${model}`
}

/** routeKey 的逆运算。 */
export function splitKey(key) {
  const at = key.indexOf('\u0000')
  if (at < 0) return { provider: key, model: '' }
  return { provider: key.slice(0, at), model: key.slice(at + 1) }
}
