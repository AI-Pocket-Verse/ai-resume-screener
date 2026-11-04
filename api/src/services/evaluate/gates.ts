import {
  type GateResult,
  type StructuredGate,
  isNlGate,
  type Gate,
} from '@ai-resume-screener/shared'
import type { MergedResume } from './merge.js'

/**
 * 结构化门槛由**代码**判,不交给 LLM。三个好处:
 *   ① 年限判定与解析层的规则计算同源 —— 不会出现「抽取算 4.8 年,门槛判成
 *      不足 3 年」这种自相矛盾
 *   ② 数值比较零幻觉
 *   ③ LLM 的输出量减少,稳定性更好
 *
 * 只有自然语言 gate 才拼进 prompt。两边结果合并成同一份 gateResults,
 * 上层与 UI 无需区分。
 */

/** 学历归一化。原文表述五花八门(「本科」「大学本科」「statutory bachelor」),
 *  比大小得先落到有序刻度上。 */
const DEGREE_RANK: Array<[RegExp, number]> = [
  [/博士|doctor|phd/i, 5],
  [/硕士|研究生|master/i, 4],
  [/本科|学士|bachelor|大学/i, 3],
  [/大专|专科|高职|associate/i, 2],
  [/高中|中专|technical secondary/i, 1],
]

export function degreeRank(text: string | null | undefined): number | null {
  if (!text) return null
  for (const [re, rank] of DEGREE_RANK) if (re.test(text)) return rank
  return null
}

const NAMED_DEGREE: Record<string, number> = {
  doctor: 5, master: 4, bachelor: 3, associate: 2, highschool: 1,
}

/** 读点路径,如 "derived.totalYears" / "basic.city"。取不到返回 undefined。 */
function readPath(m: MergedResume, path: string): unknown {
  const root: Record<string, unknown> = { ...m.data, derived: m.derived }
  return path.split('.').reduce<unknown>(
    (acc, k) => (acc == null ? undefined : (acc as Record<string, unknown>)[k]),
    root,
  )
}

/** 学历门槛要看 education[] 里的**最高**一条,不是第一条 —— 简历常按时间
 *  倒序或正序排,取第一条会随排序方式给出不同结论。 */
function highestDegree(m: MergedResume): { rank: number; text: string } | null {
  let best: { rank: number; text: string } | null = null
  for (const e of m.data.education) {
    const r = degreeRank(e.degree)
    if (r != null && (!best || r > best.rank)) best = { rank: r, text: e.degree! }
  }
  return best
}

function judgeStructured(gate: StructuredGate, m: MergedResume): GateResult {
  const base = { key: gate.key, label: gate.label, evidence: [], judgedBy: 'code' as const }

  // 学历单独走一条:需要「取最高 + 归一化到刻度」,不是裸值比较。
  if (gate.field === 'education.degree' || gate.field === 'degree') {
    const got = highestDegree(m)
    if (got == null) {
      return { ...base, pass: 'unknown', reason: '简历未提及学历,或无法识别学历表述' }
    }

    // 把门槛值(可能是单值,也可能是一组可接受的学历)统一解析成刻度。
    const wanted = (Array.isArray(gate.value) ? gate.value : [gate.value])
      .map((v) => NAMED_DEGREE[String(v)] ?? degreeRank(String(v)))
      .filter((r): r is number => r != null)
    // 门槛值本身没写清楚(如 value 是个数字或不认识的词)→ 判 unknown 交人工。
    // **绝不能默默判 false** —— 那会把合格的人挡在门外,而且看不出是配置问题。
    if (!wanted.length) {
      return { ...base, pass: 'unknown', reason: `门槛「${gate.label}」的学历要求无法识别` }
    }

    // `in ["本科","硕士","博士"]` 是招聘里表达「本科及以上」最自然的写法
    // (模型生成评分卡时就是这么写的),所以按【列表最低档及以上】判定,
    // 而不是严格的集合包含 —— 否则列表漏写「博士」就会把博士判成不合格。
    const floor = Math.min(...wanted)
    const pass = gate.op === 'lte' ? got.rank <= Math.max(...wanted) : got.rank >= floor
    return { ...base, pass, reason: `简历最高学历「${got.text}」,要求 ${gate.label}` }
  }

  const actual = readPath(m, gate.field)

  // **null/空串是「算不出来」,不是「不满足」**。年限为 null(纯项目制简历、
  // work 全缺起始日期)时判 unknown 交人工 —— 判 false 会把这类人一刀切掉。
  //
  // 空串必须一起挡:模型倾向于把缺失字段填成 ""(zod 的 nullable 也照收),
  // 而下面 `in` 分支的 `v.includes('')` 恒为 true —— 城市空着的简历会被默默
  // 判成【通过】地点门槛。方向与「绝不默默判 false」相反,更难被发现。
  if (actual == null || String(actual).trim() === '') {
    return { ...base, pass: 'unknown', reason: `简历中无法确定「${gate.label}」` }
  }

  switch (gate.op) {
    case 'gte':
    case 'lte': {
      const a = Number(actual)
      const b = Number(gate.value)
      if (Number.isNaN(a) || Number.isNaN(b)) {
        return { ...base, pass: 'unknown', reason: `「${gate.label}」无法比较` }
      }
      const pass = gate.op === 'gte' ? a >= b : a <= b
      const est = gate.field.includes('totalYears') && m.derived.totalYearsEstimated
        ? '(部分日期只有年份,为保守估算)'
        : ''
      return { ...base, pass, reason: `简历为 ${a},要求 ${gate.op === 'gte' ? '≥' : '≤'} ${b}${est}` }
    }
    case 'eq':
      return {
        ...base,
        pass: String(actual) === String(gate.value),
        reason: `简历为「${String(actual)}」,要求「${String(gate.value)}」`,
      }
    case 'in': {
      const list = (Array.isArray(gate.value) ? gate.value : [String(gate.value)])
        .map((v) => String(v).trim()).filter(Boolean)
      const got = String(actual).trim()
      if (!list.length) {
        return { ...base, pass: 'unknown', reason: `门槛「${gate.label}」没有配置可选值` }
      }
      // 地点常写「深圳市南山区」而门槛写「深圳」,用包含匹配而不是全等。
      // 但两侧都要求至少 2 个字符 —— 否则单字门槛值会匹配上一堆无关地名。
      const pass = list.some((v) => (v.length >= 2 && got.includes(v)) || (got.length >= 2 && v.includes(got)))
      return { ...base, pass, reason: `简历为「${got}」,要求属于 ${list.join(' / ')}` }
    }
  }
}

/** 判所有结构化 gate。自然语言 gate 原样返回,交给 prompt 那一侧。 */
export function judgeStructuredGates(gates: Gate[], m: MergedResume): {
  results: GateResult[]
  nlGates: Gate[]
} {
  const results: GateResult[] = []
  const nlGates: Gate[] = []
  for (const g of gates) {
    if (isNlGate(g)) nlGates.push(g)
    else results.push(judgeStructured(g, m))
  }
  return { results, nlGates }
}
