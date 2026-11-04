import type { FastifyInstance } from 'fastify'
import { createId, isCuid } from '@paralleldrive/cuid2'
import { z } from 'zod'
import { prisma } from '../db.js'
import { FileStoreError, storeResumeFile } from '../services/file-store.js'
import { enqueueParse } from '../services/parse/queue.js'
import { audit } from '../services/compliance/audit.js'
import { canAccessJob, jobScopeWhere, visibleJobIds } from '../utils/authz.js'
import { safeParse, safeParseObject } from '../utils/json.js'

const ERROR_STATUS: Record<string, number> = {
  payload_too_large: 413,
  unsupported_media_type: 415,
  empty_file: 400,
}

/** 解析失败码 → 给用户看的中文说明。**不透原始错误信息** —— 里面可能带
 *  服务器路径,甚至简历内容片段。 */
const PARSE_ERROR_TEXT: Record<string, string> = {
  pdf_encrypted: '这份 PDF 有密码保护,请提供无密码版本',
  pdf_corrupt: 'PDF 文件损坏或格式异常,无法读取',
  page_too_large: '页面尺寸异常,无法渲染',
  render_timeout: '渲染超时,文件可能过于复杂',
  render_incomplete: '渲染不完整,请重试',
  poppler_missing: '服务器缺少 PDF 渲染组件,请联系管理员',
  llm_timeout: '模型响应超时,请重试',
  bad_model_output: '模型返回的内容无法解析,请重试',
  docx_too_large: 'Word 文件解压后体积异常,无法解析',
  max_attempts: '解析多次中断,已停止重试,请重新上传或粘贴文本',
  internal_error: '解析失败,请重试或联系管理员',
}

/**
 * 一次多选上传共用的批次号(用于「这批跑完了」通知)。客户端指定,所以只接受 cuid 格式,
 * 并拼上调用者 id:不同用户即使用了同一个值也不会串批次、把通知发给别人。
 */
function uploadBatchId(header: string | string[] | undefined, userId: string): string {
  const v = Array.isArray(header) ? header[0] : header
  return v && isCuid(v) ? `${userId}:${v}` : createId()
}

export async function fileRoutes(app: FastifyInstance) {
  /** 上传简历原件。落盘 → 建 ResumeFile → 自动入队解析(解析自动)。
   *
   *  **jobId 必填**:可见性按岗位算,没有岗位归属的简历规则覆盖不到。
   *  multipart 里的普通字段要从 `part.fields` 取,不在 req.body 里。 */
  app.post('/api/files', { preHandler: app.requireAuth() }, async (req, reply) => {
    const part = await req.file()
    if (!part) return reply.code(400).send({ error: 'missing_file' })

    const jobId = (part.fields?.jobId as { value?: unknown } | undefined)?.value
    if (typeof jobId !== 'string' || !jobId) {
      return reply.code(400).send({ error: 'missing_job', message: '请先选择要投递的岗位' })
    }
    // 往自己看不到的岗位传简历 = 越权写入。用 404 而不是 403:后者等于确认
    // 「这个岗位存在」。
    if (!(await canAccessJob(req, jobId))) return reply.code(404).send({ error: 'job_not_found' })

    const buf = await part.toBuffer()
    let stored
    try {
      stored = await storeResumeFile(buf, part.mimetype)
    } catch (e) {
      if (e instanceof FileStoreError) {
        return reply.code(ERROR_STATUS[e.code] ?? 400).send({ error: e.code, message: e.message })
      }
      throw e
    }

    const file = await prisma.resumeFile.create({
      data: {
        source: 'upload',
        jobId,
        sha256: stored.sha256,
        filename: part.filename,
        mimeType: stored.mimeType,
        bytes: stored.bytes,
        storagePath: stored.storagePath,
        uploadedById: req.user!.id,
      },
    })
    // 前端逐个 POST 上传,所以每次调用自成一批。要把一次多选上传合成一批,
    // 需要前端传同一个 batchId —— 见下方 batchId 参数。
    await enqueueParse(file.id, {
      batchId: uploadBatchId(req.headers['x-upload-batch'], req.user!.id),
      createdBy: req.user!.open_id ?? null,
    })

    return reply.code(201).send({ id: file.id, filename: file.filename, parseState: file.parseState })
  })

  /** 粘贴文本/markdown 建档。走的是同一条解析链路,只是不落原件文件。 */
  app.post('/api/files/paste', { preHandler: app.requireAuth() }, async (req, reply) => {
    const body = z.object({
      jobId: z.string().min(1, '请先选择要投递的岗位'),
      text: z.string().min(20, '内容太短'),
      filename: z.string().default('粘贴的简历.md'),
    }).safeParse(req.body)
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', details: body.error.flatten() })
    }
    if (!(await canAccessJob(req, body.data.jobId))) {
      return reply.code(404).send({ error: 'job_not_found' })
    }
    const buf = Buffer.from(body.data.text, 'utf8')
    const { sha256Of } = await import('../services/file-store.js')
    const sha256 = sha256Of(buf)
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { env } = await import('../env.js')
    const dir = join(env.DATA_DIR, 'uploads')
    await mkdir(dir, { recursive: true })
    const storagePath = join(dir, `${sha256}.md`)
    await writeFile(storagePath, buf)

    const file = await prisma.resumeFile.create({
      data: {
        source: 'paste',
        jobId: body.data.jobId,
        sha256,
        filename: body.data.filename.endsWith('.md') ? body.data.filename : `${body.data.filename}.md`,
        mimeType: 'text/markdown',
        bytes: buf.length,
        storagePath,
        uploadedById: req.user!.id,
      },
    })
    await enqueueParse(file.id, { batchId: createId(), createdBy: req.user!.open_id ?? null })
    return reply.code(201).send({ id: file.id, filename: file.filename, parseState: file.parseState })
  })

  /** 列表。轮询解析进度也走它。 */
  app.get('/api/files', { preHandler: app.requireAuth() }, async (req) => {
    const q = z.object({
      parseState: z.string().optional(),
      limit: z.coerce.number().min(1).max(200).default(50),
    }).parse(req.query)

    const scope = await visibleJobIds(req)
    const rows = await prisma.resumeFile.findMany({
      where: {
        ...(q.parseState ? { parseState: q.parseState } : {}),
        ...jobScopeWhere(scope),
      },
      orderBy: { uploadedAt: 'desc' },
      take: q.limit,
      include: { parsed: { select: { derived: true, updatedAt: true } } },
    })

    return rows.map((f) => ({
      id: f.id,
      filename: f.filename,
      bytes: f.bytes,
      pageCount: f.pageCount,
      parseState: f.parseState,
      parseError: f.parseError ? (PARSE_ERROR_TEXT[f.parseError] ?? '解析失败') : null,
      truncated: f.turnsExhausted,
      uploadedAt: f.uploadedAt,
      derived: f.parsed ? safeParse(f.parsed.derived, null) : null,
    }))
  })

  /** 详情:解析结果 = raw 叠加人工纠错的 editedFields。 */
  app.get('/api/files/:id', { preHandler: app.requireAuth() }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const f = await prisma.resumeFile.findUnique({ where: { id }, include: { parsed: true } })
    if (!f) return reply.code(404).send({ error: 'not_found' })
    if (!(await canAccessJob(req, f.jobId))) return reply.code(404).send({ error: 'not_found' })

    const rawFull = f.parsed ? safeParse<Record<string, unknown> | null>(f.parsed.raw, null) : null
    const editedFull = f.parsed ? safeParseObject(f.parsed.editedFields) : {}

    // 这个接口返回的 parsed.data 里就有姓名 / 手机 / 邮箱 —— 它和候选人详情
    // 一样是 PII 出口,之前**只有候选人详情记了 view_pii**,从这里读走完整
    // 联系方式不留任何痕迹,等于审计有个正门大小的缺口。
    if (f.parsed) {
      await audit({
        actorId: req.user!.id, action: 'view_pii', targetType: 'resume_file',
        targetId: f.id, targetLabel: f.filename,
      }, req.log)
    }
    const raw = rawFull
    const edited = editedFull

    return {
      id: f.id,
      filename: f.filename,
      mimeType: f.mimeType,
      bytes: f.bytes,
      pageCount: f.pageCount,
      parseState: f.parseState,
      parseError: f.parseError ? (PARSE_ERROR_TEXT[f.parseError] ?? '解析失败') : null,
      truncated: f.turnsExhausted,
      uploadedAt: f.uploadedAt,
      parsed: f.parsed && {
        // 覆盖层叠加在 raw 之上;raw 永不覆写,这样才能算「AI 抽取准确率」也能撤销。
        data: { ...raw, ...edited },
        raw,
        editedFields: edited,
        derived: safeParse(f.parsed.derived, null),
        parserVersion: f.parsed.parserVersion,
        model: f.parsed.model,
        deliveryMode: f.parsed.deliveryMode,
        latencyMs: f.parsed.latencyMs,
      },
    }
  })

  /** 重新解析。activeKey 的唯一约束会挡掉重复入队。 */
  app.post('/api/files/:id/reparse', { preHandler: app.requireAuth() }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const f = await prisma.resumeFile.findUnique({ where: { id } })
    if (!f) return reply.code(404).send({ error: 'not_found' })
    if (!(await canAccessJob(req, f.jobId))) return reply.code(404).send({ error: 'not_found' })
    const r = await enqueueParse(id)
    if (r.queued) {
      await prisma.resumeFile.update({ where: { id }, data: { parseState: 'pending', parseError: null } })
    }
    return { queued: r.queued }
  })
}
