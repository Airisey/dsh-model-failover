/**
 * 「这次失败是不是**本机网络**造成的」的唯一判据。
 *
 * 两个半身都要用它，所以单独放一个文件：
 *   - `autocontinue.js` —— 决定这一轮结束后要不要替用户补一句「继续」；
 *   - `adapter.js`      —— 决定换模型时要不要带上「继续」，以及要不要隔离这个模型。
 *
 * ── 为什么不能只看错误码 ───────────────────────────────────────────────
 *
 * 本机网络故障在 DSH 里**没有专属错误码**。各家适配器各自把自己撞上的
 * fetch / DNS 异常包成自己认识的码，于是同一个本机故障会以不同的面貌出现。
 * 本机实测（2026-10-14 的事件日志，13 条隔离里 12 条是本机网络问题）：
 *
 *   code=SERVER     workbuddy: {"error":"cannot resolve tunnel destination
 *                   www.workbuddy.ai (ENOTFOUND): local name resolution failed —
 *                   the local resolver may be unreachable or taken over by
 *                   another DNS service (VPN/MagicDNS)…"}
 *   code=TRANSPORT  trae: transport error: fetch failed
 *   code=UNKNOWN    CodeArts token request network error: TypeError: fetch failed
 *   code=SERVER     buddy: {"error":"cannot resolve tunnel destination
 *                   copilot.tencent.com (ENOTFOUND)…"}
 *
 * 只按 code 判会漏掉第一、四条（`SERVER` 也可能是远端 5xx，那是该重试的），
 * 所以文本特征对**任何** code 都生效。
 *
 * ── 宁可漏判，不要误判 ─────────────────────────────────────────────────
 *
 * 漏判的代价：多发一次「继续」/ 多隔离一个模型，有次数上限兜底。
 * 误判的代价：真正能靠「继续」救回来的失败（远端 5xx、限流）从此不再被救。
 * 所以这里的特征都取得很具体，**故意不包含**裸的 `timeout`、`502`、`proxy`
 * 这类会跟远端问题撞车的词。
 */

/**
 * 这些错误码天生就是**链路层**的失败：请求根本没跟模型说上话。
 *
 * `TRANSPORT` 是适配器包住 fetch 异常用的（`DeepSeek Messages transport failed`
 * / `pi-ai …`），实测里它对应的就是本机 DNS 挂掉（`trae: transport error:
 * fetch failed`）。
 *
 * 这里**故意不含 `TIMEOUT`**：流空闲超时说明 TCP + TLS + HTTP 握手全都成功了，
 * 本机 DNS 和路由是通的，只是对面中途不吐字了 —— 那更像远端太慢，重发一次是有
 * 意义的。宁可漏判也不要误判。
 */
export const LOCAL_NETWORK_CODES = new Set(['TRANSPORT'])

/**
 * 「本机网络原因」的文本特征。逐条都对应一个真实见过的报错（见文件头）。
 */
export const LOCAL_NETWORK_PATTERNS = [
  // 名字解析失败：ENOTFOUND / EAI_AGAIN 是 Node 的 DNS 错误码，getaddrinfo 是它底下那层。
  /\bE(?:NOTFOUND|AI_AGAIN|ADDRNOTAVAIL|NETUNREACH|NETDOWN|HOSTUNREACH)\b/i,
  /\bgetaddrinfo\b/i,
  /\blocal name resolution failed\b/i,
  /\blocal resolver\b/i,
  // 本机隧道 / 代理明确说「这个目的地我解析不了」。
  /\btunnel_destination_denied\b/i,
  /\bcannot resolve tunnel destination\b/i,
  // 连接层被本机拒掉或掐断：代理没起来、防火墙、VPN 掉线。
  /\bE(?:CONNREFUSED|CONNRESET|CONNABORTED|PIPE)\b/i,
  /\bsocket hang up\b/i,
  /\bother side closed\b/i,
  /\bpremature close\b/i,
  /\bUND_ERR_[A-Z_]+\b/,
  // undici 把所有连接层失败都包成这一句，真正的 cause 在链路更深处。
  /\bfetch failed\b/i,
  // 本机装了拦截型根证书时的典型报错（这台机器上就有）。
  /\bunable to verify the first certificate\b/i,
  /\bself[- ]signed certificate\b/i,
  /\bcertificate (?:verify|verification|expired|invalid|untrusted)\b/i,
  /\bnetwork is unreachable\b/i,
]

/**
 * 这次失败是不是**本机网络**造成的。
 *
 * 判据分两层：链路层错误码（{@link LOCAL_NETWORK_CODES}）直接命中，其余一律看
 * message 特征（{@link LOCAL_NETWORK_PATTERNS}）。
 *
 * @param {any} failure - `{ code, message, status? }` 形状的失败描述。
 * @returns {boolean} true 表示这是本机网络问题。
 */
export function isLocalNetworkFailure(failure) {
  if (failure === null || typeof failure !== 'object') return false
  if (LOCAL_NETWORK_CODES.has(failure.code)) return true
  const message = typeof failure.message === 'string' ? failure.message : ''
  if (message === '') return false
  return LOCAL_NETWORK_PATTERNS.some((pattern) => pattern.test(message))
}
