import { useMemo, useState } from 'react'
import { cn } from '@/lib/cn'
import type { CandidateRow } from '@/lib/api'
import { useI18n } from '@/i18n'
import { decisionLabel } from '@/lib/values'
// 筛选/计数/徽标逻辑抽在 lib/list 里单测 —— 这些分支是前端真正容易算错的地方。
import { FILTERS, countByFilter, filterRows, rowBadges, type Filter } from '@/lib/list'
import { GradeBadge, ScoreText } from './GradeBadge'

const DECISION_CLS: Record<string, string> = {
  pass: 'bg-grade-a-bg text-grade-a',
  reject: 'bg-gate-fail-bg text-gate-fail',
  hold: 'bg-grade-c-bg text-grade-c',
}

export function CandidateList({
  rows, selectedId, onSelect, selection, onToggleSelect,
}: {
  rows: CandidateRow[]
  selectedId: string | null
  onSelect: (r: CandidateRow) => void
  selection: Set<string>
  onToggleSelect: (id: string) => void
}) {
  const { t } = useI18n()
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')

  const filtered = useMemo(() => filterRows(rows, filter, q), [rows, filter, q])
  // 各档人数直接标在 chip 上 —— HR 一眼看到分布,不用逐个筛选点一遍。
  const counts = useMemo(() => countByFilter(rows), [rows])

  return (
    <div className="flex h-full w-[400px] shrink-0 flex-col border-r border-line">
      <div className="border-b border-line p-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('list.search')}
          className="h-9 w-full rounded-lg border border-line bg-bg px-3 text-sm outline-none placeholder:text-fg-faint focus:border-accent focus:ring-2 focus:ring-accent/15"
        />
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs transition-colors',
                filter === f.key
                  ? 'border-accent bg-accent text-accent-fg'
                  : 'border-line text-fg-muted hover:bg-surface',
              )}
            >
              {t(f.label)}
              {counts[f.key] ? <span className="ml-1 opacity-60">{counts[f.key]}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between px-3 py-2 text-xs text-fg-faint">
        <span>{t('list.total', { n: filtered.length })}</span>
        {selection.size > 0 ? <span className="text-grade-b">{t('list.selected', { n: selection.size })}</span> : null}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {filtered.length === 0 ? (
          <div className="mt-16 text-center text-sm text-fg-faint">{t('list.empty')}</div>
        ) : (
          filtered.map((r) => (
            <CandidateCard
              key={r.applicationId}
              row={r}
              active={selectedId === r.applicationId}
              checked={selection.has(r.applicationId)}
              onSelect={() => onSelect(r)}
              onToggle={() => onToggleSelect(r.applicationId)}
            />
          ))
        )}
      </div>
    </div>
  )
}

function CandidateCard({
  row, active, checked, onSelect, onToggle,
}: {
  row: CandidateRow; active: boolean; checked: boolean; onSelect: () => void; onToggle: () => void
}) {
  const { t } = useI18n()
  const decisionCls = row.hrDecision ? DECISION_CLS[row.hrDecision] : undefined

  return (
    <div
      onClick={onSelect}
      className={cn(
        'mb-1.5 cursor-pointer rounded-xl border p-3 transition-colors',
        active ? 'border-line-strong bg-surface' : 'border-line hover:bg-surface/60',
      )}
    >
      <div className="flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={checked}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggle}
          // accent-accent = accent-color: var(--accent)。【不要写成 accent-ink】——
          // 那里的 accent- 是 Tailwind 的 accent-color 前缀,ink 已随迁移删除,
          // 类名会被静默丢弃,复选框回落成浏览器默认蓝。
          className="mt-1 h-3.5 w-3.5 shrink-0 accent-accent"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{row.name}</span>
            {row.hrDecision && decisionCls ? (
              <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[11px]', decisionCls)}>{decisionLabel(row.hrDecision, t)}</span>
            ) : null}
          </div>
          <div className="mt-0.5 truncate text-xs text-fg-muted">
            {row.currentCompany ?? '—'}
            {row.currentIsPast && row.currentCompany ? <span className="text-fg-faint">{t('list.past')}</span> : null}
            {row.totalYears != null ? t('list.years', { n: row.totalYears }) : ''}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <GradeBadge grade={row.verdict?.grade ?? null} size="sm" />
          <ScoreText score={row.verdict?.score ?? null} />
        </div>
      </div>

      {row.verdict?.summary ? (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-fg-muted">{row.verdict.summary}</p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {rowBadges(row, t).map((b) => (
          <span
            key={b.text}
            className={cn(
              'rounded px-1.5 py-0.5 text-[11px]',
              // tone 就叫 error/warn/info —— 是【通用状态】,走共享语义色。
              // 别拿 gate-fail / grade-c 来渲染:那两个是「门槛未通过」「评级 C」的业务色,
              // 混用会让「解析失败」和「候选人被淘汰」长成同一个红。
              // info 档刻意保持中性灰(「分析中…」不该抢眼),它本来就用的是语义 token,不动。
              b.tone === 'error' ? 'bg-danger-bg text-danger-fg'
                : b.tone === 'warn' ? 'bg-warning-bg text-warning-fg'
                  : 'bg-surface text-fg-faint',
            )}
          >{b.text}</span>
        ))}
        {row.tags.map((t) => (
          <span key={t.label} className="rounded bg-surface px-1.5 py-0.5 text-[11px] text-fg-muted">
            {t.label}
          </span>
        ))}
      </div>
    </div>
  )
}
