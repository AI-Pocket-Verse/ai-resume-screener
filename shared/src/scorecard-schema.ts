import { z } from 'zod'

// 评分卡:把 JD 翻译成【可执行评估标准】的一层,是本产品的核心资产。
// JD 原文普遍很水(「熟悉 Java,3 年以上经验,有责任心」),直接拿它比对,
// 输出必然是含糊的正确话。

// ── 门槛(gates)────────────────────────────────────────────────────
//
// 分两类,**判定方各不相同**:
//   - 结构化:代码判。读 derived/raw 规则比对 → 数值零幻觉,且与解析层的年限
//     计算同源,不会出现「抽取算 4.8 年、门槛判成不足 3 年」的自相矛盾
//   - 自然语言:LLM 判。只有这类才拼进 prompt
// 两者结果合并成同一份 gateResults,上层与 UI 无需区分。

export const GateOp = z.enum(['gte', 'lte', 'eq', 'in'])
export type GateOp = z.infer<typeof GateOp>

export const StructuredGate = z.object({
  key: z.string(),
  label: z.string(),
  /** 读 merge 后简历的哪个字段。支持 derived.totalYears / basic.city 这类点路径。 */
  field: z.string(),
  op: GateOp,
  value: z.union([z.string(), z.number(), z.array(z.string())]),
})

export const NlGate = z.object({
  key: z.string(),
  label: z.string(),
  /** 自然语言条件,如「有 B 端 SaaS 从 0 到 1 经验」。 */
  nl: z.string(),
})

export const Gate = z.union([StructuredGate, NlGate])
export type StructuredGate = z.infer<typeof StructuredGate>
export type NlGate = z.infer<typeof NlGate>
export type Gate = z.infer<typeof Gate>

export function isNlGate(g: Gate): g is NlGate {
  return 'nl' in g
}

// ── 维度(dimensions)──────────────────────────────────────────────

export const Dimension = z.object({
  key: z.string(),
  label: z.string(),
  /** 权重,全部维度之和应为 100(UI 用滑块自动归一,不让 HR 手算)。 */
  weight: z.number().min(0).max(100),
  /**
   * 评分锚点。**这是评分稳定的关键**,不是可选优化 —— 没有锚点,模型心里的
   * 「4 分」每次都不一样。地位等同于解析层的受控词表。
   *
   * 只写 5/3/1 三档,中间靠插值:写满 5 档反而降低一致性(要模型区分
   * 「4 分和 5 分的差别」比区分「命中且有深度 vs 仅使用层」难得多)。
   */
  anchors: z.object({
    '5': z.string(),
    '3': z.string(),
    '1': z.string(),
  }),
})
export type Dimension = z.infer<typeof Dimension>

export const Scorecard = z.object({
  gates: z.array(Gate).default([]),
  dimensions: z.array(Dimension).min(1, '至少要有一个评分维度'),
})
export type Scorecard = z.infer<typeof Scorecard>

/** 权重之和。UI 归一化用,也用于「这张卡还没配好」的校验。 */
export function totalWeight(s: Scorecard): number {
  return s.dimensions.reduce((sum, d) => sum + d.weight, 0)
}

// ── 评估输出(强制 schema)──────────────────────────────────

export const Evidence = z.object({
  /** 原文摘录。要能在简历里定位(前端据此高亮跳转)。 */
  quote: z.string(),
  /** 出处,如 "work[1]" / "project[0]"。 */
  section: z.string().nullable().default(null),
})

/**
 * `unknown` 必须是合法值。强迫模型在信息缺失时二选一是幻觉的主要来源;
 * 而「简历未提及」本身就是有用信息,UI 上显示为灰色而非红色。
 */
export const GateVerdict = z.union([z.boolean(), z.literal('unknown')])

export const GateResult = z.object({
  key: z.string(),
  label: z.string(),
  pass: GateVerdict,
  /** 判定依据。结构化 gate 由代码填(如「简历算得 4.8 年,要求 ≥3」)。 */
  reason: z.string().nullable().default(null),
  evidence: z.array(Evidence).default([]),
  /** 'code' | 'llm' —— 谁判的。UI 不区分,但排查打分问题时很关键。 */
  judgedBy: z.enum(['code', 'llm']).default('llm'),
})
export type GateResult = z.infer<typeof GateResult>

export const DimensionScore = z.object({
  key: z.string(),
  /** 1-5 分。锚点给的是 5/3/1,2/4 由模型插值。 */
  score: z.number().min(1).max(5),
  reason: z.string(),
  /** **每条 reason 必须配 evidence**,拿不出引用的结论直接丢弃。 */
  evidence: z.array(Evidence).min(1, '每个维度至少要有一条原文引用'),
})
export type DimensionScore = z.infer<typeof DimensionScore>

export const EvaluationOutput = z.object({
  /** 只含自然语言 gate 的判定;结构化的由代码判后合并进来。 */
  gateResults: z.array(GateResult).default([]),
  scores: z.array(DimensionScore),
  highlights: z.array(z.object({
    text: z.string(),
    evidence: z.array(Evidence).default([]),
  })).default([]),
  /** **只写事实层面的存疑**(如「近 3 年 3 段经历,平均 11 个月」),
   *  不写推测性人格判断。 */
  concerns: z.array(z.object({
    text: z.string(),
    evidence: z.array(Evidence).default([]),
  })).default([]),
  summary: z.string().max(120, '总评控制在 60 字左右'),
})
export type EvaluationOutput = z.infer<typeof EvaluationOutput>

/** 英文输出用:同样篇幅的英文按字符数是中文的 3-5 倍(60 字约合 40 个英文单词、
 *  300 字符上下),沿用 120 字符上限会让英文总评几乎必然校验失败。 */
export const EvaluationOutputEn = EvaluationOutput.extend({
  summary: z.string().max(320, 'Keep the summary to about 40 words'),
})

// ── 精评的三项独有产出──────────────────────────────
//
// 精评的分层【不在输出格式】上 —— 「每条结论必须配引用」对粗评同样
// 生效,所以粗评不可能便宜(实测 2 分钟/份)。真正的分层是:用更强的 provider、
// 更高的 effort、每维度引用条数 ≥2,外加下面这三项。
// 这三项都是从「HR 拿不准」这个真实场景反推出来的。

export const DeepExtras = z.object({
  /** 针对存疑点的追问建议(2-3 条,不是完整面试提纲)。
   *  聚焦 HR 犹豫的那个点:「你担心他跳槽频繁 → 面试时可以这样问」。 */
  followUpQuestions: z.array(z.object({
    question: z.string(),
    /** 为什么问这个 —— 指向哪条 concern 或低分维度。 */
    rationale: z.string(),
  })).max(3).default([]),
  /** 一句话回答「值不值得面」,外加主要依据与主要顾虑各一条。
   *  仍是**参考**,不改变「不自动淘汰、人工决策」的定位。 */
  verdict: z.object({
    stance: z.enum(['recommend', 'lean_recommend', 'lean_pass', 'pass']),
    mainReason: z.string(),
    mainConcern: z.string(),
  }),
})
export type DeepExtras = z.infer<typeof DeepExtras>

/** 横向定位:同岗位内的相对位置。**这一项最关键** —— HR 说「犹豫」,本质是
 *  缺少比较基准,给相对位置比再多一段理由更能帮他决定。而且数据现成
 *  (同岗位其他人的维度分),几乎零额外成本,所以由代码算、不问模型。 */
export interface PeerContext {
  /** 参与比较的样本数(各维度里最大的那个分母)。**不是同岗位总人数** ——
   *  见下面每个维度自己的 cohortSize。 */
  cohortSize: number
  dimensions: Array<{
    key: string
    label: string
    score: number
    /** 第几名(1 = 最高)。 */
    rank: number
    /** 该维度**实际有分的人数**(含本人),也就是 rank 的分母。
     *
     *  必须逐维度给:模型可能漏答某些维度,10 个候选人里只有 4 个有 tech 分时,
     *  「10 人中第 2」是假的,「4 人中第 2」才是真的 —— 而 HR 正是靠这个数
     *  判断名次的含金量。 */
    cohortSize: number
    median: number
    /** 相对中位数的位置,给 UI 直接用。 */
    vsMedian: 'above' | 'below' | 'equal'
  }>
}

// ── 档位 ────────────────────────────────────────────────────────

export const GRADE_THRESHOLDS = { A: 85, B: 70, C: 55 } as const
export type Grade = 'A' | 'B' | 'C' | 'D'
