import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { useI18n } from '@/i18n'

/**
 * 自定义下拉。**项目禁用原生 `<select>`** —— 它的下拉弹层由 OS/浏览器渲染,
 * 无法用 CSS 美化,和产品风格割裂。
 *
 * 浮层用 absolute 定位而非 portal:这个组件只用在弹窗表单里,外层没有
 * `overflow: hidden` 的裁剪容器。真要用到会被裁剪的地方,再改 portal 到 body。
 */
export interface SelectOption {
  value: string
  label: string
  hint?: string
}

export function Select({
  value, options, onChange, placeholder, className,
}: {
  value: string | null
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value)

  // 点外面收起 + Esc 收起。原生控件白送的行为,自己造轮子就得自己补齐,
  // 少一个都会让人觉得"这个下拉怪怪的"。
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 w-full items-center rounded-lg border border-line bg-bg px-3 text-left text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
      >
        <span className={cn('flex-1 truncate', !current && 'text-fg-faint')}>
          {current?.label ?? placeholder ?? t('select.placeholder')}
        </span>
        <span className="ml-2 text-fg-faint">{open ? '▴' : '▾'}</span>
      </button>

      {open ? (
        <div className="absolute left-0 right-0 top-11 z-20 max-h-60 overflow-y-auto rounded-lg border border-line bg-elevated py-1 shadow-lg">
          {options.length === 0 ? (
            <p className="px-3 py-2 text-xs text-fg-faint">{t('select.empty')}</p>
          ) : options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => { onChange(o.value); setOpen(false) }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface',
                o.value === value && 'bg-surface font-medium',
              )}
            >
              <span className="flex-1 truncate">{o.label}</span>
              {o.hint ? <span className="text-xs text-fg-faint">{o.hint}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
