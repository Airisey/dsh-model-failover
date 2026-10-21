/**
 * 全局常量与配置默认值。
 *
 * 这些字符串同时被 Host 半身、浏览器半身和设置页 API 使用；浏览器半身是
 * 手写的 ModuleLoader bundle，不能 import 这个文件，因此改动时必须同步
 * client.js 顶部的镜像常量。
 */

/** 插件注册的 provider 路由 id。用户在模型选择器里看到的「模型」来自这里。 */
export const ROUTE = 'model-failover'

/**
 * 队列模板的 id 就是模型 id。
 *
 * 每个模板在这条路由下注册成一个模型：用户在 DSH 的模型选择器里挑中哪个
 * 模板，那个会话就用哪个模板的队列（`GenerateOptions.model` 会原样送到
 * 适配器的 `stream(options)` 里）。
 */
export const DEFAULT_TEMPLATE_ID = 'default'

/** 第一次装上时自动建的那个模板的名字。 */
export const DEFAULT_TEMPLATE_NAME = '默认模板'

/** 一个模板最多多少个候选。 */
export const MAX_TEMPLATE_CANDIDATES = 40

/** 最多几个模板（模型选择器里最多多出这么多条）。 */
export const MAX_TEMPLATES = 8

/** 模板名的最大长度。 */
export const MAX_TEMPLATE_NAME = 24

/** `sameModelRetries` 的上限：再多也只是把同一堵墙撞更多次。 */
export const MAX_SAME_MODEL_RETRIES = 5

/** 设置页与模型选择器里显示的 provider 名。 */
export const ROUTE_LABEL = '模型接力'

/** 模型选择器里显示的一行说明。 */
export const MODEL_DESCRIPTION = '按这个模板的优先级顺序依次尝试已接入的模型，失败自动切换。'

/**
 * 老版本里那条路由下唯一的模型 id。
 *
 * 那时候还没有模板，会话里存下来的 `model` 就是它。现在只在读旧会话时用：
 * 见到 `auto` 就当成默认模板。
 */
export const LEGACY_MODEL_ID = 'auto'

/** 设置页 API 的路径前缀。 */
export const API_PREFIX = '/api/dsh-model-failover'

/** 设置命名空间 / 配置文件目录名。 */
export const NAMESPACE = 'dsh-model-failover'

/** 一条模板的出厂形状。 */
export function emptyTemplate(id = DEFAULT_TEMPLATE_ID, name = DEFAULT_TEMPLATE_NAME) {
  return { id, name, order: [] }
}

/** 设置默认值。任何一项在设置文件里缺失或类型不对时回落到这里。 */
export const DEFAULT_SETTINGS = {
  /** 总开关；关掉时队列直接交给第一个候选模型。 */
  enabled: true,
  /** 是否已用当前目录完成过一次自动填充。 */
  bootstrapped: false,
  /**
   * 队列模板。至少一条，第一条永远是默认模板。
   *
   * 老版本里这里是扁平的 `order`；`normalizeSettings` 会把那份顺序灌进默认
   * 模板，所以升级不会丢队列。输出里不再保留顶层 `order`。
   */
  templates: [],
  /** 设置页正在编辑哪个模板（只是界面状态，不影响任何会话）。 */
  editedTemplate: DEFAULT_TEMPLATE_ID,
  /** 每天几点（本地时间，0-23）解除隔离、重新从第一个模型开始尝试。 */
  resetHour: 1,
  /** 老开关，已被 `sameModelRetries` 取代，只为读得懂旧 settings.json 留着。 */
  retrySameModelOnce: true,
  /**
   * 同一个模型最多试几次（含第一次），也就是「换账号」的机会有几次。
   *
   * 一个 provider+model 背后可能挂着好几个账号 —— `dsh-our-free-model` 这类
   * 把别家模型反代进来的插件就是这样，失败一次它只把**那个账号** bench 掉，
   * 池子里剩下的账号照样能用。可从 DSH 这边看只有一个 provider+model，
   * 想让它换个人来答，唯一的办法就是把这个请求原样再发一遍（每次重发都会
   * 重新进一次账号池）。试满这么多次还不行，才判这个模型今天不行、顺延下一个。
   *
   * 注意这些重发**不带「继续」**：新账号压根没写过东西，没有可继续的。
   */
  sameModelRetries: 2,
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
