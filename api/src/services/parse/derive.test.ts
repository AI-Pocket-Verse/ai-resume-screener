import { describe, expect, it } from 'vitest'
import type { ResumeExtraction, Work } from '@ai-resume-screener/shared'
import { deriveFields } from './derive.js'

// 固定「现在」,否则含 present 的用例会随真实时间漂移。
const NOW = new Date(Date.UTC(2026, 5, 15)) // 2026-06

const emptyBasic = {
  name: null, phone: null, email: null, city: null,
  expectedTitle: null, expectedSalary: null, summary: null,
}

function ex(work: Partial<Work>[]): ResumeExtraction {
  return {
    basic: emptyBasic,
    education: [],
    work: work.map((w) => ({
      company: 'C', title: null, department: null,
      responsibilities: [], achievements: [],
      start: null, end: null, ...w,
    })),
    project: [], skill: [], cert: [],
    injectionSuspected: false, injectionEvidence: null,
  }
}

describe('deriveFields · 年限', () => {
  it('单段月精度', () => {
    const d = deriveFields(ex([{ start: '2020-01', end: '2023-01' }]), NOW)
    expect(d.totalYears).toBe(3)
    expect(d.totalYearsEstimated).toBe(false)
  })

  // 曾经 `end ?? start` 把「至今」当成「干了 0 个月」:11 年经验的在职候选人
  // totalYears 变成 0(不是 null),年限门槛随即判 false 而非 unknown,
  // 直接锁死 C/D 档,而界面上「当前公司」显示正常,完全看不出哪里错了。
  // 模型没按 prompt 填 'present' 而填了 null 就会踩到,zod 也不会拦。
  it('end 为 null 与 present 同义,都算到「现在」', () => {
    const withNull = deriveFields(ex([{ start: '2015-01', end: null }]), NOW)
    const withPresent = deriveFields(ex([{ start: '2015-01', end: 'present' }]), NOW)
    expect(withNull.totalYears).toBe(withPresent.totalYears)
    expect(withNull.totalYears).toBeGreaterThan(11)
  })

  it('present 段算到「现在」', () => {
    const d = deriveFields(ex([{ start: '2024-06', end: 'present' }]), NOW)
    expect(d.totalYears).toBe(2)
  })

  // 重叠去重是本模块最容易出错的地方:兼职/顾问与全职并存时简单相加会把
  // 年限凭空放大一倍,而「年限」正是硬性门槛的判定依据。
  it('重叠区间去重,不是简单相加', () => {
    const d = deriveFields(ex([
      { start: '2020-01', end: '2024-01' }, // 4 年
      { start: '2022-01', end: '2023-01' }, // 完全落在上一段内
    ]), NOW)
    expect(d.totalYears).toBe(4) // 相加会得 5
  })

  it('部分重叠取并集', () => {
    const d = deriveFields(ex([
      { start: '2020-01', end: '2023-01' },
      { start: '2022-01', end: '2025-01' },
    ]), NOW)
    expect(d.totalYears).toBe(5) // 2020-01 → 2025-01
  })

  // 年份精度占实测样本的 10.3%、影响 36% 的简历,是主路径不是边界。
  it('年份精度按保守值估算,并打标', () => {
    // 起始按当年末(2020-12)、结束按当年初(2023-01)→ 约 2.1 年,
    // 而不是乐观的 3 年。宁可低估:高估会把不够年限的人放进门槛。
    const d = deriveFields(ex([{ start: '2020', end: '2023' }]), NOW)
    expect(d.totalYears).toBeCloseTo(2.1, 1)
    expect(d.totalYearsEstimated).toBe(true)
  })

  // 「算不出来」和「零经验」必须可区分:年限是硬门槛的判定依据,
  // 把前者当 0 会让纯项目制简历、只写了实习的应届生全部被一刀切掉。
  it('缺开始时间的段算不出年限 → null,不是 0', () => {
    const d = deriveFields(ex([{ start: null, end: '2023-01' }]), NOW)
    expect(d.totalYears).toBeNull()
  })

  it('work 为空(纯项目制简历)→ null', () => {
    const d = deriveFields(ex([]), NOW)
    expect(d.totalYears).toBeNull()
  })

  it('真的只干过很短时间 → 是 0,不是 null', () => {
    const d = deriveFields(ex([{ start: '2026-05', end: '2026-06' }]), NOW)
    expect(d.totalYears).toBe(0.1)
  })
})

describe('deriveFields · 空窗与均值', () => {
  it('相邻段之间的最大空窗', () => {
    const d = deriveFields(ex([
      { start: '2018-01', end: '2020-01' },
      { start: '2021-01', end: '2023-01' }, // 空窗 12 个月
      { start: '2023-03', end: '2024-01' }, // 空窗 2 个月
    ]), NOW)
    expect(d.maxGapMonths).toBe(12)
  })

  it('重叠的两段不算空窗', () => {
    const d = deriveFields(ex([
      { start: '2020-01', end: '2024-01' },
      { start: '2021-01', end: '2022-01' },
    ]), NOW)
    expect(d.maxGapMonths).toBe(0)
  })

  it('只有一段时空窗为 null(不是 0)', () => {
    const d = deriveFields(ex([{ start: '2020-01', end: '2024-01' }]), NOW)
    expect(d.maxGapMonths).toBeNull()
  })
})

describe('deriveFields · 当前公司', () => {
  it('取 present 段;多段并存取 start 最晚的', () => {
    const d = deriveFields(ex([
      { company: '甲', start: '2019-01', end: 'present' },
      { company: '乙', start: '2022-01', end: 'present' },
    ]), NOW)
    expect(d.currentCompany).toBe('乙')
    expect(d.currentIsPast).toBe(false)
  })

  it('没有 present 时取 end 最晚的,并标记为「上一份」', () => {
    const d = deriveFields(ex([
      { company: '甲', start: '2019-01', end: '2021-01' },
      { company: '乙', start: '2021-02', end: '2023-06' },
    ]), NOW)
    expect(d.currentCompany).toBe('乙')
    expect(d.currentIsPast).toBe(true)
  })

  it('work 为空时返回 null', () => {
    const d = deriveFields(ex([]), NOW)
    expect(d.currentCompany).toBeNull()
    expect(d.currentIsPast).toBe(false)
  })
})

describe('deriveFields · 时间线冲突', () => {
  it('起止倒置', () => {
    const d = deriveFields(ex([{ company: '甲', start: '2023-01', end: '2020-01' }]), NOW)
    expect(d.timelineConflicts.join()).toMatch(/结束时间早于开始时间/)
  })

  it('两段全职重叠超过一个月', () => {
    const d = deriveFields(ex([
      { company: '甲', start: '2020-01', end: '2022-06' },
      { company: '乙', start: '2021-01', end: '2023-01' },
    ]), NOW)
    expect(d.timelineConflicts.join()).toMatch(/时间重叠/)
  })

  it('一个月内的交接期不报冲突', () => {
    const d = deriveFields(ex([
      { company: '甲', start: '2020-01', end: '2022-06' },
      { company: '乙', start: '2022-06', end: '2023-01' },
    ]), NOW)
    expect(d.timelineConflicts.filter((c) => c.includes('重叠'))).toHaveLength(0)
  })
})
