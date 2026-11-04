// 派生字段:总年限、跳槽次数、空窗、时间线冲突。
//
// **一律由代码算,不交给 LLM**。模型算日期不准是通病,而这些量恰恰是列表排序
// 与门槛判定的依据 —— 算错的代价比抽错一个字段大得多。LLM 只负责抽起止年月。
import type { ResumeDerived, ResumeExtraction, Work } from '@ai-resume-screener/shared'

/** 把 "YYYY" / "YYYY-MM" / "present" 转成「距 1970-01 的月数」,便于做区间运算。
 *  返回 null 表示无法定位(缺失日期)。 */
function toMonths(d: string | null, opts: { side: 'start' | 'end'; now: Date }): number | null {
  if (!d) return null
  if (d === 'present') return (opts.now.getFullYear() - 1970) * 12 + opts.now.getMonth()
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(d)
  if (!m) return null
  const year = Number(m[1])
  // 只有年份时取【保守】的一端:起始按当年末(12月)、结束按当年初(1月)。
  // 这样年限只会被低估不会被高估 —— 简历筛选里高估年限的代价更大
  // (把不满足硬性年限门槛的人放进来)。
  const month = m[2] ? Number(m[2]) - 1 : opts.side === 'start' ? 11 : 0
  return (year - 1970) * 12 + month
}

interface Span {
  start: number
  end: number
  /** 端点里是否含年份精度的日期 —— 含则本段时长是估算值。 */
  estimated: boolean
}

function toSpans(work: Work[], now: Date): Span[] {
  const nowMonths = (now.getFullYear() - 1970) * 12 + now.getMonth()
  const spans: Span[] = []
  for (const w of work) {
    const start = toMonths(w.start, { side: 'start', now })
    const end = toMonths(w.end, { side: 'end', now })
    if (start == null) continue // 起始都没有,这段无法参与计算
    // ⚠️ **`end == null` 与 `'present'` 同义(都表示「至今」)** —— schema 的
    // Period 注释和下面的 pickCurrent 都是这么定的。曾经这里写 `end ?? start`,
    // 把「至今」算成了「干了 0 个月」:一个 11 年经验的在职候选人 totalYears
    // 变成 0(而不是 null),年限门槛随即判 false 而不是 unknown,直接锁死 C/D 档,
    // 界面上「当前公司」却显示正常,完全看不出哪里错了。
    // 模型没按 prompt 填 'present' 而填了 null 就会踩到,zod 也不会拦。
    const realEnd = w.end == null ? nowMonths : (end ?? start)
    if (realEnd < start) continue // 起止倒置:交给 timelineConflicts 报,不参与年限
    spans.push({
      start,
      end: realEnd,
      estimated: (w.start?.length === 4) || (w.end?.length === 4),
    })
  }
  return spans.sort((a, b) => a.start - b.start)
}

/** 合并重叠区间后的总月数。**必须去重** —— 兼职/顾问与全职并存时,
 *  简单相加会把年限凭空放大一倍。 */
function mergedMonths(spans: Span[]): number {
  if (!spans.length) return 0
  let total = 0
  let curStart = spans[0]!.start
  let curEnd = spans[0]!.end
  for (const s of spans.slice(1)) {
    if (s.start <= curEnd) {
      curEnd = Math.max(curEnd, s.end)
    } else {
      total += curEnd - curStart
      curStart = s.start
      curEnd = s.end
    }
  }
  return total + (curEnd - curStart)
}

/** 相邻两段之间的最大空窗(月)。合并重叠后再算,否则并行的两段会被误判成空窗。 */
function maxGap(spans: Span[]): number | null {
  if (spans.length < 2) return null
  let gap = 0
  let curEnd = spans[0]!.end
  for (const s of spans.slice(1)) {
    if (s.start > curEnd) gap = Math.max(gap, s.start - curEnd)
    curEnd = Math.max(curEnd, s.end)
  }
  return gap
}

function detectConflicts(work: Work[], now: Date): string[] {
  const out: string[] = []
  work.forEach((w, i) => {
    const start = toMonths(w.start, { side: 'start', now })
    const end = toMonths(w.end, { side: 'end', now })
    if (start != null && end != null && end < start) {
      out.push(`${w.company}:结束时间早于开始时间(${w.start} → ${w.end})`)
    }
    if (start == null) out.push(`${w.company}:缺少开始时间`)
    // 全职互相重叠 —— 只报相邻两两重叠,不穷举所有组合(噪音大且没有额外信息)。
    for (let j = i + 1; j < work.length; j++) {
      const o = work[j]!
      const oStart = toMonths(o.start, { side: 'start', now })
      const oEnd = toMonths(o.end, { side: 'end', now })
      if (start == null || oStart == null) continue
      const e = end ?? start
      const oe = oEnd ?? oStart
      const overlap = Math.min(e, oe) - Math.max(start, oStart)
      // 一个月以内的重叠是交接期,正常;超过才提示。
      if (overlap > 1) {
        out.push(`${w.company} 与 ${o.company} 时间重叠约 ${overlap} 个月`)
      }
    }
  })
  return out
}

/** 取「当前公司/职位」。多段 present 并存时取 start 最晚的;
 *  都不是 present 时取 end 最晚的并标记 currentIsPast(UI 显示「上一份」)。 */
function pickCurrent(work: Work[], now: Date): Pick<ResumeDerived, 'currentCompany' | 'currentTitle' | 'currentIsPast'> {
  const present = work.filter((w) => w.end === 'present' || w.end === null)
  const pool = present.length > 0 ? present : work
  if (!pool.length) return { currentCompany: null, currentTitle: null, currentIsPast: false }

  const key = present.length > 0
    ? (w: Work) => toMonths(w.start, { side: 'start', now }) ?? -Infinity
    : (w: Work) => toMonths(w.end, { side: 'end', now }) ?? -Infinity

  let best = pool[0]!
  for (const w of pool.slice(1)) if (key(w) > key(best)) best = w
  return { currentCompany: best.company, currentTitle: best.title, currentIsPast: present.length === 0 }
}

/** `now` 可注入,否则测试会随真实时间漂移(present 段的长度天天在变)。 */
export function deriveFields(extraction: ResumeExtraction, now: Date = new Date()): ResumeDerived {
  const work = extraction.work
  const spans = toSpans(work, now)
  const months = mergedMonths(spans)
  const gap = maxGap(spans)

  return {
    // spans 为空 = 没有任何可定位的工作区间(纯项目制简历、或 work 全缺起始日期)。
    // 这时是【算不出来】,不是【零经验】—— 报 0 会让这类简历在年限门槛上被一刀切掉。
    totalYears: spans.length ? Math.round((months / 12) * 10) / 10 : null,
    totalYearsEstimated: spans.some((s) => s.estimated),
    // 跳槽次数 = 工作段数 - 1(只有一段或没有,记 0)。
    jobHopCount: Math.max(0, work.length - 1),
    avgTenureMonths: spans.length ? Math.round(months / spans.length) : null,
    maxGapMonths: gap,
    ...pickCurrent(work, now),
    timelineConflicts: detectConflicts(work, now),
  }
}
