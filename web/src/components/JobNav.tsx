import { cn } from '@/lib/cn'
import type { JobSummary, Team } from '@/lib/api'
import { useI18n } from '@/i18n'
import { jobStatusLabel, teamName } from '@/lib/values'

/** 团队 → 岗位的二级导航。团队刻意**平铺不嵌套**:
 *  一个团队通常就是一个招聘单元,再分层会带来递归权限与树形控件,却很少有实际作用。 */
export function JobNav({
  teams, jobs, activeJobId, onSelect, onNewJob, onEditJob,
}: {
  teams: Team[]
  jobs: JobSummary[]
  activeJobId: string | null
  onSelect: (job: JobSummary) => void
  onNewJob: () => void
  onEditJob: (job: JobSummary) => void
}) {
  const { t } = useI18n()
  return (
    <nav className="flex w-[252px] shrink-0 flex-col overflow-y-auto border-r border-line bg-bg px-3 py-5">
      {teams.length === 0 ? (
        <p className="px-2 text-xs text-fg-faint">{t('jobNav.noTeams')}</p>
      ) : null}

      {teams.map((team) => {
        const teamJobs = jobs.filter((j) => j.team.id === team.id)
        return (
          <div key={team.id} className="mb-5">
            <div className="mb-1.5 px-2 text-[11px] font-medium uppercase tracking-wide text-fg-faint">
              {teamName(team, t)}
            </div>
            {teamJobs.length === 0 ? (
              <p className="px-2 py-1 text-xs text-fg-faint">{t('jobNav.noJobs')}</p>
            ) : teamJobs.map((job) => (
              <button
                key={job.id}
                onClick={() => onSelect(job)}
                className={cn(
                  'group mb-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors',
                  activeJobId === job.id ? 'bg-surface font-medium' : 'hover:bg-surface/60',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{job.title}</span>
                {job.status !== 'open' ? (
                  <span className="shrink-0 rounded bg-surface px-1 text-[10px] text-fg-faint">
                    {jobStatusLabel(job.status, t)}
                  </span>
                ) : null}
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); onEditJob(job) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onEditJob(job) } }}
                  className="shrink-0 text-fg-faint opacity-0 hover:text-fg group-hover:opacity-100"
                  aria-label={t('jobNav.edit', { title: job.title })}
                >✎</span>
                {/* 没有评分卡的岗位没法评估 —— 列表要能一眼看出来,而不是点进去才发现。 */}
                {!job.hasScorecard ? (
                  <span className="shrink-0 rounded bg-warning-bg px-1 text-[10px] text-warning-fg">{t('jobNav.noScorecard')}</span>
                ) : null}
                <span className="shrink-0 text-xs tabular-nums text-fg-faint">{job.candidateCount}</span>
              </button>
            ))}
          </div>
        )
      })}

      <button
        onClick={onNewJob}
        className="mt-auto rounded-lg border border-dashed border-line px-2 py-2 text-xs text-fg-faint hover:border-fg-faint hover:text-fg-muted"
      >
        {t('jobNav.newJob')}
      </button>
    </nav>
  )
}
