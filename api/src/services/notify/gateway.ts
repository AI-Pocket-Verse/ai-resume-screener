// 飞书出站客户端(可选)。
//
// **本服务不碰飞书 SDK,也不持有任何飞书凭证** —— 全部复杂度(tenant token
// 获取与刷新、im.message.create、错误归一)都在 feishu-sso 的
// `POST /api/feishu/notify` 里,这里只是一个用共享 INTERNAL_API_TOKEN 认证的
// HTTP 转发。AUTH_API_BASE 与 INTERNAL_API_TOKEN 都配置了才会推送。
//
// 注意入站(收消息)与出站(发通知)是**两条独立通道**:出站不读事件订阅配置,
// 改事件订阅不会影响这里,反之亦然。
import { env } from '../../env.js'

export class NotifyError extends Error {
  constructor(public readonly code: string, public readonly status: number, message?: string) {
    super(message ?? code)
  }
}

/** 通知是否配好。占位符(`__` 开头)算没配 —— 拿它去打 feishu-sso 只会换回 401,
 *  而 401 在调用侧只留一行 warn,排查时看不出是「配置没填」还是「服务挂了」。 */
export function isNotifyConfigured(): boolean {
  const t = env.INTERNAL_API_TOKEN
  return Boolean(env.AUTH_API_BASE) && Boolean(t) && !t!.startsWith('__')
}

/** 按 open_id 推一张互动卡片。 */
export async function pushCard(openId: string, card: unknown): Promise<{ messageId: string }> {
  if (!isNotifyConfigured()) {
    throw new NotifyError('notify_not_configured', 0, 'AUTH_API_BASE / INTERNAL_API_TOKEN 未配置,跳过推送')
  }
  const res = await fetch(`${env.AUTH_API_BASE}/feishu/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': env.INTERNAL_API_TOKEN! },
    body: JSON.stringify({ openId, card }),
    // ⚠️ Node 的 fetch **没有默认超时**。feishu-sso 挂掉(ECONNREFUSED)会快速失败,
    // 但它【卡住】才是现实的故障模式(它自己要等飞书 API)—— 不设超时的话
    // 这个 await 永不落定,而它是在队列 runJob 里被 await 的,整条解析队列
    // 就此停止排空,外部看起来是「简历一直卡在解析中」,哪里都没有报错。
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null
    throw new NotifyError(body?.error ?? 'feishu_upstream', res.status, body?.message)
  }
  return res.json() as Promise<{ messageId: string }>
}

/** 只有飞书 open_id(ou_ 开头)推得动。其它来源的 ssoId 直接跳过,不报错。 */
export function isPushable(ssoId: string | null | undefined): ssoId is string {
  return Boolean(ssoId?.startsWith('ou_'))
}
