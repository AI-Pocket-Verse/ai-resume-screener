import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'

/**
 * 业务标签:自由输入 + 自动补全。
 *
 * 自动补全不是锦上添花 —— 它是**唯一**挡住同义词的机制:打「内」就提示「内推」,
 * HR 不会再新建一个「内部推荐」。没有它,标签库半年就会烂成一堆近义词。
 */
export function TagEditor({
  candidateId, jobId, tags, onChanged,
}: {
  candidateId: string
  /** 标签属于岗位:「已面过」在这个岗位成立、在别的岗位不成立。 */
  jobId: string
  tags: Array<{ id: string; label: string; color: string | null }>
  onChanged: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [value, setValue] = useState('')
  const [suggestions, setSuggestions] = useState<Array<{ label: string; count: number }>>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (adding) inputRef.current?.focus() }, [adding])

  useEffect(() => {
    if (!adding) return
    const t = setTimeout(() => {
      api.tagSuggestions(value).then(setSuggestions).catch(() => setSuggestions([]))
    }, 150)
    return () => clearTimeout(t)
  }, [value, adding])

  async function submit(label: string) {
    const v = label.trim()
    if (!v) return
    await api.addTag(candidateId, jobId, v).catch(() => { /* 重复标签服务端会静默返回 */ })
    setValue('')
    setAdding(false)
    onChanged()
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((t) => (
        <span key={t.id} className="group inline-flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-[11px] text-fg-muted">
          {t.label}
          <button
            onClick={() => { void api.removeTag(t.id).then(onChanged).catch(() => onChanged()) }}
            className="text-fg-faint opacity-0 transition-opacity hover:text-danger-fg group-hover:opacity-100"
            aria-label={`删除标签 ${t.label}`}
          >×</button>
        </span>
      ))}

      {adding ? (
        <div className="relative">
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit(value)
              if (e.key === 'Escape') { setAdding(false); setValue('') }
            }}
            onBlur={() => setTimeout(() => setAdding(false), 150)}
            placeholder="标签名"
            className="h-6 w-24 rounded border border-line px-1.5 text-[11px] outline-none focus:border-accent"
          />
          {suggestions.length ? (
            // 浮层 absolute 定位在输入框下方。这里不在任何 overflow 容器的裁剪范围内
            // (顶部信息条不滚动),所以不需要 portal。
            <div className="absolute left-0 top-7 z-20 min-w-[120px] rounded-lg border border-line bg-elevated py-1 shadow-lg">
              {suggestions.map((s) => (
                <button
                  key={s.label}
                  onMouseDown={(e) => { e.preventDefault(); void submit(s.label) }}
                  className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[11px] hover:bg-surface"
                >
                  <span className="flex-1">{s.label}</span>
                  <span className="text-fg-faint">{s.count}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="rounded border border-dashed border-line px-1.5 py-0.5 text-[11px] text-fg-faint hover:border-fg-faint hover:text-fg-muted"
        >+ 标签</button>
      )}
    </div>
  )
}
