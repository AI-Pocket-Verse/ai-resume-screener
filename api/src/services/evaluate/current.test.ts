import { describe, expect, it } from 'vitest'
import { pickCurrent, sortByVerdict, type EvaluationRow } from './current.js'

const row = (over: Partial<EvaluationRow> & { tier: string }): EvaluationRow => ({
  id: Math.random().toString(36).slice(2),
  grade: 'B', weightedScore: 75, createdAt: new Date('2026-01-01'),
  ...over,
})

describe('pickCurrent', () => {
  it('没有评估 → null', () => {
    expect(pickCurrent([])).toBeNull()
  })

  it('只有粗评 → 取粗评', () => {
    const v = pickCurrent([row({ tier: 'screen', grade: 'A' })])!
    expect(v.source).toBe('screen')
    expect(v.grade).toBe('A')
  })

  // 精评是「更可靠的判断」,这正是 HR 点它的原因。就算之后又跑了一次粗评
  // (比如改完评分卡批量重跑),那次也不该把精评结论盖掉 —— 所以不能跨 tier
  // 比 createdAt。
  it('精评存在就以精评为准,哪怕粗评更新', () => {
    const v = pickCurrent([
      row({ tier: 'deep', grade: 'B', createdAt: new Date('2026-01-01') }),
      row({ tier: 'screen', grade: 'A', createdAt: new Date('2026-06-01') }),
    ])!
    expect(v.source).toBe('deep')
    expect(v.grade).toBe('B')
  })

  it('同 tier 内取最新一条', () => {
    const v = pickCurrent([
      row({ tier: 'screen', grade: 'C', createdAt: new Date('2026-01-01') }),
      row({ tier: 'screen', grade: 'A', createdAt: new Date('2026-06-01') }),
    ])!
    expect(v.grade).toBe('A')
  })

  // 档位不能莫名其妙地变。UI 要能显示「B · 深度分析后(粗评为 A)」。
  it('精评改变了档位 → 带出被覆盖的粗评供 UI 解释', () => {
    const v = pickCurrent([
      row({ tier: 'screen', grade: 'A' }),
      row({ tier: 'deep', grade: 'B' }),
    ])!
    expect(v.supersededScreen?.grade).toBe('A')
  })

  it('精评与粗评档位相同 → 不提示(没有需要解释的变化)', () => {
    const v = pickCurrent([
      row({ tier: 'screen', grade: 'B' }),
      row({ tier: 'deep', grade: 'B' }),
    ])!
    expect(v.supersededScreen).toBeNull()
  })
})

describe('sortByVerdict', () => {
  const item = (grade: string | null, score: number | null) => ({
    verdict: pickCurrent([row({ tier: 'screen', grade, weightedScore: score })]),
  })

  it('先按档位分组,组内按分降序', () => {
    const sorted = sortByVerdict([item('B', 72), item('A', 86), item('A', 95), item('C', 60)])
    expect(sorted.map((s) => [s.verdict!.grade, s.verdict!.current.weightedScore])).toEqual([
      ['A', 95], ['A', 86], ['B', 72], ['C', 60],
    ])
  })

  it('未分析的排在最后', () => {
    const sorted = sortByVerdict([{ verdict: null }, item('D', 30)])
    expect(sorted[0]!.verdict).not.toBeNull()
    expect(sorted[1]!.verdict).toBeNull()
  })
})
