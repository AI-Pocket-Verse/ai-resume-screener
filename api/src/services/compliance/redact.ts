import type { ResumeExtraction } from '@ai-resume-screener/shared'

/**
 * 送模型评估前的字段裁剪。
 *
 * ⚠️ **这不是 PII 保护措施,是评分质量措施**。目的是减少光环偏见 ——
 * 避免模型被姓名暗示的性别、地域,或者年龄标签带偏。**学校必须保留**,
 * 它是评估依据(学历门槛、专业相关性都靠它)。
 *
 * ⚠️ **只适用于评估步**。解析步一律把整页 PDF 渲染成图送模型,
 * 图上 PII 一应俱全,文本裁剪在那一步**物理上不可能生效** —— 早期文档把它写成
 * 通用的「送 LLM 前脱敏」,会让人实现时绕一圈才发现做不到。
 */
export function redactForEvaluation(r: ResumeExtraction): ResumeExtraction {
  return {
    ...r,
    basic: {
      ...r.basic,
      name: null,
      phone: null,
      email: null,
      // 城市保留:地点门槛要用它判。
    },
  }
}
