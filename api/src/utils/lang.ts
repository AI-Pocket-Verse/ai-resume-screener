import type { FastifyRequest } from 'fastify'

/** AI 生成内容(评估结论、评分卡草稿)与系统判定说明的语言。 */
export type Lang = 'zh' | 'en'

/**
 * 取请求的界面语言:web 每个请求都带 `X-Lang`。没带或不认识时用中文,
 * 与加语言切换之前的行为一致(脚本、curl 调用不受影响)。
 */
export function requestLang(req: FastifyRequest): Lang {
  return parseLang(req.headers['x-lang'])
}

export function parseLang(v: unknown): Lang {
  const s = Array.isArray(v) ? v[0] : v
  return s === 'en' ? 'en' : 'zh'
}
