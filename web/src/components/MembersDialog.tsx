import { useCallback, useEffect, useState } from 'react'
import { api, type JobMember } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { useI18n } from '@/i18n'
import { userName } from '@/lib/values'
import { useAuth } from '@ai-resume-screener/auth-client-web'

/**
 * 岗位参与人。**可见性的唯一入口** —— 加进来的人才看得到这个岗位下的候选人。
 *
 * 可选的人 = 登录过本产品的人:auth 不提供全公司用户列表,所以只能是「来过的
 * 人」。新同事打开一次链接就会出现在这里(登录时 JIT 落库)。
 */
export function MembersDialog({
  jobId, jobTitle, onClose,
}: {
  jobId: string
  jobTitle: string
  onClose: () => void
}) {
  const { t } = useI18n()
  const { isLocal } = useAuth()
  const [members, setMembers] = useState<JobMember[]>([])
  const [canManage, setCanManage] = useState(false)
  const [candidates, setCandidates] = useState<Array<{ id: string; name: string; email: string | null }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const r = await api.members(jobId)
    setMembers(r.members)
    setCanManage(r.canManage)
    return r
  }, [jobId])

  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([api.members(jobId), api.users()])
      .then(([m, us]) => {
        // 载入期间可能已经切走/关掉了 —— 不校验就会把上一个岗位的成员
        // 显示在这一个头上。
        if (!alive) return
        setMembers(m.members)
        setCanManage(m.canManage)
        setCandidates(us)
      })
      .catch(() => { if (alive) setError(t('members.loadFailed')) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [jobId, t])

  const act = useCallback(async (p: Promise<unknown>) => {
    setError(null)
    try {
      await p
      await reload()
    } catch (e) {
      // 静默失败最糟:以为加上了,实际没有,而可见性正是靠这个决定的。
      setError(errorMessage(e, t))
    }
  }, [reload, t])

  const memberIds = new Set(members.map((m) => m.userId))
  const addable = candidates.filter((c) => !memberIds.has(c.id))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/30 p-4" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-xl bg-elevated shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题固顶 / 按钮固底 / 中间滚动 */}
        <div className="shrink-0 border-b border-line px-5 py-3.5">
          <h2 className="text-sm font-semibold">{t('members.title', { job: jobTitle })}</h2>
          <p className="mt-0.5 text-xs text-fg-faint">{t('members.subtitle')}</p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <p className="py-8 text-center text-sm text-fg-faint">{t('common.loading')}</p>
          ) : (
            <>
              <ul className="space-y-1.5">
                {members.map((m) => (
                  <li key={m.userId} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface">
                    <span className="min-w-0 flex-1 truncate text-sm">{userName(m.name, isLocal, t)}</span>
                    {m.role === 'owner' ? (
                      <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[10px] text-fg-muted">{t('members.owner')}</span>
                    ) : null}
                    {canManage && m.role !== 'owner' ? (
                      <button
                        onClick={() => void act(api.removeMember(jobId, m.userId))}
                        className="shrink-0 text-xs text-fg-faint hover:text-danger-fg"
                      >{t('members.remove')}</button>
                    ) : null}
                  </li>
                ))}
              </ul>

              {canManage ? (
                <div className="mt-4 border-t border-line pt-3">
                  <p className="mb-1.5 text-xs text-fg-faint">{t('members.addTitle')}</p>
                  {addable.length === 0 ? (
                    <p className="text-xs text-fg-faint">
                      {t('members.noneAddable')}
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {addable.map((c) => (
                        <li key={c.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface">
                          <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                          <button
                            onClick={() => void act(api.addMember(jobId, c.id))}
                            className="shrink-0 rounded border border-line px-2 py-0.5 text-xs hover:bg-bg"
                          >{t('members.add')}</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}

              {error ? (
                <p className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-xs text-danger-fg">{error}</p>
              ) : null}
            </>
          )}
        </div>

        <div className="shrink-0 border-t border-line px-5 py-3 text-right">
          <button onClick={onClose} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-surface">
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
