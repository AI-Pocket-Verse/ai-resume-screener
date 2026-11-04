import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { api, ApiError, type Scorecard } from '@/lib/api'

/**
 * 评分卡编辑。长表单弹窗遵循项目规范:**标题固顶 / 按钮固底 / 中间滚动**。
 *
 * 权重用滑块 + 实时显示合计,不让 HR 手算 —— 权重之和不等于 100 时加权分的
 * 分母就不是 100,档位阈值(85/70/55)会全部失真,服务端也会直接拒绝保存。
 */
export function ScorecardDialog({
  jobId, jobTitle, initial, loading, onClose, onSaved,
}: {
  jobId: string
  jobTitle: string
  initial: Scorecard | null
  /** 已有评分卡正在取回。**必须和「确实没有」区分开** —— 加载中显示
   *  「还没有评分卡」会诱导 HR 去重新生成,把手工调好的权重和锚点覆盖掉。 */
  loading: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [sc, setSc] = useState<Scorecard | null>(initial)
  const [drafting, setDrafting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // useState(initial) 只在**首次挂载**时取值。弹窗是先以 data=null 打开、
  // 数据晚一步才到的,不同步的话永远停在空态。
  useEffect(() => { setSc(initial) }, [initial])

  // Esc 关闭。原生 dialog 的行为要自己补上,否则弹窗只能靠点按钮关。
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const total = sc?.dimensions.reduce((s, d) => s + d.weight, 0) ?? 0

  async function draft() {
    setDrafting(true)
    setError(null)
    try {
      setSc(await api.draftScorecard(jobId))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '生成失败')
    } finally {
      setDrafting(false)
    }
  }

  async function save() {
    if (!sc) return
    setSaving(true)
    setError(null)
    try {
      await api.saveScorecard(jobId, sc)
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  function setWeight(key: string, weight: number) {
    setSc((s) => s && { ...s, dimensions: s.dimensions.map((d) => (d.key === key ? { ...d, weight } : d)) })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/30 p-6" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-elevated shadow-lg"
      >
        {/* 标题固顶 */}
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-3.5">
          <h2 className="text-base font-semibold">评分卡 · {jobTitle}</h2>
          <button
            onClick={draft}
            disabled={drafting}
            className="ml-auto rounded-lg border border-line px-2.5 py-1.5 text-xs hover:bg-surface disabled:opacity-50"
          >
            {drafting ? '生成中…' : sc ? '按 JD 重新生成' : '按 JD 生成草稿'}
          </button>
          <button onClick={onClose} className="text-fg-faint hover:text-fg" aria-label="关闭">×</button>
        </div>

        {/* 中间滚动 */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && !sc ? (
            <p className="py-16 text-center text-sm text-fg-faint">正在读取评分卡…</p>
          ) : !sc ? (
            <div className="py-12 text-center">
              <p className="text-sm text-fg-muted">还没有评分卡</p>
              <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-fg-faint">
                评分卡把 JD 翻译成可执行的评估标准。JD 原文通常很水（「熟悉 Java、3 年以上经验、有责任心」），
                直接拿它比对，出来的只会是含糊的正确话。
              </p>
              <button onClick={draft} disabled={drafting} className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm text-accent-fg disabled:opacity-50">
                {drafting ? '生成中…' : '按 JD 生成草稿'}
              </button>
            </div>
          ) : (
            <>
              <section className="mb-6">
                <div className="mb-2 flex items-baseline gap-2">
                  <h3 className="text-sm font-semibold">评分维度</h3>
                  <span className={cn('text-xs', total === 100 ? 'text-fg-faint' : 'text-danger-fg')}>
                    权重合计 {total}{total !== 100 ? ' · 必须等于 100' : ''}
                  </span>
                </div>
                <div className="space-y-4">
                  {sc.dimensions.map((d) => (
                    <div key={d.key} className="rounded-xl border border-line p-3">
                      <div className="flex items-center gap-3">
                        <span className="flex-1 text-sm font-medium">{d.label}</span>
                        <input
                          type="range" min={0} max={60} step={5}
                          value={d.weight}
                          onChange={(e) => setWeight(d.key, Number(e.target.value))}
                          className="w-40 accent-accent"
                        />
                        <span className="w-10 text-right text-sm tabular-nums">{d.weight}%</span>
                      </div>
                      {/* anchors 是评分稳定的基础设施,地位等同解析层的受控词表 ——
                          所以要让 HR 看得见、改得动,而不是藏起来。 */}
                      <div className="mt-2 space-y-1 text-xs">
                        {(['5', '3', '1'] as const).map((lv) => (
                          <div key={lv} className="flex gap-2">
                            <span className="w-8 shrink-0 text-fg-faint">{lv} 分</span>
                            <textarea
                              value={d.anchors[lv]}
                              onChange={(e) => setSc((s) => s && {
                                ...s,
                                dimensions: s.dimensions.map((x) =>
                                  x.key === d.key ? { ...x, anchors: { ...x.anchors, [lv]: e.target.value } } : x),
                              })}
                              rows={2}
                              className="flex-1 resize-none rounded border border-line px-2 py-1 leading-relaxed outline-none focus:border-accent"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">硬性门槛</h3>
                <div className="space-y-1.5">
                  {sc.gates.map((g, i) => (
                    <div key={i} className="rounded-lg border border-line px-3 py-2 text-xs">
                      <span className="font-medium">{String(g.label ?? g.key)}</span>
                      <span className="ml-2 text-fg-faint">
                        {'nl' in g ? `AI 判定：${String(g.nl)}` : `规则判定：${String(g.field)} ${String(g.op)} ${JSON.stringify(g.value)}`}
                      </span>
                    </div>
                  ))}
                  {sc.gates.length === 0 ? <p className="text-xs text-fg-faint">没有硬性门槛</p> : null}
                </div>
                <p className="mt-2 text-xs text-fg-faint">门槛不通过只标红并降档，不会自动淘汰。</p>
              </section>
            </>
          )}
          {error ? <p className="mt-3 text-xs text-danger-fg">{error}</p> : null}
        </div>

        {/* 按钮固底 */}
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-5 py-3">
          <p className="flex-1 text-xs text-fg-faint">保存后立即生效；已有的评估保留各自的评分卡快照，不受影响。</p>
          <button onClick={onClose} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-surface">取消</button>
          <button
            onClick={save}
            disabled={!sc || saving || total !== 100}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm text-accent-fg disabled:opacity-40"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
