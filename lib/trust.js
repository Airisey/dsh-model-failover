/**
 * 请求准入（trust fence）。
 *
 * 为什么需要这一层：本插件把设置接口挂在 `/api/dsh-model-failover` 这个前缀
 * 下，而 dsh 内核自己的鉴权写在 `connection` 服务注册的 `/api` 前缀路由里。
 * host-webserver 的路由匹配是「最长前缀胜出」，所以本插件的路由先于内核那条
 * 命中 —— 内核的信任检查根本不会执行。不补这一层，任何能连到这个端口的人
 * 都能改这台机器上的模型队列、把某个模型隔离掉。
 *
 * 两层，按顺序：
 *  1. composition 里存在 `connection` 服务时直接问它 —— 与内核给 `/api` 的
 *     判定完全一致（信任围栏 + 浏览器鉴权 cookie），于是这个插件永远不会比
 *     应用本身更弱，而且用户在 LAN 上通过受信任主机名访问时也不会被误拒；
 *  2. 没有该服务时，用结构等价的复刻：只接受环回 Host、拒绝跨站 fetch、
 *     客户端给出的 Origin/Referer 必须与 Host 同源。
 *
 * 复刻的理由：`connection` 由 Web 应用在插件之后才发布，一次性读取会把
 * 「缺席」冻结下来；所以这里按请求惰性取服务。
 */

/** 同机调用者可能合法使用的 Host。 */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

/**
 * `connection` 服务的惰性视图。
 *
 * 老版本（dsh 0.1.7 之前）把同一判定发布为 `requestRejection`，返回裸状态码；
 * 新版本是 `admit`，返回 `{ rejection }` 信封。这里把两种拼写都映射成 `admit`。
 * 注意：服务存在但读数失败时必须当成「拒绝」，绝不能当成放行 —— 否则一个
 * 挂掉的 Host 服务就等于关掉了鉴权。
 *
 * @param {object|(() => object|undefined)} service - connection 服务，或按请求解析它的 thunk
 * @returns {{admit: ((req: object) => ({rejection: number}|undefined))|undefined}}
 */
export function connectionAdmissionView(service) {
  return {
    get admit() {
      const current = typeof service === 'function' ? service() : service
      if (current === undefined) return undefined
      if (typeof current.admit !== 'function' && typeof current.requestRejection === 'function') {
        return (req) => {
          const status = current.requestRejection(req)
          return status === undefined ? undefined : { rejection: status }
        }
      }
      return (req) => current.admit(req)
    },
  }
}

/**
 * 判定一个请求。返回要拒绝的 HTTP 状态码，`undefined` 表示放行。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {object|undefined} connection - composition 的 `connection` 服务（没有则用复刻围栏）
 * @param {(decision: {status: number, source: string, reason: string}) => void} [onRejection]
 *   只允许固定字段，绝不把请求头或错误正文传出去
 * @returns {number|undefined}
 */
export function rejectionFor(req, connection, onRejection) {
  let decision

  try {
    const admit = connection?.admit
    if (typeof admit === 'function') {
      const admission = admit.call(connection, req)
      const status = admission !== null && typeof admission === 'object' ? admission.rejection : undefined
      if (status === undefined) return undefined
      decision = { status, source: 'connection', reason: 'host-rejected' }
    } else {
      const reject = connection?.requestRejection
      if (typeof reject === 'function') {
        const status = reject.call(connection, req)
        if (status === undefined) return undefined
        decision = { status, source: 'connection', reason: 'host-rejected' }
      }
    }
  } catch {
    // 挂掉的 Host 服务绝不能变成放行。
    decision = { status: 503, source: 'connection', reason: 'admission-error' }
  }

  if (decision === undefined) {
    const reason = structuralReason(req)
    if (reason === undefined) return undefined
    decision = { status: 403, source: 'structural', reason }
  }

  try {
    onRejection?.(decision)
  } catch {
    /* 诊断是旁观的，日志写不出去也不能改 HTTP 判定 */
  }
  return decision.status
}

/** 复刻围栏：与内核 `isTrustedApiRequest` 同形（DNS rebinding + 跨站 fetch）。 */
export function structuralReason(req) {
  const host = authorityOf(req.headers?.host, 'http')
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 'host-not-loopback'

  const site = String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return 'cross-site'

  for (const header of ['origin', 'referer']) {
    const raw = req.headers?.[header]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    if (header === 'referer' && isDesktopRelayReferer(raw)) {
      // 桌面壳转发的请求会保留这个 Referer；它不是 Origin 授权，也不能覆盖
      // 上面 connection 的判定 —— 只允许它单独出现。
      if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) return 'desktop-relay-markers'
      continue
    }
    const authority = authorityOf(raw.trim())
    if (authority === null) return `${header}-invalid`
    if (authority.scheme !== host.scheme || authority.hostname !== host.hostname || authority.port !== host.port) {
      return `${header}-mismatch`
    }
  }

  return undefined
}

/** 只认桌面壳自己的 dsh-app://app 中转页，不认任意自定义协议页。 */
function isDesktopRelayReferer(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'dsh-app:' && url.hostname === 'app' && url.port === ''
      && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

/** 把 Host/Origin/Referer 拆成 {scheme, hostname, port}，端口取默认值。 */
function authorityOf(value, defaultScheme) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try {
    url = new URL(value.includes('://') ? value.trim() : `${defaultScheme ?? 'http'}://${value.trim()}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port }
}
