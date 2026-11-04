// 后端返回的固定值(中文标准值 / 代码值)→ 界面显示。只做显示映射,未知值原样显示。
import type { Lang, MessageKey, TFunction } from '@/i18n'

/** 简历解析出的学历原文 → 字典 key。中文界面原样显示,只有英文界面翻译。 */
const DEGREE_KEYS: Record<string, MessageKey> = {
  '博士': 'degree.doctor', '博士研究生': 'degree.doctor',
  '硕士': 'degree.master', '硕士研究生': 'degree.master', '研究生': 'degree.master',
  '本科': 'degree.bachelor', '学士': 'degree.bachelor',
  '大专': 'degree.associate', '专科': 'degree.associate',
  '中专': 'degree.technical', '高中': 'degree.highSchool',
}

export function degreeLabel(raw: string | null, lang: Lang, t: TFunction): string {
  if (!raw) return ''
  if (lang === 'zh') return raw
  const key = DEGREE_KEYS[raw.trim()]
  return key ? t(key) : raw
}

/** HR 结论 pass / reject / hold。未知值原样显示。 */
export function decisionLabel(v: string, t: TFunction): string {
  switch (v) {
    case 'pass': return t('decision.pass')
    case 'reject': return t('decision.reject')
    case 'hold': return t('decision.hold')
    default: return v
  }
}

/** 评估档位 screen / deep。 */
export function tierLabel(v: string, t: TFunction): string {
  return v === 'deep' ? t('tier.deep') : v === 'screen' ? t('tier.screen') : v
}

/** 门槛判定方式 code / llm。 */
export function judgedByLabel(v: string, t: TFunction): string {
  return v === 'code' ? t('judged.code') : v === 'llm' ? t('judged.llm') : v
}

/** 精评倾向 stance。未知值原样显示。 */
export function stanceLabel(v: string, t: TFunction): string {
  switch (v) {
    case 'recommend': return t('stance.recommend')
    case 'lean_recommend': return t('stance.lean_recommend')
    case 'lean_pass': return t('stance.lean_pass')
    case 'pass': return t('stance.pass')
    default: return v
  }
}

/** 相对中位数。 */
export function vsMedianLabel(v: string, t: TFunction): string {
  return v === 'above' ? t('median.above') : v === 'below' ? t('median.below') : t('median.equal')
}

/** 岗位状态 open / paused / closed。 */
export function jobStatusLabel(v: string, t: TFunction): string {
  return v === 'paused' ? t('jobStatus.paused') : v === 'closed' ? t('jobStatus.closed') : t('jobStatus.open')
}

/**
 * 团队名。api 空库启动时自动建的「默认团队」(ownerId 为 system)按语言显示;
 * 岗位里嵌套的 team 只有 id / name(没有 ownerId),此时只按名字判断。其他团队名原样显示。
 */
export function teamName(team: { name: string; ownerId?: string | null }, t: TFunction): string {
  const isDefault = team.name === '默认团队' && (team.ownerId === undefined || team.ownerId === 'system')
  return isDefault ? t('team.default') : team.name
}

/**
 * 重复候选人提示的命中依据。后端存的是中文整句(api/src/services/dedup/match.ts:
 * 「同校同届:学校」「同公司同期:公司」),这里按前缀换成当前语言;其他原样显示。
 */
const DUP_PREFIX: Array<[string, MessageKey]> = [
  ['同校同届:', 'candidate.dup.sameSchool'],
  ['同公司同期:', 'candidate.dup.sameCompany'],
]
export function dupFieldLabel(raw: string, t: TFunction): string {
  for (const [prefix, key] of DUP_PREFIX) {
    if (raw.startsWith(prefix)) return t(key, { name: raw.slice(prefix.length) })
  }
  return raw
}

/**
 * 技能受控词表(shared/src/skills.ts)里的中文词条 → 英文。库里存的是词表原名,
 * 只在英文界面换成英文;词表新增中文词条时这里同步补(values.test.ts 校验)。
 */
export const SKILL_EN: Record<string, string> = {
  '微信小程序': 'WeChat Mini Programs', '阿里云': 'Alibaba Cloud', '腾讯云': 'Tencent Cloud', '华为云': 'Huawei Cloud',
  'LLM 微调': 'LLM fine-tuning', '向量数据库': 'Vector databases', '性能测试': 'Performance testing', '自动化测试': 'Test automation',
  '微服务': 'Microservices', '分布式系统': 'Distributed systems', '高并发': 'High concurrency', '高可用': 'High availability',
  '事件驱动': 'Event-driven architecture', '服务治理': 'Service governance', '多活容灾': 'Multi-active disaster recovery',
  '性能优化': 'Performance optimization', '可观测性': 'Observability', '敏捷开发': 'Agile development',
  '技术管理': 'Engineering management', '团队管理': 'Team management',
}

export function skillLabel(name: string, lang: Lang): string {
  return lang === 'en' ? (SKILL_EN[name] ?? name) : name
}

/**
 * 本地单用户模式下唯一的用户,名字由 auth-core 的 LOCAL_USER 写死为「本地用户」,按语言显示。
 * 成员接口返回的是库里的 id(不是 local),所以按「本地模式 + 名字」判断。
 */
export function userName(name: string, isLocal: boolean, t: TFunction): string {
  return isLocal && name === '本地用户' ? t('user.local') : name
}
