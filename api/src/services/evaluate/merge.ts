import type { ResumeDerived, ResumeExtraction } from '@ai-resume-screener/shared'
import { deriveFields } from '../parse/derive.js'

/**
 * 评估读的是「合并视图」,不是 raw。
 *
 * **必须合并**:否则 HR 在核对环节把「实习」改成「全职」、把错误日期改对,
 * 对打分毫无影响 —— `editedFields` 就退化成只服务于抽取准确率统计的孤儿产物。
 *
 * **derived 必须重算**:改了日期而年限不变的话,「按年限判门槛」会用旧值,
 * 人工修正等于白做。
 */
export interface MergedResume {
  data: ResumeExtraction
  derived: ResumeDerived
}

/** 按字段路径覆盖。顶层字段整体替换(如整个 work 数组),
 *  这与 UI 的编辑粒度一致 —— 前端改一条工作经历时回传整个 work。 */
export function mergeResume(
  raw: ResumeExtraction,
  editedFields: Partial<ResumeExtraction>,
  now?: Date,
): MergedResume {
  const data = { ...raw, ...editedFields } as ResumeExtraction
  return { data, derived: deriveFields(data, now) }
}
