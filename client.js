/**
 * 模型接力（dsh-model-failover）· 浏览器半身。
 *
 * 这是一个**手写的 ModuleLoader bundle**，不是 ESM：dsh 的客户端加载器要求
 * `window.__ModuleLoader__.load({ id, factory })` 这种自注册形式，`factory`
 * 拿到的是一个 CommonJS 风格的 `require`（目前只有 `react` 可用）。所以这里
 * 没有 import/export，最后手工把 `apply` / `inject` / `name` 挂到 exports 上。
 *
 * 两件事：
 *  1. 往 `settings.section` 插槽注册一个设置页（id `model-failover`），
 *     让用户挑选模型、拖动式地调整优先级、看当天的隔离名单；
 *  2. 页面上所有读写都走宿主半身挂的同源路由 `${API_PREFIX}/*`。这条路不依赖
 *     任何 Remote 绑定，也不受 dsh 版本差异影响（老版本没有客户端 settings
 *     服务，见 dsh-client-ui-settings 的说明）。
 *
 * 平台没有提供任何拖拽/排序控件（整个 client-ui-primitives 里没有任何
 * Reorder/Sortable/DragHandle），所以排序用最朴素的 ↑ / ↓ 按钮，配上自己的
 * 样式表 —— 与 dsh-our-free-model 等现有插件同样的做法。
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-failover',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** 与 lib/constants.js 保持一致的镜像常量（这个文件不能 import 那里）。 */
    const NS = 'settings.modelFailover'
    const API_PREFIX = '/api/dsh-model-failover'
    const ROUTE = 'model-failover'
    const CLIENT_NAME = 'model-failover'

    /** cordis 服务名（不是包名）。`slots` 用来插设置页，`locale` 用来翻译。 */
    const inject = ['slots', 'locale']

    // ── 样式 ────────────────────────────────────────────────────────────────
    // 刻意不用任何主题变量名：那套 --dsw-* 变量在不同版本里改过名，写死会在
    // 某个版本上变成一片透明。用 currentColor 混色，深浅主题都能自适应。
    const CSS = `
.mf-root { display: flex; flex-direction: column; gap: 14px; font-size: 13px; line-height: 1.6; color: inherit; }
.mf-card { border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.mf-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.mf-title { font-weight: 600; font-size: 13px; }
.mf-note { opacity: .7; font-size: 12px; }
.mf-err { border: 1px solid color-mix(in srgb, #e5484d 45%, transparent); background: color-mix(in srgb, #e5484d 10%, transparent); border-radius: 8px; padding: 8px 10px; font-size: 12px; }
.mf-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px 14px; }
.mf-kv { display: flex; flex-direction: column; gap: 2px; }
.mf-kv > b { font-weight: 600; }
.mf-row { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 8px; }
.mf-row:hover { background: color-mix(in srgb, currentColor 6%, transparent); }
.mf-idx { width: 20px; text-align: right; opacity: .5; font-variant-numeric: tabular-nums; }
.mf-main { flex: 1; min-width: 0; }
.mf-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mf-sub { opacity: .55; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mf-badge { flex: none; font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); opacity: .8; }
.mf-badge.mf-bad { border-color: color-mix(in srgb, #e5484d 55%, transparent); color: #e5484d; opacity: 1; }
.mf-badge.mf-ok { border-color: color-mix(in srgb, #30a46c 55%, transparent); color: #30a46c; opacity: 1; }
.mf-actions { display: flex; gap: 4px; flex: none; }
.mf-btn { font: inherit; color: inherit; background: transparent; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 7px; padding: 3px 9px; cursor: pointer; }
.mf-btn:hover:not(:disabled) { background: color-mix(in srgb, currentColor 10%, transparent); }
.mf-btn:disabled { opacity: .35; cursor: default; }
.mf-btn.mf-icon { padding: 3px 7px; line-height: 1; }
.mf-add { display: flex; gap: 8px; align-items: center; }
.mf-select, .mf-effort, .mf-input, .mf-num { font: inherit; color: inherit; background: color-mix(in srgb, currentColor 5%, transparent); border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 7px; padding: 4px 8px; min-width: 0; }
.mf-select { flex: 1; }
.mf-effort { flex: none; max-width: 150px; }
.mf-effort-none { flex: none; opacity: .45; font-size: 11.5px; }
.mf-input { flex: 1; }
.mf-num { width: 72px; }
.mf-opt { display: flex; align-items: center; gap: 10px; }
.mf-opt > .mf-opt-main { flex: 1; min-width: 0; }
.mf-switch { flex: none; width: 38px; height: 22px; border-radius: 999px; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); background: color-mix(in srgb, currentColor 8%, transparent); position: relative; cursor: pointer; padding: 0; }
.mf-switch[data-on="1"] { background: color-mix(in srgb, #30a46c 65%, transparent); border-color: transparent; }
.mf-knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .12s ease; }
.mf-switch[data-on="1"] .mf-knob { transform: translateX(16px); }
.mf-events { max-height: 240px; overflow: auto; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.mf-event { display: flex; gap: 8px; align-items: baseline; }
.mf-event-time { flex: none; opacity: .5; font-variant-numeric: tabular-nums; }
.mf-empty { opacity: .55; font-size: 12px; padding: 4px 0; }
.mf-tail { font-size: 11.5px; line-height: 1.5; opacity: .55; padding: 2px 0 0; user-select: none; }
`

    // ── 文案 ────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        nav: '模型接力',
        intro:
          '把已经接入 dsh 的模型排成一条优先级队列。选择「模型接力 / 自动接力」当模型时，任务从队列第一位开始跑；某个模型额度耗尽或产不出内容，会先用它重发一次「继续」，再不行就切到下一个，直到任务跑完。当天出过问题的模型会被隔离，第二天设定时间后自动复活。',
        status: '今日状态',
        today: '当前逻辑日',
        nextReset: '距重置',
        resetAt: '每天 {hour}:00 重置',
        pickNow: '当前起点',
        quarantineCount: '今日隔离',
        none: '无',
        queue: '优先级队列',
        queueHint:
          '靠前的优先使用。↑ / ↓ 调整顺序，✕ 移出队列；右栏给每个模型挑它这一轮用的思考强度，档位就是平时直接选它时能选的那几档。',
        effortDefault: '默认档位',
        effortUnknown: '档位待扫描',
        effortNone: '无档位',
        effortHint: '「默认档位」＝这个模型平时的档位（不指定）；档位表由模型自己提供。',
        queueEmpty: '队列是空的。从下面挑一个模型加进来，或者点「重新扫描」。',
        refQuarantine: '隔离中',
        refGood: '已验证',
        moveUp: '上移',
        moveDown: '下移',
        remove: '移出队列',
        addModel: '从已接入的模型里添加…',
        add: '添加',
        noModels: '没有扫到可用的模型。',
        quarantined: '今日隔离名单',
        quarantinedHint: '这些模型今天不再被用来起头；解除后立即可用。',
        clearQuarantine: '解除今日隔离',
        attempts: '尝试次数',
        relay: '接力规则',
        relayHint:
          '一个模型产不出东西之后怎么办：先让它自己接着写、还是直接换人，以及整条队列都没人可用时怎么收场。',
        optEnabled: '启用接力',
        optEnabledHint: '关掉后队列退化为「只使用第一个模型」。',
        optRetrySame: '同一模型失败后先重发一次「继续」',
        optRetrySameHint: '重发仍然产不出内容，才切到下一个模型。',
        optContinueText: '重发内容',
        optContinueTextHint: '默认「继续」。改成别的会原样发给模型。',
        optAllQuarantined: '全部被隔离时仍然按顺序试一遍',
        optAllQuarantinedHint: '关掉后队列里全是隔离模型时会直接报错，不再尝试。',
        optKeepLog: '记录事件日志',
        optKeepLogHint: '关掉后下面这张表不再更新，也不写盘。',
        optLogLimit: '最多保留',
        optLogLimitHint: '只留最近这么多条，超出的从最旧的开始丢。',
        optResetHour: '每天几点算新的一天',
        optResetHourHint: '到这个点隔离名单才清空。凌晨 1 点意味着 00:30 仍算昨天。',
        hourUnit: '点',
        auto: '自动「继续」',
        optAutoContinue: '自动补发「继续」',
        optAutoContinueHint: '替你接着往下做，不用你手敲。什么时候补由下面两条决定。',
        optAutoOnFailure: '本轮运行失败时',
        optAutoOnMaxTokens: '输出撞到 token 上限、被截断时',
        optAutoLimit: '同一段失败里最多自动补发',
        optAutoLimitHint: '用满就停手，等你发下一句；你手动发言或本轮正常结束都会重新计数。',
        optContinueDelay: '每次失败后先等',
        optContinueDelayHint: '包括第一次失败。刚撞完限流的模型马上再戳一次只会再撞一次，等一会儿更容易接上。0 = 不等。',
        optContinueDelayUnit: '秒',
        times: '次',
        evAutoContinue: '本轮{trigger}，自动补发「继续」',
        trigMaxTokens: '输出撞到上限',
        trigError: '运行失败',
        evAutoContinueSkipped: '本轮是本机网络问题（{code}），没有补发「继续」',
        count: '条',
        events: '事件日志',
        clearLog: '清空日志',
        refresh: '重新扫描',
        scanning: '扫描中…',
        saved: '已保存',
        busy: '处理中…',
        loadFailed: '读取设置失败：{message}',
        actionFailed: '操作失败：{message}',
        catalogErrors: '{count} 条路由的模型清单读取失败：{detail}',
        dataDir: '数据目录',
        route: '模型选择器里选',
        eventsEmpty: '还没有记录。',
        evGood: '{provider}/{model} 产出内容，标记为可用',
        evQuarantine: '{provider}/{model} 无法输出（{code}），今日隔离',
        evRollover: '跨过 {hour} 点：{from} → {to}，隔离名单已清空',
        evReset: '手动解除隔离，清了 {count} 个',
        evForget: '重置了今天的运行状态',
        tailModel: '本轮：{label}',
      },
      en: {
        nav: 'Model Relay',
        intro:
          'Line up every model already connected to dsh as one priority queue. Pick "Model Relay / auto" as your model and a task starts on the first queue entry; when a model runs out of quota or produces nothing, it is asked once more to continue, then the next model takes over, until the task finishes. A model that failed today is quarantined and comes back after the configured hour tomorrow.',
        status: 'Today',
        today: 'Logical day',
        nextReset: 'Resets in',
        resetAt: 'resets daily at {hour}:00',
        pickNow: 'Starts at',
        quarantineCount: 'Quarantined',
        none: 'none',
        queue: 'Priority queue',
        queueHint:
          'Earlier entries are tried first. Use ↑ / ↓ to reorder, ✕ to remove; the right column picks the reasoning effort each model uses — the same levels you get when you pick that model directly.',
        effortDefault: 'Default effort',
        effortUnknown: 'Effort unknown',
        effortNone: 'No effort',
        effortHint: '"Default effort" keeps the model’s own level (nothing is specified); the levels come from the model itself.',
        queueEmpty: 'The queue is empty. Add a model below, or press Rescan.',
        refQuarantine: 'quarantined',
        refGood: 'verified',
        moveUp: 'Move up',
        moveDown: 'Move down',
        remove: 'Remove',
        addModel: 'Add a connected model…',
        add: 'Add',
        noModels: 'No models were discovered.',
        quarantined: 'Quarantined today',
        quarantinedHint: 'These models will not start a task today. Clearing makes them usable immediately.',
        clearQuarantine: 'Clear today’s quarantine',
        attempts: 'attempts',
        relay: 'Relay rules',
        relayHint:
          'What happens after a model produces nothing: let it keep writing, hand over to the next one, and how to end when the whole queue is unusable.',
        optEnabled: 'Relay enabled',
        optEnabledHint: 'Turned off, the queue degrades to "always the first model".',
        optRetrySame: 'Ask the same model to continue once',
        optRetrySameHint: 'Only after that still yields nothing does the relay move on.',
        optContinueText: 'Continuation text',
        optContinueTextHint: 'Defaults to 继续. Whatever you write is sent verbatim.',
        optAllQuarantined: 'Still try the queue when all are quarantined',
        optAllQuarantinedHint: 'Turned off, an all-quarantined queue fails immediately.',
        optKeepLog: 'Keep an event log',
        optKeepLogHint: 'Turned off, the table below stops updating and nothing is written to disk.',
        optLogLimit: 'Keep at most',
        optLogLimitHint: 'Only the most recent entries survive; the oldest are dropped first.',
        optResetHour: 'A new day starts at',
        optResetHourHint: 'The quarantine clears at this hour. 1 means 00:30 still counts as yesterday.',
        hourUnit: ':00',
        auto: 'Automatic “continue”',
        optAutoContinue: 'Send “continue” for you',
        optAutoContinueHint: 'Picks the work back up so you do not have to type it. The two rows below decide when.',
        optAutoOnFailure: 'The turn failed',
        optAutoOnMaxTokens: 'The answer hit the token ceiling',
        optAutoLimit: 'Send at most',
        optAutoLimitHint: 'Then it stops and waits for you; your next message or a clean turn resets the count.',
        optContinueDelay: 'Wait before each retry',
        optContinueDelayHint: 'Including the first failure. Re-hitting a just-rate-limited model immediately tends to hit the same wall; a pause makes it likelier to resume. 0 = no wait.',
        optContinueDelayUnit: 'sec',
        times: 'time(s)',
        evAutoContinue: 'Turn {trigger} — sent “continue” automatically',
        trigMaxTokens: 'hit the token ceiling',
        trigError: 'failed',
        evAutoContinueSkipped: 'Local network problem ({code}) — no “continue” was sent',
        count: 'entries',
        events: 'Event log',
        clearLog: 'Clear log',
        refresh: 'Rescan',
        scanning: 'Scanning…',
        saved: 'Saved',
        busy: 'Working…',
        loadFailed: 'Could not load settings: {message}',
        actionFailed: 'Failed: {message}',
        catalogErrors: '{count} provider(s) failed to list models: {detail}',
        dataDir: 'Data directory',
        route: 'Pick in the model chooser',
        eventsEmpty: 'Nothing recorded yet.',
        evGood: '{provider}/{model} produced output — marked usable',
        evQuarantine: '{provider}/{model} produced nothing ({code}) — quarantined today',
        evRollover: 'Crossed {hour}:00 — {from} → {to}, quarantine cleared',
        evReset: 'Quarantine cleared by hand — {count} released',
        evForget: 'Today’s runtime state was reset',
        tailModel: 'Turn: {label}',
      },
    }

    // ── 后端接口 ────────────────────────────────────────────────────────────
    /** 与设置页同源：`/api/dsh-model-failover`。 */
    const API = (() => {
      try {
        return new URL(API_PREFIX.replace(/^\//, ''), document.baseURI).pathname
      } catch {
        return API_PREFIX
      }
    })()

    async function api(path, options = {}) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20000)
      try {
        const response = await fetch(API + path, {
          method: options.method ?? 'GET',
          headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          redirect: 'error',
          signal: controller.signal,
        })
        const text = await response.text()
        let payload
        try {
          payload = text === '' ? {} : JSON.parse(text)
        } catch {
          payload = undefined
        }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        if (payload === undefined || payload === null || typeof payload !== 'object') {
          throw new Error('后端返回的不是 JSON')
        }
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    const getState = () => api('/state')
    const post = (path, body) => api(path, { method: 'POST', body: body ?? {} })

    // ── 小工具 ──────────────────────────────────────────────────────────────
    const pad = (value) => String(value).padStart(2, '0')

    /** `HH:MM`。 */
    function clock(ts) {
      const at = new Date(ts)
      return `${pad(at.getHours())}:${pad(at.getMinutes())}`
    }

    /** `MM-DD HH:MM`。 */
    function stamp(ts) {
      const at = new Date(ts)
      return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock(ts)}`
    }

    /** 「3 小时 12 分」这种人类可读的剩余时间。 */
    function remain(ms, t) {
      if (!Number.isFinite(ms) || ms <= 0) return t('none')
      const minutes = Math.floor(ms / 60000)
      const hours = Math.floor(minutes / 60)
      const days = Math.floor(hours / 24)
      const zh = /^zh/.test(document.documentElement.lang ?? '') || /^zh/.test(navigator.language ?? '')
      const hUnit = zh ? '小时' : 'h'
      const mUnit = zh ? '分' : 'm'
      const dUnit = zh ? '天' : 'd'
      if (days > 0) return `${days}${dUnit} ${hours % 24}${hUnit}`
      if (hours > 0) return `${hours}${hUnit} ${minutes % 60}${mUnit}`
      return `${minutes}${mUnit}`
    }

    const keyOf = (provider, model) => `${provider}\u0000${model}`

    /** 错误码 → 一句人话。 */
    function codeText(code) {
      const table = {
        QUOTA: '额度/余额耗尽',
        ACCOUNT_QUOTA: '账户额度耗尽',
        INVALID_CREDENTIAL: '凭证无效',
        EMPTY_RESPONSE: '没有产出任何内容',
        NO_VISIBLE_OUTPUT: '没有产出任何内容',
        RATE_LIMIT: '被限流',
        SERVER: '服务端错误',
        TIMEOUT: '超时',
        TRANSPORT: '网络中断',
        CONTEXT_WINDOW_EXCEEDED: '上下文超长',
        ABORTED: '被中止',
      }
      return table[code] ?? ''
    }

    // ── 基础控件 ────────────────────────────────────────────────────────────
    const div = (props, ...kids) => h('div', props, ...kids)
    const span = (props, ...kids) => h('span', props, ...kids)

    function Switch({ checked, onChange, disabled, label }) {
      return h('button', {
        type: 'button',
        className: 'mf-switch',
        'data-on': checked ? '1' : '0',
        'aria-label': label,
        'aria-pressed': checked ? 'true' : 'false',
        disabled: disabled === true,
        onClick: () => onChange(!checked),
      }, h('span', { className: 'mf-knob' }))
    }

    function Card({ title, extra }, ...children) {
      return div({ className: 'mf-card' },
        h('div', { className: 'mf-head' },
          h('div', { className: 'mf-title' }, title),
          extra ?? null,
        ),
        ...children.filter((child) => child !== null && child !== undefined && child !== false),
      )
    }

    /** 一行开关：左边说明 + 副标题，右边开关。 */
    function ToggleRow({ label, hint, checked, onChange, disabled }) {
      return div({ className: 'mf-opt' },
        div({ className: 'mf-opt-main' },
          div(null, label),
          hint ? div({ className: 'mf-note' }, hint) : null,
        ),
        h(Switch, { checked, onChange, disabled, label }),
      )
    }

    // ── 设置页 ──────────────────────────────────────────────────────────────
    /**
     * @param {object} props - 插槽给的业务属性（`close`）加上 apply 里塞进来的 `t`。
     */
    function SettingsPage(props) {
      const t = props.t
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [addKey, setAddKey] = useState('')
      const [, setTick] = useState(0)
      const alive = useRef(true)

      useEffect(() => () => { alive.current = false }, [])

      const load = useCallback(async () => {
        try {
          const next = await getState()
          if (!alive.current) return
          setState(next)
          setError('')
        } catch (failure) {
          if (!alive.current) return
          setError(String(failure?.message ?? failure))
        }
      }, [])

      useEffect(() => { void load() }, [load])

      // 倒计时自己走：30 秒重绘一次就够了。
      useEffect(() => {
        const timer = setInterval(() => setTick((value) => value + 1), 30_000)
        return () => clearInterval(timer)
      }, [])

      const run = useCallback(async (path, body) => {
        setBusy(true)
        setNotice('')
        try {
          const next = await post(path, body)
          if (alive.current) {
            setState(next)
            setError('')
            setNotice(t('saved'))
          }
        } catch (failure) {
          if (alive.current) setError(t('actionFailed', { message: String(failure?.message ?? failure) }))
        } finally {
          if (alive.current) setBusy(false)
        }
      }, [t])

      const settings = state?.settings
      const order = useMemo(() => (Array.isArray(settings?.order) ? settings.order : []), [settings])

      const quarantined = useMemo(() => {
        const map = new Map()
        for (const row of state?.quarantined ?? []) map.set(row.key, row)
        return map
      }, [state])

      const good = useMemo(() => new Set((state?.good ?? []).map((row) => row.key)), [state])

      /** 已接入但还没进队列的模型，按 provider 分组给下拉框用。 */
      const available = useMemo(() => {
        const inQueue = new Set(order.map((item) => keyOf(item.provider, item.model)))
        const groups = new Map()
        for (const row of state?.catalog ?? []) {
          const key = keyOf(row.provider, row.model)
          if (inQueue.has(key)) continue
          if (!groups.has(row.provider)) groups.set(row.provider, { provider: row.provider, name: row.providerName, rows: [] })
          groups.get(row.provider).rows.push({ key, model: row.model, label: row.name, description: row.description })
        }
        for (const group of groups.values()) group.rows.sort((a, b) => a.label.localeCompare(b.label))
        return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
      }, [state, order])

      const mutateOrder = useCallback((next) => { void run('/settings', { order: next }) }, [run])

      const move = useCallback((index, delta) => {
        const target = index + delta
        if (target < 0 || target >= order.length) return
        const next = [...order]
        const [item] = next.splice(index, 1)
        next.splice(target, 0, item)
        mutateOrder(next)
      }, [order, mutateOrder])

      const removeAt = useCallback((index) => {
        mutateOrder(order.filter((_, at) => at !== index))
      }, [order, mutateOrder])

      /**
       * 给队列里某一项设置思考强度；`''` 表示「不指定」（用它平时的档位）。
       *
       * 只留 provider/model 两个键是有意的：这一行除了档位没有别的可带字段，
       * 显式重建比留着旧键更不容易在以后加字段时留下幽灵值。
       */
      const setEffort = useCallback((index, value) => {
        const next = order.map((item, at) => {
          if (at !== index) return item
          if (value === '') return { provider: item.provider, model: item.model }
          return { provider: item.provider, model: item.model, reasoningEffort: value }
        })
        mutateOrder(next)
      }, [order, mutateOrder])

      const add = useCallback(() => {
        if (addKey === '') return
        const at = addKey.indexOf('\u0000')
        const provider = addKey.slice(0, at)
        const model = addKey.slice(at + 1)
        setAddKey('')
        mutateOrder([...order, { provider, model }])
      }, [addKey, order, mutateOrder])

      /** 队列里第一个既没被隔离、又产出过的模型 —— 也就是下一个任务真正的起点。 */
      const startAt = useMemo(() => {
        if (order.length === 0) return undefined
        const usable = order.find((item) => !quarantined.has(keyOf(item.provider, item.model)))
        return usable ?? order[0]
      }, [order, quarantined])

      const labelOf = useCallback((provider, model) => {
        const hit = (state?.catalog ?? []).find((row) => row.provider === provider && row.model === model)
        return hit === undefined ? `${provider} / ${model}` : hit.name
      }, [state])

      // 供事件文案使用的补充参数
      const now = state?.now ?? Date.now()

      const describeEvent = useCallback((event) => {
        const when = clock(event.at ?? now)
        const head = span({ className: 'mf-event-time' }, stamp(event.at ?? now))
        let body
        switch (event.kind) {
          case 'good':
            body = t('evGood', { provider: event.provider, model: event.model })
            break
          case 'quarantine':
            body = t('evQuarantine', { provider: event.provider, model: event.model, code: event.code ?? '?' })
            break
          case 'rollover':
            body = t('evRollover', { hour: settings?.resetHour ?? 1, from: event.from ?? '?', to: event.to ?? '?' })
            break
          case 'reset':
            body = t('evReset', { count: event.cleared ?? 0 })
            break
          case 'forget':
            body = t('evForget')
            break
          case 'auto-continue':
            body = t('evAutoContinue', { trigger: t(event.trigger === 'max-tokens' ? 'trigMaxTokens' : 'trigError') })
            break
          case 'auto-continue-skipped':
            body = t('evAutoContinueSkipped', { code: event.code ?? '?' })
            break
          default:
            body = `${event.kind ?? '?'}`
        }
        return h('div', { className: 'mf-event', key: `${event.at}-${event.kind}-${event.provider ?? ''}-${event.model ?? ''}-${when}` },
          head,
          span(null, body),
        )
      }, [now, settings, t])

      if (state === null) {
        return div({ className: 'mf-root' },
          div({ className: 'mf-card' },
            error !== '' ? div({ className: 'mf-err' }, t('loadFailed', { message: error })) : div({ className: 'mf-note' }, t('busy')),
          ),
        )
      }

      return div({ className: 'mf-root' },
        div({ className: 'mf-note' }, t('intro')),

        error !== '' ? div({ className: 'mf-err' }, error) : null,

        // ── 今日状态 ────────────────────────────────────────────────────────
        div({ className: 'mf-card' },
          div({ className: 'mf-head' },
            div({ className: 'mf-title' }, t('status')),
            div({ className: 'mf-actions' },
              h('button', { type: 'button', className: 'mf-btn', disabled: busy, onClick: () => void run('/refresh', {}) }, busy ? t('scanning') : t('refresh')),
              h('button', {
                type: 'button',
                className: 'mf-btn',
                disabled: busy || quarantined.size === 0,
                onClick: () => void run('/reset', {}),
              }, t('clearQuarantine')),
            ),
          ),
          div({ className: 'mf-grid' },
            div({ className: 'mf-kv' }, span({ className: 'mf-note' }, t('today')), h('b', null, state.day || t('none'))),
            div({ className: 'mf-kv' },
              span({ className: 'mf-note' }, t('nextReset')),
              h('b', null, `${remain(state.nextResetAt - Date.now(), t)}  ·  ${t('resetAt', { hour: settings.resetHour })}`),
            ),
            div({ className: 'mf-kv' },
              span({ className: 'mf-note' }, t('pickNow')),
              h('b', null, startAt === undefined ? t('none') : labelOf(startAt.provider, startAt.model)),
            ),
            div({ className: 'mf-kv' },
              span({ className: 'mf-note' }, t('quarantineCount')),
              h('b', null, String(quarantined.size)),
            ),
          ),
          notice !== '' && error === '' ? div({ className: 'mf-note' }, notice) : null,
          // 重置时刻属于「今天怎么算」，跟上面的逻辑日、距重置是一回事，
          // 所以留在状态卡片里，不跟接力规则混在一起。
          div({ className: 'mf-opt' },
            div({ className: 'mf-opt-main' },
              div(null, t('optResetHour')),
              div({ className: 'mf-note' }, t('optResetHourHint')),
            ),
            h(NumberInput, {
              value: settings.resetHour,
              min: 0,
              max: 23,
              disabled: busy,
              onCommit: (value) => { if (value !== settings.resetHour) void run('/settings', { resetHour: value }) },
            }),
            span({ className: 'mf-note' }, t('hourUnit')),
          ),
          (state.catalogErrors ?? []).length > 0
            ? div({ className: 'mf-err' }, t('catalogErrors', {
                count: (state.catalogErrors ?? []).length,
                detail: (state.catalogErrors ?? []).map((row) => `${row.provider || '?'}: ${row.message}`).join('; '),
              }))
            : null,
        ),

        // ── 优先级队列 ──────────────────────────────────────────────────────
        Card({ title: t('queue') },
          div({ className: 'mf-note' }, t('queueHint')),
          ...order.map((item, index) => {
              const key = keyOf(item.provider, item.model)
              const bad = quarantined.get(key)
              const isGood = good.has(key)
              const hit = (state.catalog ?? []).find((row) => row.provider === item.provider && row.model === item.model)
              return div({ className: 'mf-row', key },
                span({ className: 'mf-idx' }, String(index + 1)),
                div({ className: 'mf-main' },
                  div({ className: 'mf-name' }, hit?.name ?? item.model),
                  div({ className: 'mf-sub' }, `${hit?.providerName ?? item.provider} · ${item.model}`),
                ),
                // 思考强度：档位表来自模型自己（resolveModelInfo 的 reasoning），
                // 所以画出来的就是用户在模型设置页直接选它时看到的那几档。
                // 还没问到档位表时先给一个禁用态，不要凭空造几个档位出来。
                hit === undefined || hit.effortsKnown !== true
                  ? h('select', { className: 'mf-effort', disabled: true, title: t('effortHint'), value: '' },
                      h('option', { value: '' }, t('effortUnknown')))
                  : (hit.efforts.length === 0
                      ? span({ className: 'mf-effort-none', title: t('effortHint') }, t('effortNone'))
                      : h('select', {
                          className: 'mf-effort',
                          title: t('effortHint'),
                          value: item.reasoningEffort ?? '',
                          disabled: busy,
                          onChange: (event) => setEffort(index, event.target.value),
                        },
                          h('option', { value: '' }, t('effortDefault')),
                          ...hit.efforts.map((effort) => h('option', { key: effort.id, value: effort.id },
                            effort.name,
                          )),
                        )),
                bad !== undefined
                  ? span({ className: 'mf-badge mf-bad', title: `${bad.code ?? ''} ${bad.message ?? ''}`.trim() }, t('refQuarantine'))
                  : (isGood ? span({ className: 'mf-badge mf-ok' }, t('refGood')) : null),
                div({ className: 'mf-actions' },
                  h('button', { type: 'button', className: 'mf-btn mf-icon', title: t('moveUp'), disabled: busy || index === 0, onClick: () => move(index, -1) }, '↑'),
                  h('button', { type: 'button', className: 'mf-btn mf-icon', title: t('moveDown'), disabled: busy || index === order.length - 1, onClick: () => move(index, 1) }, '↓'),
                  h('button', { type: 'button', className: 'mf-btn mf-icon', title: t('remove'), disabled: busy, onClick: () => removeAt(index) }, '✕'),
                ),
              )
            }),
            order.length === 0 ? div({ className: 'mf-empty' }, t('queueEmpty')) : null,
            div({ className: 'mf-add' },
              h('select', {
                className: 'mf-select',
                value: addKey,
                disabled: busy || available.length === 0,
                onChange: (event) => setAddKey(event.target.value),
              },
                h('option', { value: '' }, available.length === 0 ? t('noModels') : t('addModel')),
                ...available.map((group) => h('optgroup', { key: group.provider, label: group.name },
                  ...group.rows.map((row) => h('option', { key: row.key, value: row.key }, `${row.label}  (${row.model})`)),
                )),
              ),
              h('button', { type: 'button', className: 'mf-btn', disabled: busy || addKey === '', onClick: add }, t('add')),
            ),
        ),

        // ── 今日隔离名单 ────────────────────────────────────────────────────
        quarantined.size > 0
          ? Card({ title: `${t('quarantined')} (${quarantined.size})` },
              div({ className: 'mf-note' }, t('quarantinedHint')),
              ...[...quarantined.values()].map((row) => div({ className: 'mf-row', key: row.key },
                div({ className: 'mf-main' },
                  div({ className: 'mf-name' }, row.label ?? `${row.provider} / ${row.model}`),
                  div({ className: 'mf-sub' },
                    [codeText(row.code), row.code, String(row.message ?? '').slice(0, 160), `${row.attempts ?? 1} ${t('attempts')}`]
                      .filter((part) => part !== '' && part !== undefined)
                      .join(' · '),
                  ),
                ),
                span({ className: 'mf-badge mf-bad' }, stamp(row.at ?? now)),
              )),
            )
          : null,

        // ── 接力规则 ────────────────────────────────────────────────────────
        Card({ title: t('relay') },
            div({ className: 'mf-note' }, t('relayHint')),
            h(ToggleRow, {
              label: t('optEnabled'),
              hint: t('optEnabledHint'),
              checked: settings.enabled !== false,
              disabled: busy,
              onChange: (value) => void run('/settings', { enabled: value }),
            }),
            h(ToggleRow, {
              label: t('optRetrySame'),
              hint: t('optRetrySameHint'),
              checked: settings.retrySameModelOnce !== false,
              disabled: busy,
              onChange: (value) => void run('/settings', { retrySameModelOnce: value }),
            }),
            div({ className: 'mf-opt' },
              div({ className: 'mf-opt-main' },
                div(null, t('optContinueText')),
                div({ className: 'mf-note' }, t('optContinueTextHint')),
              ),
              h(ContinueTextInput, {
                value: settings.continueText,
                disabled: busy,
                onCommit: (value) => { if (value !== settings.continueText) void run('/settings', { continueText: value }) },
              }),
            ),
            h(ToggleRow, {
              label: t('optAllQuarantined'),
              hint: t('optAllQuarantinedHint'),
              checked: settings.retryWhenAllQuarantined !== false,
              disabled: busy,
              onChange: (value) => void run('/settings', { retryWhenAllQuarantined: value }),
            }),
        ),

        // ── 自动「继续」 ────────────────────────────────────────────────────
        Card({ title: t('auto') },
          h(ToggleRow, {
            label: t('optAutoContinue'),
            hint: t('optAutoContinueHint'),
            checked: settings.autoContinue !== false,
            disabled: busy,
            onChange: (value) => void run('/settings', { autoContinue: value }),
          }),
          h(ToggleRow, {
            label: t('optAutoOnFailure'),
            checked: settings.autoContinueOnFailure !== false,
            disabled: busy || settings.autoContinue === false,
            onChange: (value) => void run('/settings', { autoContinueOnFailure: value }),
          }),
          h(ToggleRow, {
            label: t('optAutoOnMaxTokens'),
            checked: settings.autoContinueOnMaxTokens !== false,
            disabled: busy || settings.autoContinue === false,
            onChange: (value) => void run('/settings', { autoContinueOnMaxTokens: value }),
          }),
          div({ className: 'mf-opt' },
            div({ className: 'mf-opt-main' },
              div(null, t('optAutoLimit')),
              div({ className: 'mf-note' }, t('optAutoLimitHint')),
            ),
            h(NumberInput, {
              value: settings.autoContinueLimit,
              min: 1,
              max: 20,
              disabled: busy || settings.autoContinue === false,
              onCommit: (value) => { if (value !== settings.autoContinueLimit) void run('/settings', { autoContinueLimit: value }) },
            }),
            span({ className: 'mf-note' }, t('times')),
          ),
          div({ className: 'mf-opt' },
            div({ className: 'mf-opt-main' },
              div(null, t('optContinueDelay')),
              div({ className: 'mf-note' }, t('optContinueDelayHint')),
            ),
            h(NumberInput, {
              value: settings.continueDelaySec,
              min: 0,
              max: 300,
              disabled: busy || settings.autoContinue === false,
              onCommit: (value) => { if (value !== settings.continueDelaySec) void run('/settings', { continueDelaySec: value }) },
            }),
            span({ className: 'mf-note' }, t('optContinueDelayUnit')),
          ),
        ),

        // ── 事件日志 ────────────────────────────────────────────────────────
        Card({
          title: t('events'),
          extra: h('button', {
            type: 'button',
            className: 'mf-btn',
            disabled: busy || (state.events ?? []).length === 0,
            onClick: () => void run('/log/clear', {}),
          }, t('clearLog')),
        },
          (state.events ?? []).length === 0
            ? div({ className: 'mf-empty' }, t('eventsEmpty'))
            : div({ className: 'mf-events' }, ...(state.events ?? []).map(describeEvent)),
          // 日志自己的开关放在日志卡片里，别混进接力规则。
          h(ToggleRow, {
            label: t('optKeepLog'),
            hint: t('optKeepLogHint'),
            checked: settings.keepEventLog !== false,
            disabled: busy,
            onChange: (value) => void run('/settings', { keepEventLog: value }),
          }),
          div({ className: 'mf-opt' },
            div({ className: 'mf-opt-main' },
              div(null, t('optLogLimit')),
              div({ className: 'mf-note' }, t('optLogLimitHint')),
            ),
            h(NumberInput, {
              value: settings.eventLogLimit,
              min: 1,
              max: 2000,
              disabled: busy || settings.keepEventLog === false,
              onCommit: (value) => { if (value !== settings.eventLogLimit) void run('/settings', { eventLogLimit: value }) },
            }),
            span({ className: 'mf-note' }, t('count')),
          ),
          div({ className: 'mf-note' }, `${t('dataDir')}：${state.dataDir ?? '?'}`),
          div({ className: 'mf-note' }, `${t('route')}：${state.route?.label ?? ROUTE} / ${state.route?.model ?? 'auto'}`),
        ),
      )
    }

    /** 只在失焦/回车时提交的文本输入 —— 每敲一个字都写盘太吵。 */
    function ContinueTextInput({ value, disabled, onCommit }) {
      const [draft, setDraft] = useState(value)
      useEffect(() => { setDraft(value) }, [value])
      return h('input', {
        className: 'mf-input',
        type: 'text',
        value: draft ?? '',
        disabled,
        onChange: (event) => setDraft(event.target.value),
        onBlur: () => onCommit(draft),
        onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
      })
    }

    /** 只在失焦/回车时提交的数字输入，并对上下界做夹取。 */
    function NumberInput({ value, min, max, disabled, onCommit }) {
      const [draft, setDraft] = useState(String(value))
      useEffect(() => { setDraft(String(value)) }, [value])
      const commit = () => {
        const parsed = Number.parseInt(draft, 10)
        if (!Number.isInteger(parsed)) { setDraft(String(value)); return }
        const clamped = Math.min(max, Math.max(min, parsed))
        setDraft(String(clamped))
        onCommit(clamped)
      }
      return h('input', {
        className: 'mf-num',
        type: 'number',
        min,
        max,
        value: draft,
        disabled,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
      })
    }

    // ── 轮尾小字：接力插过手的那一轮，是谁在跑 ──────────────────────────────
    /**
     * 便签缓存（会话 → 这个会话最近的几条）。
     *
     * 一个会话里有几十条轮尾，它们各自只想知道「我这一轮是不是接力补出来的、
     * 是谁跑的」。所以按会话缓存、把同时挂载的那一批请求合并成一个，并且只在
     * 缓存里真的没有这一轮时才去问后端 —— 否则每挂一次轮尾就打一次接口。
     */
    const NOTE_TTL_MS = 3000
    const noteCache = new Map()

    function noteRow(sessionId) {
      let row = noteCache.get(sessionId)
      if (row === undefined) {
        row = { at: 0, rows: [], inflight: false, waiters: new Set() }
        noteCache.set(sessionId, row)
      }
      return row
    }

    /**
     * @param {string} sessionId
     * @param {boolean} force - 缓存里没有目标轮时置位，越过最短间隔问一次。
     */
    function ensureNotes(sessionId, force) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      const row = noteRow(sessionId)
      if (row.inflight) return
      if (force !== true && Date.now() - row.at < NOTE_TTL_MS) return
      row.inflight = true
      api(`/notes?sessionId=${encodeURIComponent(sessionId)}`)
        .then((payload) => {
          row.rows = Array.isArray(payload?.notes) ? payload.notes : []
        })
        .catch(() => {
          /* 便签纯装饰：后端没答上来时那一轮干脆不显示小字。 */
        })
        .finally(() => {
          row.at = Date.now()
          row.inflight = false
          const waiters = [...row.waiters]
          row.waiters.clear()
          for (const fn of waiters) fn()
        })
    }

    /** 这个会话的便签；后端答上来之后会自己重渲染一次。 */
    function useTurnNotes(sessionId, turn) {
      const [revision, setRevision] = useState(0)
      useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        // 轮号不是数就根本渲染不出东西，连问都不必问。
        if (!Number.isFinite(turn)) return undefined
        const row = noteRow(sessionId)
        const bump = () => setRevision((value) => value + 1)
        row.waiters.add(bump)
        const known = row.rows.some((item) => item.turn === turn)
        ensureNotes(sessionId, !known)
        return () => {
          row.waiters.delete(bump)
        }
      }, [sessionId, turn])
      return useMemo(() => noteCache.get(sessionId)?.rows ?? [], [sessionId, revision])
    }

    /**
     * 轮尾小字。
     *
     * 只在接力插过手的那几轮出现：自动补发了「继续」的那一轮（这一轮是谁跑到
     * 半截的），以及补发出来的那一轮（换成了谁）。普通对话的轮尾一个字都不加。
     *
     * `turnTail` 是会话作用域的 list 插槽，绑定的 props 里有 `sessionId`（由
     * dsh-client-ui-session 的 scope 绑定注入）和 `turn`。
     */
    function RelayTail(props) {
      const { sessionId, turn } = props
      const t = props?.t
      const rows = useTurnNotes(sessionId, turn)
      if (!Number.isFinite(turn)) return null
      const hit = rows.find((row) => row.turn === turn)
      if (hit === undefined) return null
      const label = typeof hit.label === 'string' && hit.label !== ''
        ? hit.label
        : `${hit.provider} / ${hit.model}`
      return h('div', { className: 'mf-tail' }, t('tailModel', { label }))
    }

    // ── 挂载 ────────────────────────────────────────────────────────────────
    /**
     * @param {any} ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)

      ctx.effect(
        () => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }),
        'model-failover: dictionaries',
      )

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-model-failover')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'model-failover: styles')

      // order 30：general(0)、models(10) 之后，示例插件(35) 之前。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'model-failover',
        order: 30,
        label: () => t('nav'),
        locale: NS,
      }, (props) => h(SettingsPage, { ...props, t: props?.t ?? t, ctx })))

      // 轮尾小字。这条插槽由 dsh-client-ui-chat 声明，我们只往里加一条，
      // **不要**再声明它的子插槽（那是 chat 自己的事，重复声明会直接抛错）。
      ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail',
        id: 'model-failover:relay-tail',
        order: 20,
        locale: NS,
      }, (props) => h(RelayTail, { ...props, t: props?.t ?? t })))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = CLIENT_NAME

    return module.exports
  },
})
