import { describe, expect, it } from 'vitest'
import type { CandidateRow } from './api'
import {
  analyzeTargets, countByFilter, filterRows, isParsing, isUnanalyzed, rowBadges,
} from './list'

function row(over: Partial<CandidateRow> & { applicationId: string }): CandidateRow {
  return {
    candidateId: `c-${over.applicationId}`,
    name: '某某', currentCompany: null, currentIsPast: false, totalYears: null,
    parseState: 'parsed', injectionSuspected: false,
    tags: [], hrDecision: null, analyzing: null, verdict: null,
    ...over,
  }
}

const graded = (id: string, grade: 'A' | 'B' | 'C' | 'D', score = 80) =>
  row({ applicationId: id, verdict: { grade, score, source: 'screen', summary: null, supersededGrade: null } })

describe('isParsing / isUnanalyzed', () => {
  it('解析终态:parsed 与 failed 都不算「进行中」', () => {
    expect(isParsing(row({ applicationId: '1', parseState: 'parsed' }))).toBe(false)
    expect(isParsing(row({ applicationId: '2', parseState: 'failed' }))).toBe(false)
    for (const st of ['pending', 'rendering', 'extracting']) {
      expect(isParsing(row({ applicationId: '3', parseState: st }))).toBe(true)
    }
  })

  // 解析中的混进「未分析」会让「一键分析 N 份」虚高,点下去一部分根本跑不了。
  it('解析中的不算未分析', () => {
    expect(isUnanalyzed(row({ applicationId: '1', parseState: 'pending' }))).toBe(false)
    expect(isUnanalyzed(row({ applicationId: '2', parseState: 'parsed' }))).toBe(true)
  })

  it('解析失败的也不算未分析(它根本分析不了)', () => {
    expect(isUnanalyzed(row({ applicationId: '1', parseState: 'failed' }))).toBe(false)
  })

  it('已有评估 → 不是未分析', () => {
    expect(isUnanalyzed(graded('1', 'B'))).toBe(false)
  })
})

describe('filterRows', () => {
  const rows = [
    graded('a', 'A'), graded('b', 'B'), graded('b2', 'B'),
    row({ applicationId: 'u' }),
    row({ applicationId: 'p', parseState: 'rendering' }),
    row({ applicationId: 'f', parseState: 'failed' }),
  ]

  it('按档位筛', () => {
    expect(filterRows(rows, 'B', '').map((r) => r.applicationId)).toEqual(['b', 'b2'])
  })

  it('未分析 / 解析中互不混淆', () => {
    expect(filterRows(rows, 'unanalyzed', '').map((r) => r.applicationId)).toEqual(['u'])
    expect(filterRows(rows, 'pending', '').map((r) => r.applicationId)).toEqual(['p'])
  })

  it('全部包含解析失败的那条(不能让它消失)', () => {
    expect(filterRows(rows, 'all', '').map((r) => r.applicationId)).toContain('f')
  })

  it('关键词匹配姓名与公司,大小写不敏感', () => {
    const rs = [
      row({ applicationId: '1', name: '测试甲', currentCompany: '深圳示例科技' }),
      row({ applicationId: '2', name: 'Alice', currentCompany: 'Acme Corp' }),
    ]
    expect(filterRows(rs, 'all', '示例').map((r) => r.applicationId)).toEqual(['1'])
    expect(filterRows(rs, 'all', 'acme').map((r) => r.applicationId)).toEqual(['2'])
    expect(filterRows(rs, 'all', '  ').map((r) => r.applicationId)).toEqual(['1', '2'])
  })

  it('关键词与筛选是「且」的关系', () => {
    expect(filterRows(rows, 'B', 'zzz')).toHaveLength(0)
  })
})

describe('countByFilter', () => {
  it('各档计数与总数', () => {
    const c = countByFilter([
      graded('a', 'A'), graded('b', 'B'), graded('b2', 'B'),
      row({ applicationId: 'u' }),
      row({ applicationId: 'p', parseState: 'pending' }),
    ])
    expect(c).toMatchObject({ all: 5, A: 1, B: 2, C: 0, D: 0, unanalyzed: 1, pending: 1 })
  })

  it('空列表全为 0', () => {
    expect(countByFilter([])).toMatchObject({ all: 0, A: 0, unanalyzed: 0, pending: 0 })
  })
})

describe('analyzeTargets', () => {
  const rows = [graded('a', 'A'), row({ applicationId: 'u1' }), row({ applicationId: 'u2' })]

  // 「一键分析」= 分析全部未分析的,不重跑已分析项。
  it('无选中 → 只取未分析的', () => {
    expect(analyzeTargets(rows, new Set())).toEqual(['u1', 'u2'])
  })

  it('有选中 → 以选中为准(允许重跑已分析的)', () => {
    expect(analyzeTargets(rows, new Set(['a']))).toEqual(['a'])
  })

  it('都分析过且没选中 → 空,按钮应置灰', () => {
    expect(analyzeTargets([graded('a', 'A')], new Set())).toEqual([])
  })
})

describe('rowBadges', () => {
  // 档位不能莫名其妙地变 —— 精评覆盖粗评时必须带出解释。
  it('精评改了档位 → 带出粗评', () => {
    const r = row({
      applicationId: '1',
      verdict: { grade: 'B', score: 75, source: 'deep', summary: null, supersededGrade: 'A' },
    })
    expect(rowBadges(r)[0]!.text).toContain('粗评为 A')
  })

  it('分析中与解析中互斥,不会同时出现', () => {
    const r = row({ applicationId: '1', parseState: 'pending', analyzing: 'screen' })
    const texts = rowBadges(r).map((b) => b.text)
    expect(texts).toContain('分析中…')
    expect(texts).not.toContain('解析中…')
  })

  it('深度分析中单独文案', () => {
    const r = row({ applicationId: '1', analyzing: 'deep' })
    expect(rowBadges(r)[0]!.text).toBe('深度分析中…')
  })

  it('解析失败标 error', () => {
    const b = rowBadges(row({ applicationId: '1', parseState: 'failed' }))
    expect(b).toEqual([{ text: '解析失败', tone: 'error' }])
  })

  it('正常已分析 → 无徽标', () => {
    expect(rowBadges(graded('a', 'A'))).toEqual([])
  })

  // 疑似注入必须在列表上就看得见:这条信息的价值恰恰在于「点开之前就该警惕」。
  // 措辞是「请人工核对」而不是「已拦截」—— 流程没有被阻断,简历里写提示词的
  // AI 从业者是正常候选人,说成拦截会让 HR 直接跳过这个人。
  it('疑似注入 → 列表上标红提示人工核对,且不影响档位显示', () => {
    const r = { ...graded('a', 'A'), injectionSuspected: true }
    expect(rowBadges(r)).toEqual([{ text: '含可疑内容，请人工核对', tone: 'error' }])
  })

  it('疑似注入与解析失败可以并存', () => {
    const b = rowBadges(row({ applicationId: '1', parseState: 'failed', injectionSuspected: true }))
    expect(b).toHaveLength(2)
  })
})
