import { chatJson } from '@ai-resume-screener/llm-kit'
import { ResumeExtraction, isKnownSkill } from '@ai-resume-screener/shared'
import { getProvider } from '../llm.js'
import { llmSemaphore } from '../../utils/concurrency.js'
import { buildParsePrompt, turnsForPages } from './prompt.js'

export interface ExtractInput {
  /** 页图绝对路径(图片路径)。与 text 二选一。 */
  imagePaths?: string[]
  /** 纯文本(粘贴/markdown/docx)。与 imagePaths 二选一。 */
  text?: string
}

export interface ExtractResult {
  data: ResumeExtraction | null
  /** 失败原因。成功为 null。 */
  error: string | null
  /** 模型原文,失败时留档排查(**只进日志,不给前端** —— 里面是简历内容)。 */
  rawText: string
  latencyMs: number
  model: string | null
  /** 被词表过滤掉的技能名。有值说明模型仍在自由发挥,是 prompt 该收紧的信号。 */
  droppedSkills: string[]
  /** document | image | text —— 这份是怎么喂给模型的。 */
  deliveryMode: 'image' | 'text'
}

/**
 * 调模型把简历抽成结构化 JSON。
 *
 * **绝不抛**:一份坏简历不该把整批带崩。失败落 error 字段,由队列决定重试还是
 * 标记失败。
 */
export async function extractResume(input: ExtractInput): Promise<ExtractResult> {
  const images = input.imagePaths ?? []
  const deliveryMode: 'image' | 'text' = images.length > 0 ? 'image' : 'text'
  if (deliveryMode === 'text' && !input.text?.trim()) {
    return {
      data: null, error: '没有可解析的内容', rawText: '',
      latencyMs: 0, model: null, droppedSkills: [], deliveryMode,
    }
  }

  const provider = getProvider('parse')
  const prompt = buildParsePrompt(input)
  const ac = new AbortController()
  const t0 = Date.now()

  const release = await llmSemaphore.acquire()
  let result
  try {
    result = await chatJson<unknown>(provider, prompt, ac.signal, {
      // 空数组会让 provider 走纯文本单轮分支,所以文本路径【不传】images。
      ...(images.length > 0 ? { images, maxTurns: turnsForPages(images.length) } : {}),
    })
  } finally {
    release()
  }
  const latencyMs = Date.now() - t0
  const model = provider.lastModel

  if (result.error || !result.data) {
    return {
      data: null,
      error: result.error ?? '模型没有返回可解析的 JSON',
      rawText: result.rawText,
      latencyMs, model, droppedSkills: [], deliveryMode,
    }
  }

  // zod 校验:模型即使返回了合法 JSON,字段形状也未必对(日期格式、必填缺失)。
  const parsed = ResumeExtraction.safeParse(result.data)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    return {
      data: null, error: `结构校验失败: ${issues}`, rawText: result.rawText,
      latencyMs, model, droppedSkills: [], deliveryMode,
    }
  }

  // 受控词表兜底:prompt 已经要求只从词表里选,但模型偶尔仍会自由发挥。
  // 放行的话「可比性」——给词表的唯一目的——就失效了。
  const droppedSkills: string[] = []
  const data = parsed.data
  data.skill = data.skill.filter((s) => {
    if (isKnownSkill(s.name)) return true
    droppedSkills.push(s.name)
    return false
  })

  return { data, error: null, rawText: result.rawText, latencyMs, model, droppedSkills, deliveryMode }
}
