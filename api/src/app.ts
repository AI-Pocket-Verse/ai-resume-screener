import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import Fastify, { LogController } from 'fastify'

import apiKit, { createLogger } from '@ai-resume-screener/api-kit'
import authPlugin from '@ai-resume-screener/auth-client-api'

import { env } from './env.js'
import { initDb } from './db.js'
import { candidateRoutes } from './routes/candidates.js'
import { evaluationRoutes } from './routes/evaluations.js'
import { fileRoutes } from './routes/files.js'
import { jobRoutes } from './routes/jobs.js'
import { MAX_RESUME_BYTES } from './services/file-store.js'

export interface BuildAppOptions {
  /** 覆盖 auth 插件调 whoami 用的 fetch。**仅供测试** —— 授权分档是安全边界,
   *  必须能在测试里以「某个具体用户」的身份打进来验证,否则只能靠人工核对
   *  每条路由挂没挂 preHandler。auth-client-api 自己就留了这个注入点。 */
  authFetch?: typeof fetch
}

/** 构建 Fastify 实例但**不** listen —— 与入口分离,好让测试用 app.inject() 驱动。 */
export async function buildApp(opts?: BuildAppOptions) {
  // trustProxy:生产走 nginx 反代,不信任的话 req.ip 对所有人恒等于 127.0.0.1,
  // 限流的「按 IP 分桶」退化成全公司共用一个桶。但不能无条件 true:那样任何客户端
  // 都能伪造 X-Forwarded-For 绕过限流。只信任 TRUST_PROXY 指定的反代(默认本机回环),
  // 并配合 nginx 用 `X-Forwarded-For $remote_addr`(覆盖而非追加)。
  // 日志:复用 api-kit 的 pino(已脱敏 cookie / token)。关掉逐请求日志 —— 请求行里的
  // query 可能带姓名(如 /api/users?q=),简历相关内容一律不进日志。测试里静默。
  const app = Fastify({
    loggerInstance: createLogger({ service: 'resume-api', ...(env.NODE_ENV === 'test' ? { level: 'fatal' as const } : {}) }),
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: env.TRUST_PROXY,
  })

  // 接口返回的都是按人可见的简历数据:禁止浏览器与中间代理缓存,
  // 免得换人登录同一台电脑、或经过共享代理时读到上一个人的结果。
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store')
  })

  // 本地单用户模式不鉴权,只能靠「只有本机能连上」兜底。DNS rebinding 可以让任意网页
  // 以同源身份请求 127.0.0.1,所以还要校验 Host:只放行本机名和 WEB_PUBLIC_URL 的主机名。
  if (!env.WHOAMI_URL) {
    const allowed = localModeHosts()
    app.addHook('onRequest', async (req, reply) => {
      const host = hostnameOf(req.headers.host)
      if (!host || !allowed.has(host)) {
        return reply.code(421).send({ code: 'host_not_allowed', message: '本地模式只接受本机访问' })
      }
    })
  }

  await app.register(cors, { origin: env.WEB_ORIGIN || false, credentials: true })
  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    // 按登录身份分桶比按 IP 准确:同一间办公室出口 IP 相同,而我们要限的是
    // 单个账号的滥用,不是整个办公室。
    keyGenerator: (req) => req.user?.id ?? req.ip,
  })
  await app.register(multipart, { limits: { fileSize: MAX_RESUME_BYTES, files: 1 } })
  await app.register(apiKit, { service: 'resume-api', version: '0.0.0' })
  // 简历含个人信息,所有业务路由都挂 requireAuth,没有 publicAccess 例外。
  // 未配置 WHOAMI_URL 时是本地单用户模式,所有请求都是 LOCAL_USER。
  await app.register(authPlugin, {
    whoamiUrl: env.WHOAMI_URL,
    ...(opts?.authFetch ? { fetchImpl: opts.authFetch } : {}),
  })

  await app.register(fileRoutes)
  await app.register(jobRoutes)
  await app.register(evaluationRoutes)
  await app.register(candidateRoutes)

  await initDb()
  return app
}

/** 本地模式允许的 Host:本机回环 + WEB_PUBLIC_URL / WEB_ORIGIN 的主机名(ALLOW_NO_AUTH 时经反代访问用)。 */
function localModeHosts(): Set<string> {
  const hosts = new Set(['localhost', '127.0.0.1', '::1'])
  for (const u of [env.WEB_PUBLIC_URL, env.WEB_ORIGIN]) {
    try { hosts.add(new URL(u).hostname.replace(/^\[|\]$/g, '')) } catch { /* 非法 URL 不放行 */ }
  }
  return hosts
}

/** 从 Host 头取主机名(去端口、去 IPv6 方括号),统一小写。 */
export function hostnameOf(host: string | undefined): string | null {
  if (!host) return null
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return null
  }
}
