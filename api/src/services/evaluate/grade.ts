import {
  GRADE_THRESHOLDS,
  type DimensionScore,
  type Dimension,
  type GateResult,
  type Grade,
} from '@ai-resume-screener/shared'

export interface GradeResult {
  /** 0-100 的加权分。**取整到个位** —— 绝不出现 87.3 那种伪精度。 */
  weightedScore: number
  grade: Grade
  /** 有门槛判定为 false。UI 据此标红。 */
  hasGateFailure: boolean
  /** 有门槛判定为 unknown。灰色显示「简历未提及」,不是失败。 */
  hasGateUnknown: boolean
  /** 逐维度的计算过程,供「这个分怎么来的」一键展开。 */
  breakdown: Array<{ key: string; label: string; score: number; weight: number; contribution: number }>
}

/**
 * 加权算分 + 档位切分。
 *
 * 1-5 分线性映射到 0-100:1 分 → 0,5 分 → 100。用 (score-1)/4 而不是
 * score/5,因为 1 分的锚点是「基本不相关」,给它 20 分会让全不相关的候选人
 * 也拿到 20 分底分,压缩了有效区分度。
 */
export function computeGrade(
  scores: DimensionScore[],
  dimensions: Dimension[],
  gateResults: GateResult[],
): GradeResult | null {
  const byKey = new Map(dimensions.map((d) => [d.key, d]))
  const breakdown: GradeResult['breakdown'] = []
  let weighted = 0
  let usedWeight = 0

  for (const s of scores) {
    const dim = byKey.get(s.key)
    if (!dim) continue // 模型返回了评分卡里没有的维度 → 忽略,不让它参与权重
    const normalized = ((s.score - 1) / 4) * 100
    const contribution = (normalized * dim.weight) / 100
    weighted += contribution
    usedWeight += dim.weight
    breakdown.push({
      key: s.key, label: dim.label, score: s.score, weight: dim.weight,
      contribution: Math.round(contribution * 10) / 10,
    })
  }

  // 模型漏了某个维度时按【实际覆盖的权重】归一,而不是拿 100 当分母 ——
  // 否则漏一个 30% 权重的维度会让所有人平白少 30 分,看起来像「大家都很差」。
  //
  // ⚠️ 但**全都对不上是另一回事**:那时 weightedScore=0、breakdown 空,
  // 候选人拿到一个 0 分 D 档、点开「这个分怎么来的」一片空白,却被当成一次
  // 成功的评估落库、进通知的档位分布。这是评分卡改了 key 而模型照旧 key 输出
  // 时的典型症状,必须当失败重试,而不是静默出分。
  if (usedWeight === 0) return null
  const score = Math.round((weighted / usedWeight) * 100)

  const hasGateFailure = gateResults.some((g) => g.pass === false)
  const hasGateUnknown = gateResults.some((g) => g.pass === 'unknown')

  return {
    weightedScore: score,
    grade: toGrade(score, hasGateFailure),
    hasGateFailure,
    hasGateUnknown,
    breakdown,
  }
}

/** 档位。**门槛失败一票降到 C 以下**,无论加权分多高 —— 硬性条件不满足时,
 *  再高的分也不该出现在 A/B 档里误导 HR。注意仍不自动淘汰。 */
export function toGrade(score: number, hasGateFailure: boolean): Grade {
  if (hasGateFailure) return score >= GRADE_THRESHOLDS.C ? 'C' : 'D'
  if (score >= GRADE_THRESHOLDS.A) return 'A'
  if (score >= GRADE_THRESHOLDS.B) return 'B'
  if (score >= GRADE_THRESHOLDS.C) return 'C'
  return 'D'
}
