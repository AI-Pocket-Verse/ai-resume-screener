import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { api, ApiError, type JobDetail, type JobSummary, type Team } from '@/lib/api'
import { Select } from './Select'

/**
 * 岗位新建/编辑。长表单弹窗遵循项目规范:标题固顶 / 按钮固底 / 中间滚动。
 *
 * **改 JD 不会自动重算评分卡** —— 评分卡是 HR 的资产,悄悄重生成会把手工调过的
 * 权重和锚点冲掉。想重生成得去评分卡弹窗显式点。
 */
export function JobDialog({
  teams, editing, onClose, onSaved, onDeleted,
}: {
  teams: Team[]
  /** null = 新建。 */
  editing: JobSummary | null
  onClose: () => void
  onSaved: (jobId: string) => void
  onDeleted: () => void
}) {
  const [teamId, setTeamId] = useState<string | null>(editing?.team.id ?? teams[0]?.id ?? null)
  const [title, setTitle] = useState(editing?.title ?? '')
  const [location, setLocation] = useState(editing?.location ?? '')
  const [level, setLevel] = useState(editing?.level ?? '')
  const [headcount, setHeadcount] = useState(String(editing?.headcount ?? 1))
  const [status, setStatus] = useState(editing?.status ?? 'open')
  const [jdRaw, setJdRaw] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ count: number } | null>(null)

  // 编辑时把 JD 原文取回来 —— 列表接口不带它(太大)。
  useEffect(() => {
    if (!editing) return
    api.job(editing.id).then((d: JobDetail) => setJdRaw(d.jdRaw ?? '')).catch(() => {})
  }, [editing])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  async function save() {
    if (!teamId || !title.trim()) {
      setError('团队与岗位名称是必填的')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const body = {
        title: title.trim(),
        jdRaw,
        location: location.trim() || undefined,
        level: level.trim() || undefined,
        headcount: Number(headcount) || 1,
      }
      if (editing) {
        await api.updateJob(editing.id, { ...body, status, teamId })
        onSaved(editing.id)
      } else {
        const created = await api.createJob({ teamId, ...body })
        onSaved(created.id)
      }
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function remove(force: boolean) {
    if (!editing) return
    try {
      await api.deleteJob(editing.id, force)
      onDeleted()
      onClose()
    } catch (e) {
      // 409 = 岗位下还有候选人,后端要求显式确认 —— 这一步刻意不能一键跳过。
      if (e instanceof ApiError && e.code === 'has_candidates') {
        setConfirmDelete({ count: Number(e.extra?.candidateCount ?? 0) })
        return
      }
      setError(e instanceof ApiError ? e.message : '删除失败')
    }
  }

  const field = 'h-10 w-full rounded-lg border border-line px-3 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/15'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/30 p-6" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-elevated shadow-lg"
      >
        <div className="flex shrink-0 items-center border-b border-line px-5 py-3.5">
          <h2 className="text-base font-semibold">{editing ? '编辑岗位' : '新建岗位'}</h2>
          <button onClick={onClose} className="ml-auto text-fg-faint hover:text-fg" aria-label="关闭">×</button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <label className="mb-1 block text-xs text-fg-muted">团队</label>
            <Select
              value={teamId}
              onChange={setTeamId}
              placeholder="选择团队"
              options={teams.map((t) => ({ value: t.id, label: t.name, hint: `${t._count.jobs} 个岗位` }))}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-fg-muted">岗位名称</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={field} placeholder="如：高级后端开发工程师" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-xs text-fg-muted">地点</label>
              <input value={location} onChange={(e) => setLocation(e.target.value)} className={field} placeholder="深圳" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-fg-muted">职级</label>
              <input value={level} onChange={(e) => setLevel(e.target.value)} className={field} placeholder="高级" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-fg-muted">招聘人数</label>
              <input
                type="number" min={1} value={headcount}
                onChange={(e) => setHeadcount(e.target.value)}
                className={cn(field, '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none')}
              />
            </div>
          </div>

          {editing ? (
            <div>
              <label className="mb-1 block text-xs text-fg-muted">状态</label>
              <Select
                value={status}
                onChange={setStatus}
                options={[
                  { value: 'open', label: '招聘中' },
                  { value: 'paused', label: '暂停', hint: '不再接收新简历' },
                  { value: 'closed', label: '已关闭', hint: '已招到人 / 需求取消' },
                ]}
              />
            </div>
          ) : null}

          <div>
            <label className="mb-1 block text-xs text-fg-muted">JD 原文</label>
            <textarea
              value={jdRaw}
              onChange={(e) => setJdRaw(e.target.value)}
              rows={10}
              placeholder="把 JD 粘进来。评分卡会按它生成 —— JD 越具体，评分标准越可判断。"
              className="w-full resize-y rounded-lg border border-line px-3 py-2 text-sm leading-relaxed outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
            />
            {editing ? (
              <p className="mt-1 text-xs text-fg-faint">
                改了 JD 不会自动重算评分卡；需要的话去评分卡弹窗点「按 JD 重新生成」。
              </p>
            ) : null}
          </div>

          {error ? <p className="text-xs text-danger-fg">{error}</p> : null}

          {confirmDelete ? (
            <div className="rounded-lg border border-danger-line bg-danger-bg p-3">
              <p className="text-sm text-danger-fg">
                该岗位下还有 {confirmDelete.count} 位候选人的投递与评估记录，删除后这些记录一并消失。
              </p>
              <p className="mt-1 text-xs text-fg-muted">
                候选人本身不会被删除（他们可能还投了别的岗位）。要彻底删人请去候选人列表。
              </p>
              <div className="mt-2 flex gap-2">
                <button onClick={() => setConfirmDelete(null)} className="rounded border border-line bg-bg px-2.5 py-1 text-xs">取消</button>
                <button onClick={() => void remove(true)} className="rounded bg-danger-fg px-2.5 py-1 text-xs text-bg">确认删除</button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-line px-5 py-3">
          {editing ? (
            <button onClick={() => void remove(false)} className="text-xs text-danger-fg hover:underline">
              删除岗位
            </button>
          ) : null}
          <div className="ml-auto flex gap-2">
            <button onClick={onClose} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-surface">取消</button>
            <button onClick={() => void save()} disabled={saving} className="rounded-lg bg-accent px-4 py-1.5 text-sm text-accent-fg disabled:opacity-40">
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
