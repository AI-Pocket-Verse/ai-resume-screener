import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { audit } from '../services/compliance/audit.js'
import { purgeCandidate } from '../services/compliance/purge.js'
import { MergeError, mergeCandidates, undoMerge } from '../services/dedup/merge.js'
import { collectIdentifiers } from '../services/dedup/normalize.js'
import { resolveCandidate } from '../services/dedup/resolve.js'
import { canAccessCandidate, canAccessJob, jobScopeWhere, requireSuperAdmin, visibleJobIds } from '../utils/authz.js'
import { safeParse, safeParseObject } from '../utils/json.js'

/** ResumeExtraction 的数组段。缺一个,前端对应的 `data.<段>.map(...)` 就当场抛。 */
const ARRAY_SECTIONS = ['education', 'work', 'project', 'skill', 'cert'] as const

/**
 * 补齐缺失的数组段。
 *
 * `ResumeExtraction` 给每个数组段都写了 `.default([])`,但那只在**写入侧**
 * (parse/extract.ts 的 safeParse)生效;读取侧是把库里的 raw 直接摊开返回的,
 * schema 默认值一次都不过。于是:
 *   - 给 ResumeExtraction 新增一个数组段时,【历史行的 raw 里没有它】
 *   - 前端 `data.<新段>.map(...)` 直接抛 TypeError,而前端没有 ErrorBoundary
 *   → 整个候选人详情白屏,且症状与数据无关联提示,极难定位。
 *
 * 只补缺失的键,不动已有字段、不过 schema —— 过 schema 会把 editedFields 里的
 * 额外键静默剥掉,那是数据丢失,比这个问题更糟。
 */
function withEmptySections(data: Record<string, unknown>): Record<string, unknown> {
  for (const k of ARRAY_SECTIONS) if (!Array.isArray(data[k])) data[k] = []
  return data
}

/** 从可见简历里收集联系方式哈希与姓名(raw 与人工纠错层都算)。 */
function visibleBasics(files: Array<{ parsed: { raw: string; editedFields: string } | null }>): {
  hashes: Set<string>
  names: string[] // 按 files 顺序(上传时间倒序),每份取纠错后的姓名优先
} {
  const hashes = new Set<string>()
  const names: string[] = []
  for (const f of files) {
    if (!f.parsed) continue
    const layers = [safeParseObject(f.parsed.editedFields), safeParseObject(f.parsed.raw)]
    let name: string | null = null
    for (const layer of layers) {
      const basic = (layer.basic ?? null) as { name?: unknown; phone?: unknown; email?: unknown } | null
      if (!basic || typeof basic !== 'object') continue
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
      for (const i of collectIdentifiers({ phone: str(basic.phone), email: str(basic.email) })) hashes.add(i.valueHash)
      name ??= str(basic.name)?.trim() ?? null
    }
    if (name) names.push(name)
  }
  return { hashes, names }
}

export async function candidateRoutes(app: FastifyInstance) {
  /**
   * 候选人详情。查子表**统一走 resolveCandidate** —— 合并只写 mergedIntoId、
   * 不动子行,直接用裸 id 查会漏掉合并进来的那个人的简历与投递。
   */
  app.get('/api/candidates/:id', { preHandler: app.requireAuth() }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const resolved = await resolveCandidate(id)
    if (!resolved) return reply.code(404).send({ error: 'not_found' })

    // 候选人是全局唯一的(同手机号 = 同一人,跨岗位不重复录入),但**子表按
    // 你有权限的岗位过滤**:同一个人可能同时投了你看不到的岗位,那边的简历、
    // 评估、标签、HR 结论都不该出现在这里。
    const scope = await visibleJobIds(req)
    const jobFilter = jobScopeWhere(scope)

    const [candidate, files, applications, tags, hints] = await Promise.all([
      prisma.candidate.findUnique({
        where: { id: resolved.primaryId },
        include: { identifiers: true, aliases: true },
      }),
      prisma.resumeFile.findMany({
        where: { candidateId: { in: resolved.mergedIds }, ...jobFilter },
        orderBy: { uploadedAt: 'desc' },
        include: { parsed: true },
      }),
      prisma.application.findMany({
        where: { candidateId: { in: resolved.mergedIds }, ...jobFilter },
        include: {
          job: { select: { id: true, title: true } },
          evaluations: { select: { id: true, tier: true, grade: true, weightedScore: true, createdAt: true } },
        },
      }),
      prisma.candidateTag.findMany({ where: { candidateId: { in: resolved.mergedIds }, ...jobFilter } }),
      prisma.duplicateHint.findMany({
        where: { candidateId: { in: resolved.mergedIds }, dismissedAt: null },
      }),
    ])
    if (!candidate) return reply.code(404).send({ error: 'not_found' })

    // 这个候选人跟你有没有关系,取决于他有没有投过你能看到的岗位。
    // 一条都没有 = 你根本不该知道这个人存在 → 404(不是 403,那等于确认他存在)。
    if (files.length === 0 && applications.length === 0) {
      return reply.code(404).send({ error: 'not_found' })
    }

    // 能看到这个候选人 = 你是相关岗位的成员,看到的就是完整联系方式
    // (隔离之后不存在「看得到人、看不到手机号」的中间态)。仍然留痕:
    // 明文存储的防护靠「访问控制 + 审计 + 最小留存」三件事,少一件都不成立。
    await audit({
      actorId: req.user!.id, action: 'view_pii', targetType: 'candidate',
      targetId: resolved.primaryId, targetLabel: candidate.name,
    }, req.log)

    // 重复提示指向另一个候选人,而那个人可能只存在于你看不到的岗位里。
    // 「疑似与某某是同一人」这句话本身就泄露了他的存在与姓名 —— 所以先按
    // 可见性筛一遍,筛掉的提示条整条不返回(而不是返回一条没有名字的)。
    const hintOthers = await prisma.candidate.findMany({
      where: {
        id: { in: hints.map((h) => h.otherId) },
        ...(scope === null ? {} : { resumeFiles: { some: { jobId: { in: scope } } } }),
      },
      select: { id: true, name: true },
    })
    const visibleHintIds = new Set(hintOthers.map((o) => o.id))

    // Candidate 的 name / aliases / identifiers 是跨岗位合并出来的全局字段:别的岗位简历里的
    // 备用手机、邮箱、新旧姓名都会并进来。非超管只能看到【可见简历里出现过】的那部分,
    // 全局值按可见简历重新筛(不改 schema,用 identifiers.valueHash 与可见简历联系方式比对)。
    let name = candidate.name
    let aliases = candidate.aliases.map((a) => a.alias)
    let identifiers = candidate.identifiers
    if (scope !== null) {
      const vis = visibleBasics(files)
      identifiers = identifiers.filter((i) => vis.hashes.has(i.valueHash))
      aliases = aliases.filter((a) => vis.names.includes(a))
      if (!name || !vis.names.includes(name)) name = vis.names[0] ?? name
    }

    return {
      id: candidate.id,
      name,
      wasRedirected: resolved.wasRedirected,
      mergedCount: resolved.mergedIds.length - 1,
      aliases,
      identifiers: identifiers.map((i) => ({
        kind: i.kind, value: i.valueEnc, isPrimary: i.isPrimary,
      })),
      tags: tags.map((t) => ({ id: t.id, label: t.label, color: t.color })),
      files: files.map((f) => ({
        id: f.id, filename: f.filename, parseState: f.parseState,
        uploadedAt: f.uploadedAt, pageCount: f.pageCount,
        parsed: f.parsed && {
          data: withEmptySections({
            ...safeParseObject(f.parsed.raw),
            ...safeParseObject(f.parsed.editedFields),
          }),
          derived: safeParse(f.parsed.derived, null),
        },
      })),
      applications: applications.map((a) => ({
        id: a.id, job: a.job, hrDecision: a.hrDecision, evaluations: a.evaluations,
      })),
      // 弱匹配提示条:「疑似与 张三(同校同届:某某大学)是同一人 → 合并 / 忽略」
      duplicateHints: hints.filter((h) => visibleHintIds.has(h.otherId)).map((h) => ({
        id: h.id,
        otherId: h.otherId,
        otherName: hintOthers.find((o) => o.id === h.otherId)?.name ?? null,
        matchedField: h.matchedField,
      })),
    }
  })

  /** 人工合并。只写 mergedIntoId,子行一行不动 → 撤销就是置回 null。 */
  app.post('/api/candidates/:id/merge', { preHandler: app.requireAuth() }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const b = z.object({ intoId: z.string(), reason: z.string().optional() }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'invalid_request', details: b.error.flatten() })
    // 两边都要可见:只查一边的话,可以把别人岗位下的候选人合并到自己名下
    // (拿到数据),或把自己的推过去(污染别人的库)。
    const [okFrom, okInto] = await Promise.all([
      canAccessCandidate(req, id), canAccessCandidate(req, b.data.intoId),
    ])
    if (!okFrom || !okInto) return reply.code(404).send({ error: 'not_found' })

    try {
      await mergeCandidates(id, b.data.intoId, req.user!.id, b.data.reason)
    } catch (e) {
      if (e instanceof MergeError) {
        return reply.code(e.code === 'not_found' ? 404 : 409).send({ error: e.code, message: e.message })
      }
      throw e
    }
    await audit({
      actorId: req.user!.id, action: 'merge', targetType: 'candidate',
      targetId: id, detail: `合并到 ${b.data.intoId}`,
    }, req.log)
    return { ok: true }
  })

  app.post('/api/candidates/:id/undo-merge', { preHandler: app.requireAuth() }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    if (!(await canAccessCandidate(req, id))) return reply.code(404).send({ error: 'not_found' })
    try {
      await undoMerge(id, req.user!.id)
    } catch (e) {
      if (e instanceof MergeError) return reply.code(404).send({ error: e.code, message: e.message })
      throw e
    }
    await audit({ actorId: req.user!.id, action: 'undo_merge', targetType: 'candidate', targetId: id }, req.log)
    return { ok: true }
  })

  /** 忽略一条疑似重复提示。没有它,提示条会永远重复弹。 */
  app.post('/api/duplicate-hints/:id/dismiss', { preHandler: app.requireAuth() }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const hint = await prisma.duplicateHint.findUnique({ where: { id }, select: { candidateId: true } })
    if (!hint) return reply.code(404).send({ error: 'not_found' })
    if (!(await canAccessCandidate(req, hint.candidateId))) return reply.code(404).send({ error: 'not_found' })
    const updated = await prisma.duplicateHint.update({
      where: { id },
      data: { dismissedAt: new Date(), dismissedBy: req.user!.id },
    }).catch(() => null)
    if (!updated) return reply.code(404).send({ error: 'not_found' })
    return { ok: true }
  })

  // ── 标签 ────────────────────────────────────────────────────────
  // 自由输入 + 自动补全:零维护成本,自动补全挡掉大部分同义词
  //(打「内」即提示「内推」,不会再新建一个「内部推荐」)。

  /** 已有标签,按使用次数降序 —— 自动补全的数据源。 */
  app.get('/api/tags', { preHandler: app.requireAuth() }, async (req) => {
    const q = z.object({ q: z.string().optional() }).parse(req.query)
    // 补全候选词也要按可见性筛 —— 否则输入框会提示出别的岗位在用的标签,
    // 那本身就泄露了「别处在招什么、怎么标记候选人」。
    const scope = await visibleJobIds(req)
    const rows = await prisma.candidateTag.groupBy({
      by: ['label'],
      where: {
        ...(q.q ? { label: { contains: q.q } } : {}),
        ...jobScopeWhere(scope),
      },
      _count: { label: true },
      orderBy: { _count: { label: 'desc' } },
      take: 20,
    })
    return rows.map((r) => ({ label: r.label, count: r._count.label }))
  })

  /** 打标签。**必须指定岗位** —— 标签属于岗位,「已面过」在 A 岗位成立、
   *  在 B 岗位不成立;不带 jobId 的话同事在别的岗位打的标签会出现在你这里。 */
  app.post('/api/candidates/:id/tags', { preHandler: app.requireAuth() }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const b = z.object({
      jobId: z.string().min(1),
      label: z.string().min(1).max(20),
      color: z.string().optional(),
    }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'invalid_request', details: b.error.flatten() })
    if (!(await canAccessJob(req, b.data.jobId))) return reply.code(404).send({ error: 'not_found' })
    if (!(await canAccessCandidate(req, id))) return reply.code(404).send({ error: 'not_found' })

    const resolved = await resolveCandidate(id)
    if (!resolved) return reply.code(404).send({ error: 'not_found' })

    // 打在主记录上:被合并的记录在 UI 上不独立存在,标在它身上会「看不见」。
    const tag = await prisma.candidateTag.create({
      data: {
        candidateId: resolved.primaryId, jobId: b.data.jobId,
        label: b.data.label.trim(), color: b.data.color, createdBy: req.user!.id,
      },
    }).catch((e: { code?: string }) => (e.code === 'P2002' ? null : Promise.reject(e)))
    if (!tag) return reply.code(200).send({ ok: true, duplicate: true })
    return reply.code(201).send({ id: tag.id, label: tag.label, color: tag.color })
  })

  app.delete('/api/tags/:id', { preHandler: app.requireAuth() }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const tag = await prisma.candidateTag.findUnique({ where: { id }, select: { jobId: true } })
    if (!tag) return reply.code(404).send({ error: 'not_found' })
    // 删别人岗位下的标签同样是越权 —— 读要挡,写更要挡。
    if (!(await canAccessJob(req, tag.jobId))) return reply.code(404).send({ error: 'not_found' })
    await prisma.candidateTag.delete({ where: { id } })
    return { ok: true }
  })

  // ── 彻底删除 ────────────────────────────────────────────────────

  app.delete('/api/candidates/:id', { preHandler: [app.requireAuth(), requireSuperAdmin] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const c = await prisma.candidate.findUnique({ where: { id }, select: { name: true } })
    if (!c) return reply.code(404).send({ error: 'not_found' })

    // 先写审计再删 —— 删完 targetId 就悬空了,targetLabel 快照是唯一还能读懂的线索。
    await audit({
      actorId: req.user!.id, action: 'delete', targetType: 'candidate',
      targetId: id, targetLabel: c.name, detail: '彻底删除(含原件与渲染图)',
    }, req.log)

    const r = await purgeCandidate(id)
    return {
      ok: true,
      deletedCandidates: r.candidateIds.length,
      filesDeleted: r.filesDeleted,
      bytesFreed: r.bytesFreed,
      // 明确告诉调用方:删除不追溯历史备份,这是已知边界。
      note: '历史备份中的副本不受影响,将随备份保留期自然过期',
    }
  })

  /** 批量彻底删除。彻底删除的配套 —— 没有批量工具的话,攒到几百人时
   *  「手动删」实际不可执行,PII 就这么无限期存着了。
   *
   *  逐个调 purgeCandidate 而不是拼一条批量 SQL:物理文件的引用计数要一个个查
   *  (同一份 PDF 可能被别人也传过),而这个规模下多几十次查询完全无所谓。 */
  app.post('/api/candidates/bulk-delete', { preHandler: [app.requireAuth(), requireSuperAdmin] }, async (req, reply) => {
    const b = z.object({ ids: z.array(z.string()).min(1).max(500) }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'invalid_request', details: b.error.flatten() })

    const targets = await prisma.candidate.findMany({
      where: { id: { in: b.data.ids } },
      select: { id: true, name: true },
    })

    let deleted = 0
    let filesDeleted = 0
    let bytesFreed = 0
    for (const t of targets) {
      // 先写审计 —— 删完 targetId 就悬空,targetLabel 快照是唯一还读得懂的线索。
      await audit({
        actorId: req.user!.id, action: 'delete', targetType: 'candidate',
        targetId: t.id, targetLabel: t.name, detail: '批量彻底删除',
      }, req.log)
      // 一个失败不该让整批停下 —— 已删的不会回滚,继续删剩下的更符合预期。
      try {
        const r = await purgeCandidate(t.id)
        deleted += r.candidateIds.length
        filesDeleted += r.filesDeleted
        bytesFreed += r.bytesFreed
      } catch (e) {
        req.log.error({ err: e, candidateId: t.id }, '[purge] 批量删除中有一条失败')
      }
    }
    return {
      ok: true, deleted, filesDeleted, bytesFreed,
      note: '历史备份中的副本不受影响，将随备份保留期自然过期',
    }
  })

  /** 审计日志查询。**必须收在管理员档** —— 这张表记的是「谁在什么时候查了谁
   *  的简历」,全员可读的话它本身就成了最敏感的一张表。 */
  app.get('/api/audit', { preHandler: [app.requireAuth(), requireSuperAdmin] }, async (req) => {
    const q = z.object({
      targetId: z.string().optional(),
      actorId: z.string().optional(),
      limit: z.coerce.number().min(1).max(200).default(50),
    }).parse(req.query)
    return prisma.auditLog.findMany({
      where: { targetId: q.targetId, actorId: q.actorId },
      orderBy: { at: 'desc' },
      take: q.limit,
    })
  })
}
