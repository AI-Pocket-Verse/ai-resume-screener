// PDF/图片 → 页图数组。喂给模型的统一中间格式(不依赖任何模型的
// 文件直读能力,任何 vision 模型都能顶上)。
//
// **渲染只服务于模型识别,与前端预览无关** —— 前端直接读原件,不消费这里的产物。
// 所以尺寸/格式纯按「识别效果 + token 成本」调,不必迁就人眼。
import { spawn } from 'node:child_process'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { env } from '../env.js'
import { renderSemaphore } from '../utils/concurrency.js'

/** 归一化的解析错误码。**不要把原始错误信息透给前端** —— 里面可能带文件路径,
 *  甚至简历内容片段。原始信息只进服务端日志。 */
export type RenderErrorCode =
  | 'pdf_encrypted'
  | 'pdf_corrupt'
  | 'page_too_large'
  | 'render_timeout'
  | 'render_incomplete'
  | 'poppler_missing'

export class RenderError extends Error {
  constructor(
    public readonly code: RenderErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface RenderResult {
  /** 页图【绝对路径】,按页序。喂给 provider 的 images 就是它。 */
  pagePaths: string[]
  /** PDF 的真实总页数(可能大于渲染出的页数)。 */
  totalPages: number
  /** 是否因超过上限而只渲了前 N 页 —— UI 要提示用户。 */
  truncated: boolean
}

/** 跑一个子进程,拿 stdout。超时则 SIGKILL【整个进程组】—— SIGTERM 对卡死的
 *  渲染进程未必有效,而 poppler 可能已经 fork 出子进程。 */
function run(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    // detached 让子进程自成进程组,这样 kill(-pid) 能连同它的后代一起收掉。
    const child = spawn(bin, args, { detached: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        try { child.kill('SIGKILL') } catch { /* 已经退出 */ }
      }
    }, timeoutMs)

    child.stdout.on('data', (b: Buffer) => { stdout += b.toString() })
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString() })
    child.on('error', (err) => {
      clearTimeout(timer)
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') {
        reject(new RenderError('poppler_missing', `找不到 ${bin},需要安装 poppler`))
      } else {
        reject(err)
      }
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return reject(new RenderError('render_timeout', `${bin} 超过 ${timeoutMs}ms`))
      resolve({ stdout, stderr, code: code ?? -1 })
    })
  })
}

export interface PdfInfo {
  pages: number
  /** 页面尺寸(pt)。1pt = 1/72 英寸。 */
  widthPt: number
  heightPt: number
  encrypted: boolean
}

/** `pdfinfo` 秒取页数与页面尺寸,渲染【前】预检。 */
export async function inspectPdf(pdfPath: string): Promise<PdfInfo> {
  const { stdout, stderr, code } = await run('pdfinfo', [pdfPath], 15_000)
  if (code !== 0) {
    if (/password|encrypt/i.test(stderr)) throw new RenderError('pdf_encrypted', stderr.trim())
    throw new RenderError('pdf_corrupt', stderr.trim() || `pdfinfo exit ${code}`)
  }
  const pages = Number(/^Pages:\s+(\d+)$/m.exec(stdout)?.[1] ?? 0)
  const size = /^Page size:\s+([\d.]+) x ([\d.]+) pts/m.exec(stdout)
  const encrypted = /^Encrypted:\s+yes/im.test(stdout)
  if (!pages) throw new RenderError('pdf_corrupt', '读不到页数')
  return {
    pages,
    widthPt: Number(size?.[1] ?? 0),
    heightPt: Number(size?.[2] ?? 0),
    encrypted,
  }
}

/**
 * 页面尺寸预检。**60s 超时防不住内存耗尽**:PDF 规范允许 MediaBox 到
 * 200×200 英寸,而文件本身可以只有几十 KB —— 光栅化时才炸成 GB 级位图。
 *
 * 我们用 `-scale-to` 封顶输出像素,已经绕开了这个问题的主因;这里再挡一道
 * 是因为极端长宽比(如 1×200 英寸)在长边封顶后另一边会被压成几像素,
 * 渲出来什么都看不清,不如早早判失败并告诉用户。
 */
const MAX_ASPECT_RATIO = 10

export function checkPageGeometry(info: PdfInfo): void {
  const { widthPt, heightPt } = info
  if (!widthPt || !heightPt) return // 读不到尺寸就不拦,让渲染自己去报错
  const ratio = Math.max(widthPt / heightPt, heightPt / widthPt)
  if (ratio > MAX_ASPECT_RATIO) {
    throw new RenderError('page_too_large', `页面长宽比 ${ratio.toFixed(1)}:1 过于极端`)
  }
}

/** 页图文件名的补零位宽由【总页数】决定,不是渲染页数 —— 27 页的 PDF 即使
 *  只渲前 3 页,输出也是 page-01.png。所以只 readdir + 按尾部数字自然排序,
 *  **绝不按 `page-${i}.png` 构造文件名**。
 *
 *  这个坑会静默失败:构造错了就一张图都读不到 → images 为空 → provider 走纯
 *  文本单轮分支 → 模型对着没有附件的 prompt 编造一份简历,退出码 0、JSON 可
 *  解析、字段齐全。而 1~9 页的样本永远测不出来。 */
export async function listPageFiles(dir: string): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^page-\d+\.png$/.test(f))
  return files
    .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]))
    .map((f) => join(dir, f))
}

// 同一份 PDF(相同 sha256)共用一个渲染目录。按 sha 串行:后到的任务等先到的渲染完,
// 再检查缓存直接命中,而不是各自 rm 目录重渲 —— 否则后进入者会删掉先进入者正在写、
// 或已经返回给 LLM 去读的页图,先者被误判成永久失败的 pdf_corrupt。
const shaLocks = new Map<string, Promise<void>>()

async function withShaLock<T>(sha256: string, fn: () => Promise<T>): Promise<T> {
  const prev = shaLocks.get(sha256) ?? Promise.resolve()
  let unlock!: () => void
  const mine = new Promise<void>((r) => { unlock = r })
  const tail = prev.then(() => mine)
  shaLocks.set(sha256, tail)
  await prev
  try {
    return await fn()
  } finally {
    unlock()
    if (shaLocks.get(sha256) === tail) shaLocks.delete(sha256)
  }
}

/**
 * 把 PDF 渲染成页图。产物按内容 hash 缓存在
 * `DATA_DIR/resume-pages/<sha256>/page-NN.png`,可随时删掉重建。
 */
export async function renderPdf(pdfPath: string, sha256: string): Promise<RenderResult> {
  const info = await inspectPdf(pdfPath)
  if (info.encrypted) throw new RenderError('pdf_encrypted', '加密 PDF')
  checkPageGeometry(info)

  const outDir = join(env.DATA_DIR, 'resume-pages', sha256)
  const limit = Math.min(info.pages, env.RESUME_MAX_PAGES)
  return withShaLock(sha256, () => renderLocked(pdfPath, info, outDir, limit))
}

/** 持有该 sha 的锁时才能调用。缓存检查必须在锁内:排队等锁期间别人可能刚渲染完。 */
async function renderLocked(
  pdfPath: string,
  info: PdfInfo,
  outDir: string,
  limit: number,
): Promise<RenderResult> {
  // 命中缓存:页数对得上就直接用。对不上说明上次渲染是半成品,重来。
  try {
    const cached = await listPageFiles(outDir)
    if (cached.length === limit) {
      return { pagePaths: cached, totalPages: info.pages, truncated: info.pages > limit }
    }
  } catch { /* 目录不存在 → 首次渲染 */ }

  const release = await renderSemaphore.acquire()
  try {
    // 半成品目录先清干净,避免上次失败留下的页混进这次的 readdir。
    await rm(outDir, { recursive: true, force: true })
    await mkdir(outDir, { recursive: true })

    const { stderr, code } = await run(
      'pdftocairo',
      [
        '-png',
        '-scale-to', String(env.RESUME_RENDER_LONG_EDGE),
        '-f', '1',
        '-l', String(limit),
        pdfPath,
        join(outDir, 'page'),
      ],
      env.RESUME_RENDER_TIMEOUT_MS,
    )
    if (code !== 0) {
      await rm(outDir, { recursive: true, force: true })
      if (/password|encrypt/i.test(stderr)) throw new RenderError('pdf_encrypted', stderr.trim())
      throw new RenderError('pdf_corrupt', stderr.trim() || `pdftocairo exit ${code}`)
    }

    const pagePaths = await listPageFiles(outDir)
    // **断言数量,不等就整份判失败**,而不是静默少几页 —— 少的那几页里可能正好
    // 是工作经历,而结果看起来完全正常。
    if (pagePaths.length !== limit) {
      await rm(outDir, { recursive: true, force: true })
      throw new RenderError(
        'render_incomplete',
        `期望 ${limit} 页,实际渲出 ${pagePaths.length} 页`,
      )
    }
    return { pagePaths, totalPages: info.pages, truncated: info.pages > limit }
  } catch (e) {
    if (!(e instanceof RenderError)) await rm(outDir, { recursive: true, force: true })
    throw e
  } finally {
    release()
  }
}
