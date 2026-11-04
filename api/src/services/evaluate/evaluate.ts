import { chatJson } from '@ai-resume-screener/llm-kit'
import {
  DeepExtras,
  EvaluationOutput,
  Scorecard,
  type DeepExtras as DeepExtrasT,
  type EvaluationOutput as EvaluationOutputT,
  type GateResult,
  type Scorecard as ScorecardT,
} from '@ai-resume-screener/shared'
import { getProvider } from '../llm.js'
import { llmSemaphore } from '../../utils/concurrency.js'
import { judgeStructuredGates } from './gates.js'
import { computeGrade, type GradeResult } from './grade.js'
import type { MergedResume } from './merge.js'
import { buildEvalPrompt, buildScorecardDraftPrompt } from './prompt.js'

export interface EvaluateInput {
  jobTitle: string
  teamName: string
  jdSummary: string
  scorecard: ScorecardT
  resume: MergedResume
  tier: 'screen' | 'deep'
}

export interface EvaluateResult {
  output: EvaluationOutputT | null
  deep: DeepExtrasT | null
  /** 代码判 + LLM 判合并后的完整门槛结果。 */
  gateResults: GateResult[]
  grade: GradeResult | null
  error: string | null
  rawText: string
  latencyMs: number
  model: string | null
}

/** 评估一份简历。**绝不抛** —— 批量跑时一份出问题不该带崩整批。 */
export async function evaluateResume(input: EvaluateInput): Promise<EvaluateResult> {
  // 结构化门槛先由代码判掉,只把自然语言的交给模型。
  const { results: codeGates, nlGates } = judgeStructuredGates(input.scorecard.gates, input.resume)

  const provider = getProvider(input.tier === 'deep' ? 'deep' : 'screen')
  const prompt = buildEvalPrompt({ ...input, nlGates })
  const ac = new AbortController()
  const t0 = Date.now()

  const release = await llmSemaphore.acquire()
  let r
  try {
    r = await chatJson<unknown>(provider, prompt, ac.signal, {
      // 精评调高思考强度 —— 这是精评分层的实际手段之一(另两个是更强的
      // provider 与更多引用条数),而不是换个输出格式。
      ...(input.tier === 'deep' ? { effort: 'high' } : {}),
    })
  } finally {
    release()
  }
  const latencyMs = Date.now() - t0
  const model = provider.lastModel
  const fail = (error: string): EvaluateResult => ({
    output: null, deep: null, gateResults: codeGates, grade: null,
    error, rawText: r?.rawText ?? '', latencyMs, model,
  })

  if (r.error || !r.data) return fail(r.error ?? '模型没有返回可解析的 JSON')

  const parsed = EvaluationOutput.safeParse(r.data)
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    return fail(`结构校验失败: ${issues}`)
  }
  const output = parsed.data

  // 精评的额外产出【单独校验】:少了它们不至于让整条评估作废 ——
  // 分数和引用才是主体,追问建议缺失只是少个锦上添花。
  let deep: DeepExtrasT | null = null
  if (input.tier === 'deep') {
    const d = DeepExtras.safeParse(r.data)
    deep = d.success ? d.data : null
  }

  // LLM 判的自然语言门槛补上 label 与 judgedBy,与代码判的合并成一份。
  const nlLabel = new Map(nlGates.map((g) => [g.key, g.label]))
  const llmGates: GateResult[] = output.gateResults
    // 模型偶尔会把已由代码判掉的结构化 gate 也答一遍 —— 丢弃,以代码为准。
    .filter((g) => nlLabel.has(g.key))
    .map((g) => ({ ...g, label: nlLabel.get(g.key) ?? g.label, judgedBy: 'llm' as const }))
  const gateResults = [...codeGates, ...llmGates]

  const grade = computeGrade(output.scores, input.scorecard.dimensions, gateResults)
  // 一个维度都对不上 = 模型答的和评分卡不是一回事,当失败重试而不是出个 0 分。
  if (!grade) return fail('模型返回的维度与评分卡完全不匹配(可能是评分卡的 key 改过)')

  return { output, deep, gateResults, grade, error: null, rawText: r.rawText, latencyMs, model }
}

/** JD → 评分卡草稿。生成完由 HR 人工编辑,不直接生效。 */
export async function draftScorecard(jobTitle: string, jdRaw: string): Promise<{
  scorecard: ScorecardT | null
  error: string | null
  rawText: string
}> {
  const provider = getProvider('deep')
  const ac = new AbortController()
  const release = await llmSemaphore.acquire()
  let r
  try {
    r = await chatJson<unknown>(provider, buildScorecardDraftPrompt(jobTitle, jdRaw), ac.signal)
  } finally {
    release()
  }
  if (r.error || !r.data) return { scorecard: null, error: r.error ?? '生成失败', rawText: r.rawText }

  const parsed = Scorecard.safeParse(r.data)
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    return { scorecard: null, error: `结构校验失败: ${issues}`, rawText: r.rawText }
  }
  return { scorecard: parsed.data, error: null, rawText: r.rawText }
}
