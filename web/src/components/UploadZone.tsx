import { useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { api, ApiError } from '@/lib/api'

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.docx'

/** 上传后【自动解析、不自动评估】:解析是必须的且相对便宜,
 *  评估是 1-2 分钟/份的真实开销,让 HR 先确认解析无误再决定花算力。 */
export function UploadZone({ jobId, onUploaded }: { jobId: string | null; onUploaded: () => void }) {
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function upload(files: FileList | null) {
    if (!files?.length) return
    // 简历必须归属岗位(可见性按岗位算)。理论上进不到这里 —— 没选岗位时
    // 上传入口是禁用的 —— 但拖拽能绕过 disabled,所以这里再挡一次。
    if (!jobId) { setMsg('请先选择一个岗位'); return }
    setBusy(true)
    setMsg(null)
    let ok = 0
    const errors: string[] = []
    for (const f of Array.from(files)) {
      try {
        await api.upload(jobId, f)
        ok += 1
      } catch (e) {
        errors.push(`${f.name}：${e instanceof ApiError ? e.message : '上传失败'}`)
      }
    }
    setBusy(false)
    // 逐个报错而不是整批失败 —— 一份坏文件不该让另外九份白传。
    setMsg(errors.length ? `已上传 ${ok} 份；${errors.join('；')}` : `已上传 ${ok} 份，正在解析`)
    onUploaded()
  }

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void upload(e.dataTransfer.files) }}
        onClick={() => inputRef.current?.click()}
        className={cn(
          'cursor-pointer rounded-xl border border-dashed p-6 text-center transition-colors',
          dragging ? 'border-grade-b bg-grade-b-bg' : 'border-line hover:border-fg-faint',
        )}
      >
        <p className="text-sm text-fg-muted">{busy ? '上传中…' : '拖拽简历到这里，或点击选择'}</p>
        <p className="mt-1 text-xs text-fg-faint">支持 PDF / 图片 / Word（.docx），单份 20MB 以内</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => { void upload(e.target.files); e.target.value = '' }}
        />
      </div>
      {msg ? <p className="mt-2 text-xs text-fg-muted">{msg}</p> : null}
    </div>
  )
}
