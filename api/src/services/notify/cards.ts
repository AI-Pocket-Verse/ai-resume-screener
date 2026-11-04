import type { Lang } from '../../utils/lang.js'

// 通知卡片拼装(纯函数,便于测)。
//
// 文案按发起人当时的界面语言(批次任务上记的 lang);中文与加语言切换前一致。
//
// 设计原则:**一批一张卡**,不是一份一张。HR 一次传 20 份简历,收到 20 条推送
// 只会把人逼到关掉通知 —— 那样连真正重要的那条也一起丢了。

export interface ParseBatchSummary {
  total: number
  parsed: number
  failed: number
  /** 这批里检出疑似操纵评估内容的份数。 */
  injectionSuspected: number
  jobUrl: string
}

export interface EvalBatchSummary {
  jobTitle: string
  total: number
  done: number
  failed: number
  /** 档位分布,只列有人的档。 */
  grades: Partial<Record<'A' | 'B' | 'C' | 'D', number>>
  jobUrl: string
}

const TEXT = {
  zh: {
    parseTitle: '简历解析完成',
    parseDone: (n: number) => `${n} 份简历解析完成。`,
    parseFailed: (n: number) => `其中 ${n} 份解析失败，原件已保留，可在列表中重试。`,
    injection: (n: number) => `其中 ${n} 份含疑似操纵评估的内容，已照常分析，建议人工核对。`,
    noAutoEval: '解析完成后不会自动分析，请确认信息无误后再决定是否分析。',
    parseBtn: '去看看',
    evalTitle: '简历分析完成',
    grade: (g: string, n: number) => `${g} 档 ${n} 人`,
    evalDone: (job: string, n: number) => `「${job}」${n} 份分析完成。`,
    evalFailed: (n: number) => `${n} 份分析失败，可在列表中重试。`,
    reference: '评估结果仅供参考，请结合简历原文自行判断。',
    evalBtn: '查看结果',
  },
  en: {
    parseTitle: 'Resumes parsed',
    parseDone: (n: number) => `${n} ${n === 1 ? 'resume' : 'resumes'} parsed.`,
    parseFailed: (n: number) => `${n} failed to parse. The originals are kept and can be retried from the list.`,
    injection: (n: number) => `${n} may contain content that tries to manipulate the evaluation. They were processed as usual; please review them manually.`,
    noAutoEval: 'Parsed resumes are not analyzed automatically. Check the details, then decide whether to analyze them.',
    parseBtn: 'Open',
    evalTitle: 'Analysis complete',
    grade: (g: string, n: number) => `Grade ${g}: ${n}`,
    evalDone: (job: string, n: number) => `"${job}": ${n} ${n === 1 ? 'resume' : 'resumes'} analyzed.`,
    evalFailed: (n: number) => `${n} failed to analyze and can be retried from the list.`,
    reference: 'Results are for reference only. Check them against the original resumes.',
    evalBtn: 'View results',
  },
} as const

function actionButton(text: string, url: string) {
  return {
    tag: 'action',
    actions: [{ tag: 'button', text: { tag: 'plain_text', content: text }, type: 'primary', url }],
  }
}

export function buildParseDoneCard(s: ParseBatchSummary, lang: Lang = 'zh'): unknown {
  const T = TEXT[lang]
  const lines: string[] = [T.parseDone(s.total)]
  if (s.failed > 0) {
    // 失败数放在成功数之后单独说 —— 混在一句里容易被扫过去,而失败的那几份
    // 需要人去看一眼(原件仍在,可重试或粘贴文本补录)。
    lines.push(T.parseFailed(s.failed))
  }
  if (s.injectionSuspected > 0) {
    // 检出了但只在详情页角落显示的话,等于没检出 —— HR 不会逐个点开看。
    // 措辞刻意中性:简历里写提示词的 AI 从业者是正常候选人,不是攻击者,
    // 这里要的是「去看一眼」,不是「这人有问题」。
    lines.push(T.injection(s.injectionSuspected))
  }
  lines.push(T.noAutoEval)
  return {
    config: { wide_screen_mode: true },
    header: {
      template: s.failed > 0 || s.injectionSuspected > 0 ? 'orange' : 'blue',
      title: { tag: 'plain_text', content: T.parseTitle },
    },
    elements: [
      ...lines.map((content) => ({ tag: 'div', text: { tag: 'plain_text', content } })),
      actionButton(T.parseBtn, s.jobUrl),
    ],
  }
}

export function buildEvalDoneCard(s: EvalBatchSummary, lang: Lang = 'zh'): unknown {
  const T = TEXT[lang]
  const dist = (['A', 'B', 'C', 'D'] as const)
    .filter((g) => s.grades[g])
    .map((g) => T.grade(g, s.grades[g]!))
    .join(' · ')

  const lines: string[] = [T.evalDone(s.jobTitle, s.done)]
  if (dist) lines.push(dist)
  if (s.failed > 0) lines.push(T.evalFailed(s.failed))
  lines.push(T.reference)

  return {
    config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text', content: T.evalTitle } },
    elements: [
      ...lines.map((content) => ({ tag: 'div', text: { tag: 'plain_text', content } })),
      actionButton(T.evalBtn, s.jobUrl),
    ],
  }
}
