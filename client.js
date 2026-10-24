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
    /** 模板数量与名字长度的上限，与 lib/constants.js 保持一致。 */
    const MAX_TEMPLATES = 8
    const MAX_TEMPLATE_NAME = 24
    /** 同一个模型额外重试次数的上限，同样与 lib/constants.js 保持一致。 */
    const MAX_SAME_MODEL_RETRIES = 5

    /**
     * 试连接同时发几条。
     *
     * 一条模板动辄十几个模型，串着发要等好几分钟；但一口气全发出去又容易撞上
     * 供应商的并发限流，那反而是假故障。4 是「够快、又不至于自己把自己限流」。
     */
    const PROBE_CONCURRENCY = 4

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
.mf-name { display: flex; align-items: center; font-weight: 500; }
/* 名字本身会被截断，但试连接的胶囊必须一直在 —— 它才是这一行要看的结论。 */
.mf-name-text { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mf-sub { opacity: .55; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mf-badge { flex: none; font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); opacity: .8; }
.mf-badge.mf-bad { border-color: color-mix(in srgb, #e5484d 55%, transparent); color: #e5484d; opacity: 1; }
.mf-badge.mf-ok { border-color: color-mix(in srgb, #30a46c 55%, transparent); color: #30a46c; opacity: 1; }
.mf-badge.mf-run { border-color: color-mix(in srgb, #4c9aff 55%, transparent); color: #4c9aff; opacity: 1; }
.mf-actions { display: flex; gap: 4px; flex: none; }
/* 正在编辑的那个模板：左边一条竖线，比整行换底色更不刺眼。 */
.mf-row-on { background: color-mix(in srgb, currentColor 6%, transparent); box-shadow: inset 2px 0 0 currentColor; }
/* 红 / 绿两个数字是**今天**的失败与成功次数，用等宽数字免得跳动。 */
.mf-tally { display: flex; gap: 6px; flex: none; font-variant-numeric: tabular-nums; font-size: 12px; }
.mf-fail { color: #e5484d; min-width: 1.2em; text-align: right; opacity: .85; }
.mf-good { color: #30a46c; min-width: 1.2em; text-align: right; opacity: .85; }
.mf-text { font: inherit; color: inherit; background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 1px 4px; min-width: 0; max-width: 260px; width: 100%; }
/* 试连接的结果，紧跟在模型名字后面。它是**这一次体检**的结论，不是隔离状态：
   关掉设置页就没了，所以画成一个小胶囊，别让它看起来像常驻标记。 */
.mf-probe { flex: none; margin-left: 7px; padding: 0 6px; border-radius: 999px; border: 1px solid currentColor; font-size: 10.5px; font-weight: 400; vertical-align: 1px; }
.mf-probe-busy { opacity: .4; }
.mf-probe-ok { color: #30a46c; }
.mf-probe-bad { color: #e5484d; }
.mf-text:hover:not(:disabled) { border-color: color-mix(in srgb, currentColor 18%, transparent); }
.mf-text:focus { outline: none; border-color: color-mix(in srgb, currentColor 40%, transparent); background: color-mix(in srgb, currentColor 5%, transparent); }
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
.mf-qv-clear { flex: none; font-size: 11.5px; padding: 1px 8px; }
.mf-qv-line { display: flex; align-items: baseline; gap: 8px; }
.mf-qv-label { flex: none; width: 4.5em; opacity: .55; font-size: 11.5px; }
.mf-qv-value { flex: 1; min-width: 0; word-break: break-word; }
.mf-qv-list { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 4px 8px; }
.mf-qv-item { display: inline-flex; align-items: baseline; gap: 6px; padding: 1px 8px; border-radius: 999px; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); font-size: 11.5px; }
.mf-qv-item.mf-bad { border-color: color-mix(in srgb, #e5484d 55%, transparent); color: #e5484d; }
.mf-qv-item.mf-ok { border-color: color-mix(in srgb, #30a46c 55%, transparent); color: #30a46c; }
.mf-qv-item > .mf-qv-code { opacity: .65; }
/* 右键就能整块复制，鼠标形状得先说明这件事。 */
.mf-qv-item.mf-copyable { cursor: context-menu; }
.mf-copied { margin-left: 4px; color: #30a46c; }
/* 输出速度：蓝框蓝字，紧跟在模型名后面。跟红/绿胶囊并排，一眼分清「今天行不行」
   和「用起来多快」是两个问题。 */
.mf-speed { flex: none; border: 1px solid #4c9aff; color: #4c9aff; border-radius: 5px; padding: 0 4px; font-size: 11px; font-variant-numeric: tabular-nums; }
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
        templates: '队列模板',
        templatesHint:
          '每个模板在模型选择器里就是一个模型：会话挑中哪个模板，它就用哪条队列。下面正在编辑的是这一次要改的那个。',
        queueOf: '「{name}」的队列',
        templateName: '模板名',
        templateNewName: '新模板',
        templateCandidates: '队列里 {count} 个模型',
        templateEdit: '编辑',
        templateEditing: '正在编辑',
        templateDelete: '删除这个模板',
        templateAdd: '新建模板',
        templateAddHint: '最多 8 个。新建出来是空队列，从下面把模型加进去。',
        templateProbe: '测试连接',
        templateProbeHint:
          '把这条队列里的模型挨个试一次，结果显示在下面每个模型名字后面。只发一句「hi」，花不了几个 token；结果关掉设置页就没了。',
        probeBusy: '测试中…',
        probeOk: '通',
        probeBad: '不通',
        probeRunning: '正在等这个模型的回应',
        probeOkHint: '{ms} 毫秒收到回应',
        probeBadHint: '试连接失败',
        failCountHint: '今天这个模型一共失败了几次（所有会话合计）',
        goodCountHint: '今天这个模型成功了几次（所有会话合计）',
        queueHint:
          '靠前的优先使用。↑ / ↓ 调整顺序，✕ 移出队列；右栏给每个模型挑它这一轮用的思考强度，档位就是平时直接选它时能选的那几档。',
        effortDefault: '默认档位',
        effortUnknown: '档位待扫描',
        effortNone: '无档位',
        effortHint: '「默认档位」＝这个模型平时的档位（不指定）；档位表由模型自己提供。',
        queueEmpty: '队列是空的。从下面挑一个模型加进来，或者点「重新扫描」。',
        moveUp: '上移',
        moveDown: '下移',
        remove: '移出队列',
        addModel: '从已接入的模型里添加…',
        add: '添加',
        noModels: '没有扫到可用的模型。',
        relay: '模型异常',
        relayHint:
          '开着的时候，队列里的模型会一直在后台自动接力：一个产不出东西就换下一个，直到有人把这一轮做完。',
        optEnabled: '启用接力',
        optEnabledHint: '关掉后队列退化为「只使用第一个模型」。',
        optSameModelRetries: '同一个模型失败后重试几次',
        optSameModelRetriesHint:
          '一个模型背后可能挂着几个账号（dsh-our-free-model 这类多账号反代就是这样）。失败一次通常只停用了其中一个账号，把原请求一模一样再发一遍，它就会换个人来答；试满这么多次还不行，才判这个模型今天不行、换队列里的下一个。这些重发不带「继续」——新账号没写过东西，没什么可继续的。',
        optSameModelRetriesUnit: '次',
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
        routeTemplates: '共 {count} 个模板',
        appearance: '外观',
        appearanceHint: '决定会话页「隔离队列」里显示哪些会话。',
        optShowSubagents: '显示子智能体的会话',
        optShowSubagentsHint:
          '子智能体干活时也是一次正经会话（也会走接力、也会撞墙），但那是你委托出去的一次执行，不是你在侧边栏里开的那个对话，所以默认不显示。',
        optShowForeign: '显示其他工作区的会话',
        optShowForeignHint:
          '别的工作区里的会话同样是你的对话。关掉之后，这一栏只剩当前工作区的会话。',
        eventsEmpty: '还没有记录。',
        evGood: '{provider}/{model} 产出内容，标记为可用',
        evQuarantine: '{provider}/{model} 无法输出（{code}），今日隔离',
        evRollover: '跨过 {hour} 点：{from} → {to}，隔离名单已清空',
        evReset: '手动解除隔离，清了 {count} 个',
        evResetSession: '会话 {session} 手动解除隔离，清了 {count} 个',
        evForget: '重置了今天的运行状态',
        tailModel: '本轮：{label}',
        viewQuarantine: '隔离队列',
        qvHint:
          '隔离是「按会话 × 模板」算的：某个模型在哪个会话的哪条模板上撞了墙，就只在那条队列里被跳过，别的会话、别的模板照常用它。下面只列你自己建的会话（子智能体跑出来的会话不在这里），每个会话右边那个按钮只解除它自己的隔离。',
        qvRefresh: '刷新',
        qvClear: '解除隔离',
        qvClearHint: '只解除这个会话的隔离，别的会话一条都不动。',
        qvCopyHint: '右键复制这条报错（含模型、错误码和完整原文）',
        qvCopied: '已复制',
        qvCopyFailed: '复制失败：浏览器没让我们写剪贴板，手动选中复制吧',
        qvLoading: '读取中…',
        qvFailed: '读取失败：{message}',
        qvEmpty: '还没有任何会话跑过。',
        qvNoProblem: '这个会话今天没有出过问题的模型。',
        qvActive: '正在用',
        qvQuarantined: '已隔离',
        qvQueued: '已验证',
        qvCurrent: '当前会话',
        qvRunning: '运行中',
        qvUnnamed: '未命名会话',
        qvUnscoped: '后台任务（不挂在任何会话下）',
        qvDay: '当前逻辑日 {day}',
        qvSpeedHint: '本会话累计跑出 {tokens} 个输出 token，扣掉排队和首字延迟后用了 {ms} 毫秒',
        qvSpeedHintRuns: '本会话累计 {runs} 趟、共 {tokens} 个输出 token，扣掉排队和首字延迟后用了 {ms} 毫秒',
        qvTemplate: '模板「{name}」',
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
        templates: 'Queue templates',
        templatesHint:
          'Each template is a model in the model chooser: a conversation that picks a template uses that queue. The one being edited right now is the one below.',
        queueOf: 'Queue for “{name}”',
        templateName: 'Template name',
        templateNewName: 'New template',
        templateCandidates: '{count} model(s) queued',
        templateEdit: 'Edit',
        templateEditing: 'Editing',
        templateDelete: 'Delete this template',
        templateAdd: 'New template',
        templateAddHint: 'Up to 8. A new one starts empty — add models below.',
        templateProbe: 'Test',
        templateProbeHint:
          'Pings every model in this queue once and shows the result next to each name below. It only sends “hi”, so it costs almost nothing; the results are gone once you close this page.',
        probeBusy: 'Testing…',
        probeOk: 'OK',
        probeBad: 'Fail',
        probeRunning: 'Waiting for this model',
        probeOkHint: 'Answered in {ms} ms',
        probeBadHint: 'Connection test failed',
        failCountHint: 'How many times this model failed today (all conversations)',
        goodCountHint: 'How many times this model succeeded today (all conversations)',
        queueHint:
          'Earlier entries are tried first. Use ↑ / ↓ to reorder, ✕ to remove; the right column picks the reasoning effort each model uses — the same levels you get when you pick that model directly.',
        effortDefault: 'Default effort',
        effortUnknown: 'Effort unknown',
        effortNone: 'No effort',
        effortHint: '"Default effort" keeps the model’s own level (nothing is specified); the levels come from the model itself.',
        queueEmpty: 'The queue is empty. Add a model below, or press Rescan.',
        moveUp: 'Move up',
        moveDown: 'Move down',
        remove: 'Remove',
        addModel: 'Add a connected model…',
        add: 'Add',
        noModels: 'No models were discovered.',
        relay: 'Model anomalies',
        relayHint:
          'While this is on, the queued models keep relaying in the background: one produces nothing and the next takes over, until someone finishes the turn.',
        optEnabled: 'Relay enabled',
        optEnabledHint: 'Turned off, the queue degrades to "always the first model".',
        optSameModelRetries: 'Retries per model',
        optSameModelRetriesHint:
          'One model can sit in front of several accounts (multi-account proxies such as dsh-our-free-model). A failure usually only benches one account, so re-sending the very same request lands on another one. Only after all retries fail is the model treated as broken and the next one tried. These retries carry no "continue" text — a fresh account has written nothing to continue.',
        optSameModelRetriesUnit: 'times',
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
        routeTemplates: '{count} template(s)',
        appearance: 'Appearance',
        appearanceHint: 'Decides which conversations show up in the “Quarantine” view.',
        optShowSubagents: 'Show subagent conversations',
        optShowSubagentsHint:
          'A subagent run is a real conversation too (it relays, it hits walls), but it is one delegated execution, not the chat you opened in the sidebar — so it is hidden by default.',
        optShowForeign: 'Show conversations from other workspaces',
        optShowForeignHint:
          'Conversations in other workspaces are yours as well. Turn this off to keep only the current workspace.',
        eventsEmpty: 'Nothing recorded yet.',
        evGood: '{provider}/{model} produced output — marked usable',
        evQuarantine: '{provider}/{model} produced nothing ({code}) — quarantined today',
        evRollover: 'Crossed {hour}:00 — {from} → {to}, quarantine cleared',
        evReset: 'Quarantine cleared by hand — {count} released',
        evResetSession: 'Quarantine cleared by hand in conversation {session} — {count} released',
        evForget: 'Today’s runtime state was reset',
        tailModel: 'Turn: {label}',
        viewQuarantine: 'Quarantine',
        qvHint:
          'Quarantine is per conversation and per template: a model that failed on one queue inside one conversation is skipped only there, and stays available everywhere else. The list below shows, per conversation, the model in use and the models quarantined; the button on each row only clears that conversation.',
        qvRefresh: 'Refresh',
        qvClear: 'Clear',
        qvClearHint: 'Only clears the quarantine of this conversation; other conversations are untouched.',
        qvCopyHint: 'Right-click to copy this error (model, code and the full message)',
        qvCopied: 'Copied',
        qvCopyFailed: 'Copy failed: the browser would not let us write to the clipboard — select the text instead',
        qvLoading: 'Loading…',
        qvFailed: 'Could not load: {message}',
        qvEmpty: 'No conversation has run anything yet.',
        qvNoProblem: 'No model has failed in this conversation today.',
        qvActive: 'In use',
        qvQuarantined: 'Quarantined',
        qvQueued: 'Verified',
        qvCurrent: 'This conversation',
        qvRunning: 'Running',
        qvUnnamed: 'Untitled conversation',
        qvUnscoped: 'Background work (not tied to a conversation)',
        qvDay: 'Logical day {day}',
        qvSpeedHint: 'This conversation produced {tokens} output tokens in {ms} ms, excluding queueing and time to first token',
        qvSpeedHintRuns: 'This conversation ran {runs} times for {tokens} output tokens in {ms} ms, excluding queueing and time to first token',
        qvTemplate: 'template “{name}”',
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

    /**
     * 把一段文字塞进系统剪贴板，返回是否成功。
     *
     * 先走 `navigator.clipboard`（本程序跑在 127.0.0.1 上，属于安全上下文，
     * 这条路径正常可用）；拿不到或被权限挡住时退回隐藏 textarea + `execCommand`。
     * 两条都失败就返回 false，让调用方**不要**谎报「已复制」。
     */
    async function copyText(text) {
      try {
        if (typeof navigator?.clipboard?.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // 权限被拒 / 非安全上下文，落到下面那条老路。
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy') === true
        area.remove()
        return ok
      } catch {
        return false
      }
    }

    /**
     * 一条隔离记录拼成可以直接粘出去的文本：抬头一行写清「谁、哪条模板、什么码、
     * 什么时候」，换行后跟宿主留下的报错原文。
     *
     * 为什么要抬头：报错正文常常只有一句 `Error in upstream response`，
     * 单看它既认不出是哪个模型，也认不出是哪条队列上的账 —— 贴到别处等于白贴。
     */
    function errorBlock(item, templateName) {
      const code = String(item?.code ?? '?')
      // 没有模板号的记录（不分会话那一桶）不补模板名：宁缺一句，也不写个「?」。
      const template = typeof item?.templateId === 'string' && item.templateId !== ''
        ? templateName(item.templateId)
        : undefined
      const head = [
        sessionItemLabel(item),
        template,
        `${codeText(code) || code} (${code})`,
        stamp(item?.at),
      ].filter((part) => typeof part === 'string' && part !== '').join(' · ')
      const message = String(item?.message ?? '').trim()
      return message === '' ? head : `${head}\n${message}`
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
      /**
       * 试连接的结果，键是 `provider\0model`。
       *
       * **刻意只放在组件里、不落盘**：一次体检的结论过几分钟就可能不准（账号
       * 掉了、额度用完了），留着只会误导人。设置页一关，它就跟着没了。
       */
      const [probes, setProbes] = useState({})
      /** 正在测哪个模板（空串 = 没有在测）。 */
      const [probingId, setProbingId] = useState('')
      const [, setTick] = useState(0)
      const alive = useRef(true)

      useEffect(() => () => { alive.current = false }, [])

      const load = useCallback(async (scan = false) => {
        try {
          // 打开设置页顺带扫一次目录：新接进来的 provider、新登录的账号，进来
          // 就该在清单里，不该先让用户去点一下「重新扫描」。
          const next = scan ? await post('/refresh', {}) : await getState()
          if (!alive.current) return
          setState(next)
          setError('')
        } catch (failure) {
          if (!alive.current) return
          if (scan) {
            // 扫描失败不该让整页空着：退回纯读取，至少还能改设置。
            try {
              const next = await getState()
              if (!alive.current) return
              setState(next)
              setError('')
              return
            } catch {
              // 连读取也失败：落到下面统一报错。
            }
          }
          setError(String(failure?.message ?? failure))
        }
      }, [])

      useEffect(() => { void load(true) }, [load])

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
      /**
       * 队列模板。模板 id 就是模型 id：会话在 DSH 的模型选择器里挑中哪个模板，
       * 它就用哪个模板的队列。设置页一次只编辑其中一个。
       */
      const templates = useMemo(() => (Array.isArray(settings?.templates) ? settings.templates : []), [settings])
      const editedTemplate = useMemo(
        () => templates.find((template) => template.id === settings?.editedTemplate) ?? templates[0],
        [templates, settings],
      )
      const order = useMemo(
        () => (Array.isArray(editedTemplate?.order) ? editedTemplate.order : []),
        [editedTemplate],
      )
      /** 每模型当天的失败/成功次数（全机器合计），队列前面那对红绿数字。 */
      const countsOf = useCallback((key) => (state?.counts ?? {})[key] ?? undefined, [state])

      /**
       * 今日隔离（跨会话、跨模板）的条数。
       *
       * 设置页不再列名单了 —— 隔离是按「会话 × 模板」算的，一页表格说不清
       * 「在我这个会话里能不能用」。要看细节去会话页那一栏。
       */
      const quarantineCount = (state?.quarantined ?? []).length

      /**
       * 今天被隔离过的模型（任意会话）。
       *
       * 队列行上不再画隔离徽标了 —— 隔离是按会话算的，一行一个模型根本答不了
       * 「在我这个会话里能不能用」。这个集合现在只服务「下一个任务会用谁」
       * 那一格。
       */
      const quarantinedKeys = useMemo(
        () => new Set((state?.quarantined ?? []).map((row) => row.key)),
        [state],
      )

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

      const mutateOrder = useCallback((nextOrder) => {
        if (editedTemplate === undefined) return
        // 整个数组一起写回去：模板是设置里唯一需要「同时改名字和队列」的地方，
        // 逐键补丁会把两次修改拆成两个请求，中间那一瞬的名字可能是旧的。
        void run('/settings', {
          templates: templates.map((template) => (
            template.id === editedTemplate.id ? { ...template, order: nextOrder } : template
          )),
        })
      }, [editedTemplate, templates, run])

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

      /** 切到另一个模板编辑。只是界面状态，不影响任何会话实际用哪条队列。 */
      const selectTemplate = useCallback((id) => {
        if (id === settings?.editedTemplate) return
        void run('/settings', { editedTemplate: id })
      }, [settings, run])

      const renameTemplate = useCallback((id, name) => {
        const trimmed = String(name ?? '').trim().slice(0, MAX_TEMPLATE_NAME)
        const hit = templates.find((template) => template.id === id)
        if (hit === undefined || trimmed === '' || trimmed === hit.name) return
        void run('/settings', {
          templates: templates.map((template) => (template.id === id ? { ...template, name: trimmed } : template)),
        })
      }, [templates, run])

      /**
       * 新建一个空队列模板。
       *
       * id 在浏览器这边生成、宿主只校验字符集与唯一性：用时间戳后缀是为了
       * 同一个页面连点两次也能拿到两个不同的 id。
       */
      const createTemplate = useCallback(() => {
        if (templates.length >= MAX_TEMPLATES) return
        const id = `t${Date.now().toString(36)}`
        const name = `${t('templateNewName')} ${templates.length + 1}`
        void run('/settings', { templates: [...templates, { id, name, order: [] }], editedTemplate: id })
      }, [templates, run, t])

      /** 删掉一个模板。最后一个不给删：这条路由总得有一条队列兜底。 */
      const deleteTemplate = useCallback((id) => {
        if (templates.length <= 1) return
        const next = templates.filter((template) => template.id !== id)
        void run('/settings', { templates: next, editedTemplate: next[0].id })
      }, [templates, run])

      /**
       * 把一个模板里的模型挨个试一遍连接。
       *
       * 结果画在下面那张队列卡里，所以先把这张模板切到眼前 —— 不然点了「测试」
       * 却什么都看不见，只会让人以为按钮坏了。
       *
       * 逐个发请求而不是一次全发：一条模板十几个模型、每个都要等网络，一次
       * 全发等于盯着一个不动的列表等半分钟；逐个发还能各自显示进度。
       */
      const probeTemplate = useCallback(async (template) => {
        const items = Array.isArray(template?.order) ? [...template.order] : []
        if (items.length === 0) return
        if (template.id !== settings?.editedTemplate) selectTemplate(template.id)
        setProbingId(template.id)
        setProbes((previous) => {
          const next = { ...previous }
          for (const item of items) next[keyOf(item.provider, item.model)] = { state: 'busy' }
          return next
        })
        let cursor = 0
        const worker = async () => {
          while (cursor < items.length) {
            const item = items[cursor]
            cursor += 1
            const key = keyOf(item.provider, item.model)
            let row
            try {
              const payload = await api('/probe', {
                method: 'POST',
                body: { provider: item.provider, model: item.model },
                // 宿主自己 15 秒就放弃，所以这里的上限要比它宽一点，
                // 否则先超时的是浏览器，报出来的错就看不出到底是哪一步卡住。
                timeoutMs: 25_000,
              })
              const result = payload?.result ?? {}
              row = result.ok === true
                ? { state: 'ok', ms: result.ms }
                : { state: 'bad', code: result.code ?? 'UNKNOWN', message: result.message ?? '' }
            } catch (failure) {
              row = { state: 'bad', code: 'HTTP', message: String(failure?.message ?? failure) }
            }
            if (!alive.current) return
            setProbes((previous) => ({ ...previous, [key]: row }))
          }
        }
        await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, items.length) }, () => worker()))
        if (alive.current) setProbingId('')
      }, [settings, selectTemplate])

      /** 试连接结果的那颗小胶囊：文字与悬停说明。 */
      const probeText = (row) => (row.state === 'busy' ? t('probeBusy') : row.state === 'ok' ? t('probeOk') : t('probeBad'))
      const probeHint = (row) => {
        if (row.state === 'busy') return t('probeRunning')
        if (row.state === 'ok') return t('probeOkHint', { ms: row.ms ?? 0 })
        const code = row.code ?? 'UNKNOWN'
        return row.message === undefined || row.message === ''
          ? `${t('probeBadHint')} — ${code}`
          : `${code} — ${row.message}`
      }

      /** 队列里第一个没被隔离的模型 —— 也就是下一个任务会从谁起头。 */
      const startAt = useMemo(() => {
        if (order.length === 0) return undefined
        const usable = order.find((item) => !quarantinedKeys.has(keyOf(item.provider, item.model)))
        return usable ?? order[0]
      }, [order, quarantinedKeys])

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
            // 带会话号的是会话页那个「解除本会话隔离」，不带的是全局解除。
            body = typeof event.sessionId === 'string' && event.sessionId !== ''
              ? t('evResetSession', { count: event.cleared ?? 0, session: event.sessionId.slice(0, 8) })
              : t('evReset', { count: event.cleared ?? 0 })
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
              // 跨会话、跨模板合计：设置页只报个数，明细在会话页那一栏。
              h('b', null, String(quarantineCount)),
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

        // ── 队列模板 ────────────────────────────────────────────────────────
        // 每个模板在这条路由下就是一个「模型」：会话在模型选择器里挑中哪个
        // 模板，它就用哪条队列。设置页一次只编辑其中一个。
        Card({ title: t('templates') },
          div({ className: 'mf-note' }, t('templatesHint')),
          ...templates.map((template) => h(TemplateRow, {
            key: template.id,
            template,
            edited: template.id === editedTemplate?.id,
            busy,
            t,
            canDelete: templates.length > 1,
            onSelect: () => selectTemplate(template.id),
            onRename: (name) => renameTemplate(template.id, name),
            onDelete: () => deleteTemplate(template.id),
            onProbe: () => void probeTemplate(template),
            probing: probingId === template.id,
          })),
          div({ className: 'mf-add' },
            h('button', {
              type: 'button',
              className: 'mf-btn',
              'data-role': 'template-add',
              disabled: busy || templates.length >= MAX_TEMPLATES,
              onClick: createTemplate,
            }, t('templateAdd')),
            span({ className: 'mf-note' }, t('templateAddHint')),
          ),
        ),

        // ── 优先级队列 ──────────────────────────────────────────────────────
        Card({ title: t('queueOf', { name: editedTemplate?.name ?? '' }) },
          div({ className: 'mf-note' }, t('queueHint')),
          ...order.map((item, index) => {
              const key = keyOf(item.provider, item.model)
              const hit = (state.catalog ?? []).find((row) => row.provider === item.provider && row.model === item.model)
              const tally = countsOf(key)
              const probeRow = probes[key]
              return div({ className: 'mf-row', key },
                span({ className: 'mf-idx' }, String(index + 1)),
                // 今天这个模型在全机器上失败了几次、成了几次。红的是失败、绿的是
                // 成功 —— 它是**统计**，不是隔离状态：隔离按「会话 × 模板」算，
                // 一行一个模型答不了「在我这个会话里能不能用」。
                span({ className: 'mf-tally' },
                  span({ className: 'mf-fail', title: t('failCountHint') }, String(tally?.fail ?? 0)),
                  span({ className: 'mf-good', title: t('goodCountHint') }, String(tally?.ok ?? 0)),
                ),
                div({ className: 'mf-main' },
                  div({ className: 'mf-name' },
                    span({ className: 'mf-name-text' }, hit?.name ?? item.model),
                    // 试连接的结论紧跟在名字后面，一眼看清哪个通、哪个不通。
                    probeRow === undefined
                      ? null
                      : span({
                          className: `mf-probe mf-probe-${probeRow.state}`,
                          title: probeHint(probeRow),
                          'data-role': 'probe',
                        }, probeText(probeRow)),
                  ),
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
                div({ className: 'mf-actions' },
                  h('button', { type: 'button', className: 'mf-btn mf-icon', title: t('moveUp'), disabled: busy || index === 0, onClick: () => move(index, -1) }, '↑'),
                  h('button', { type: 'button', className: 'mf-btn mf-icon', title: t('moveDown'), disabled: busy || index === order.length - 1, onClick: () => move(index, 1) }, '↓'),
                  h('button', { type: 'button', className: 'mf-btn mf-icon', 'data-role': 'queue-remove', title: t('remove'), disabled: busy, onClick: () => removeAt(index) }, '✕'),
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

        // 这里原来有一张「今日隔离名单」卡片，已经删掉：隔离是按「会话 × 模板」
        // 算的，一页全局表格既说不清是谁撞的墙，也容易让人以为解除了就全局生效。
        // 明细改在会话页顶部的「隔离队列」一栏，那里能就地解除当前会话。

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
            div({ className: 'mf-opt' },
              div({ className: 'mf-opt-main' },
                div(null, t('optSameModelRetries')),
                div({ className: 'mf-note' }, t('optSameModelRetriesHint')),
              ),
              h(NumberInput, {
                value: settings.sameModelRetries ?? 2,
                min: 0,
                max: MAX_SAME_MODEL_RETRIES,
                name: 'sameModelRetries',
                disabled: busy || settings.enabled === false,
                onCommit: (value) => { if (value !== settings.sameModelRetries) void run('/settings', { sameModelRetries: value }) },
              }),
              span({ className: 'mf-note' }, t('optSameModelRetriesUnit')),
            ),
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

        // ── 外观 ────────────────────────────────────────────────────────────
        Card({ title: t('appearance') },
          div({ className: 'mf-note' }, t('appearanceHint')),
          h(ToggleRow, {
            label: t('optShowSubagents'),
            hint: t('optShowSubagentsHint'),
            checked: settings.showSubagentSessions === true,
            disabled: busy,
            onChange: (value) => void run('/settings', { showSubagentSessions: value }),
          }),
          h(ToggleRow, {
            label: t('optShowForeign'),
            hint: t('optShowForeignHint'),
            checked: settings.showForeignSessions !== false,
            disabled: busy,
            onChange: (value) => void run('/settings', { showForeignSessions: value }),
          }),
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
          div({ className: 'mf-note' }, `${t('route')}：${state.route?.label ?? ROUTE} · ${t('routeTemplates', { count: templates.length })}`),
        ),
      )
    }

    /**
     * 只在失焦/回车时提交的数字输入，并对上下界做夹取。
     *
     * `name` 只落成 `data-name`，给测试和排查用：同一张卡片里不止一个数字框，
     * 光靠上下界认不出是哪一个。`max` 可以不给 —— 那表示这一项没有上限
     * （比如「继续」的次数上限，想填多少填多少）。
     */
    function NumberInput({ value, min, max, name, disabled, onCommit }) {
      const [draft, setDraft] = useState(String(value))
      useEffect(() => { setDraft(String(value)) }, [value])
      const commit = () => {
        const parsed = Number.parseInt(draft, 10)
        if (!Number.isInteger(parsed)) { setDraft(String(value)); return }
        const clamped = max === undefined ? Math.max(min, parsed) : Math.min(max, Math.max(min, parsed))
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

    /**
     * 模板列表里的一行：改名、切成正在编辑、删掉。
     *
     * 名字用「失焦/回车才提交」的输入框，而不是每敲一个字就发一次请求 ——
     * 一个名字要打十几次键盘，那样就是十几次往返，而且每次都会把正在编辑的
     * 模板重置一遍。
     */
    function TemplateRow({ template, edited, busy, t, canDelete, onSelect, onRename, onDelete, onProbe, probing }) {
      const [draft, setDraft] = useState(template.name)
      useEffect(() => { setDraft(template.name) }, [template.name])
      const commit = () => {
        const trimmed = draft.trim().slice(0, MAX_TEMPLATE_NAME)
        if (trimmed === '') { setDraft(template.name); return }
        setDraft(trimmed)
        onRename(trimmed)
      }
      return div({ className: edited ? 'mf-row mf-row-on' : 'mf-row' },
        div({ className: 'mf-main' },
          h('input', {
            className: 'mf-text',
            type: 'text',
            value: draft,
            maxLength: MAX_TEMPLATE_NAME,
            disabled: busy,
            'data-name': 'templateName',
            'aria-label': t('templateName'),
            onChange: (event) => setDraft(event.target.value),
            onBlur: commit,
            onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
          }),
          div({ className: 'mf-sub' }, `${template.id} · ${t('templateCandidates', { count: template.order.length })}`),
        ),
        div({ className: 'mf-actions' },
          h('button', {
            type: 'button',
            className: 'mf-btn',
            'data-role': 'template-probe',
            title: t('templateProbeHint'),
            disabled: busy || probing || template.order.length === 0,
            onClick: onProbe,
          }, probing ? t('probeBusy') : t('templateProbe')),
          h('button', {
            type: 'button',
            className: 'mf-btn',
            'data-role': 'template-select',
            disabled: busy || edited,
            onClick: onSelect,
          }, edited ? t('templateEditing') : t('templateEdit')),
          h('button', {
            type: 'button',
            className: 'mf-btn mf-icon',
            'data-role': 'template-delete',
            title: t('templateDelete'),
            disabled: busy || !canDelete,
            onClick: onDelete,
          }, '✕'),
        ),
      )
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
     * 有会话正在跑时的轮询间隔。
     *
     * 速度数字要「实时」，靠的就是这个：每一趟结束时宿主的累计值才跳一下，而
     * 一趟可能跑几十秒 —— 15 秒的间隔会让它看起来像回放。2 秒足够跟上，也不至于
     * 让这一栏变成一个请求放大器（闲下来立刻退回 15 秒）。
     */
    const QV_POLL_MS_ACTIVE = 2000

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
     * 把一趟的输出速度写成 `42.1 tok/s`。
     *
     * 口径照抄 dsh 自己那个「输出速度（TPS）」：先把每一趟的 `decodeTokens` 与
     * 「首字到结束」的毫秒数分别加起来，最后再除；显示上也一样 ——
     * **两位数以上取整，个位数保留一位小数**（官方 `formatTokensPerSecond` 就是
     * `>= 10 ? Math.round : toFixed(1)`）。个位数保留小数是因为「3.4 tok/s」和
     * 「3 tok/s」差的三分之一是能感觉到的，而「247.3」和「247」之间的零点三
     * 没有任何意义。
     *
     * 拿不到有效数字就返回 `undefined`，调用方据此什么都不画：宁可空着，也不
     * 让界面上出现 `NaN tok/s` 或者一个凭空的 `0.0`。
     */
    function speedText(speed) {
      const tokens = speed?.tokens
      const ms = speed?.ms
      if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return undefined
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined
      const clamped = Math.max(0, tokens / (ms / 1000))
      if (!Number.isFinite(clamped)) return undefined
      return `${clamped >= 10 ? String(Math.round(clamped)) : clamped.toFixed(1)} tok/s`
    }

    /**
     * 一栏里的一行会话。
     *
     * `useSessions` 由宿主以标准 hook 属性注入（dsh-client-ui-session 的
     * `provideRoot({ hooks: { sessions: ctx.sessions.list } })`），拿它换会话标题；
     * 拿不到时退回会话号前缀 —— 这一栏是给人看「哪个会话出事了」，标题只是
     * 帮助识别，缺了也不能空白。
     */
    function SessionQueueRow({ row, mine, title, t, templateName, onClear, busy, onCopyError, copiedKey }) {
      const quarantined = row?.quarantined ?? []
      const good = row?.good ?? []
      const active = row?.active
      const activeTemplate = typeof active?.templateName === 'string' && active.templateName !== ''
        ? active.templateName
        : undefined
      // 每个模型胶囊后面跟一个蓝色小框写它的输出速度 —— 已隔离和已验证都要，
      // 因为「它多快」和「它今天行不行」是两个独立的问题：一个被隔离的模型
      // 可能刚才还跑得飞快（只是最后撞了额度），而那正是值得知道的信息。
      const speedChip = (item) => {
        const text = speedText(item?.speed)
        if (text === undefined) return null
        const runs = Number.isInteger(item.speed.runs) && item.speed.runs > 1 ? item.speed.runs : undefined
        return span({
          className: 'mf-speed',
          title: runs === undefined
            ? t('qvSpeedHint', { tokens: item.speed.tokens, ms: Math.round(item.speed.ms) })
            : t('qvSpeedHintRuns', { tokens: item.speed.tokens, ms: Math.round(item.speed.ms), runs }),
        }, text)
      }
      // 此刻正在跑：这一栏要能一眼看出「有人在写字」，因为速度数字只在每一趟
      // 结束时才跳一下，中间那几十秒光看数字是看不出还在跑的。
      const running = row?.running
      return div({ className: mine ? 'mf-qv-session mf-mine' : 'mf-qv-session' },
        div({ className: 'mf-qv-top' },
          span({ className: 'mf-qv-title' }, title === undefined || title === '' ? t('qvUnnamed') : title),
          running === undefined ? null : span({ className: 'mf-badge mf-run' }, t('qvRunning')),
          mine ? span({ className: 'mf-badge mf-ok' }, t('qvCurrent')) : null,
          span({ className: 'mf-qv-id' }, shortId(row?.sessionId)),
          // 解除按钮就在这一行上：解哪个会话的隔离，按钮长在哪个会话上最没歧义。
          // 没有隔离就点不动 —— 灰着比按下去什么也不发生更好懂。
          h('button', {
            type: 'button',
            className: 'mf-btn mf-qv-clear',
            disabled: busy || quarantined.length === 0,
            title: t('qvClearHint'),
            onClick: () => onClear?.(row?.sessionId ?? ''),
          }, t('qvClear')),
        ),
        div({ className: 'mf-qv-line' },
          span({ className: 'mf-qv-label' }, t('qvActive')),
          // 模板名跟着模型一起报：同一个模型可能同时挂在好几条模板的队列里，
          // 只说模型名答不了「这个会话现在跑的是哪条队列」。
          span({ className: 'mf-qv-value' }, active === undefined
            // 还没跑完任何一趟的会话（刚开的对话）只有实时表知道它在用谁。
            ? (running === undefined ? t('none') : sessionItemLabel(running))
            : `${sessionItemLabel(active)}${activeTemplate === undefined ? '' : ` · ${t('qvTemplate', { name: activeTemplate })}`}`),
        ),
        div({ className: 'mf-qv-line' },
          span({ className: 'mf-qv-label' }, t('qvQuarantined')),
          quarantined.length === 0
            ? span({ className: 'mf-qv-value' }, t('qvNoProblem'))
            : div({ className: 'mf-qv-list' },
                ...quarantined.map((item) => {
                  const chipKey = `${item.key ?? ''}\u0000${item.templateId ?? ''}`
                  const copied = copiedKey !== undefined && copiedKey === chipKey
                  return h('span', {
                    className: 'mf-qv-item mf-bad mf-copyable',
                    key: chipKey,
                    // 悬停给全文（正文动辄几百字符，铺在行里会把面板撑烂）；
                    // 右键把「谁 + 哪条模板 + 什么码 + 报错原文」整块拿走。
                    title: `${String(item.message ?? '')}\n${t('qvCopyHint')}`,
                    onContextMenu: (event) => {
                      event?.preventDefault?.()
                      onCopyError?.(item, chipKey)
                    },
                  },
                    span(null, sessionItemLabel(item)),
                    // 别的模板撞的墙不算这个会话当前的麻烦，但也不能凭空消失：
                    // 补一句模板名，说明它是哪条队列上的账。
                    item.templateId === undefined || item.templateId === active?.templateId
                      ? null
                      : span({ className: 'mf-qv-code' }, ` · ${templateName(item.templateId)}`),
                    span({ className: 'mf-qv-code' }, ` · ${codeText(item.code) || String(item.code ?? '?')} · ${stamp(item.at)}`),
                    speedChip(item),
                    copied ? span({ className: 'mf-copied' }, t('qvCopied')) : null,
                  )
                }),
              ),
        ),
        good.length === 0
          ? null
          : div({ className: 'mf-qv-line' },
              span({ className: 'mf-qv-label' }, t('qvQueued')),
              div({ className: 'mf-qv-list' },
                ...good.map((item) => h('span', {
                  className: 'mf-qv-item mf-ok',
                  key: `${item.key ?? ''}\u0000${item.templateId ?? ''}`,
                }, sessionItemLabel(item), speedChip(item))),
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
      /** 刚复制过的那条隔离记录的 key —— 只为了在那颗胶囊上闪一下「已复制」。 */
      const [copied, setCopied] = useState('')
      const copiedTimer = useRef(0)
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

      // 有没有会话正在跑 —— 决定轮询快慢，也决定要不要在行上挂「运行中」。
      const running = (data?.sessions ?? []).some((row) => row?.running !== undefined)

      useEffect(() => {
        alive.current = true
        void load(true)
        return () => {
          alive.current = false
          clearTimeout(copiedTimer.current)
        }
      }, [load])

      // 有人在写字的时候刷得快：用户此刻盯着的就是那几个数字，而速度数字只在
      // 每一趟结束时才跳一下 —— 15 秒的间隔会让「实时」变成「回放」。
      // 全闲着就退回慢慢问：这一栏大部分时间没人看，每两秒戳一次纯属浪费。
      useEffect(() => {
        const timer = setInterval(
          () => { void load(false) },
          running ? QV_POLL_MS_ACTIVE : QV_POLL_MS,
        )
        return () => clearInterval(timer)
      }, [load, running])

      /**
       * 当前会话排在第一行，其余保持宿主给的顺序（隔离着的 → 正在跑的 → 其余）。
       *
       * 只把「我这一栏」拎到最上面，别的相对位置一个都不动：那一份顺序是宿主按
       * 紧急程度排的，前端再排一次就等于两处各自维护一套规则。
       *
       * 没有会话号时按钮一律灰着：说不清「当前会话」是谁的时候，按下去要么
       * 什么都不做，要么（更糟）落到「不分会话」那一桶里替后台任务解开。
       */
      const scoped = typeof mineId === 'string' && mineId !== ''
      /** 「外观」两个开关，宿主随 /sessions 一起给，缺省按默认值走。 */
      const showSubagents = data?.view?.subagentSessions === true
      const showForeign = data?.view?.foreignSessions !== false
      const rows = useMemo(() => {
        const all = Array.isArray(data?.sessions) ? data.sessions : []
        /**
         * 这一栏只列**你自己建的会话**：子智能体的会话默认不显示，别的工作区的
         * 会话默认显示。两个开关都在设置页的「外观」里。
         *
         * 判据全部来自宿主自己的会话摘要（`origin`、`cwd`）。**查不到的会话一律
         * 保留** —— 早先那版把「会话表里查无此号」当成子智能体藏掉，结果把真实
         * 的主会话也藏了（宿主的会话表并不保证收着每一个历史会话）。宁可多显示
         * 几行，也不能把用户的对话吞掉。
         */
        const mineCwd = byId?.[mineId]?.cwd
        const visible = all.filter((row) => {
          const id = row?.sessionId
          // 空串是「不分会话」那一桶（压缩上下文、后台任务），它不是子智能体。
          if (typeof id !== 'string' || id === '') return true
          const summary = byId?.[id]
          if (summary === undefined) return true
          if (summary.origin === 'subagent' && !showSubagents) return false
          if (
            !showForeign &&
            typeof mineCwd === 'string' &&
            typeof summary.cwd === 'string' &&
            summary.cwd !== mineCwd
          ) return false
          return true
        })
        if (!scoped) return visible
        const index = visible.findIndex((row) => row.sessionId === mineId)
        if (index <= 0) return visible
        return [visible[index], ...visible.slice(0, index), ...visible.slice(index + 1)]
      }, [byId, data, mineId, scoped, showForeign, showSubagents])

      /** 模板 id → 名字。隔离条目上只带 id，名字得从宿主给的模板表里换。 */
      const templateName = useCallback((id) => {
        const hit = (Array.isArray(data?.templates) ? data.templates : []).find((template) => template.id === id)
        return typeof hit?.name === 'string' && hit.name !== '' ? hit.name : String(id ?? '?')
      }, [data])

      const titleOf = (sessionId) => {
        // 空串是「不分会话」那一桶：压缩上下文、后台任务、离线测试都落在那里。
        // 它不是某个会话，套一个「未命名会话」会让人以为有这么个对话。
        if (sessionId === '') return t('qvUnscoped')
        const hit = byId?.[sessionId]
        /* 会话标题由宿主给；拿不到就退回会话号前缀。 */
        return typeof hit?.displayTitle === 'string' && hit.displayTitle !== '' ? hit.displayTitle : undefined
      }

      /**
       * 解除**某一个会话**的隔离。
       *
       * 会话号走查询串，因为 POST 的 body 已经被设置补丁占用了；宿主那边按
       * 「带不带 sessionId」分成按会话解除与全局解除两条路径。按钮长在会话行上，
       * 所以传进来的是那一行的会话号，不是「当前会话」。
       */
      const clearOne = useCallback(async (sessionId) => {
        if (!scoped || busy) return
        setBusy(true)
        try {
          const next = await post(`/reset?sessionId=${encodeURIComponent(sessionId)}`, {})
          if (!alive.current) return
          // 响应里已经把新的会话列表带回来了，先用它落屏，省一次往返。
          if (Array.isArray(next?.sessions)) setData((previous) => ({ ...(previous ?? {}), ...next }))
          setError('')
          void load(false)
        } catch (failure) {
          if (!alive.current) return
          setError(String(failure?.message ?? failure))
        } finally {
          if (alive.current) setBusy(false)
        }
      }, [busy, load, scoped])

      /**
       * 右键一条隔离记录：把它的报错整块塞进剪贴板。
       *
       * 复制失败时**写进 error 那一行**，不假装成功 —— 这颗胶囊闪一下「已复制」
       * 却没真进剪贴板，比什么都不做更糟。
       */
      const copyError = useCallback(async (item, chipKey) => {
        const ok = await copyText(errorBlock(item, templateName))
        if (!alive.current) return
        if (!ok) {
          setError(t('qvCopyFailed'))
          return
        }
        setError('')
        setCopied(chipKey)
        clearTimeout(copiedTimer.current)
        copiedTimer.current = setTimeout(() => {
          if (alive.current) setCopied('')
        }, 1600)
      }, [t, templateName])

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
                templateName,
                busy,
                onClear: (sessionId) => void clearOne(sessionId),
                onCopyError: (item, chipKey) => void copyError(item, chipKey),
                copiedKey: copied,
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