import { useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { api } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { useI18n } from '@/i18n'

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.docx'

/** 上传后【自动解析、不自动评估】:解析是必须的且相对便宜,
 *  评估是 1-2 分钟/份的真实开销,让 HR 先确认解析无误再决定花算力。 */
export function UploadZone({ jobId, onUploaded }: { jobId: string | null; onUploaded: () => void }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function upload(files: FileList | null) {
    if (!files?.length) return
    // 简历必须归属岗位(可见性按岗位算)。理论上进不到这里 —— 没选岗位时
    // 上传入口是禁用的 —— 但拖拽能绕过 disabled,所以这里再挡一次。
    if (!jobId) { setMsg(t('upload.pickJob')); return }
    setBusy(true)
    setMsg(null)
    let ok = 0
    const errors: string[] = []
    for (const f of Array.from(files)) {
      try {
        await api.upload(jobId, f)
        ok += 1
      } catch (e) {
        errors.push(t('upload.fileError', { name: f.name, reason: errorMessage(e, t, 'error.uploadFailed') }))
      }
    }
    setBusy(false)
    // 逐个报错而不是整批失败 —— 一份坏文件不该让另外九份白传。
    setMsg(errors.length ? t('upload.uploaded', { ok, errors: errors.join(t('upload.errorSep')) }) : t('upload.done', { ok }))
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
        <p className="text-sm text-fg-muted">{busy ? t('upload.busy') : t('upload.drop')}</p>
        <p className="mt-1 text-xs text-fg-faint">{t('upload.hint')}</p>
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
