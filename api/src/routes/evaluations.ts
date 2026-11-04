import type { FastifyInstance } from 'fastify'
import { createId } from '@paralleldrive/cuid2'
import { z } from 'zod'
import { prisma } from '../db.js'
import { pickCurrent, sortByVerdict } from '../services/evaluate/current.js'
import { enqueueEval } from '../services/evaluate/queue.js'
import { canAccessCandidate, canAccessJob, requireJobAccess, visibleJobIds } from '../utils/authz.js'
import { safeParse, safeParseObject } from '../utils/json.js'

/** 候选人列表用到的 ResumeParsed.raw 字段子集。落库前已过 zod,
 *  这里只是给读取侧一个类型,免得字段名拼错也没人发现。 */
interface ListParsed {
  basic?: { name?: string | null } | null
  injectionSuspected?: boolean
}

interface ListDerived {
  currentCompany?: string | null
  currentIsPast?: boolean
  totalYears?: number | null
}

export async function evaluationRoutes(app: FastifyInstance) {
  /** 把候选人投到某岗位。同一人同一岗位只有一条(DB 唯一约束)。 */
  app.post('/api/applications', { preHandler: app.requireAuth() }, async (req, reply) => {
    const b = z.object({ candidateId: z.string(), jobId: z.string() }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'invalid_request', details: b.error.flatten() })
    if (!(await canAccessJob(req, b.data.jobId))) return reply.code(404).send({ error: 'not_found' })
    // 候选人也要可见:否则能把别人岗位的候选人挂到自己岗位下,随后读到他的联系方式。
    // 不可见与不存在返回同样的 404。
    if (!(await canAccessCandidate(req, b.data.candidateId))) return reply.code(404).send({ error: 'not_found' })
    const existing = await prisma.application.findUnique({
      where: { candidateId_jobId: b.data },
    })
    if (existing) return reply.code(200).send(existing)
    const created = await prisma.application.create({ data: { ...b.data, createdById: req.user!.id } })
    return reply.code(201).send(created)
  })

  /**
   * 岗位下的候选人列表。这是产品的主界面数据源。
   * 排序统一按【当前有效结论】(精评优先),否则一部分人按粗评分、一部分按精评分
   * 混在同一个排序里,无从解释。
   */
  app.get('/api/jobs/:id/candidates', { preHandler: [app.requireAuth(), requireJobAccess] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const job = await prisma.job.findUnique({ where: { id } })
    if (!job) return reply.code(404).send({ error: 'not_found' })

    const apps = await prisma.application.findMany({
      where: { jobId: id },
      include: {
        candidate: {
          include: {
            tags: { where: { jobId: id } },
            // 只取【本岗位】的简历:同一个人可能在别的岗位也投过,
            // 那份简历不该出现在这个列表里(哪怕是同一个候选人主体)。
            resumeFiles: {
              where: { jobId: id },
              orderBy: { uploadedAt: 'desc' },
              include: { parsed: { select: { raw: true, editedFields: true, derived: true } } },
            },
          },
        },
        evaluations: {
          select: { id: true, tier: true, grade: true, weightedScore: true, createdAt: true, summary: true },
        },
        // 分析状态从队列派生,不在 Application 上冗余存 —— 双真相源迟早
        // 产生「列表说分析中、队列说已失败」这种不可恢复的 UI 死角。
        evalJobs: { where: { status: { in: ['queued', 'running'] } }, select: { tier: true, status: true } },
      },
    })

    // 先带着 CurrentVerdict 对象排序(sortByVerdict 需要它的 grade/score),
    // 排完再压成前端要的扁平形态。
    const rows = apps.map((a) => {
      const file = a.candidate.resumeFiles.find((f) => f.parsed)
      // 只声明这里真正读的那几个字段。之前是 JSON.parse 返回 any,
      // `merged?.basic?.name` 拼错也不会有人发现。
      const derived = file?.parsed ? safeParse<ListDerived | null>(file.parsed.derived, null) : null
      const raw = file?.parsed ? safeParse<ListParsed | null>(file.parsed.raw, null) : null
      const edited = file?.parsed ? safeParse<ListParsed>(file.parsed.editedFields, {}) : {}
      const merged: ListParsed | null = raw ? { ...raw, ...edited } : null
      return {
        applicationId: a.id,
        candidateId: a.candidateId,
        // 不回退到全局 candidate.name:它可能是别的岗位简历里的最新姓名。
        name: merged?.basic?.name ?? '(未识别姓名)',
        currentCompany: derived?.currentCompany ?? null,
        currentIsPast: derived?.currentIsPast ?? false,
        totalYears: derived?.totalYears ?? null,
        parseState: file?.parseState ?? 'pending',
        // 疑似注入要在**列表**上就看得见。只在详情页角落显示的话,HR 得逐个点开
        // 才知道 —— 而这条信息的价值恰恰在于「点开之前就该警惕」。
        // 注意不阻断评估:简历里写 prompt 的 AI 从业者是正常候选人,
        // 硬拦会精准误伤这个产品最想招的那批人。
        injectionSuspected: merged?.injectionSuspected === true,
        tags: a.candidate.tags.map((t) => ({ label: t.label, color: t.color })),
        hrDecision: a.hrDecision,
        // 未分析 = 没有任何 Evaluation;分析中 = 队列里有非终态任务。
        analyzing: a.evalJobs[0]?.tier ?? null,
        summaries: new Map(a.evaluations.map((e) => [e.id, e.summary])),
        verdict: pickCurrent(a.evaluations),
      }
    })

    return sortByVerdict(rows).map(({ verdict, summaries, ...rest }) => ({
      ...rest,
      verdict: verdict && {
        grade: verdict.grade,
        score: verdict.current.weightedScore,
        source: verdict.source,
        summary: summaries.get(verdict.current.id) ?? null,
        // 精评改了档位时带上粗评,UI 显示「B · 深度分析后(粗评为 A)」。
        supersededGrade: verdict.supersededScreen?.grade ?? null,
      },
    }))
  })

  /** 触发分析。粗评可批量,精评只能单份。 */
  app.post('/api/evaluations', { preHandler: app.requireAuth() }, async (req, reply) => {
    const b = z.object({
      applicationIds: z.array(z.string()).min(1),
      tier: z.enum(['screen', 'deep']).default('screen'),
    }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'invalid_request', details: b.error.flatten() })

    // 精评是「拿不准时帮我定」的场景,天然是一次一个;放开批量精评等于
    // 给了一个能一次烧掉几小时机器时间的按钮。
    if (b.data.tier === 'deep' && b.data.applicationIds.length > 1) {
      return reply.code(400).send({ error: 'deep_is_single_only', message: '深度评估一次只能对一位候选人' })
    }

    // 只能对自己岗位下的投递发起分析 —— 否则可以用别人的 applicationId
    // 烧算力,并把评估结果写进你看不到的岗位。
    const scope = await visibleJobIds(req)
    if (scope !== null) {
      const okCount = await prisma.application.count({
        where: { id: { in: b.data.applicationIds }, jobId: { in: scope } },
      })
      if (okCount !== b.data.applicationIds.length) {
        return reply.code(404).send({ error: 'not_found' })
      }
    }

    // 同一次操作共用一个 batchId → 这批全部跑完才推一张卡片,
    // 而不是 20 份简历轰 20 条通知。createdBy 存 open_id,通知推给发起人本人。
    const batch = { batchId: createId(), createdBy: req.user!.open_id ?? null }
    const results = []
    for (const applicationId of b.data.applicationIds) {
      const r = await enqueueEval(applicationId, b.data.tier, batch)
      results.push({ applicationId, ...r })
    }
    return { queued: results.filter((r) => r.queued).length, results }
  })

  /** 一条评估的完整内容,含「这个分怎么来的」。 */
  app.get('/api/evaluations/:id', { preHandler: app.requireAuth() }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const e = await prisma.evaluation.findUnique({
      where: { id },
      include: { application: { select: { jobId: true } } },
    })
    if (!e) return reply.code(404).send({ error: 'not_found' })
    if (!(await canAccessJob(req, e.application.jobId))) return reply.code(404).send({ error: 'not_found' })
    return {
      id: e.id,
      tier: e.tier,
      grade: e.grade,
      weightedScore: e.weightedScore,
      summary: e.summary,
      gateResults: safeParse(e.gateResults, []),
      scores: safeParse(e.scores, []),
      highlights: safeParse(e.highlights, []),
      concerns: safeParse(e.concerns, []),
      extras: safeParseObject(e.extras),
      // 评估当时的评分卡全量副本 —— 「这个分怎么来的」靠它回答,而不是靠版本号。
      //
      // ⚠️ 兜底【必须是空壳而不是 null】,与上面几行保持一致。
      // safeParse 的用意(见 utils/json.ts)是「一行坏数据只让这一行显示不全,
      // 不让所有人都用不了」。但给 null 会把这个失败原样转嫁给前端:
      // EvaluationView 要 `scorecardSnapshot.dimensions.map(...)` 拿维度标签,
      // 拿到 null 当场抛异常,而前端没有 ErrorBoundary —— 整个详情页白屏,
      // 比服务端返回 500 还难排查。给空壳的话维度标签退化成 key,其余照常显示。
      scorecardSnapshot: safeParse(e.scorecardSnapshot, { gates: [], dimensions: [] }),
      promptVersion: e.promptVersion,
      parserVersion: e.parserVersion,
      model: e.model,
      latencyMs: e.latencyMs,
      createdAt: e.createdAt,
    }
  })

  /** HR 结论。**唯一的候选人状态真相源**—— 后续流程走飞书。 */
  app.put('/api/applications/:id/decision', { preHandler: app.requireAuth() }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const b = z.object({
      decision: z.enum(['pass', 'reject', 'hold']).nullable(),
      reason: z.string().optional(),
    }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'invalid_request', details: b.error.flatten() })

    const target = await prisma.application.findUnique({ where: { id }, select: { jobId: true } })
    if (!target) return reply.code(404).send({ error: 'not_found' })
    if (!(await canAccessJob(req, target.jobId))) return reply.code(404).send({ error: 'not_found' })

    const updated = await prisma.application.update({
      where: { id },
      data: {
        hrDecision: b.data.decision,
        hrDecidedBy: b.data.decision ? req.user!.id : null,
        hrDecidedAt: b.data.decision ? new Date() : null,
        hrReason: b.data.reason ?? null,
      },
    }).catch(() => null)
    if (!updated) return reply.code(404).send({ error: 'not_found' })
    return { id: updated.id, hrDecision: updated.hrDecision, hrDecidedAt: updated.hrDecidedAt }
  })
}
