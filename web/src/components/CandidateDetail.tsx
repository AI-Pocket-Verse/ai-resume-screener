import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { api, type CandidateDetail as Detail, type CandidateRow, type EvaluationDetail, type ResumeData } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { useI18n } from '@/i18n'
import { decisionLabel, degreeLabel, dupFieldLabel, skillLabel } from '@/lib/values'
import { EvaluationView } from './EvaluationView'
import { TagEditor } from './TagEditor'

type Tab = 'evaluation' | 'resume' | 'raw'

export function CandidateDetail({
  row, jobId, onAnalyze, onDecide, onChanged,
}: {
  row: CandidateRow
  /** 当前岗位。标签按岗位存,所以打标签时要带上。 */
  jobId: string
  onAnalyze: (tier: 'screen' | 'deep') => void
  onDecide: (d: 'pass' | 'reject' | 'hold' | null) => void
  onChanged: () => void
}) {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('evaluation')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [evaluation, setEvaluation] = useState<EvaluationDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setEvaluation(null)
    api.candidate(row.candidateId)
      .then(async (d) => {
        if (!alive) return
        setDetail(d)
        // 当前有效结论 = 该投递下最新的那条(服务端已按 deep 优先规则排好)。
        const appl = d.applications.find((a) => a.id === row.applicationId)
        const latest = appl?.evaluations.slice().sort((a, b) =>
          (a.tier === b.tier ? 0 : a.tier === 'deep' ? -1 : 1)
          || +new Date(b.createdAt) - +new Date(a.createdAt))[0]
        if (latest) {
          const ev = await api.evaluation(latest.id)
          // **await 之后必须再查一次 alive**:这一步 resolve 时用户可能已经切到
          // 别人了,不检查就会把上一个人的评估显示在当前这个人名下 ——
          // 在简历筛选里就是「看着 B 的名字读 A 的评估」,可能据此做出决定。
          if (alive) setEvaluation(ev)
        }
      })
      .catch(() => { /* 详情拿不到时下面会显示空态 */ })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [row.candidateId, row.applicationId])

  const parsed = detail?.files.find((f) => f.parsed)?.parsed ?? null

  /** 合并/忽略/撤销这类一次性动作的统一收口:成功刷新,失败必须让用户看见 ——
   *  静默吞掉的话用户只会反复点同一个按钮,以为没生效。 */
  async function act(p: Promise<unknown>): Promise<void> {
    try {
      await p
      onChanged()
    } catch (e) {
      setActionError(errorMessage(e, t))
      setTimeout(() => setActionError(null), 4000)
    }
  }

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden">
      {/* 顶部信息条 */}
      <div className="shrink-0 border-b border-line px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{row.name}</h2>
              {detail?.aliases.length ? (
                <span className="text-xs text-fg-faint">{t('candidate.alias', { names: detail.aliases.join(t('common.listSep')) })}</span>
              ) : null}
            </div>
            <p className="mt-0.5 text-sm text-fg-muted">
              {row.currentCompany ?? '—'}
              {row.currentIsPast && row.currentCompany ? t('candidate.past') : ''}
              {row.totalYears != null ? t('candidate.experience', { n: row.totalYears }) : t('candidate.yearsUnknown')}
              {parsed?.data.basic.city ? ` · ${parsed.data.basic.city}` : ''}
            </p>
            {detail ? (
              <p className="mt-1 text-xs text-fg-faint">
                {detail.identifiers.map((i) => i.value).join(' · ') || t('candidate.noContact')}
                {/* 说清楚这是脱敏后的值,否则会被当成「库里存的就是这样」而去
                    重新解析/找 HR 报错。 */}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 gap-1.5">
              <button onClick={() => onAnalyze('screen')} className="rounded-lg border border-line px-2.5 py-1.5 text-xs hover:bg-surface">
                {t('candidate.reanalyze')}
              </button>
            <button onClick={() => onAnalyze('deep')} className="rounded-lg bg-accent px-2.5 py-1.5 text-xs text-accent-fg hover:opacity-90">
              {t('candidate.deep')}
            </button>
          </div>
        </div>

        {/* 疑似重复提示。没有「忽略」的话这条会永远弹。合并/忽略都是写操作,
            只读身份看得到提示但不给按钮。 */}
        {(detail?.duplicateHints ?? []).map((h) => (
          <div key={h.id} className="mt-3 flex items-center gap-2 rounded-lg bg-warning-bg px-3 py-2 text-xs text-warning-fg">
            <span className="flex-1">
              {t('candidate.dup.hint', { name: h.otherName ?? t('candidate.dup.otherName'), field: dupFieldLabel(h.matchedField, t) })}
            </span>
            <button
              onClick={() => { void act(api.mergeCandidate(row.candidateId, h.otherId)) }}
              className="rounded border border-warning-line px-2 py-0.5 hover:bg-bg/50"
            >{t('candidate.dup.merge')}</button>
            <button
              onClick={() => { void act(api.dismissHint(h.id)) }}
              className="rounded px-2 py-0.5 hover:bg-bg/50"
            >{t('candidate.dup.dismiss')}</button>
          </div>
        ))}

        {detail?.wasRedirected ? (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-xs text-fg-muted">
            <span className="flex-1">{t('candidate.merged')}</span>
            <button
              onClick={() => { void act(api.undoMerge(row.candidateId)) }}
              className="rounded border border-line px-2 py-0.5 hover:bg-bg"
            >{t('candidate.undoMerge')}</button>
          </div>
        ) : null}

        {parsed?.data.injectionSuspected ? (
          <div className="mt-3 rounded-lg bg-warning-bg px-3 py-2 text-xs text-warning-fg">
            {t('candidate.injection')}
            <span className="mt-1 block opacity-80">{parsed.data.injectionEvidence}</span>
          </div>
        ) : null}

        {detail ? (
          <div className="mt-3">
            <TagEditor candidateId={row.candidateId} jobId={jobId} tags={detail.tags} onChanged={onChanged} />
          </div>
        ) : null}

        {actionError ? (
          <p className="mt-2 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg">{actionError}</p>
        ) : null}

        {/* HR 结论 —— 唯一的候选人状态真相源,后续流程走飞书。
            只读身份看得到当前结论(那是重要信息),但改不了。 */}
        <div className="mt-3 flex items-center gap-1.5">
          <span className="text-xs text-fg-faint">{t('candidate.decision')}</span>
          {(['pass', 'hold', 'reject'] as const).map((v) => (
            <button
              key={v}
              onClick={() => onDecide(row.hrDecision === v ? null : v)}
              className={cn(
                'rounded-lg border px-2.5 py-1 text-xs transition-colors',
                row.hrDecision === v ? 'border-accent bg-accent text-accent-fg' : 'border-line hover:bg-surface',
              )}
            >{decisionLabel(v, t)}</button>
          ))}
        </div>
      </div>

      {/* tabs */}
      <div className="flex shrink-0 gap-4 border-b border-line px-5">
        {(['evaluation', 'resume', 'raw'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={cn(
              '-mb-px border-b-2 py-2.5 text-sm transition-colors',
              tab === k ? 'border-line-strong font-medium' : 'border-transparent text-fg-faint hover:text-fg-muted',
            )}
          >{t(`candidate.tab.${k}`)}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <p className="mt-16 text-center text-sm text-fg-faint">{t('common.loading')}</p>
        ) : tab === 'evaluation' ? (
          evaluation
            ? <EvaluationView evaluation={evaluation} />
            : <NotAnalyzed onAnalyze={() => onAnalyze('screen')} />
        ) : tab === 'resume' ? (
          parsed ? <ResumeView data={parsed.data} /> : <p className="text-sm text-fg-faint">{t('candidate.notParsed')}</p>
        ) : (
          <pre className="whitespace-pre-wrap break-all rounded-lg bg-surface p-3 text-xs leading-relaxed">
            {JSON.stringify(parsed?.data ?? {}, null, 2)}
          </pre>
        )}
      </div>
    </div>
  )
}

/** 解析完但没分析 —— 这是常态,不是异常:让 HR 先确认解析无误
 *  再决定花算力,误传一批文件不会白烧一小时。 */
function NotAnalyzed({ onAnalyze }: { onAnalyze: () => void }) {
  const { t } = useI18n()
  return (
    <div className="mx-auto mt-20 max-w-sm rounded-xl border border-dashed border-line p-8 text-center">
      <p className="text-sm text-fg-muted">{t('candidate.notAnalyzed')}</p>
      <p className="mt-1 text-xs text-fg-faint">{t('candidate.analyzeCost')}</p>
      <button onClick={onAnalyze} className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm text-accent-fg hover:opacity-90">
        {t('candidate.startAnalyze')}
      </button>
    </div>
  )
}

function ResumeView({ data }: { data: ResumeData }) {
  const { t, lang } = useI18n()
  return (
    <div className="space-y-6 text-sm">
      {data.work.length ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t('resume.work')}</h3>
          <div className="space-y-3">
            {data.work.map((w, i) => (
              <div key={i} className="border-l-2 border-line pl-3">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{w.company}</span>
                  <span className="text-fg-muted">{w.title ?? ''}</span>
                  <span className="ml-auto text-xs text-fg-faint">
                    {w.start ?? '?'} ~ {w.end === 'present' ? t('resume.present') : (w.end ?? '?')}
                  </span>
                </div>
                <ul className="mt-1 space-y-0.5 text-xs text-fg-muted">
                  {w.responsibilities.map((r, j) => <li key={j}>· {r}</li>)}
                  {w.achievements.map((a, j) => <li key={`a${j}`} className="text-grade-a">· {a}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {data.project.length ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t('resume.project')}</h3>
          <div className="space-y-2.5">
            {data.project.map((p, i) => (
              <div key={i} className="border-l-2 border-line pl-3">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{p.name}</span>
                  {/* workIndex 决定了评估时能否判断这个项目是在什么规模的公司做的 */}
                  <span className="text-xs text-fg-faint">
                    {p.workIndex != null ? (data.work[p.workIndex]?.company ?? `work#${p.workIndex}`) : t('resume.soloProject')}
                  </span>
                </div>
                {p.techStack.length ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {p.techStack.map((t) => (
                      <span key={t} className="rounded bg-surface px-1.5 py-0.5 text-[11px] text-fg-muted">{t}</span>
                    ))}
                  </div>
                ) : null}
                {p.description ? <p className="mt-1 text-xs text-fg-muted">{p.description}</p> : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {data.education.length ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t('resume.education')}</h3>
          {data.education.map((e, i) => (
            <div key={i} className="flex items-baseline gap-2">
              <span className="font-medium">{e.school}</span>
              <span className="text-fg-muted">{e.major ?? ''} {degreeLabel(e.degree, lang, t)}</span>
              <span className="ml-auto text-xs text-fg-faint">{e.start ?? '?'} ~ {e.end ?? '?'}</span>
            </div>
          ))}
        </section>
      ) : null}

      {data.skill.length ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{t('resume.skills')}</h3>
          <div className="flex flex-wrap gap-1.5">
            {data.skill.map((s) => (
              <span key={s.name} className="rounded-lg bg-surface px-2 py-1 text-xs">
                {skillLabel(s.name, lang)}{s.level ? <span className="ml-1 text-fg-faint">{s.level}</span> : null}
              </span>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
