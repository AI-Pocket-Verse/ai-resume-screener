// 原件落盘。校验逻辑:
// 白名单 MIME + magic-byte 双重判定 + 大小上限。
//
// **按内容 hash 命名**(`<sha256>.<ext>`):HR 重复上传同一份 PDF 是高频行为,
// 同内容不重复落盘。注意这【只是文件级去重】—— 刻意不复用解析结果,
// 跨文件复用解析只省一次两分钟,却会带来极难复现的跨团队串扰。
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileTypeFromBuffer } from 'file-type'
import { env } from '../env.js'

export const MAX_RESUME_BYTES = 20 * 1024 * 1024

/** 能进解析链路的类型。`.doc`(老二进制)刻意不支持 —— 要拖 LibreOffice 进来,
 *  而让用户另存为 PDF/docx 是一句话的事。 */
const ALLOWED: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
}

export type FileStoreErrorCode = 'payload_too_large' | 'unsupported_media_type' | 'empty_file'

export class FileStoreError extends Error {
  constructor(public readonly code: FileStoreErrorCode, message: string) {
    super(message)
  }
}

export interface StoredFile {
  sha256: string
  storagePath: string
  mimeType: string
  ext: string
  bytes: number
}

export function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 校验并落盘。**真实类型以 magic-byte 为准**,不信任浏览器给的 Content-Type ——
 * 那是客户端说了算的,改个扩展名就能绕过白名单。
 */
export async function storeResumeFile(buf: Buffer, claimedMime?: string): Promise<StoredFile> {
  if (buf.length === 0) throw new FileStoreError('empty_file', '空文件')
  if (buf.length > MAX_RESUME_BYTES) {
    throw new FileStoreError('payload_too_large', '文件超过 20MB 上限')
  }
  if (claimedMime && !ALLOWED[claimedMime]) {
    throw new FileStoreError('unsupported_media_type', '仅支持 PDF / 图片 / docx')
  }

  const detected = await fileTypeFromBuffer(buf)
  // docx 是 zip 容器,file-type 报 application/zip 或 docx 两种都可能,
  // 两者都放行(内容真假交给 mammoth 去报错)。
  const mime = detected?.mime ?? ''
  const isDocx =
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    (mime === 'application/zip' && claimedMime && ALLOWED[claimedMime] === 'docx')
  const ext = isDocx ? 'docx' : ALLOWED[mime]
  if (!ext) throw new FileStoreError('unsupported_media_type', '文件类型与扩展名不匹配')

  const sha256 = sha256Of(buf)
  const dir = join(env.DATA_DIR, 'uploads')
  await mkdir(dir, { recursive: true })
  const storagePath = join(dir, `${sha256}.${ext}`)
  // 同 hash 已存在就不重复写(内容相同,覆盖也无意义)。
  await writeFile(storagePath, buf, { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e
  })

  return {
    sha256,
    storagePath,
    mimeType: isDocx ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : mime,
    ext,
    bytes: buf.length,
  }
}
