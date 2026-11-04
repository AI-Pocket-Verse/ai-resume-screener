import { describe, expect, it } from 'vitest'
import type { Gate, ResumeExtraction } from '@ai-resume-screener/shared'
import { degreeRank, judgeStructuredGates } from './gates.js'
import { mergeResume } from './merge.js'

const NOW = new Date(Date.UTC(2026, 5, 15))

function resume(over: Partial<ResumeExtraction> = {}): ResumeExtraction {
  return {
    basic: {
      name: '张三', phone: null, email: null, city: '深圳市南山区',
      expectedTitle: null, expectedSalary: null, summary: null,
    },
    education: [], work: [], project: [], skill: [], cert: [],
    injectionSuspected: false, injectionEvidence: null,
    ...over,
  }
}

const merged = (over?: Partial<ResumeExtraction>) => mergeResume(resume(over), {}, NOW)

describe('degreeRank', () => {
  it('归一化各种学历表述', () => {
    expect(degreeRank('本科')).toBe(3)
    expect(degreeRank('大学本科')).toBe(3)
    expect(degreeRank('硕士研究生')).toBe(4)
    expect(degreeRank('博士')).toBe(5)
    expect(degreeRank('大专')).toBe(2)
    expect(degreeRank(null)).toBeNull()
    expect(degreeRank('不知道什么学位')).toBeNull()
  })
})

describe('结构化门槛 · 学历', () => {
  const g: Gate = { key: 'degree', label: '本科及以上', field: 'degree', op: 'gte', value: 'bachelor' }

  // 简历的 education[] 可能按时间正序也可能倒序。取第一条会随排序方式
  // 给出不同结论 —— 必须取最高的那条。
  it('取最高学历,不是第一条', () => {
    const m = merged({
      education: [
        { school: 'A', major: null, degree: '大专', fullTime: null, start: null, end: null },
        { school: 'B', major: null, degree: '硕士', fullTime: null, start: null, end: null },
      ],
    })
    const { results } = judgeStructuredGates([g], m)
    expect(results[0]!.pass).toBe(true)
    expect(results[0]!.reason).toContain('硕士')
  })

  it('低于要求 → false', () => {
    const m = merged({
      education: [{ school: 'A', major: null, degree: '大专', fullTime: null, start: null, end: null }],
    })
    expect(judgeStructuredGates([g], m).results[0]!.pass).toBe(false)
  })

  it('没写学历 → unknown,不是 false', () => {
    expect(judgeStructuredGates([g], merged()).results[0]!.pass).toBe('unknown')
  })

  // 实测回归:让模型按 JD 生成评分卡时,「本科及以上」它写成的是
  // `op:"in", value:["本科","硕士","博士"]` —— 这是招聘里最自然的表达。
  // 而原实现只处理 gte/lte/eq,in 落到 eq 且 Number(数组) = NaN,
  // 于是**硕士、本科、大专全部判 false**,合格的人被静默挡在门外。
  describe('op=in(「本科及以上」的自然写法)', () => {
    const gIn: Gate = {
      key: 'degree', label: '本科及以上学历', field: 'degree',
      op: 'in', value: ['本科', '硕士', '博士'],
    }
    const withDegree = (degree: string) => merged({
      education: [{ school: 'A', major: null, degree, fullTime: null, start: null, end: null }],
    })

    it('本科 → 通过', () => {
      expect(judgeStructuredGates([gIn], withDegree('本科')).results[0]!.pass).toBe(true)
    })
    it('硕士 → 通过', () => {
      expect(judgeStructuredGates([gIn], withDegree('硕士')).results[0]!.pass).toBe(true)
    })
    it('大专 → 不通过', () => {
      expect(judgeStructuredGates([gIn], withDegree('大专')).results[0]!.pass).toBe(false)
    })
    // 列表漏写「博士」是很容易发生的。按【列表最低档及以上】判,
    // 而不是严格集合包含,博士才不会被误判。
    it('列表里漏写的更高学历也算通过', () => {
      const gShort: Gate = { ...gIn, value: ['本科', '硕士'] } as Gate
      expect(judgeStructuredGates([gShort], withDegree('博士')).results[0]!.pass).toBe(true)
    })
  })

  // 门槛配错时必须能看出来,不能默默判 false 把人挡在门外。
  it('门槛的学历要求无法识别 → unknown', () => {
    const bad: Gate = { key: 'degree', label: '学历', field: 'degree', op: 'gte', value: 3 }
    const m = merged({
      education: [{ school: 'A', major: null, degree: '本科', fullTime: null, start: null, end: null }],
    })
    const r = judgeStructuredGates([bad], m).results[0]!
    expect(r.pass).toBe('unknown')
    expect(r.reason).toContain('无法识别')
  })
})

describe('结构化门槛 · 年限', () => {
  const g: Gate = { key: 'years', label: '3 年以上', field: 'derived.totalYears', op: 'gte', value: 3 }
  const work = (start: string, end: string) => ({
    company: 'C', title: null, department: null,
    responsibilities: [], achievements: [], start, end,
  })

  it('够年限 → true', () => {
    const { results } = judgeStructuredGates([g], merged({ work: [work('2020-01', '2024-01')] }))
    expect(results[0]!.pass).toBe(true)
    expect(results[0]!.judgedBy).toBe('code')
  })

  it('不够 → false', () => {
    const { results } = judgeStructuredGates([g], merged({ work: [work('2024-01', '2025-01')] }))
    expect(results[0]!.pass).toBe(false)
  })

  // 这是本模块最重要的一条:totalYears 为 null 表示「算不出来」(纯项目制简历、
  // work 缺起始日期)。判 false 会把这批人一刀切掉,而他们恰恰最该人工看一眼。
  it('年限算不出来 → unknown,不是 false', () => {
    const { results } = judgeStructuredGates([g], merged())
    expect(results[0]!.pass).toBe('unknown')
    expect(results[0]!.reason).toContain('无法确定')
  })

  it('年份精度时在理由里标注是估算', () => {
    const { results } = judgeStructuredGates([g], merged({ work: [work('2018', '2024')] }))
    expect(results[0]!.reason).toContain('保守估算')
  })
})

describe('结构化门槛 · 地点', () => {
  const g: Gate = { key: 'loc', label: '深圳或远程', field: 'basic.city', op: 'in', value: ['深圳', '远程'] }

  // 简历常写「深圳市南山区」,门槛写「深圳」。全等匹配会误判为不通过。
  it('包含匹配,不是全等', () => {
    expect(judgeStructuredGates([g], merged()).results[0]!.pass).toBe(true)
  })

  it('不在列表内 → false', () => {
    const m = merged({ basic: { ...resume().basic, city: '哈尔滨' } })
    expect(judgeStructuredGates([g], m).results[0]!.pass).toBe(false)
  })
})

describe('自然语言门槛', () => {
  it('不由代码判,原样交给 prompt', () => {
    const gates: Gate[] = [
      { key: 'saas', label: 'B 端经验', nl: '有 B 端 SaaS 从 0 到 1 经验' },
      { key: 'years', label: '3 年', field: 'derived.totalYears', op: 'gte', value: 3 },
    ]
    const { results, nlGates } = judgeStructuredGates(gates, merged())
    expect(results).toHaveLength(1)
    expect(nlGates).toHaveLength(1)
    expect(nlGates[0]).toMatchObject({ key: 'saas' })
  })
})

describe('mergeResume', () => {
  // 不合并的话,HR 在核对环节做的修正对打分毫无影响,editedFields 就成了
  // 只服务于统计的孤儿产物。
  it('人工修正覆盖 raw', () => {
    const m = mergeResume(resume(), { basic: { ...resume().basic, city: '北京' } }, NOW)
    expect(m.data.basic.city).toBe('北京')
  })

  // 改了日期而年限不变的话,「按年限判门槛」还是用旧值,人工修正等于白做。
  it('derived 按合并后的数据【重算】', () => {
    const raw = resume({
      work: [{ company: 'C', title: null, department: null, responsibilities: [], achievements: [], start: '2024-01', end: '2025-01' }],
    })
    const edited = {
      work: [{ company: 'C', title: null, department: null, responsibilities: [], achievements: [], start: '2015-01', end: '2025-01' }],
    }
    expect(mergeResume(raw, {}, NOW).derived.totalYears).toBe(1)
    expect(mergeResume(raw, edited, NOW).derived.totalYears).toBe(10)
  })
})
