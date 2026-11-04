import { useState } from 'react'
import { cn } from '@/lib/cn'
import type { EvaluationDetail, Evidence } from '@/lib/api'
import { GradeBadge, ScoreBar } from './GradeBadge'

/** 原文引用。**每条结论都必须配** —— 拿不出引用的结论在服务端就被丢弃了。
 *  这是产品可信度的核心:HR 能顺着引用回到简历原文自己判断。 */
function EvidenceList({ items }: { items: Evidence[] }) {
  if (!items.length) return null
  return (
    <div className="mt-1.5 space-y-1">
      {items.map((e, i) => (
        <blockquote
          key={i}
          className="border-l-2 border-line pl-2.5 text-xs leading-relaxed text-fg-muted"
        >
          「{e.quote}」
          {e.section ? <span className="ml-1 text-fg-faint">· {e.section}</span> : null}
        </blockquote>
      ))}
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-2.5 flex items-baseline gap-2 text-sm font-semibold">
        {title}
        {hint ? <span className="text-xs font-normal text-fg-faint">{hint}</span> : null}
      </h3>
      {children}
    </section>
  )
}

export function EvaluationView({ evaluation }: { evaluation: EvaluationDetail }) {
  const [showBreakdown, setShowBreakdown] = useState(false)
  const e = evaluation
  // 快照只用来查维度的中文名与权重。**不能假设它一定完好**:服务端对它走的是
  // safeParse(容错解析),老数据/写坏的行会退化成空壳;这里再兜一次,拿不到就
  // 让维度显示成 key —— 分数与引用照常可见,比整页白屏强得多。
  const dimLabel = new Map((e.scorecardSnapshot?.dimensions ?? []).map((d) => [d.key, d]))

  return (
    <div>
      {/* 档位 + 总分。总分可点开看计算过程 —— 「这个分怎么来的」永远只有一次点击距离。 */}
      <div className="mb-5 flex items-center gap-3">
        <GradeBadge grade={e.grade} />
        <button
          onClick={() => setShowBreakdown((v) => !v)}
          className="text-xs text-fg-faint underline decoration-dotted underline-offset-2 hover:text-fg-muted"
        >
          {e.weightedScore != null ? `${Math.round(e.weightedScore)} 分` : '—'} · 看计算过程
        </button>
        <span className="ml-auto text-xs text-fg-faint">
          {e.tier === 'deep' ? '深度评估' : '快速评估'}
          {e.model ? ` · ${e.model}` : ''}
        </span>
      </div>

      {showBreakdown && e.extras.breakdown ? (
        <div className="mb-5 rounded-xl border border-line bg-surface/50 p-3">
          <table className="w-full text-xs">
            <thead className="text-fg-faint">
              <tr><th className="pb-1 text-left font-normal">维度</th>
                <th className="pb-1 text-right font-normal">得分</th>
                <th className="pb-1 text-right font-normal">权重</th>
                <th className="pb-1 text-right font-normal">贡献</th></tr>
            </thead>
            <tbody>
              {e.extras.breakdown.map((b) => (
                <tr key={b.key} className="border-t border-line">
                  <td className="py-1">{b.label}</td>
                  <td className="py-1 text-right tabular-nums">{b.score}/5</td>
                  <td className="py-1 text-right tabular-nums text-fg-faint">{b.weight}%</td>
                  <td className="py-1 text-right tabular-nums">{b.contribution}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-fg-faint">
            1-5 分线性映射到 0-100（1 分 = 0），再按权重加权。这里用的是本次评估当时的评分卡快照。
          </p>
        </div>
      ) : null}

      {e.summary ? <p className="mb-5 text-sm leading-relaxed">{e.summary}</p> : null}

      <Section title="硬性门槛" hint="不通过只标红,不自动淘汰">
        <div className="space-y-1.5">
          {e.gateResults.map((g) => {
            const tone = g.pass === true
              ? 'border-line'
              : g.pass === false
                ? 'border-gate-fail/30 bg-gate-fail-bg/50'
                : 'border-line bg-surface/50'
            return (
              <div key={g.key} className={cn('rounded-lg border p-2.5', tone)}>
                <div className="flex items-center gap-2 text-sm">
                  {/* 文字色跟着底色走:前两档压在【业务色】上,配固定白字;
                      未知档压在语义 token bg-fg-faint 上,必须用 text-bg 才能跟着皮肤翻。 */}
                  <span className={cn(
                    'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px]',
                    g.pass === true
                      ? 'bg-grade-a text-grade-fg'
                      : g.pass === false
                        ? 'bg-gate-fail text-gate-fail-fg'
                        : 'bg-fg-faint text-bg',
                  )}>
                    {g.pass === true ? '✓' : g.pass === false ? '✕' : '?'}
                  </span>
                  <span className="font-medium">{g.label}</span>
                  {/* unknown 是「简历未提及」,不是「不满足」——灰色而非红色。 */}
                  {g.pass === 'unknown' ? <span className="text-xs text-fg-faint">简历未提及</span> : null}
                  <span className="ml-auto text-[11px] text-fg-faint">
                    {g.judgedBy === 'code' ? '规则判定' : 'AI 判定'}
                  </span>
                </div>
                {g.reason ? <p className="mt-1 pl-6 text-xs text-fg-muted">{g.reason}</p> : null}
                <div className="pl-6"><EvidenceList items={g.evidence} /></div>
              </div>
            )
          })}
        </div>
      </Section>

      <Section title="维度评分" hint="每条结论均可追溯到简历原文">
        <div className="space-y-3.5">
          {e.scores.map((s) => {
            const d = dimLabel.get(s.key)
            return (
              <div key={s.key}>
                <div className="mb-1 flex items-baseline gap-2 text-sm">
                  <span className="font-medium">{d?.label ?? s.key}</span>
                  <span className="tabular-nums text-fg-muted">{s.score}/5</span>
                  <span className="ml-auto text-xs text-fg-faint">权重 {d?.weight ?? '—'}%</span>
                </div>
                <ScoreBar score={s.score} />
                <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">{s.reason}</p>
                <EvidenceList items={s.evidence} />
              </div>
            )
          })}
        </div>
      </Section>

      {e.highlights.length ? (
        <Section title="亮点">
          <ul className="space-y-2">
            {e.highlights.map((h, i) => (
              <li key={i} className="text-sm">
                <span className="text-grade-a">·</span> {h.text}
                <EvidenceList items={h.evidence} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {e.concerns.length ? (
        <Section title="存疑" hint="仅事实层面,不含人格推测">
          <ul className="space-y-2">
            {e.concerns.map((c, i) => (
              <li key={i} className="text-sm">
                <span className="text-grade-c">·</span> {c.text}
                <EvidenceList items={c.evidence} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {/* ── 以下是精评独有产出 ── */}

      {e.extras.peerContext ? (
        <Section title="横向定位" hint={`同岗位 ${e.extras.peerContext.cohortSize} 人中`}>
          <div className="space-y-1.5">
            {e.extras.peerContext.dimensions.map((d) => (
              <div key={d.key} className="flex items-center gap-2 text-xs">
                <span className="w-32 shrink-0 truncate text-fg-muted">{d.label}</span>
                <span className="tabular-nums">第 {d.rank} 名</span>
                <span className={cn(
                  'rounded px-1.5 py-0.5',
                  d.vsMedian === 'above' ? 'bg-grade-a-bg text-grade-a'
                    : d.vsMedian === 'below' ? 'bg-grade-c-bg text-grade-c'
                      : 'bg-surface text-fg-faint',
                )}>
                  {d.vsMedian === 'above' ? '高于中位' : d.vsMedian === 'below' ? '低于中位' : '等于中位'}
                </span>
                <span className="text-fg-faint">中位数 {d.median}</span>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {e.extras.followUpQuestions?.length ? (
        <Section title="面试追问建议" hint="针对存疑点与低分维度">
          <ul className="space-y-2.5">
            {e.extras.followUpQuestions.map((q, i) => (
              <li key={i} className="rounded-lg border border-line p-2.5">
                <p className="text-sm">{q.question}</p>
                <p className="mt-1 text-xs text-fg-faint">为什么问：{q.rationale}</p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {e.extras.verdict ? (
        <Section title="倾向" hint="仅供参考,最终由你决定">
          <div className="rounded-xl border border-line p-3">
            <div className="text-sm font-medium">
              {{
                recommend: '推荐面试', lean_recommend: '倾向推荐',
                lean_pass: '倾向放弃', pass: '不建议面试',
              }[e.extras.verdict.stance] ?? e.extras.verdict.stance}
            </div>
            <p className="mt-1.5 text-xs text-fg-muted">主要依据：{e.extras.verdict.mainReason}</p>
            <p className="mt-1 text-xs text-fg-muted">主要顾虑：{e.extras.verdict.mainConcern}</p>
          </div>
        </Section>
      ) : null}
    </div>
  )
}
