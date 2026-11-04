import { describe, expect, it } from 'vitest'
import { buildEvalDoneCard, buildParseDoneCard } from './cards.js'
import { isPushable } from './gateway.js'

/** 从卡片里把所有 plain_text 文案抠出来,便于断言。 */
function texts(card: unknown): string {
  return JSON.stringify(card)
}

describe('buildParseDoneCard', () => {
  it('全部成功 → 蓝色头,不提失败', () => {
    const c = buildParseDoneCard({ total: 12, parsed: 12, failed: 0, injectionSuspected: 0, jobUrl: 'https://x/resume/' }) as {
      header: { template: string }
    }
    expect(c.header.template).toBe('blue')
    expect(texts(c)).toContain('12 份简历解析完成')
    expect(texts(c)).not.toContain('解析失败')
  })

  // 失败要单独成句而不是混在一行里 —— 混着写容易被扫过去,而失败那几份
  // 需要人去看一眼(原件仍在,可重试或粘贴补录)。
  it('有失败 → 橙色头,并单独说明', () => {
    const c = buildParseDoneCard({ total: 12, parsed: 10, failed: 2, injectionSuspected: 0, jobUrl: 'https://x/resume/' }) as {
      header: { template: string }
    }
    expect(c.header.template).toBe('orange')
    expect(texts(c)).toContain('2 份解析失败')
    expect(texts(c)).toContain('原件已保留')
  })

  // 解析自动、评估手动。通知里要说清楚,否则 HR 会以为分析也跑完了。
  it('提示「不会自动分析」', () => {
    const c = buildParseDoneCard({ total: 3, parsed: 3, failed: 0, injectionSuspected: 0, jobUrl: 'https://x/resume/' })
    expect(texts(c)).toContain('不会自动分析')
  })

  // 检出了却只在详情页角落显示,等于没检出 —— HR 不会为了看这个逐个点开。
  it('检出疑似注入 → 橙色头 + 单独说明,且明确「已照常分析」', () => {
    const c = buildParseDoneCard({
      total: 5, parsed: 5, failed: 0, injectionSuspected: 1, jobUrl: 'https://x/resume/',
    }) as { header: { template: string } }
    expect(c.header.template).toBe('orange')
    expect(texts(c)).toContain('1 份含疑似操纵评估的内容')
    // 措辞必须中性且说清没拦:简历里写提示词的 AI 从业者是正常候选人,
    // 让 HR 以为「系统已经拦了」会导致他们直接跳过这个人。
    expect(texts(c)).toContain('已照常分析')
  })
})

describe('buildEvalDoneCard', () => {
  it('带档位分布,只列有人的档', () => {
    const c = buildEvalDoneCard({
      jobTitle: '高级后端开发工程师', total: 7, done: 7, failed: 0,
      grades: { A: 2, B: 5 }, jobUrl: 'https://x/resume/?job=1',
    })
    const s = texts(c)
    expect(s).toContain('高级后端开发工程师')
    expect(s).toContain('A 档 2 人 · B 档 5 人')
    expect(s).not.toContain('C 档')
    expect(s).not.toContain('D 档')
  })

  //辅助参考、人工决策。通知是最容易被当成结论的地方,必须写明。
  it('写明「仅供参考」', () => {
    const c = buildEvalDoneCard({
      jobTitle: 'X', total: 1, done: 1, failed: 0, grades: { A: 1 }, jobUrl: 'https://x/',
    })
    expect(texts(c)).toContain('仅供参考')
  })

  it('深链带上 jobId', () => {
    const c = buildEvalDoneCard({
      jobTitle: 'X', total: 1, done: 1, failed: 0, grades: {}, jobUrl: 'https://x/resume/?job=abc',
    })
    expect(texts(c)).toContain('?job=abc')
  })
})

describe('卡片语言跟随发起人的界面语言', () => {
  const parse = { total: 3, parsed: 2, failed: 1, injectionSuspected: 1, jobUrl: 'https://x/' }
  const evalS = { jobTitle: 'Senior Backend Engineer', total: 1, done: 1, failed: 0, grades: { A: 1 }, jobUrl: 'https://x/?job=1' }
  it('缺省与 zh 完全一致(加语言切换前的中文卡片)', () => {
    expect(buildParseDoneCard(parse, 'zh')).toEqual(buildParseDoneCard(parse))
    expect(buildEvalDoneCard(evalS, 'zh')).toEqual(buildEvalDoneCard(evalS))
  })
  it('en:整张卡片没有中文,单复数正确,链接与颜色不变', () => {
    const p = buildParseDoneCard(parse, 'en')
    const e = buildEvalDoneCard(evalS, 'en')
    for (const c of [p, e]) expect(texts(c)).not.toMatch(/[一-龥]/)
    expect(texts(p)).toContain('3 resumes parsed.')
    expect(texts(e)).toContain('Senior Backend Engineer\\": 1 resume analyzed.')
    expect(texts(e)).toContain('Grade A: 1')
    expect(texts(e)).toContain('for reference only')
    expect(texts(p)).toContain('orange')
    expect(texts(e)).toContain('https://x/?job=1')
  })
})

describe('isPushable', () => {
  // 飞书只按 open_id 投递。别的来源的 ssoId 推不动,直接跳过而不是报错。
  it('只有 ou_ 开头的 open_id 能推', () => {
    expect(isPushable('ou_abc123')).toBe(true)
    expect(isPushable('some-uuid')).toBe(false)
    expect(isPushable(null)).toBe(false)
    expect(isPushable(undefined)).toBe(false)
  })
})
