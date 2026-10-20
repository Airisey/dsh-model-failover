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
/* 会话页那一栏（conversation.view 的一条）。它占满整个视图区域，所以自己带内边距
   和滚动，而不是套用设置页那种「一列卡片」的紧凑布局。 */
.mf-qv { display: flex; flex-direction: column; gap: 12px; padding: 16px 20px; font-size: 13px; line-height: 1.6; color: inherit; overflow: auto; height: 100%; box-sizing: border-box; }
.mf-qv-head { display: flex; align-items: center; gap: 10px; }
.mf-qv-head > .mf-title { flex: 1; font-size: 14px; }
.mf-qv-session { border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.mf-qv-session.mf-mine { border-color: color-mix(in srgb, #30a46c 45%, transparent); }
.mf-qv-top { display: flex; align-items: baseline; gap: 8px; }
.mf-qv-title { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mf-qv-id { flex: none; opacity: .45; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.mf-qv-line { display: flex; align-items: baseline; gap: 8px; }
.mf-qv-label { flex: none; width: 4.5em; opacity: .55; font-size: 11.5px; }
.mf-qv-value { flex: 1; min-width: 0; word-break: break-word; }
.mf-qv-list { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 4px 8px; }
.mf-qv-item { display: inline-flex; align-items: baseline; gap: 6px; padding: 1px 8px; border-radius: 999px; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); font-size: 11.5px; }
.mf-qv-item.mf-bad { border-color: color-mix(in srgb, #e5484d 55%, transparent); color: #e5484d; }
.mf-qv-item.mf-ok { border-color: color-mix(in srgb, #30a46c 55%, transparent); color: #30a46c; }
.mf-qv-item > .mf-qv-code { opacity: .65; }
/* 隔离名单的一行：主行 +（展开时）下面的报错详情。单开一层是为了不动 .mf-row 的
   单行布局 —— 里面塞不下会换行的正文。 */
.mf-qrow { display: flex; flex-direction: column; }
.mf-detail { display: flex; flex-direction: column; gap: 3px; margin: 0 8px 6px; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, currentColor 5%, transparent); font-size: 11.5px; }
.mf-detail-row { display: flex; gap: 8px; align-items: baseline; }
.mf-detail-label { flex: none; opacity: .55; }
.mf-detail-text { min-width: 0; white-space: pre-wrap; word-break: break-word; }
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
        quarantinedHint: '这些模型今天不再被用来起头；解除后立即可用。隔离按会话算，所以同一个模型可能挂在不同的会话名下。点左边的箭头看完整报错。',
        clearQuarantine: '解除今日隔离',
        attempts: '尝试次数',
        expand: '展开报错详情',
        collapse: '收起报错详情',
        detailCode: '错误码',
        detailRoute: '路由',
        detailAttempts: '尝试次数',
        detailAt: '判定时间',
        detailMessage: '报错原文',
        detailNoMessage: '宿主没有留下报错文本。',
        detailSession: '所属会话',
        detailNoSession: '不分会话（压缩上下文、后台任务）',
        rowSession: '会话 {id}…',
        relay: '模型异常',
        relayHint:
          '开着的时候，队列里的模型会一直在后台自动接力：一个产不出东西就换下一个，直到有人把这一轮做完。',
        optEnabled: '启用接力',
        optEnabledHint: '关掉后队列退化为「只使用第一个模型」。',
        optAllQuarantined: '全部被隔离时仍然按顺序试一遍',
        optAllQuarantinedHint: '关掉后队列里全是隔离模型时会直接报错，不再尝试。',
        optKeepLog: '记录事件日志',
        optKeepLogHint: '关掉后下面这张表不再更新，也不写盘。',
        optLogLimit: '最多保留',
        optLogLimitHint: '只留最近这么多条，超出的从最旧的开始丢。',
        optResetHour: '每天几点算新的一天',
        optResetHourHint: '到这个点隔离名单才清空。凌晨 1 点意味着 00:30 仍算昨天。',
        hourUnit: '点',
        auto: 'DSH 异常',
        optAutoContinue: '自动补发「继续」',
        optAutoContinueHint:
          '这一节对整个 DSH 生效 —— 不管你在模型选择器里挑了哪个模型，出这几种情况都会自动补一句「继续」，并不需要是「模型接力」。',
        optAutoOnFailure: '本轮运行失败时',
        optAutoOnMaxTokens: '输出撞到 token 上限、被截断时',
        optFailureLimit: '最多补',
        optFailureLimitHint:
          '运行失败往往意味着这件事现在办不成（模型不肯、工具报错），再问一遍多半还是同一个结局，所以默认只补一次。',
        optMaxTokensLimit: '最多补',
        optMaxTokensLimitHint:
          '撞上限只是没写完，接着写就行，所以可以多给几次。两个上限各算各的：长文档撞上限不会吃掉失败那次。',
        optContinueDelay: '每次失败后先等',
        optContinueDelayHint: '包括第一次失败。刚撞完限流的模型马上再戳一次只会再撞一次，等一会儿更容易接上。0 = 不等。',
        optContinueDelayUnit: '秒',
        times: '次',
        evAutoContinue: '本轮{trigger}，自动补发「继续」',
        trigMaxTokens: '输出撞到上限',
        trigError: '运行失败',
        evAutoContinueSkipped: '本轮是本机网络问题（{code}），没有补发「继续」',
        evCeilingRotate: '「{provider} · {model}」连着 {count} 次撞到输出上限，接着写的换成「{to}」',
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
        viewQuarantine: '隔离队列',
        qvHint:
          '隔离是「按会话」算的：某个模型在哪个会话里撞了墙，就只在那个会话里被跳过，别的会话照常用它。下面按会话列出正在使用的模型和已经被隔离的模型。',
        qvRefresh: '刷新',
        qvLoading: '读取中…',
        qvFailed: '读取失败：{message}',
        qvEmpty: '还没有任何会话跑过。',
        qvNoProblem: '这个会话今天没有出过问题的模型。',
        qvActive: '正在用',
        qvQuarantined: '已隔离',
        qvQueued: '已验证',
        qvCurrent: '当前会话',
        qvUnnamed: '未命名会话',
        qvUnscoped: '后台任务（不挂在任何会话下）',
        qvDay: '当前逻辑日 {day}',
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
        quarantinedHint: 'These models will not start a task today. Clearing makes them usable immediately. Quarantine is per conversation, so the same model can appear under several conversations. Use the arrow at left to see the full error.',
        clearQuarantine: 'Clear today’s quarantine',
        attempts: 'attempts',
        expand: 'Show the full error',
        collapse: 'Hide the error',
        detailCode: 'Code',
        detailRoute: 'Route',
        detailAttempts: 'Attempts',
        detailAt: 'Recorded',
        detailMessage: 'Raw error',
        detailNoMessage: 'The host recorded no error text.',
        detailSession: 'Conversation',
        detailNoSession: 'Not tied to a conversation (compaction, background work)',
        rowSession: 'Conversation {id}…',
        relay: 'Model anomalies',
        relayHint:
          'While this is on, the queued models keep relaying in the background: one produces nothing and the next takes over, until someone finishes the turn.',
        optEnabled: 'Relay enabled',
        optEnabledHint: 'Turned off, the queue degrades to "always the first model".',
        optAllQuarantined: 'Still try the queue when all are quarantined',
        optAllQuarantinedHint: 'Turned off, an all-quarantined queue fails immediately.',
        optKeepLog: 'Keep an event log',
        optKeepLogHint: 'Turned off, the table below stops updating and nothing is written to disk.',
        optLogLimit: 'Keep at most',
        optLogLimitHint: 'Only the most recent entries survive; the oldest are dropped first.',
        optResetHour: 'A new day starts at',
        optResetHourHint: 'The quarantine clears at this hour. 1 means 00:30 still counts as yesterday.',
        hourUnit: ':00',
        auto: 'DSH exceptions',
        optAutoContinue: 'Send “continue” for you',
        optAutoContinueHint:
          'This section applies to the whole of DSH — whichever model you picked in the chooser, these two cases get an automatic “continue”. Being on the relay is not required.',
        optAutoOnFailure: 'The turn failed',
        optAutoOnMaxTokens: 'The answer hit the token ceiling',
        optFailureLimit: 'Send at most',
        optFailureLimitHint:
          'A failed turn usually means the task cannot proceed right now (the model refused, a tool errored); asking again tends to end the same way, so it defaults to one.',
        optMaxTokensLimit: 'Send at most',
        optMaxTokensLimitHint:
          'Hitting the ceiling only means it was not finished — carrying on is normal, so this one gets more room. The two counts are independent: a long document cannot eat the failure budget.',
        optContinueDelay: 'Wait before each retry',
        optContinueDelayHint: 'Including the first failure. Re-hitting a just-rate-limited model immediately tends to hit the same wall; a pause makes it likelier to resume. 0 = no wait.',
        optContinueDelayUnit: 'sec',
        times: 'time(s)',
        evAutoContinue: 'Turn {trigger} — sent “continue” automatically',
        trigMaxTokens: 'hit the token ceiling',
        trigError: 'failed',
        evAutoContinueSkipped: 'Local network problem ({code}) — no “continue” was sent',
        evCeilingRotate: '“{provider} · {model}” hit the output ceiling {count} times in a row — “{to}” takes over',
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
        viewQuarantine: 'Quarantine',
        qvHint:
          'Quarantine is per conversation: a model that failed inside one conversation is skipped only there, and stays available everywhere else. The list below shows, per conversation, the model in use and the models quarantined.',
        qvRefresh: 'Refresh',
        qvLoading: 'Loading…',
        qvFailed: 'Could not load: {message}',
        qvEmpty: 'No conversation has run anything yet.',
        qvNoProblem: 'No model has failed in this conversation today.',
        qvActive: 'In use',
        qvQuarantined: 'Quarantined',
        qvQueued: 'Verified',
        qvCurrent: 'This conversation',
        qvUnnamed: 'Untitled conversation',
        qvUnscoped: 'Background work (not tied to a conversation)',
        qvDay: 'Logical day {day}',
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
    const getSessions = () => api('/sessions')
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

    /**
     * 隔离名单里的一行：默认只给一行摘要，点箭头才摊开完整报错。
     *
     * 摘要那行故意把正文截到 160 字符 —— 一行放不下，且多数报错的关键词就在开头。
     * 摊开时给的是宿主存下来的**原文**（`health.js` 落盘时截到 400 字符），不再
     * 二次截断：点开就是为了看被截掉的那半句，再截一次等于没点。
     *
     * 展开状态放在行自己身上，所以「哪几行摊开着」是每个渲染器各自的事，宿主和
     * 设置页都不需要记住它。
     */
    function QuarantineRow({ row, t, now }) {
      const [open, setOpen] = useState(false)
      const at = row.at ?? now
      const message = String(row.message ?? '')
      const detail = [
        { key: 'detailCode', value: [codeText(row.code), row.code].filter((part) => part !== '').join('  ') },
        { key: 'detailRoute', value: `${row.provider ?? '?'} / ${row.model ?? '?'}` },
        { key: 'detailAttempts', value: String(row.attempts ?? 1) },
        { key: 'detailAt', value: stamp(at) },
        // 隔离按会话算，所以「这是哪个会话撞的」是这个名单里最关键的一条信息：
        // 同一张表里同一个模型可能出现好几次，各挂在不同会话名下。
        { key: 'detailSession', value: row.sessionId === undefined || row.sessionId === '' ? t('detailNoSession') : row.sessionId },
      ].filter((item) => item.value !== '')
      return div({ className: 'mf-qrow' },
        div({ className: 'mf-row' },
          h('button', {
            type: 'button',
            className: 'mf-btn mf-icon',
            'aria-expanded': open ? 'true' : 'false',
            title: t(open ? 'collapse' : 'expand'),
            onClick: () => setOpen((value) => !value),
          }, open ? '▾' : '▸'),
          div({ className: 'mf-main' },
            div({ className: 'mf-name' }, row.label ?? `${row.provider} / ${row.model}`),
            div({ className: 'mf-sub' },
              [codeText(row.code), row.code, message.slice(0, 160), `${row.attempts ?? 1} ${t('attempts')}`]
                .filter((part) => part !== '' && part !== undefined)
                .join(' · '),
            ),
            row.sessionId === undefined || row.sessionId === ''
              ? null
              : div({ className: 'mf-sub' }, t('rowSession', { id: row.sessionId.slice(0, 8) })),
          ),
          span({ className: 'mf-badge mf-bad' }, stamp(at)),
        ),
        open
          ? div({ className: 'mf-detail' },
              ...detail.map((item) => div({ className: 'mf-detail-row', key: item.key },
                span({ className: 'mf-detail-label' }, t(item.key)),
                span({ className: 'mf-detail-text' }, item.value),
              )),
              div({ className: 'mf-detail-row', key: 'detailMessage' },
                span({ className: 'mf-detail-label' }, t('detailMessage')),
                span({ className: 'mf-detail-text' }, message === '' ? t('detailNoMessage') : message),
              ),
            )
          : null,
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
          case 'ceiling-rotate':
            body = t('evCeilingRotate', {
              provider: event.provider,
              model: event.model,
              count: event.count ?? 0,
              to: event.to ?? '?',
            })
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
              name: 'resetHour',
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
              ...[...quarantined.values()].map((row) => h(QuarantineRow, {
                key: row.key,
                row,
                t,
                now,
              })),
            )
          : null,

        // ── 模型异常 ────────────────────────────────────────────────────────
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
              label: t('optAllQuarantined'),
              hint: t('optAllQuarantinedHint'),
              checked: settings.retryWhenAllQuarantined !== false,
              disabled: busy,
              onChange: (value) => void run('/settings', { retryWhenAllQuarantined: value }),
            }),
        ),

        // ── DSH 异常 ────────────────────────────────────────────────────────
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
          // 失败与撞上限两个上限分开摆、分开算 —— 它们的次数不该互相吃掉。
          div({ className: 'mf-opt' },
            div({ className: 'mf-opt-main' },
              div(null, t('optFailureLimit')),
              div({ className: 'mf-note' }, t('optFailureLimitHint')),
            ),
            h(NumberInput, {
              value: settings.autoContinueFailureLimit,
              min: 1,
              max: 20,
              name: 'failureLimit',
              disabled: busy || settings.autoContinue === false || settings.autoContinueOnFailure === false,
              onCommit: (value) => { if (value !== settings.autoContinueFailureLimit) void run('/settings', { autoContinueFailureLimit: value }) },
            }),
            span({ className: 'mf-note' }, t('times')),
          ),
          h(ToggleRow, {
            label: t('optAutoOnMaxTokens'),
            checked: settings.autoContinueOnMaxTokens !== false,
            disabled: busy || settings.autoContinue === false,
            onChange: (value) => void run('/settings', { autoContinueOnMaxTokens: value }),
          }),
          div({ className: 'mf-opt' },
            div({ className: 'mf-opt-main' },
              div(null, t('optMaxTokensLimit')),
              div({ className: 'mf-note' }, t('optMaxTokensLimitHint')),
            ),
            h(NumberInput, {
              value: settings.autoContinueMaxTokensLimit,
              min: 1,
              max: 20,
              name: 'maxTokensLimit',
              disabled: busy || settings.autoContinue === false || settings.autoContinueOnMaxTokens === false,
              onCommit: (value) => { if (value !== settings.autoContinueMaxTokensLimit) void run('/settings', { autoContinueMaxTokensLimit: value }) },
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
              name: 'continueDelay',
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
              name: 'eventLogLimit',
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

    /**
     * 只在失焦/回车时提交的数字输入，并对上下界做夹取。
     *
     * `name` 只落成 `data-name`，给测试和排查用：同一张卡片里现在不止一个
     * `min=1 max=20` 的数字框，光靠上下界认不出是哪一个。
     */
    function NumberInput({ value, min, max, name, disabled, onCommit }) {
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
        'data-name': name,
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

    // ── 会话页顶部的「隔离队列」一栏 ────────────────────────────────────────
    /**
     * 这一栏自己的刷新周期。
     *
     * 15000 是个折中：换模型、被隔离都是「几秒内就该看见」的事，但这一栏通常
     * 只是挂在那里没人看，问得太勤纯属浪费。手动点「刷新」随时能立刻拉一次。
     */
    const QV_POLL_MS = 15000

    /**
     * 某个模型的显示名。`/sessions` 已经把 `label` 拼好了，这里只兜底。
     */
    function sessionItemLabel(item) {
      if (typeof item?.label === 'string' && item.label !== '') return item.label
      if (typeof item?.provider === 'string' && typeof item?.model === 'string') {
        return `${item.provider} / ${item.model}`
      }
      return '?'
    }

    /** 会话号太长了，列表里只留前 8 位。 */
    function shortId(sessionId) {
      return typeof sessionId === 'string' && sessionId.length > 8 ? sessionId.slice(0, 8) : String(sessionId ?? '')
    }

    /**
     * 一栏里的一行会话。
     *
     * `useSessions` 由宿主以标准 hook 属性注入（dsh-client-ui-session 的
     * `provideRoot({ hooks: { sessions: ctx.sessions.list } })`），拿它换会话标题；
     * 拿不到时退回会话号前缀 —— 这一栏是给人看「哪个会话出事了」，标题只是
     * 帮助识别，缺了也不能空白。
     */
    function SessionQueueRow({ row, mine, title, t }) {
      const quarantined = row?.quarantined ?? []
      const good = row?.good ?? []
      const active = row?.active
      return div({ className: mine ? 'mf-qv-session mf-mine' : 'mf-qv-session' },
        div({ className: 'mf-qv-top' },
          span({ className: 'mf-qv-title' }, title === undefined || title === '' ? t('qvUnnamed') : title),
          mine ? span({ className: 'mf-badge mf-ok' }, t('qvCurrent')) : null,
          span({ className: 'mf-qv-id' }, shortId(row?.sessionId)),
        ),
        div({ className: 'mf-qv-line' },
          span({ className: 'mf-qv-label' }, t('qvActive')),
          span({ className: 'mf-qv-value' }, active === undefined ? t('none') : sessionItemLabel(active)),
        ),
        div({ className: 'mf-qv-line' },
          span({ className: 'mf-qv-label' }, t('qvQuarantined')),
          quarantined.length === 0
            ? span({ className: 'mf-qv-value' }, t('qvNoProblem'))
            : div({ className: 'mf-qv-list' },
                ...quarantined.map((item) => h('span', {
                  className: 'mf-qv-item mf-bad',
                  key: item.key,
                  title: String(item.message ?? ''),
                },
                  span(null, sessionItemLabel(item)),
                  span({ className: 'mf-qv-code' }, ` · ${codeText(item.code) || String(item.code ?? '?')} · ${stamp(item.at)}`),
                )),
              ),
        ),
        good.length === 0
          ? null
          : div({ className: 'mf-qv-line' },
              span({ className: 'mf-qv-label' }, t('qvQueued')),
              div({ className: 'mf-qv-list' },
                ...good.map((item) => h('span', { className: 'mf-qv-item mf-ok', key: item.key }, sessionItemLabel(item))),
              ),
            ),
      )
    }

    /**
     * 会话页顶部的「隔离队列」栏。
     *
     * 为什么单独注册一条 `conversation.view` 而不是塞进设置页：会话页顶部那排
     * tab 就是 `slots.entries("conversation.view")` 枚举出来的（见
     * dsh-client-ui-conversation 的 `viewTabs()`），注册一条就自然多一栏。
     * 它的作用域是 session，所以 props 里一定有当前会话号，用来把「当前会话」
     * 那一行标出来。
     *
     * 数据走自己的 `/sessions` 路由而不是 `/state`：这一栏只关心隔离与当前模型，
     * 每几秒刷新一次，拖整份模型清单和几十条事件不划算。
     */
    function SessionQueue(props) {
      const t = props.t
      const mineId = props.sessionId
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const alive = useRef(true)
      // 宿主没注入这个 hook 也照常工作，只是标题退化成会话号。
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : () => undefined
      const byId = useSessions((snapshot) => snapshot?.byId)

      const load = useCallback(async (manual) => {
        if (manual === true) setBusy(true)
        try {
          const next = await getSessions()
          if (!alive.current) return
          setData(next)
          setError('')
        } catch (failure) {
          // 拉不到就保留上一份：网络抖一下不该让整栏变成报错墙。
          if (!alive.current) return
          if (manual === true) setError(String(failure?.message ?? failure))
        } finally {
          if (alive.current && manual === true) setBusy(false)
        }
      }, [])

      useEffect(() => {
        alive.current = true
        void load(true)
        // 会话在跑的时候这一栏要跟着变（换模型、被隔离），所以自己轮询。
        const timer = setInterval(() => { void load(false) }, QV_POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [load])

      const rows = Array.isArray(data?.sessions) ? data.sessions : []
      const titleOf = (sessionId) => {
        // 空串是「不分会话」那一桶：压缩上下文、后台任务、离线测试都落在那里。
        // 它不是某个会话，套一个「未命名会话」会让人以为有这么个对话。
        if (sessionId === '') return t('qvUnscoped')
        const hit = byId?.[sessionId]
        /* 会话标题由宿主给；拿不到就退回会话号前缀。 */
        return typeof hit?.displayTitle === 'string' && hit.displayTitle !== '' ? hit.displayTitle : undefined
      }

      return div({ className: 'mf-qv' },
        div({ className: 'mf-qv-head' },
          div({ className: 'mf-title' }, t('viewQuarantine')),
          data?.day ? span({ className: 'mf-note' }, t('qvDay', { day: data.day })) : null,
          h('button', {
            type: 'button',
            className: 'mf-btn',
            disabled: busy,
            onClick: () => void load(true),
          }, busy ? t('busy') : t('qvRefresh')),
        ),
        div({ className: 'mf-note' }, t('qvHint')),
        error !== '' ? div({ className: 'mf-err' }, t('qvFailed', { message: error })) : null,
        data === null
          ? div({ className: 'mf-empty' }, t('qvLoading'))
          : rows.length === 0
            ? div({ className: 'mf-empty' }, t('qvEmpty'))
            : rows.map((row) => h(SessionQueueRow, {
                key: row.sessionId === '' ? '(none)' : row.sessionId,
                row,
                mine: row.sessionId === mineId,
                title: titleOf(row.sessionId),
                t,
              })),
      )
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

      // 会话页顶部多一栏「隔离队列」。这排 tab 是宿主按
      // `slots.entries("conversation.view")` 枚举出来的（chat 是 order 0、
      // 详情是 10），我们把 order 放到 20，排在它们右边。
      //
      // 不声明 children：这一栏自己不往外开子插槽，而 `conversation.view`
      // 的子槽位归宿主和 chat 所有，重复声明会直接抛错。
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'model-failover:quarantine',
        order: 20,
        label: () => t('viewQuarantine'),
        locale: NS,
      }, (props) => h(SessionQueue, { ...props, t: props?.t ?? t })))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = CLIENT_NAME

    return module.exports
  },
})
