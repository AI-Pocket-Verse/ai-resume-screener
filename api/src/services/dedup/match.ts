import type { Education, ResumeExtraction, Work } from '@ai-resume-screener/shared'

// 弱匹配判定(纯函数,便于测)。
//
// 规则:
//   强匹配 = phoneHash 或 emailHash 相同 → 自动软合并(由 DB 唯一约束保证零误判)
//   弱匹配 = 姓名完全相同 AND (同校同届 OR 同公司同期) → 只提示,不自动合并
//   仅姓名相同 → **不提示**。重名太常见,提示了等于每天给 HR 制造噪音。

/** 两个年份区间是否「同期」:有重叠即可。年份精度足够 —— 同校同届本来就是年级概念。 */
function yearsOverlap(
  a: { start: string | null; end: string | null },
  b: { start: string | null; end: string | null },
): boolean {
  const y = (s: string | null) => (s && s !== 'present' ? Number(s.slice(0, 4)) : null)
  const [as, ae] = [y(a.start), y(a.end) ?? new Date().getFullYear()]
  const [bs, be] = [y(b.start), y(b.end) ?? new Date().getFullYear()]
  if (as == null || bs == null) return false
  return Math.max(as, bs) <= Math.min(ae, be)
}

function sameSchoolAndPeriod(a: Education[], b: Education[]): string | null {
  for (const x of a) {
    for (const z of b) {
      if (x.school && x.school === z.school && yearsOverlap(x, z)) return `同校同届:${x.school}`
    }
  }
  return null
}

function sameCompanyAndPeriod(a: Work[], b: Work[]): string | null {
  for (const x of a) {
    for (const z of b) {
      if (x.company && x.company === z.company && yearsOverlap(x, z)) return `同公司同期:${x.company}`
    }
  }
  return null
}

export interface WeakMatch {
  /** 命中的依据,直接显示给 HR:「疑似与 张三(同校同届:某某大学)是同一人」。 */
  matchedField: string
  score: number
}

/**
 * 弱匹配判定。返回 null 表示不提示。
 *
 * **姓名必须完全相同**才进入判定 —— 这是最强的前置条件。之后还要求同校同届或
 * 同公司同期,是为了把「张伟」这种大姓重名挡掉:光凭姓名相同就提示,HR 每天
 * 要处理几十条无效提示,很快就会对所有提示条视而不见,连真的那条也一起忽略。
 */
export function weakMatch(a: ResumeExtraction, b: ResumeExtraction): WeakMatch | null {
  const nameA = a.basic.name?.trim()
  const nameB = b.basic.name?.trim()
  if (!nameA || !nameB || nameA !== nameB) return null

  const school = sameSchoolAndPeriod(a.education, b.education)
  if (school) return { matchedField: school, score: 0.8 }

  const company = sameCompanyAndPeriod(a.work, b.work)
  if (company) return { matchedField: company, score: 0.7 }

  return null
}
