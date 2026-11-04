import type { Dimension, DimensionScore, PeerContext } from '@ai-resume-screener/shared'

/**
 * 横向定位:同岗位内的相对位置。**精评三项独有产出里最关键的一项** ——
 * HR 说「拿不准」,本质是缺少比较基准,给出相对位置比再多一段理由更能帮他决定。
 *
 * 由代码算而不是问模型:数据现成(同岗位其他人的维度分已经在库里),
 * 让模型去"感觉"排名只会引入幻觉,而且它根本看不到别人的分。
 */
export function computePeerContext(
  mine: DimensionScore[],
  /** 同岗位其他人的维度分,每人一组。不含本人。 */
  peers: DimensionScore[][],
  dimensions: Dimension[],
): PeerContext | null {
  // 一个人没法比较。**返回 null 而不是「排第 1」** —— 「12 人中排第 3」有信息量,
  // 「1 人中排第 1」是废话,还会被误读成「他最强」。
  if (peers.length === 0) return null

  const labelOf = new Map(dimensions.map((d) => [d.key, d.label]))
  const out: PeerContext['dimensions'] = []
  // 名次的分母 = 该维度**实际有分的人数**,而不是同岗位总人数。
  //
  // 曾经 cohortSize 取 peers.length + 1(全部人),而 rank 只在有这个维度分的人
  // 里算:10 个候选人只有 3 个答了 tech 维度时,界面显示「10 人中第 2」,实际是
  // 4 个人里的第 2 —— HR 会据此高估这个人的竞争力,而横向定位存在的意义恰恰
  // 是给 HR 一个可靠的比较基准。
  let maxCohort = 0

  for (const m of mine) {
    const others = peers
      .map((p) => p.find((s) => s.key === m.key)?.score)
      .filter((s): s is number => typeof s === 'number')
    if (others.length === 0) continue

    const all = [...others, m.score].sort((a, b) => b - a)
    maxCohort = Math.max(maxCohort, all.length)
    // 并列时取【最好】的名次(1-based):两个 5 分并列都算第 1,
    // 而不是一个第 1 一个第 2 —— 同分给不同名次没有依据。
    const rank = all.indexOf(m.score) + 1

    out.push({
      key: m.key,
      label: labelOf.get(m.key) ?? m.key,
      score: m.score,
      rank,
      // 每个维度带上自己的分母,UI 才能如实写「4 人中第 2」而不是「10 人中第 2」。
      cohortSize: all.length,
      median: median(all),
      vsMedian: m.score > median(all) ? 'above' : m.score < median(all) ? 'below' : 'equal',
    })
  }

  // 顶层 cohortSize 取各维度里最大的那个 —— 仍是「参与比较的人数」的量级,
  // 不会超过任何一个维度的实际分母。
  return out.length ? { cohortSize: maxCohort, dimensions: out } : null
}

function median(sorted: number[]): number {
  if (!sorted.length) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
