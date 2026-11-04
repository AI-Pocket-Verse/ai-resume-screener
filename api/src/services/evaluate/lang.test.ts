import { afterAll, describe, expect, it } from 'vitest'
import { EvaluationOutput, EvaluationOutputEn, type Gate, type ResumeExtraction, type Scorecard } from '@ai-resume-screener/shared'

import { buildApp } from '../../app.js'
import { disconnectDb, prisma } from '../../db.js'
import { parseLang } from '../../utils/lang.js'
import { judgeStructuredGates } from './gates.js'
import { mergeResume } from './merge.js'
import { buildEvalPrompt, buildScorecardDraftPrompt, evalPromptVersion } from './prompt.js'

// AI 生成的结论按「发起时的界面语言」写:中文 prompt 必须与加语言切换前完全一致
// (不改变已有评分口径),英文只在末尾追加语言要求。

const resume: ResumeExtraction = {
  basic: { name: '张三', phone: null, email: null, city: '深圳', expectedTitle: null, expectedSalary: null, summary: null },
  education: [{ school: '示例大学', degree: '本科', major: null, fullTime: null, start: '2014-09', end: '2018-06' }],
  work: [], project: [], skill: [], cert: [],
  injectionSuspected: false, injectionEvidence: null,
}
const merged = mergeResume(resume, {}, new Date(Date.UTC(2026, 5, 15)))
const scorecard: Scorecard = {
  gates: [],
  dimensions: [{ key: 'core', label: '核心能力', weight: 100, anchors: { '5': '强', '3': '中', '1': '弱' } }],
} as Scorecard
const input = { jobTitle: '后端', teamName: '研发', jdSummary: '', scorecard, nlGates: [], resume: merged, tier: 'screen' as const }

describe('评估 prompt 的输出语言', () => {
  it('中文:不带语言要求,与缺省一致', () => {
    const zh = buildEvalPrompt({ ...input, lang: 'zh' })
    expect(zh.systemPrompt).toBe(buildEvalPrompt(input).systemPrompt)
    expect(zh.systemPrompt).not.toContain('English')
  })
  it('英文:system prompt 末尾追加英文输出要求,且要求引用保持原文', () => {
    const zhSys = buildEvalPrompt(input).systemPrompt
    const en = buildEvalPrompt({ ...input, lang: 'en' }).systemPrompt
    expect(en.startsWith(zhSys)).toBe(true)
    expect(en.slice(zhSys.length)).toMatch(/English[\s\S]*不要翻译/)
  })
  it('英文总评长度上限单独放宽,中文 schema 不变', () => {
    // 字符上限按中文定(120),同样篇幅的英文 300 字符上下,沿用会让英文评估反复校验失败
    const zhMsg = buildEvalPrompt(input).userMessage
    const enMsg = buildEvalPrompt({ ...input, lang: 'en' }).userMessage
    expect(zhMsg).toContain('"maxLength":120')
    expect(enMsg).toContain('"maxLength":320')
    expect(buildEvalPrompt({ ...input, tier: 'deep', lang: 'en' }).userMessage).toContain('"maxLength":320')
    const out = { scores: [], summary: 'x'.repeat(300) }
    expect(EvaluationOutput.safeParse(out).success).toBe(false)
    expect(EvaluationOutputEn.safeParse(out).success).toBe(true)
  })
  it('评分卡草稿同样按语言追加', () => {
    expect(buildScorecardDraftPrompt('t', 'jd').systemPrompt).not.toContain('English')
    expect(buildScorecardDraftPrompt('t', 'jd', 'en').systemPrompt).toContain('English')
  })
  it('落库的 prompt 版本区分语言', () => {
    expect(evalPromptVersion('zh')).toBe('v1')
    expect(evalPromptVersion('en')).toBe('v1-en')
  })
})

describe('代码判定的门槛说明随语言', () => {
  const g: Gate = { key: 'degree', label: '本科及以上', field: 'degree', op: 'gte', value: 'bachelor' }
  it('中文缺省', () => {
    expect(judgeStructuredGates([g], merged).results[0]!.reason).toBe('简历最高学历「本科」,要求 本科及以上')
  })
  it('英文', () => {
    expect(judgeStructuredGates([g], merged, 'en').results[0]!.reason).toBe('Highest degree in resume: "本科"; required: 本科及以上')
  })
})

describe('X-Lang 解析', () => {
  it('只认 en,其余一律中文(与加切换前的行为一致)', () => {
    expect(parseLang('en')).toBe('en')
    expect(parseLang(['en'])).toBe('en')
    for (const v of ['zh', 'EN', 'fr', undefined, '']) expect(parseLang(v)).toBe('zh')
  })
})

// 走真实路由:超管身份(手机号在测试 env 的 ADMIN_MOBILES 里)发起评估,看任务记下的语言。
const boss = await buildApp({
  authFetch: (async () => new Response(JSON.stringify({
    authenticated: true,
    user: { id: 'uid-ou_lang', open_id: 'ou_lang', name: 'lang', mobile: '13800138000', last_login_at: new Date(0).toISOString() },
    session: { id: 's', user_id: 'uid-ou_lang', remember_me: false, expires_at: new Date(Date.now() + 86_400_000).toISOString(), last_seen_at: new Date(0).toISOString() },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
})
afterAll(async () => {
  await boss.close()
  await disconnectDb()
})

describe('发起评估时记下界面语言', () => {
  it('X-Lang: en 的请求 → 评估任务 lang=en;不带头 → zh', async () => {
    const stamp = `${Date.now()}-${Math.random()}`
    const team = await prisma.team.create({ data: { name: `lang-team-${stamp}`, ownerId: 'x' } })
    const job = await prisma.job.create({ data: { teamId: team.id, title: 'lang-job', jdRaw: '', createdBy: 'x' } })
    const mk = async () => {
      const c = await prisma.candidate.create({ data: { name: 'x' } })
      return prisma.application.create({ data: { candidateId: c.id, jobId: job.id } })
    }
    const [a1, a2] = [await mk(), await mk()]
    const post = (id: string, headers: Record<string, string>) => boss.inject({
      method: 'POST', url: '/api/evaluations',
      headers: { cookie: 'sso_session=fake', ...headers },
      payload: { applicationIds: [id], tier: 'screen' },
    })
    expect((await post(a1.id, { 'x-lang': 'en' })).statusCode).toBeLessThan(300)
    expect((await post(a2.id, {})).statusCode).toBeLessThan(300)
    expect((await prisma.evalJob.findFirstOrThrow({ where: { applicationId: a1.id } })).lang).toBe('en')
    expect((await prisma.evalJob.findFirstOrThrow({ where: { applicationId: a2.id } })).lang).toBe('zh')
  })
})
