// 解析队列。4 段范式:
//   ① 防重入 Set  ② 失败退避  ③ 启动对账  ④ 定时 tick
// 不引入 cron 逻辑 —— 解析是「上传即入队」的一次性任务,没有周期概念。
//
// **单进程前提**:systemd 单元是 Type=simple + 单条 ExecStart,所以用进程内
// Set 防重入就够,不需要租约(leaseExpiresAt)。多进程部署时这里要重做。
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { env } from '../../env.js'
import type { FastifyBaseLogger } from 'fastify'
import { prisma } from '../../db.js'
import { attachResume } from '../dedup/merge.js'
import { notifyParseBatchIfDone } from '../notify/batch.js'
import { RenderError, renderPdf } from '../render.js'
import { extractResume } from './extract.js'
import { deriveFields } from './derive.js'
import { PARSER_VERSION, PROMPT_VERSION } from './prompt.js'

const TICK_MS = 5_000
/** 一次 tick 最多捞几条。渲染/LLM 各自有信号量,这里只是别一次性把上千条读进内存。 */
const BATCH = 10
const MAX_ATTEMPTS = 3
/** 重试也不会好的错误(缺程序、文件本身的问题):第一次就标失败,不让用户白等退避。 */
const PERMANENT_ERRORS = new Set(['poppler_missing', 'pdf_encrypted', 'pdf_corrupt', 'page_too_large', 'docx_too_large'])
/** docx 解压后大小上限:word/document.xml 单条、全部条目合计。 */
const DOCX_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
const DOCX_MAX_TOTAL_BYTES = 50 * 1024 * 1024

class DocxTooLargeError extends Error {
  readonly code = 'docx_too_large'
  constructor(detail: string) { super(`docx 解压后过大:${detail}`) }
}

/**
 * mammoth 解压之前,先按真实解压结果校验大小。
 *
 * **不能只信中央目录里声明的解压大小**:那是攻击者可控的字段,jszip(mammoth 内部用它)
 * 要等整段解压完才比对声明值,伪造一个小的声明值就能在比对前把内存撑爆。所以这里
 * 逐条目用 zlib 的 `maxOutputLength` 实际解压,超过上限时 zlib 直接抛错、不会继续分配,
 * 内存占用有硬上限。压缩数据的位置与长度取自中央目录,和 jszip 读取的是同一段字节。
 * 结构异常(找不到目录、zip64、未知压缩方式、数据越界)一律拒绝。
 */
function assertDocxWithinLimits(buf: Buffer): void {
  const eocdMin = Math.max(0, buf.length - 22 - 0xffff)
  let eocd = -1
  for (let i = buf.length - 22; i >= eocdMin; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new DocxTooLargeError('找不到 zip 中央目录')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  let total = 0
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw new DocxTooLargeError('zip 中央目录损坏')
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    if (compSize === 0xffffffff || localOff === 0xffffffff) throw new DocxTooLargeError('zip64 条目')
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) throw new DocxTooLargeError('zip 本地文件头损坏')
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28)
    if (dataStart + compSize > buf.length) throw new DocxTooLargeError('zip 数据越界')

    const limit = Math.min(name === 'word/document.xml' ? DOCX_MAX_DOCUMENT_BYTES : Infinity, DOCX_MAX_TOTAL_BYTES - total)
    let actual: number
    if (method === 0) {
      actual = compSize
    } else if (method === 8) {
      try {
        actual = inflateRawSync(buf.subarray(dataStart, dataStart + compSize), { maxOutputLength: limit + 1 }).length
      } catch (e) {
        if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') actual = limit + 1
        else throw new DocxTooLargeError(`${name} 压缩数据损坏`)
      }
    } else {
      throw new DocxTooLargeError(`不支持的压缩方式 ${method}`)
    }
    if (actual > limit) {
      throw new DocxTooLargeError(name === 'word/document.xml' && limit === DOCX_MAX_DOCUMENT_BYTES
        ? `document.xml 超过 ${DOCX_MAX_DOCUMENT_BYTES} 字节`
        : `条目合计超过 ${DOCX_MAX_TOTAL_BYTES} 字节`)
    }
    total += actual
    off += 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32)
  }
}

/** 送进 prompt 的文本硬上限。防 zip bomb 与超大粘贴把进程撑爆。 */
const MAX_TEXT_CHARS = 512 * 1024

/** 真实类型(magic-byte 判定)→ 解析分支。**不信任客户端给的文件名**。 */
const DISPATCH: Record<string, 'pdf' | 'docx' | 'image'> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
}

/** 防重入:同一 job 上一次没跑完就不再触发。 */
const running = new Set<string>()

/**
 * 指数退避。`attempt` 是**已用掉的次数**(从 1 起,见调用点的 `job.attempt + 1`),
 * 所以指数要减 1 —— 否则首档 30s 永远取不到,第一次重试就等满 2 分钟。
 *
 * MAX_ATTEMPTS=3 → 实际只会用到 attempt=1、2,即 **30s → 2min**。
 * 解析失败大多是 LLM 瞬时超时,第一次隔 30 秒重试就能恢复,让用户干等两分钟
 * 没有任何好处。
 */
function retryDelayMs(attempt: number): number {
  return 30_000 * 4 ** Math.max(0, attempt - 1)
}

/** 归一化错误码。**不要把原始错误信息落进 parseError** —— 它会显示给用户,
 *  而原始信息可能带文件路径甚至简历内容片段。原始信息只进日志。 */
function normalizeError(e: unknown): { code: string; detail: string } {
  const detail = e instanceof Error ? e.message : String(e)
  if (e instanceof RenderError) return { code: e.code, detail }
  if (e instanceof DocxTooLargeError) return { code: e.code, detail }
  if (/timeout|超时/i.test(detail)) return { code: 'llm_timeout', detail }
  if (/JSON 解析失败|结构校验失败/.test(detail)) return { code: 'bad_model_output', detail }
  return { code: 'internal_error', detail }
}

/** 解析一份文件:渲染 → 抽取 → 派生 → 落库。失败抛错,由调用方决定退避还是终止。 */
async function parseFile(resumeFileId: string, log?: FastifyBaseLogger): Promise<void> {
  const file = await prisma.resumeFile.findUnique({ where: { id: resumeFileId } })
  if (!file) throw new Error(`ResumeFile ${resumeFileId} 不存在`)

  // ⚠️ **按落库的 mimeType 分派,不按 filename** —— filename 是 multipart 里
  // 客户端完全控制的字符串,而 mimeType 来自 file-store 的 magic-byte 判定。
  // 用文件名分派会让那道校验形同虚设:内容是 PDF、名字叫 x.notes,就会掉进
  // 兜底分支被当 UTF-8 文本原样塞进 prompt。
  const kind = DISPATCH[file.mimeType] ?? 'text'
  const ext = extname(file.storagePath).toLowerCase()
  let imagePaths: string[] | undefined
  let text: string | undefined
  let truncated = false
  let totalPages: number | null = null

  if (kind === 'pdf') {
    await prisma.resumeFile.update({ where: { id: file.id }, data: { parseState: 'rendering' } })
    const r = await renderPdf(file.storagePath, file.sha256)
    imagePaths = r.pagePaths
    truncated = r.truncated
    totalPages = r.totalPages
  } else if (kind === 'docx') {
    // docx 是唯一不转图的例外:Word 简历是单栏文字流,版面不携带信息,
    // 转文本无损;而 docx→图要把 LibreOffice 整个拖进依赖。
    //
    // 用 convertToHtml 而不是 extractRawText:保留标题/加粗/列表这些结构标记,
    // 模型据此区分「公司名」和「职责条目」。convertToMarkdown 已被 mammoth 废弃
    // (类型定义里都没有了)。
    const mammoth = await import('mammoth')
    // docx 是 zip 容器:20MB 的压缩包解出几十 GB 是可以构造的,而落盘校验只看
    // 压缩后大小。mammoth 会先全量解压再解析,等它返回再查长度已经晚了(进程先被
    // OOM kill),所以解压前先读中央目录校验未压缩大小。
    const docxBuf = await readFile(file.storagePath)
    assertDocxWithinLimits(docxBuf)
    const { value } = await mammoth.convertToHtml({ buffer: docxBuf })
    if (value.length > MAX_TEXT_CHARS) {
      throw new Error(`docx 抽出文本 ${value.length} 字,超过 ${MAX_TEXT_CHARS} 上限`)
    }
    text = value
  } else if (kind === 'image') {
    // ⚠️ **必须复制到每份文件独立的目录**,不能直接用 uploads 里的原件路径。
    // provider 会把子进程 cwd 设成 dirname(images[0]),而 uploads 目录里躺着
    // **所有候选人的简历原件** —— 模型带着 Read 工具,一句「请读取本目录下所有
    // 文件」的提示注入就能把全库 PII 读进这一份的解析结果里,而且根本不需要
    // 越出 cwd,那道边界防线在这条路径上完全失效。
    // PDF 走 renderPdf 天然落在 resume-pages/<sha>/ 独立目录,不受影响。
    const dir = join(env.DATA_DIR, 'resume-pages', file.sha256)
    await mkdir(dir, { recursive: true })
    const page = join(dir, `page-01${ext || '.png'}`)
    await copyFile(file.storagePath, page).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e
    })
    imagePaths = [page]
  } else {
    const buf = await readFile(file.storagePath, 'utf8')
    if (buf.length > MAX_TEXT_CHARS) {
      throw new Error(`文本 ${buf.length} 字,超过 ${MAX_TEXT_CHARS} 上限`)
    }
    text = buf
  }

  await prisma.resumeFile.update({ where: { id: file.id }, data: { parseState: 'extracting' } })
  const r = await extractResume({ imagePaths, text })
  if (!r.data) throw new Error(r.error ?? '抽取失败')

  const derived = deriveFields(r.data)

  // ⚠️ LLM 调用【已经结束】才开事务 —— 单次调用 2 分钟量级,在事务里跨它会长时间持锁。
  await prisma.$transaction([
    prisma.resumeParsed.upsert({
      where: { resumeFileId: file.id },
      create: {
        resumeFileId: file.id,
        parserVersion: PARSER_VERSION,
        promptVersion: PROMPT_VERSION,
        providerId: 'claude',
        model: r.model,
        deliveryMode: r.deliveryMode,
        raw: JSON.stringify(r.data),
        derived: JSON.stringify(derived),
        latencyMs: r.latencyMs,
      },
      update: {
        parserVersion: PARSER_VERSION,
        promptVersion: PROMPT_VERSION,
        model: r.model,
        deliveryMode: r.deliveryMode,
        raw: JSON.stringify(r.data),
        derived: JSON.stringify(derived),
        latencyMs: r.latencyMs,
        // editedFields 【不动】:人工纠错是覆盖层,重新解析不该把它抹掉。
      },
    }),
    prisma.resumeFile.update({
      where: { id: file.id },
      data: {
        parseState: 'parsed',
        parseStage: null,
        parseError: null,
        ...(totalPages != null ? { pageCount: totalPages } : {}),
        // 截断意味着后面几页【没看到】,结果不完整却看起来正常 —— 必须显式标记。
        turnsExhausted: truncated,
      },
    }),
  ])

  if (r.droppedSkills.length) {
    log?.warn?.({ fileId: file.id, dropped: r.droppedSkills }, '[parse] 模型返回了词表外的技能,已丢弃')
  }

  // 去重挂主体。**必须在解析之后**:联系方式是从简历里抽出来的,上传那一刻还没有。
  // 放在事务外:去重失败(如并发撞约束)不该让已经跑完的解析结果丢掉 ——
  // 解析花了两分钟,而候选人归属可以事后人工修。
  try {
    const attached = await attachResume(file.id, r.data)
    if (attached.outcome === 'matched') {
      log?.info?.({ fileId: file.id, candidateId: attached.candidateId, by: attached.matchedBy }, '[dedup] 命中已有候选人')
    }
    if (attached.hints.length) {
      log?.info?.({ fileId: file.id, hints: attached.hints.length }, '[dedup] 产生了疑似重复提示')
    }

    // 自动建投递。上传时就选了岗位,再让人手动点一次「投递」是纯粹的多余步骤 ——
    // 而且忘了点的话,候选人解析完却不出现在任何岗位下,看起来像解析失败。
    // 同一人同一岗位有唯一约束,重复解析不会建出第二条。
    await prisma.application.create({
      data: { candidateId: attached.candidateId, jobId: file.jobId, createdById: file.uploadedById },
    }).catch((e: { code?: string }) => {
      if (e.code !== 'P2002') throw e // 已投过 → 幂等
    })
  } catch (e) {
    log?.warn?.({ err: e, fileId: file.id }, '[dedup] 归属候选人失败,解析结果已保留')
  }
}

async function runJob(jobId: string, log?: FastifyBaseLogger): Promise<void> {
  const job = await prisma.parseJob.findUnique({ where: { id: jobId } })
  if (!job || job.status !== 'queued') return

  await prisma.parseJob.update({
    where: { id: jobId },
    data: { status: 'running', startedAt: new Date(), attempt: job.attempt + 1 },
  })

  try {
    await parseFile(job.resumeFileId, log)
    await prisma.parseJob.update({
      where: { id: jobId },
      // activeKey 置空 → 释放 @@unique 占位,同一文件之后可以再入队(重新解析)。
      data: { status: 'done', finishedAt: new Date(), activeKey: null, lastError: null },
    })
    await notifyParseBatchIfDone(job.batchId, log)
  } catch (e) {
    const { code, detail } = normalizeError(e)
    const attempt = job.attempt + 1
    log?.error?.({ err: e, jobId, fileId: job.resumeFileId, attempt, code }, '[parse] 解析失败')

    if (attempt < MAX_ATTEMPTS && !PERMANENT_ERRORS.has(code)) {
      await prisma.parseJob.update({
        where: { id: jobId },
        data: {
          status: 'queued',
          nextRunAt: new Date(Date.now() + retryDelayMs(attempt)),
          lastError: code,
        },
      })
      // 退避期间保持 pending:界面显示「排队中」,而不是先闪一下失败再变回来。
      await prisma.resumeFile.update({
        where: { id: job.resumeFileId },
        data: { parseState: 'pending' },
      })
    } else {
      await prisma.$transaction([
        prisma.parseJob.update({
          where: { id: jobId },
          data: { status: 'failed', finishedAt: new Date(), activeKey: null, lastError: code },
        }),
        prisma.resumeFile.update({
          where: { id: job.resumeFileId },
          // **原件一定保留**:永远不让一份简历因为解析失败而消失。
          // 用户仍可预览原件,或粘贴文本补录。
          data: { parseState: 'failed', parseError: code, parseStage: detail.slice(0, 200) },
        }),
      ])
      // 失败也算这批「跑完了」的一部分 —— 否则一份失败就永远等不到通知。
      await notifyParseBatchIfDone(job.batchId, log)
    }
  }
}

async function tick(log?: FastifyBaseLogger): Promise<void> {
  const due = await prisma.parseJob.findMany({
    where: { status: 'queued', nextRunAt: { lte: new Date() } },
    orderBy: { nextRunAt: 'asc' },
    take: BATCH,
  })
  for (const job of due) {
    if (running.has(job.id)) continue
    running.add(job.id)
    void runJob(job.id, log)
      .catch((e) => log?.error?.({ err: e, jobId: job.id }, '[parse] runJob 未捕获异常'))
      .finally(() => running.delete(job.id))
  }
}

/** 启动对账:进程重启时任何 running 的 job 都是被中断的孤儿。
 *  **重排回 queued 而不是标 failed** —— 解析是幂等的(upsert + 内容 hash 缓存),
 *  重跑一次的代价只是一次渲染,比让用户看到一条莫名其妙的失败要好。 */
/** 卡死兜底,理由同 evaluate/queue.ts 的 sweepStuck。 */
const STUCK_MS = 30 * 60_000

/** 把被中断的 running 任务重排;attempt 已达上限的直接标 failed(OOM 崩溃循环的断路器:
 *  attempt 在开始时自增,崩溃的任务走不到 catch 里的 MAX_ATTEMPTS 检查)。 */
async function requeueInterrupted(
  rows: Array<{ id: string; resumeFileId: string; attempt: number; batchId: string | null }>,
  requeueReason: string,
  log?: FastifyBaseLogger,
): Promise<void> {
  const dead = rows.filter((r) => r.attempt >= MAX_ATTEMPTS)
  const alive = rows.filter((r) => r.attempt < MAX_ATTEMPTS)
  if (dead.length) {
    await prisma.parseJob.updateMany({
      where: { id: { in: dead.map((r) => r.id) } },
      data: { status: 'failed', finishedAt: new Date(), activeKey: null, lastError: 'max_attempts' },
    })
    await prisma.resumeFile.updateMany({
      where: { id: { in: dead.map((r) => r.resumeFileId) } },
      data: { parseState: 'failed', parseError: 'max_attempts' },
    })
    log?.error?.({ count: dead.length }, '[parse] 任务多次中断且已达重试上限,标记失败')
    for (const batchId of new Set(dead.map((r) => r.batchId))) await notifyParseBatchIfDone(batchId, log)
  }
  if (alive.length) {
    await prisma.parseJob.updateMany({
      where: { id: { in: alive.map((r) => r.id) } },
      data: { status: 'queued', nextRunAt: new Date(), lastError: requeueReason },
    })
    await prisma.resumeFile.updateMany({
      where: { id: { in: alive.map((r) => r.resumeFileId) } },
      data: { parseState: 'pending' },
    })
  }
}

async function sweepStuck(log?: FastifyBaseLogger): Promise<void> {
  const stuck = await prisma.parseJob.findMany({
    where: { status: 'running', startedAt: { lt: new Date(Date.now() - STUCK_MS) } },
    select: { id: true, resumeFileId: true, attempt: true, batchId: true },
  })
  if (!stuck.length) return
  await requeueInterrupted(stuck, 'stuck_requeued', log)
  log?.warn?.({ count: stuck.length }, '[parse] 有任务卡在 running 超过 30 分钟,已重新排队或标记失败')
}

async function reconcile(log?: FastifyBaseLogger): Promise<void> {
  const orphans = await prisma.parseJob.findMany({
    where: { status: 'running' },
    select: { id: true, resumeFileId: true, attempt: true, batchId: true },
  })
  if (!orphans.length) return
  await requeueInterrupted(orphans, 'restarted', log)
  log?.warn?.({ count: orphans.length }, '[parse] 服务重启,已处理中断的解析任务(未达上限的重新排队)')
}

let timer: ReturnType<typeof setInterval> | null = null

export function startParseQueue(log?: FastifyBaseLogger): void {
  if (timer) return
  void reconcile(log)
    .catch((e) => log?.warn?.({ err: e }, '[parse] reconcile 失败'))
    .finally(() => {
      timer = setInterval(() => {
        void tick(log)
        void sweepStuck(log).catch(() => { /* 兜底本身失败不该打断 tick */ })
      }, TICK_MS)
      timer.unref?.()
    })
}

export function stopParseQueue(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** 入队。activeKey = resumeFileId 且 @@unique,所以「同一文件重复入队」由 DB
 *  直接挡掉,不需要应用层先查再插(那中间有竞态窗口)。 */
export async function enqueueParse(
  resumeFileId: string,
  batch?: { batchId: string; createdBy: string | null },
): Promise<{ queued: boolean }> {
  try {
    await prisma.parseJob.create({
      data: { resumeFileId, activeKey: resumeFileId, batchId: batch?.batchId, createdBy: batch?.createdBy },
    })
    return { queued: true }
  } catch (e) {
    // P2002 = 唯一约束冲突 = 已经有一条在跑或排队,直接当成功。
    if ((e as { code?: string }).code === 'P2002') return { queued: false }
    throw e
  }
}

/** 文件内容 hash,用作去重键与渲染缓存目录名。 */
export function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}
