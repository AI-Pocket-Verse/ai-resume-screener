import type { Grade } from '@ai-resume-screener/shared'

export interface EvaluationRow {
  id: string
  tier: string
  grade: string | null
  weightedScore: number | null
  createdAt: Date
}

export interface CurrentVerdict {
  current: EvaluationRow
  /** 被精评覆盖掉的粗评结论。UI 显示成「B · 深度分析后(粗评为 A)」,
   *  而不是让档位莫名其妙地变了 —— 变化必须可解释。 */
  supersededScreen: EvaluationRow | null
  grade: Grade | null
  source: 'screen' | 'deep'
}

/**
 * 取「当前有效结论」。
 *
 * **显式规则,不要跨 tier 比 createdAt**:精评是「更可靠的判断」,这正是 HR
 * 点它的原因,所以只要存在 deep 就以 deep 为准 —— 哪怕之后又跑了一次粗评
 * (比如改完评分卡批量重跑),那次粗评也不该把精评结论盖掉。
 *
 * 同 tier 内才按 createdAt 取最新。注:cuid 不单调递增,不能靠 id 排序。
 */
export function pickCurrent(rows: EvaluationRow[]): CurrentVerdict | null {
  if (!rows.length) return null
  const newest = (tier: string) =>
    rows.filter((r) => r.tier === tier)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null

  const deep = newest('deep')
  const screen = newest('screen')
  const current = deep ?? screen
  if (!current) return null

  return {
    current,
    // 只有在精评确实盖掉了粗评、且两者档位不同时才值得提示。
    supersededScreen: deep && screen && screen.grade !== deep.grade ? screen : null,
    grade: (current.grade as Grade | null) ?? null,
    source: deep ? 'deep' : 'screen',
  }
}

/** 列表排序键:先按档位分组,组内按分降序(视觉上先看到分组,
 *  而不是一条连续的分数流,以免把 71 分和 69 分读成「差不多」)。 */
const GRADE_ORDER: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 }

export function sortByVerdict<T extends { verdict: CurrentVerdict | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    // 没有结论的(未分析)一律排在最后 —— 它们不参与档位比较。
    if (!a.verdict && !b.verdict) return 0
    if (!a.verdict) return 1
    if (!b.verdict) return -1
    const ga = GRADE_ORDER[a.verdict.grade ?? 'D'] ?? 9
    const gb = GRADE_ORDER[b.verdict.grade ?? 'D'] ?? 9
    if (ga !== gb) return ga - gb
    return (b.verdict.current.weightedScore ?? 0) - (a.verdict.current.weightedScore ?? 0)
  })
}
