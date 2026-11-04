import { describe, expect, it } from 'vitest'
import type { Dimension, DimensionScore, GateResult } from '@ai-resume-screener/shared'
import { computeGrade, toGrade } from './grade.js'
import { computePeerContext } from './peers.js'

const DIMS: Dimension[] = [
  { key: 'tech', label: '技术栈匹配', weight: 60, anchors: { '5': '', '3': '', '1': '' } },
  { key: 'depth', label: '项目复杂度', weight: 40, anchors: { '5': '', '3': '', '1': '' } },
]

const score = (key: string, s: number): DimensionScore => ({
  key, score: s, reason: 'r', evidence: [{ quote: 'q', section: null }],
})

const gate = (pass: GateResult['pass']): GateResult => ({
  key: 'years', label: '年限', pass, reason: null, evidence: [], judgedBy: 'code',
})

describe('computeGrade', () => {
  // 全部维度都对不上评分卡 = 模型答的和评分卡不是一回事。曾经这里静默返回
  // 0 分 D 档并当成功落库,候选人拿到一个「点开计算过程一片空白」的结论。
  it('维度 key 全对不上 → null(交由调用方当失败重试)', () => {
    expect(computeGrade([score('不存在的', 5)], DIMS, [])).toBeNull()
    expect(computeGrade([], DIMS, [])).toBeNull()
  })

  it('满分 5 分 → 100', () => {
    const r = computeGrade([score('tech', 5), score('depth', 5)], DIMS, [])!
    expect(r.weightedScore).toBe(100)
    expect(r.grade).toBe('A')
  })

  // 1 分锚点是「基本不相关」。若按 score/5 映射,全不相关也能拿 20 分底分,
  // 白白压缩有效区分度 —— 所以用 (score-1)/4。
  it('全 1 分 → 0,不是 20', () => {
    const r = computeGrade([score('tech', 1), score('depth', 1)], DIMS, [])!
    expect(r.weightedScore).toBe(0)
    expect(r.grade).toBe('D')
  })

  it('按权重加权,不是简单平均', () => {
    // tech=5(100) × 60% + depth=1(0) × 40% = 60
    const r = computeGrade([score('tech', 5), score('depth', 1)], DIMS, [])!
    expect(r.weightedScore).toBe(60)
    expect(r.grade).toBe('C')
  })

  // 模型漏维度是真实会发生的。拿 100 当分母的话,漏一个 40% 权重的维度会让
  // 所有人平白少 40 分,看起来像「这批人都很差」,而不是「模型少答了一项」。
  it('模型漏了某个维度 → 按实际覆盖权重归一', () => {
    const r = computeGrade([score('tech', 5)], DIMS, [])!
    expect(r.weightedScore).toBe(100)
    expect(r.breakdown).toHaveLength(1)
  })

  it('评分卡里没有的维度被忽略', () => {
    const r = computeGrade([score('tech', 5), score('不存在的', 1)], DIMS, [])!
    expect(r.weightedScore).toBe(100)
  })

  it('breakdown 给出逐维度的计算过程', () => {
    const r = computeGrade([score('tech', 5), score('depth', 3)], DIMS, [])!
    expect(r.breakdown).toEqual([
      { key: 'tech', label: '技术栈匹配', score: 5, weight: 60, contribution: 60 },
      { key: 'depth', label: '项目复杂度', score: 3, weight: 40, contribution: 20 },
    ])
  })
})

describe('门槛对档位的影响', () => {
  // 硬性条件不满足时,再高的加权分也不该出现在 A/B 档里误导 HR。
  it('门槛失败 → 一票降到 C 以下,无论分多高', () => {
    const r = computeGrade([score('tech', 5), score('depth', 5)], DIMS, [gate(false)])!
    expect(r.weightedScore).toBe(100)
    expect(r.grade).toBe('C')
    expect(r.hasGateFailure).toBe(true)
  })

  it('门槛失败 + 低分 → D', () => {
    expect(toGrade(40, true)).toBe('D')
  })

  // unknown 是「简历未提及」,不是「不满足」。当成失败会把信息不全的简历
  // 全部打到 C 档,而那恰恰是最该人工看一眼的一批。
  it('门槛 unknown 不降档,只标记', () => {
    const r = computeGrade([score('tech', 5), score('depth', 5)], DIMS, [gate('unknown')])!
    expect(r.grade).toBe('A')
    expect(r.hasGateUnknown).toBe(true)
    expect(r.hasGateFailure).toBe(false)
  })
})

describe('computePeerContext', () => {
  // 「1 人中排第 1」是废话,而且会被误读成「他最强」。
  it('没有同岗位其他人 → null,而不是「排第 1」', () => {
    expect(computePeerContext([score('tech', 4)], [], DIMS)).toBeNull()
  })

  it('给出名次与中位数对比', () => {
    const r = computePeerContext(
      [score('tech', 4)],
      [[score('tech', 5)], [score('tech', 2)], [score('tech', 1)]],
      DIMS,
    )!
    expect(r.cohortSize).toBe(4)
    expect(r.dimensions[0]).toMatchObject({
      label: '技术栈匹配', score: 4, rank: 2, cohortSize: 4, vsMedian: 'above',
    })
  })

  // 名次的分母必须是【该维度实际有分的人数】。曾经 cohortSize 取同岗位总人数、
  // rank 却在有分的人里算 —— 10 人里只有 4 人答了 tech 时界面写「10 人中第 2」,
  // 实际是 4 人里的第 2,HR 会据此高估这个人的竞争力。
  it('模型漏答的人不进分母 —— 名次与 cohortSize 必须同源', () => {
    const r = computePeerContext(
      [score('tech', 4)],
      [
        [score('tech', 5)],           // 有 tech 分
        [score('depth', 5)],          // 只答了 depth,不该进 tech 的分母
        [score('depth', 3)],
        [score('depth', 1)],
      ],
      DIMS,
    )!
    const tech = r.dimensions.find((d) => d.key === 'tech')!
    expect(tech.rank).toBe(2)
    expect(tech.cohortSize).toBe(2)  // 只有 2 个人有 tech 分,不是 5
    expect(r.cohortSize).toBe(2)     // 顶层也不能报 5
  })

  it('并列取最好的名次', () => {
    const r = computePeerContext(
      [score('tech', 5)],
      [[score('tech', 5)], [score('tech', 3)]],
      DIMS,
    )!
    expect(r.dimensions[0]!.rank).toBe(1)
  })

  it('其他人没有这个维度的分 → 跳过该维度', () => {
    const r = computePeerContext([score('tech', 4)], [[score('depth', 5)]], DIMS)
    expect(r).toBeNull()
  })
})
