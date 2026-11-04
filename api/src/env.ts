import { resolve } from 'node:path'
import { z } from 'zod'

// TRUST_PROXY：true / false，或 proxy-addr 支持的 loopback / IP / 网段列表（逗号分隔）。
// 留空按默认 loopback。原样把 "true" 交给 Fastify 会被当成 IP 地址而不生效。
// 跳数（纯数字）不再支持：Fastify 5.12 起按跳数信任一律视为不信任（GHSA-3m5p-2c4r-xxw2），
// 静默失效比报错更糟，所以启动时直接拒绝。
export function parseTrustProxy(v: string): boolean | string {
  const s = v.trim() || 'loopback'
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true'
  if (/^\d+$/.test(s)) {
    throw new Error(`TRUST_PROXY=${s}：不支持按跳数信任代理，请填反向代理的 IP 或网段（如 loopback、192.0.2.0/24）`)
  }
  return s
}

/** 归一化到裸号:剥非数字 + 剥 86 国家码。
 *
 *  飞书按账号返回 `+8613...` / `86 137...` / `137...` 都有可能,直接字符串
 *  相等比对会在某些账号上**静默**失配 —— 人还在,权限没了,且毫无提示。
 *  中国手机号不以 86 开头,剥前缀不会误伤。 */
export function normPhone(p: string): string {
  return p.replace(/\D/g, '').replace(/^86/, '')
}

/** 可选的 URL / 字符串变量：留空（`X=`）等同于未设置。 */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional())

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4070),
  // 默认只监听本机：本地模式不鉴权，而简历含个人信息。
  HOST: z.string().default('127.0.0.1'),

  // 信任的反向代理地址(Fastify trustProxy,proxy-addr 语法:loopback / IP / CIDR,逗号分隔)。
  // 默认只信任本机回环(同机 nginx 反代)。不要设为 true:任何客户端都能伪造来源 IP 绕过限流。
  TRUST_PROXY: z.string().default('loopback').transform(parseTrustProxy),

  // 浏览器访问前端时看到的源 URL,用于 @fastify/cors 白名单。
  WEB_ORIGIN: z.string().default('http://localhost:5070'),

  // 可选登录：feishu-sso 的 whoami 端点。不设置 → 本地单用户模式（唯一的本地用户即超管）。
  WHOAMI_URL: optional(z.string().url()),
  // 接入登录后的超级管理员手机号，逗号分隔。超管可看全部岗位、彻底删除候选人、查审计日志。
  ADMIN_MOBILES: z.string().default(''),
  // 生产环境不配登录时默认拒绝启动(见 assertProductionConfig)。确实要在生产跑免登录模式
  // (例如前面已有自建的访问认证)时显式设为 true,后果自负。
  ALLOW_NO_AUTH: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

  // ── 飞书通知(出站,可选)────────────────────────────────────────
  // 本服务不持有飞书凭证:推卡片走 feishu-sso 的 POST /api/feishu/notify,
  // 用共享口令 INTERNAL_API_TOKEN 认证。两项都配置才会发通知,否则跳过。
  AUTH_API_BASE: optional(z.string().url()),
  INTERNAL_API_TOKEN: optional(z.string()),
  // 通知卡片里深链的公开访问基址(用户点卡片打开的地址)。
  WEB_PUBLIC_URL: z.string().default('http://localhost:5070'),

  // 原件、渲染页图、SQLite 库的落地根目录。
  DATA_DIR: z.string().default('./data'),

  // ── LLM ────────────────────────────────────────────────────────────
  // 通道与模型按用途(解析 / 粗评 / 精评)取:LLM_<用途>_PROVIDER / _MODEL 优先,
  // 否则用全局 LLM_PROVIDER / LLM_MODEL。可选通道与各自需要的配置见 resolveLlmConfig。
  LLM_PROVIDER: z.string().default('claude'),
  LLM_MODEL: optional(z.string()),
  LLM_PARSE_PROVIDER: optional(z.string()),
  LLM_PARSE_MODEL: optional(z.string()),
  LLM_SCREEN_PROVIDER: optional(z.string()),
  LLM_SCREEN_MODEL: optional(z.string()),
  LLM_DEEP_PROVIDER: optional(z.string()),
  LLM_DEEP_MODEL: optional(z.string()),
  // claude CLI 可执行文件路径。留空则从 PATH 找 `claude`。
  CLAUDE_BIN: optional(z.string()),
  // 各通道的 key 与地址。只有被选中的通道才要求配置。
  ANTHROPIC_API_KEY: optional(z.string()),
  ANTHROPIC_BASE_URL: optional(z.string().url()),
  OPENAI_API_KEY: optional(z.string()),
  OPENAI_BASE_URL: optional(z.string().url()),
  ARK_API_KEY: optional(z.string()),
  QWEN_API_KEY: optional(z.string()),
  DEEPSEEK_API_KEY: optional(z.string()),
  ZHIPU_API_KEY: optional(z.string()),
  KIMI_API_KEY: optional(z.string()),
  MINIMAX_API_KEY: optional(z.string()),

  // ── PDF 渲染(poppler)────────────────────────────────────────────
  // 输出长边像素上限。**刻意用 -scale-to 而不是 -r DPI**:两者互斥,而 -r 是按
  // DPI × 页面物理尺寸出图 —— PDF 规范允许 MediaBox 到 200×200 英寸,
  // 一页就是 30000×30000px ≈ 3.6GB 位图,而文件本身可以只有几十 KB。
  // -scale-to 直接封顶输出像素,与页面物理尺寸无关。A4 下约 1558×2200。
  RESUME_RENDER_LONG_EDGE: z.coerce.number().default(2200),
  // 单份简历渲染页数上限。超出的多是作品集,只渲前 N 页并提示。
  RESUME_MAX_PAGES: z.coerce.number().default(20),
  // 单份渲染硬超时。到点 SIGKILL【整个进程组】—— SIGTERM 对卡死的渲染进程未必有效。
  RESUME_RENDER_TIMEOUT_MS: z.coerce.number().default(60_000),
})

const raw = Env.parse(process.env)

/**
 * 生产配置自检。**占位符直接拒绝启动,不是打个警告。**
 *
 * 配了 AUTH_API_BASE(要发通知)却没换掉占位口令时,失败是静默的:服务照常启动,
 * 只是飞书通知悄悄不工作,要等 HR 问「怎么没收到卡片」才发现。
 * 服务最清楚自己需要哪些配置,启动时自检是唯一绕不开的位置。
 */
/** 导出仅为可测:模块顶层的守卫一旦 throw 就整个 import 失败,
 *  测试没法在那种状态下断言「它到底拦没拦住」。 */
export function assertProductionConfig(e: {
  NODE_ENV: string
  WHOAMI_URL?: string | undefined
  ALLOW_NO_AUTH?: boolean
  AUTH_API_BASE?: string | undefined
  INTERNAL_API_TOKEN?: string | undefined
}): void {
  if (e.NODE_ENV !== 'production') return
  // 本地模式不鉴权、所有人都是超管,唯一的防线是只监听 127.0.0.1。而部署模板正是同机
  // nginx 从 127.0.0.1 反代过来 —— 不配登录就上线 = 全部简历对能访问网页的人公开。
  if (!e.WHOAMI_URL && !e.ALLOW_NO_AUTH) {
    throw new Error(
      '[resume-api] 生产配置不完整,拒绝启动:\n' +
      '  - 未配置 WHOAMI_URL(登录)。免登录模式下任何能打开网页的人都是超级管理员,能看到全部简历。\n' +
      '  (接入登录见 README「可选:飞书登录与权限」;确实要免登录运行时设置 ALLOW_NO_AUTH=true)',
    )
  }
  if (!e.AUTH_API_BASE) return
  const token = e.INTERNAL_API_TOKEN
  // `__` 开头视为占位符。按前缀判而不是穷举字面量 —— 否则换个写法又能绕过去。
  if (!token || token.startsWith('__')) {
    throw new Error(
      '[resume-api] 生产配置不完整,拒绝启动:\n' +
      '  - 已配置 AUTH_API_BASE,但 INTERNAL_API_TOKEN 为空或仍是占位符。' +
      '它的值必须与 feishu-sso 的 .env.prod 里的 INTERNAL_API_TOKEN 完全相同,否则飞书通知会静默失效。\n' +
      '  (改 api/.env.prod 后重启;不需要通知时删掉 AUTH_API_BASE 即可)',
    )
  }
}
assertProductionConfig(raw)

export const env = {
  ...raw,
  /** 归一化后的超管手机号集合 */
  ADMIN_MOBILES: new Set(raw.ADMIN_MOBILES.split(',').map((p) => normPhone(p)).filter(Boolean)),
  // 统一成绝对路径:队列 worker、渲染子进程、静态文件服务三处都要用它。
  // 尤其是喂图给 claude 时 provider 会把 cwd 改成图片目录 —— 相对路径在那之后必然解错。
  DATA_DIR: resolve(raw.DATA_DIR),
}
export type Env = typeof env
