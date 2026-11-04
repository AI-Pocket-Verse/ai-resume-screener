import { useCallback, useEffect, useRef, useState } from 'react'
import { AuthProvider } from '@ai-resume-screener/auth-client-web'
import { Button } from '@/components/Button'
import { cn } from '@/lib/cn'
import { api, type CandidateRow, type JobSummary, type Me, type Scorecard, type Team } from '@/lib/api'
import { CandidateDetail } from '@/components/CandidateDetail'
import { CandidateList } from '@/components/CandidateList'
import { JobNav } from '@/components/JobNav'
import { ScorecardDialog } from '@/components/ScorecardDialog'
import { UploadZone } from '@/components/UploadZone'
import { JobDialog } from '@/components/JobDialog'
import { MembersDialog } from '@/components/MembersDialog'
import { Shell } from '@/components/Shell'
import { analyzeTargets, isUnanalyzed } from '@/lib/list'
import { errorMessage } from '@/lib/errors'
import { useI18n } from '@/i18n'
import { teamName } from '@/lib/values'

// 登录可选。不设置 → 本地单用户模式。反向代理把同源 /auth/* 转给 feishu-sso 时，
// 设置 VITE_SSO_BASE=/auth（写在 web/.env.local 或构建时注入），api 也要同时设置 WHOAMI_URL。
const ssoBase = (import.meta.env.VITE_SSO_BASE as string | undefined) || undefined

export function App() {
  return (
    <AuthProvider config={{ ssoBase }}>
      {/* 岗位导航(JobNav)是【业务数据】,不是外壳导航,所以留在内容区当第一列。 */}
      <Workspace />
    </AuthProvider>
  )
}

function Workspace() {
  const { t } = useI18n()
  const [teams, setTeams] = useState<Team[]>([])
  const [jobs, setJobs] = useState<JobSummary[]>([])
  const [job, setJob] = useState<JobSummary | null>(null)
  // 回调里读当前岗位一律走这个 ref —— useCallback 捕获的 job 会过期(见 openScorecard)。
  const jobRef = useRef<JobSummary | null>(null)
  const [rows, setRows] = useState<CandidateRow[]>([])
  const [selected, setSelected] = useState<CandidateRow | null>(null)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  // 打开评分卡弹窗前先把**已有的**评分卡取回来。写死 null 的话,已配置好的岗位
  // 打开也会显示「还没有评分卡」,HR 只能重新生成 —— 手工调过的权重与锚点全丢。
  const [scorecard, setScorecard] = useState<{ open: boolean; data: Scorecard | null; loading: boolean }>({ open: false, data: null, loading: false })

  const [showUpload, setShowUpload] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)
  const [jobDialog, setJobDialog] = useState<{ open: boolean; editing: JobSummary | null }>({ open: false, editing: null })
  const [toast, setToast] = useState<string | null>(null)
  // 登录即可用,写操作不再分档 —— 能看到这个岗位就说明你是它的成员。
  // 只有「彻底删除 / 审计日志」留给超管。
  const [me, setMe] = useState<Me | null>(null)
  const canDelete = me?.isSuperAdmin ?? false

  const notify = useCallback((m: string) => {
    setToast(m)
    setTimeout(() => setToast(null), 3200)
  }, [])

  /**
   * 打开评分卡弹窗。
   *
   * ⚠️ **必须显式传目标岗位,不能依赖闭包里的 `job`**:新建岗位后要自动引导配置
   * 评分卡,而那时 `setJob(新岗位)` 还没反映到这个 useCallback 捕获的 `job` 上,
   * 拿到的仍是【新建之前】选中的旧岗位 —— 弹窗标题和 jobId 是新岗位、数据却是
   * 旧岗位的评分卡,点一下保存就把旧岗位的权重锚点写进了新岗位。
   */
  const openScorecard = useCallback(async (target?: JobSummary) => {
    const j = target ?? jobRef.current
    if (!j) return
    setScorecard({ open: true, data: null, loading: j.hasScorecard })
    if (!j.hasScorecard) return
    try {
      const detail = await api.job(j.id)
      // 载入期间用户可能又切走了 —— 只有目标仍是当前岗位时才填数据,
      // 否则会把上一个岗位的评分卡显示在这一个头上。
      if (jobRef.current?.id !== j.id) return
      setScorecard({
        open: true,
        loading: false,
        data: detail.scorecard
          ? { gates: detail.scorecard.gates, dimensions: detail.scorecard.dimensions }
          : null,
      })
    } catch {
      setScorecard((s) => ({ ...s, loading: false }))
      notify(t('app.toast.scorecardLoadFailed'))
    }
  }, [notify, t])

  useEffect(() => {
    Promise.all([api.teams(), api.jobs(), api.me()])
      .then(([t, j, m]) => {
        setTeams(t)
        setJobs(j)
        setMe(m)
        if (j.length) setJob((cur) => cur ?? j[0]!)
      })
      .catch(() => notify(t('app.toast.loadFailed')))
  }, [notify, t])

  const reloadRows = useCallback(() => {
    if (!job) return
    const requested = job.id
    api.candidates(requested)
      // 快速切岗位时旧请求可能后返回。不校验的话,标题写着 B、列表却是 A 的人,
      // 而且要等下一次轮询才会自己纠正。
      .then((rs) => { if (jobRef.current?.id === requested) setRows(rs) })
      .catch(() => { /* 拿不到时保持原列表,不闪空 */ })
  }, [job])

  useEffect(() => {
    jobRef.current = job
    setSelected(null)
    setSelection(new Set())
    reloadRows()
  }, [job, reloadRows])

  // 解析与分析都是分钟级后台任务。没有推送通道时轮询最简单可靠,
  // 但**只在确实有任务在跑时轮询** —— 空闲时不打扰服务端。
  useEffect(() => {
    const busy = rows.some((r) => r.analyzing || (r.parseState !== 'parsed' && r.parseState !== 'failed'))
    if (!busy) return
    const t = setInterval(reloadRows, 5000)
    return () => clearInterval(t)
  }, [rows, reloadRows])

  const analyze = useCallback(async (applicationIds: string[], tier: 'screen' | 'deep') => {
    if (!applicationIds.length) return
    if (job && !job.hasScorecard) {
      notify(t('app.toast.needScorecard'))
      void openScorecard(job)
      return
    }
    try {
      const r = await api.analyze(applicationIds, tier)
      notify(r.queued > 0 ? t('app.toast.queued', { n: r.queued }) : t('app.toast.alreadyQueued'))
      reloadRows()
    } catch (e) {
      notify(errorMessage(e, t, 'error.triggerFailed'))
    }
  }, [job, notify, reloadRows, t])

  // 「一键分析」= 分析全部【未分析的】,不重跑已分析项 —— 避免误点烧掉一小时算力。
  const unanalyzed = rows.filter(isUnanalyzed)

  // 批量彻底删除。**二次确认不可省** —— 这个操作删记录 + 原件 + 渲染图,不可撤销。
  const bulkDelete = useCallback(async () => {
    const picked = rows.filter((r) => selection.has(r.applicationId))
    if (!picked.length) return
    const names = picked.slice(0, 3).map((r) => r.name).join(t('common.listSep')) +
      (picked.length > 3 ? t('app.confirm.more') : '')
    const ok = window.confirm(t('app.confirm.bulkDelete', { count: picked.length, names }))
    if (!ok) return
    try {
      const r = await api.bulkDeleteCandidates(picked.map((p) => p.candidateId))
      notify(t('app.toast.deleted', { n: r.deleted, mb: (r.bytesFreed / 1024 / 1024).toFixed(1) }))
      setSelection(new Set())
      setSelected(null)
      reloadRows()
    } catch (e) {
      notify(errorMessage(e, t, 'error.deleteFailed'))
    }
  }, [rows, selection, notify, reloadRows, t])

  // 标题与动作交给外壳的顶栏 —— 页面本体不再自绘 header,也不重复 h1。
  const chrome = {
    title: job?.title ?? t('shell.productName'),
    subtitle: job ? t('app.subtitle', { team: teamName(job.team, t), n: rows.length }) : t('app.subtitle.empty'),
    actions: (
      <>
        {/* 能看到这个岗位 = 你是它的成员,写操作一律放开。 */}
        <Button variant="ghost" size="sm" disabled={!job} onClick={() => setShowUpload((v) => !v)}>
          {t('app.btn.upload')}
        </Button>
        <Button variant="ghost" size="sm" disabled={!job} onClick={() => setMembersOpen(true)}>
          {t('app.btn.members')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!job}
          onClick={() => void openScorecard(job ?? undefined)}
          // 未配置评分卡是【待办提示】,不是错误 —— 走共享的 warning 而非 danger。
          //(别用 grade-c:那是「评级 C」的业务色,不是通用警告色)
          className={cn(job && !job.hasScorecard && 'border-warning-line bg-warning-bg text-warning-fg')}
        >
          {job && !job.hasScorecard ? t('app.btn.scorecardPending') : t('app.btn.scorecard')}
        </Button>
        {/* 彻底删除不可撤销,且跨岗位候选人只有超管删得干净。 */}
        {canDelete && selection.size > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void bulkDelete()}
            className="border-danger-line text-danger-fg hover:bg-danger-bg"
          >
            {t('app.btn.deleteSelected', { n: selection.size })}
          </Button>
        ) : null}
        <Button
          size="sm"
          disabled={!job || (selection.size === 0 && unanalyzed.length === 0)}
          onClick={() => void analyze(analyzeTargets(rows, selection), 'screen')}
        >
          {selection.size ? t('app.btn.analyzeSelected', { n: selection.size }) : t('app.btn.analyzeAll', { n: unanalyzed.length })}
        </Button>
      </>
    ),
  }

  return (
    <Shell {...chrome}>
      <div className="flex h-full min-h-0 overflow-hidden">
        <JobNav
          teams={teams}
          jobs={jobs}
          activeJobId={job?.id ?? null}
          onSelect={setJob}
          onNewJob={() => setJobDialog({ open: true, editing: null })}
          onEditJob={(j) => setJobDialog({ open: true, editing: j })}
        />

        <div className="flex min-w-0 flex-1 flex-col">

          {showUpload ? (
            <div className="shrink-0 border-b border-line px-5 py-4">
              <UploadZone jobId={job?.id ?? null} onUploaded={reloadRows} />
            </div>
          ) : null}

          <div className="flex min-h-0 flex-1">
            <CandidateList
              rows={rows}
              selectedId={selected?.applicationId ?? null}
              onSelect={setSelected}
              selection={selection}
              onToggleSelect={(id) => setSelection((s) => {
                const next = new Set(s)
                if (next.has(id)) next.delete(id)
                else next.add(id)
                return next
              })}
            />

            {selected && job ? (
              <CandidateDetail
                row={selected}
                jobId={job.id}
                onAnalyze={(tier) => void analyze([selected.applicationId], tier)}
                onDecide={(d) => {
                  void api.decide(selected.applicationId, d)
                    .then(() => {
                      notify(d ? t('app.toast.decided') : t('app.toast.decisionCleared'))
                      reloadRows()
                    })
                    // 静默失败最糟:HR 以为结论记下了,实际后端没收到。
                    .catch((e) => notify(errorMessage(e, t)))
                }}
                onChanged={reloadRows}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-fg-faint">
                {t('app.empty.pickCandidate')}
              </div>
            )}
          </div>
        </div>

        {membersOpen && job ? (
          <MembersDialog jobId={job.id} jobTitle={job.title} onClose={() => setMembersOpen(false)} />
        ) : null}

        {jobDialog.open ? (
          <JobDialog
            teams={teams}
            editing={jobDialog.editing}
            onClose={() => setJobDialog({ open: false, editing: null })}
            onSaved={(jobId) => {
              notify(jobDialog.editing ? t('app.toast.jobUpdated') : t('app.toast.jobCreated'))
              void api.jobs().then((js) => {
                setJobs(js)
                const target = js.find((j) => j.id === jobId)
                if (target) {
                  setJob(target)
                  jobRef.current = target
                }
                // 新建的岗位没有评分卡,没评分卡就没法分析 —— 直接引到下一步,
                // 而不是让人自己发现「怎么点分析没反应」。
                // **显式传 target**:此刻 setJob 还没生效,靠闭包会拿到旧岗位。
                if (target && !target.hasScorecard) void openScorecard(target)
              })
            }}
            onDeleted={() => {
              notify(t('app.toast.jobDeleted'))
              void api.jobs().then((js) => { setJobs(js); setJob(js[0] ?? null) })
            }}
          />
        ) : null}

        {scorecard.open && job ? (
          <ScorecardDialog
            jobId={job.id}
            jobTitle={job.title}
            initial={scorecard.data}
            loading={scorecard.loading}
            onClose={() => setScorecard({ open: false, data: null, loading: false })}
            onSaved={() => {
              notify(t('app.toast.scorecardSaved'))
              void api.jobs().then(setJobs)
            }}
          />
        ) : null}

        {toast ? (
          <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-fg px-4 py-2 text-sm text-bg shadow-lg">
            {toast}
          </div>
        ) : null}
      </div>
    </Shell>
  )
}
