import { createHash } from 'node:crypto'

// 联系方式归一化。**不做的话命中率大跌** —— 同一个人用「+86 138-0013-8001」
// 和「13800138001」投两次,不归一就是两个候选人,而去重的全部价值建立在「查得到」上。

/** 手机号:去国际区号、空格、横线、括号。只保留数字。 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[\s\-()（）]/g, '').replace(/^\+?86/, '')
  // 中国大陆手机号 11 位且以 1 开头。不符合的(座机、工号、写错的)不作为去重键 ——
  // 宁可漏合并,也不能把两个不同的人合成一个:合错了要人工拆,而漏了只是多一条记录。
  return /^1\d{10}$/.test(digits) ? digits : null
}

/**
 * 邮箱:转小写;Gmail 的 `.` 与 `+suffix` 归一。
 *
 * Gmail 把 `zhang.san@gmail.com` 和 `zhangsan+job@gmail.com` 视为同一个信箱,
 * 求职者也确实会用 `+公司名` 来区分投递。但**只对 gmail 系做这个归一** ——
 * 别家域名的 `.` 是有意义的(`zhang.san@` 和 `zhangsan@` 可能是两个人)。
 */
export function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase()
  const m = /^([^@\s]+)@([^@\s]+\.[^@\s]+)$/.exec(trimmed)
  if (!m) return null
  let [, local, domain] = m as unknown as [string, string, string]
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.split('+')[0]!.replace(/\./g, '')
    domain = 'gmail.com'
  } else {
    local = local.split('+')[0]!
  }
  return local ? `${local}@${domain}` : null
}

export function hashIdentifier(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex')
}

export interface NormalizedIdentifier {
  kind: 'phone' | 'email'
  valueHash: string
  valueEnc: string
}

/** 从解析结果里抽出可用于去重的联系方式。归一化失败的直接丢弃(不作为去重键),
 *  但**原始值仍然存在 ResumeParsed.raw 里**,不影响展示。 */
export function collectIdentifiers(basic: { phone?: string | null; email?: string | null }): NormalizedIdentifier[] {
  const out: NormalizedIdentifier[] = []
  if (basic.phone) {
    const p = normalizePhone(basic.phone)
    if (p) out.push({ kind: 'phone', valueHash: hashIdentifier(p), valueEnc: basic.phone })
  }
  if (basic.email) {
    const e = normalizeEmail(basic.email)
    if (e) out.push({ kind: 'email', valueHash: hashIdentifier(e), valueEnc: basic.email })
  }
  return out
}
