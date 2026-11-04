// 列表的筛选与计数逻辑。
//
// **从组件里抽出来是为了能测**:这些分支(未分析 vs 解析中 vs 解析失败、
// 档位计数、精评覆盖粗评的展示)是前端真正容易算错的地方,而截图只能证明
// 「渲染出来了」,证明不了「算对了」。
import type { MessageKey, TFunction } from '@/i18n'
import type { CandidateRow, Grade } from './api'

export type Filter = 'all' | Grade | 'unanalyzed' | 'pending'

export const FILTERS: Array<{ key: Filter; label: MessageKey }> = [
  { key: 'all', label: 'list.filter.all' },
  { key: 'A', label: 'list.filter.A' },
  { key: 'B', label: 'list.filter.B' },
  { key: 'C', label: 'list.filter.C' },
  { key: 'D', label: 'list.filter.D' },
  { key: 'unanalyzed', label: 'list.filter.unanalyzed' },
  { key: 'pending', label: 'list.filter.pending' },
]

/** 解析尚未结束(排队/渲染/抽取中)。failed 是终态,不算「进行中」。 */
export function isParsing(row: CandidateRow): boolean {
  return row.parseState !== 'parsed' && row.parseState !== 'failed'
}

/** 「未分析」= 解析好了但一条评估都没有。**解析中的不算未分析** ——
 *  它们还没到能分析的阶段,混进来会让「一键分析 N 份」这个数字虚高,
 *  点下去有一部分根本跑不了。 */
export function isUnanalyzed(row: CandidateRow): boolean {
  return !row.verdict && row.parseState === 'parsed'
}

export function matchesKeyword(row: CandidateRow, keyword: string): boolean {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return true
  return `${row.name} ${row.currentCompany ?? ''}`.toLowerCase().includes(kw)
}

export function matchesFilter(row: CandidateRow, filter: Filter): boolean {
  switch (filter) {
    case 'all': return true
    case 'unanalyzed': return isUnanalyzed(row)
    case 'pending': return isParsing(row)
    default: return row.verdict?.grade === filter
  }
}

export function filterRows(rows: CandidateRow[], filter: Filter, keyword: string): CandidateRow[] {
  return rows.filter((r) => matchesKeyword(r, keyword) && matchesFilter(r, filter))
}

/** 各筛选项的人数,直接标在 chip 上。 */
export function countByFilter(rows: CandidateRow[]): Record<string, number> {
  const c: Record<string, number> = { all: rows.length, A: 0, B: 0, C: 0, D: 0, unanalyzed: 0, pending: 0 }
  for (const r of rows) {
    const g = r.verdict?.grade
    if (g) c[g] = (c[g] ?? 0) + 1
    if (isUnanalyzed(r)) c.unanalyzed! += 1
    if (isParsing(r)) c.pending! += 1
  }
  return c
}

/** 「一键分析」的目标。语义是**分析全部未分析的**,不重跑已分析项 ——
 *  误点一次不该烧掉一小时机器时间。 */
export function analyzeTargets(rows: CandidateRow[], selection: Set<string>): string[] {
  if (selection.size > 0) return [...selection]
  return rows.filter(isUnanalyzed).map((r) => r.applicationId)
}

/** 列表行的状态徽标。同一行可能同时有多个(如既在分析中又打了标签),
 *  但解析态与分析态**互斥** —— 没解析完根本不可能在分析。 */
export interface RowBadge { text: string; tone: 'info' | 'warn' | 'error' }

export function rowBadges(row: CandidateRow, t: TFunction): RowBadge[] {
  const out: RowBadge[] = []
  if (row.verdict?.supersededGrade) {
    out.push({ text: t('list.badge.superseded', { grade: row.verdict.supersededGrade }), tone: 'info' })
  }
  if (row.analyzing) {
    out.push({ text: row.analyzing === 'deep' ? t('list.badge.analyzingDeep') : t('list.badge.analyzing'), tone: 'info' })
  } else if (isParsing(row)) {
    out.push({ text: t('list.badge.parsing'), tone: 'warn' })
  }
  if (row.parseState === 'failed') out.push({ text: t('list.badge.failed'), tone: 'error' })
  // 疑似注入放在**列表**上,而不是只在详情页角落 —— 这条信息的价值就在于
  // 「点开之前就该警惕」。不阻断评估:简历里写 prompt 的 AI 从业者是正常候选人。
  if (row.injectionSuspected) out.push({ text: t('list.badge.suspicious'), tone: 'error' })
  return out
}
