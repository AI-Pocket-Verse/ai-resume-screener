// 通知卡片拼装(纯函数,便于测)。
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

function actionButton(text: string, url: string) {
  return {
    tag: 'action',
    actions: [{ tag: 'button', text: { tag: 'plain_text', content: text }, type: 'primary', url }],
  }
}

export function buildParseDoneCard(s: ParseBatchSummary): unknown {
  const lines = [`${s.total} 份简历解析完成。`]
  if (s.failed > 0) {
    // 失败数放在成功数之后单独说 —— 混在一句里容易被扫过去,而失败的那几份
    // 需要人去看一眼(原件仍在,可重试或粘贴文本补录)。
    lines.push(`其中 ${s.failed} 份解析失败，原件已保留，可在列表中重试。`)
  }
  if (s.injectionSuspected > 0) {
    // 检出了但只在详情页角落显示的话,等于没检出 —— HR 不会逐个点开看。
    // 措辞刻意中性:简历里写提示词的 AI 从业者是正常候选人,不是攻击者,
    // 这里要的是「去看一眼」,不是「这人有问题」。
    lines.push(`其中 ${s.injectionSuspected} 份含疑似操纵评估的内容，已照常分析，建议人工核对。`)
  }
  lines.push('解析完成后不会自动分析，请确认信息无误后再决定是否分析。')
  return {
    config: { wide_screen_mode: true },
    header: {
      template: s.failed > 0 || s.injectionSuspected > 0 ? 'orange' : 'blue',
      title: { tag: 'plain_text', content: '简历解析完成' },
    },
    elements: [
      ...lines.map((content) => ({ tag: 'div', text: { tag: 'plain_text', content } })),
      actionButton('去看看', s.jobUrl),
    ],
  }
}

export function buildEvalDoneCard(s: EvalBatchSummary): unknown {
  const dist = (['A', 'B', 'C', 'D'] as const)
    .filter((g) => s.grades[g])
    .map((g) => `${g} 档 ${s.grades[g]} 人`)
    .join(' · ')

  const lines = [`「${s.jobTitle}」${s.done} 份分析完成。`]
  if (dist) lines.push(dist)
  if (s.failed > 0) lines.push(`${s.failed} 份分析失败，可在列表中重试。`)
  lines.push('评估结果仅供参考，请结合简历原文自行判断。')

  return {
    config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text', content: '简历分析完成' } },
    elements: [
      ...lines.map((content) => ({ tag: 'div', text: { tag: 'plain_text', content } })),
      actionButton('查看结果', s.jobUrl),
    ],
  }
}
