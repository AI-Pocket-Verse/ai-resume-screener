import type { FastifyInstance } from 'fastify'
import { Scorecard, totalWeight } from '@ai-resume-screener/shared'
import { z } from 'zod'
import { prisma } from '../db.js'
import { audit } from '../services/compliance/audit.js'
import { removeOrphanCandidates, removeUnreferencedFiles } from '../services/compliance/purge.js'
import { draftScorecard } from '../services/evaluate/evaluate.js'
import {
  canAccessJob, canManageJob, currentUser, isSuperAdmin, requireJobAccess, requireJobManage, visibleJobIds,
} from '../utils/authz.js'
import { safeParse } from '../utils/json.js'

export async function jobRoutes(app: FastifyInstance) {
  /** 当前用户。**顺带完成 JIT 建档** —— 前端启动必调它,所以每个人登录后
   *  自然出现在用户表里,「加成员」的选人框才有数据可选。 */
  app.get('/api/me', { preHandler: app.requireAuth() }, async (req) => {
    const me = await currentUser(req)
    return {
      id: me?.id ?? null,
      openId: req.user!.open_id ?? null,
      name: req.user!.name ?? null,
      isSuperAdmin: isSuperAdmin(req),
    }
  })

  /** 可加为成员的人 = 登录过本产品的人。auth 不提供全公司用户列表,
   *  所以只能是「来过的人」—— 新同事打开一次链接就会出现在这里。 */
  app.get('/api/users', { preHandler: app.requireAuth() }, async (req) => {
    const q = z.object({ q: z.string().optional() }).parse(req.query)
    const rows = await prisma.user.findMany({
      where: q.q ? { name: { contains: q.q } } : undefined,
      orderBy: { lastSeenAt: 'desc' },
      take: 50,
      select: { id: true, name: true, email: true, avatarUrl: true },
    })
    return rows
  })

  // ── 团队 ────────────────────────────────────────────────────────
  // 建岗位要选团队,所以团队列表仍对所有登录用户开放;但岗位数只统计调用者可见的岗位,
  // 否则团队名 + 岗位数会泄露别处的招聘规模。
  app.get('/api/teams', { preHandler: app.requireAuth() }, async (req) => {
    const scope = await visibleJobIds(req)
    return prisma.team.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        _count: { select: { jobs: scope === null ? true : { where: { id: { in: scope } } } } },
      },
    })
  })

  app.post('/api/teams', { preHandler: app.requireAuth() }, async (req, reply) => {
    const b = z.object({ name: z.string().min(1), description: z.string().optional() }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'invalid_request', details: b.error.flatten() })
    const team = await prisma.team.create({
      data: { name: b.data.name, description: b.data.description, ownerId: req.user!.id },
    }).catch((e: { code?: string }) => {
      if (e.code === 'P2002') return null // 团队名唯一
      throw e
    })
    if (!team) return reply.code(409).send({ error: 'duplicate_name', message: '已有同名团队' })
    return reply.code(201).send(team)
  })

  // ── 岗位 ────────────────────────────────────────────────────────
  /** 岗位列表。**只列你参与的** —— 岗位名本身也会泄露招聘计划
   *  (「在招 CTO」这种事往往比候选人简历更敏感)。 */
  app.get('/api/jobs', { preHandler: app.requireAuth() }, async (req) => {
    const q = z.object({ teamId: z.string().optional() }).parse(req.query)
    const scope = await visibleJobIds(req)
    const jobs = await prisma.job.findMany({
      where: {
        ...(q.teamId ? { teamId: q.teamId } : {}),
        ...(scope === null ? {} : { id: { in: scope } }),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        team: { select: { id: true, name: true } },
        scorecard: { select: { id: true, updatedAt: true } },
        _count: { select: { applications: true } },
      },
    })
    return jobs.map((j) => ({
      id: j.id, title: j.title, status: j.status, location: j.location, level: j.level,
      headcount: j.headcount, team: j.team,
      // 没有评分卡的岗位无法评估 —— 列表要能一眼看出来。
      hasScorecard: Boolean(j.scorecard),
      candidateCount: j._count.applications,
      createdAt: j.createdAt,
    }))
  })

  app.post('/api/jobs', { preHandler: app.requireAuth() }, async (req, reply) => {
    const b = z.object({
      teamId: z.string(),
      title: z.string().min(1),
      jdRaw: z.string().default(''),
      location: z.string().optional(),
      level: z.string().optional(),
      headcount: z.coerce.number().min(1).default(1),
    }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'invalid_request', details: b.error.flatten() })

    const team = await prisma.team.findUnique({ where: { id: b.data.teamId } })
    if (!team) return reply.code(404).send({ error: 'team_not_found' })

    const me = await currentUser(req)
    if (!me) return reply.code(401).send({ error: 'unauthenticated' })

    // 建岗与「把自己加成 owner」必须同一个事务:分两步的话中间失败会留下一个
    // **谁都进不去的岗位** —— 包括建它的人自己,而且没有任何入口能补救。
    const job = await prisma.$transaction(async (tx) => {
      const j = await tx.job.create({ data: { ...b.data, createdBy: me.id } })
      await tx.jobMember.create({ data: { jobId: j.id, userId: me.id, role: 'owner' } })
      return j
    })
    return reply.code(201).send(job)
  })

  app.get('/api/jobs/:id', { preHandler: [app.requireAuth(), requireJobAccess] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const job = await prisma.job.findUnique({
      where: { id },
      include: { team: true, scorecard: true },
    })
    if (!job) return reply.code(404).send({ error: 'not_found' })
    return {
      ...job,
      scorecard: job.scorecard && {
        id: job.scorecard.id,
        gates: safeParse(job.scorecard.gates, []),
        dimensions: safeParse(job.scorecard.dimensions, []),
        updatedAt: job.scorecard.updatedAt,
        updatedBy: job.scorecard.updatedBy,
      },
    }
  })

  /** 改岗位。JD 改了不会自动重算评分卡 —— 评分卡是 HR 的资产,
   *  悄悄重生成会把手工调过的权重和锚点冲掉。要重生成得显式点。 */
  app.patch('/api/jobs/:id', { preHandler: [app.requireAuth(), requireJobAccess] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const b = z.object({
      title: z.string().min(1).optional(),
      jdRaw: z.string().optional(),
      location: z.string().nullable().optional(),
      level: z.string().nullable().optional(),
      headcount: z.coerce.number().min(1).optional(),
      status: z.enum(['open', 'paused', 'closed']).optional(),
      teamId: z.string().optional(),
    }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'invalid_request', details: b.error.flatten() })

    const updated = await prisma.job.update({ where: { id }, data: b.data }).catch(() => null)
    if (!updated) return reply.code(404).send({ error: 'not_found' })
    // 岗位成员都能改岗位信息(有意的权限划分,见 README「权限」),所以留痕:只记字段名,不记内容。
    await audit({
      actorId: req.user!.id, action: 'update_job', targetType: 'job',
      targetId: id, targetLabel: updated.title, detail: `修改字段:${Object.keys(b.data).join(',')}`,
    }, req.log)
    return { id: updated.id, title: updated.title, status: updated.status }
  })

  /** 删岗位。**候选人不会被删** —— 他们属于 Candidate,可能还投了别的岗位;
   *  这里级联删掉的只是这个岗位下的投递与评估记录。想彻底删人走候选人删除。 */
  app.delete('/api/jobs/:id', { preHandler: [app.requireAuth(), requireJobManage] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const count = await prisma.application.count({ where: { jobId: id } })
    // 不能用 z.coerce.boolean():它把任何非空字符串(含 "false"、"0")都当成 true,会误删整岗数据。
    const forceRaw = z.object({ force: z.enum(['true', 'false', '1', '0']).default('false') }).parse(req.query).force
    const force = forceRaw === 'true' || forceRaw === '1'
    // 有候选人时要求显式 force,避免一次误点抹掉一整个岗位的筛选记录。
    if (count > 0 && !force) {
      return reply.code(409).send({
        error: 'has_candidates',
        message: `该岗位下还有 ${count} 位候选人的投递与评估记录，确认要一并删除吗？`,
        candidateCount: count,
      })
    }
    // 删岗会级联删光 DB 行,之后再没有任何路径能找到这些原件 / 页图 / 只属于本岗位的候选人,
    // 所以必须在删之前收集线索,提交后按引用计数清理(与彻底删除候选人同一套逻辑)。
    const files = await prisma.resumeFile.findMany({
      where: { jobId: id },
      select: { sha256: true, storagePath: true, bytes: true, candidateId: true },
    })
    const apps = await prisma.application.findMany({ where: { jobId: id }, select: { candidateId: true } })
    const del = await prisma.job.delete({ where: { id } }).catch(() => null)
    if (!del) return reply.code(404).send({ error: 'not_found' })
    await audit({
      actorId: req.user!.id, action: 'delete_job', targetType: 'job',
      targetId: id, targetLabel: del.title, detail: `删除岗位:投递 ${count},简历 ${files.length}`,
    }, req.log)
    try {
      await removeUnreferencedFiles(files)
      await removeOrphanCandidates([
        ...files.map((f) => f.candidateId).filter((c): c is string => !!c),
        ...apps.map((a) => a.candidateId),
      ])
    } catch (e) {
      // 岗位已删,清理失败只留日志,不让接口报错(重复点删除也找不回岗位了)。
      req.log.error({ err: e, jobId: id }, '[job] 删岗后清理原件 / 孤儿候选人失败')
    }
    return { ok: true, removedApplications: count }
  })

  // ── 岗位成员 ────────────────────────────────────────────────────
  // 可见性的唯一依据。管理入口放在岗位详情页而不是独立后台:一个人在岗位 A
  // 是负责人、在岗位 B 只是面试官,「全局角色」表达不了这件事。

  app.get('/api/jobs/:id/members', { preHandler: [app.requireAuth(), requireJobAccess] }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const rows = await prisma.jobMember.findMany({
      where: { jobId: id },
      orderBy: [{ role: 'asc' }, { addedAt: 'asc' }], // owner 在前
      include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
    })
    return {
      canManage: await canManageJob(req, id),
      members: rows.map((m) => ({
        userId: m.user.id, name: m.user.name, email: m.user.email,
        avatarUrl: m.user.avatarUrl, role: m.role, addedAt: m.addedAt,
      })),
    }
  })

  app.post('/api/jobs/:id/members', { preHandler: [app.requireAuth(), requireJobManage] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const b = z.object({ userId: z.string() }).safeParse(req.body)
    if (!b.success) return reply.code(400).send({ error: 'invalid_request', details: b.error.flatten() })

    const user = await prisma.user.findUnique({ where: { id: b.data.userId }, select: { id: true } })
    if (!user) return reply.code(404).send({ error: 'user_not_found', message: '该用户还没登录过本产品' })

    const me = await currentUser(req)
    const created = await prisma.jobMember.create({
      data: { jobId: id, userId: user.id, role: 'member', addedBy: me?.id },
    }).catch((e: { code?: string }) => (e.code === 'P2002' ? null : Promise.reject(e)))
    // 已是成员 → 200 幂等,不报错:重复点「添加」是很正常的操作。
    if (!created) return reply.code(200).send({ ok: true, duplicate: true })
    await audit({
      actorId: req.user!.id, action: 'add_member', targetType: 'job',
      targetId: id, detail: `userId=${user.id}`,
    }, req.log)
    return reply.code(201).send({ ok: true })
  })

  app.delete('/api/jobs/:id/members/:userId', { preHandler: [app.requireAuth(), requireJobManage] }, async (req, reply) => {
    const { id, userId } = z.object({ id: z.string(), userId: z.string() }).parse(req.params)
    const target = await prisma.jobMember.findUnique({
      where: { jobId_userId: { jobId: id, userId } },
      select: { role: true },
    })
    if (!target) return reply.code(404).send({ error: 'not_found' })
    // 移除最后一个 owner 会让岗位**永久无人可管**(连加人的入口都没了),
    // 而恢复它需要直接改库。挡在这里。
    if (target.role === 'owner') {
      const owners = await prisma.jobMember.count({ where: { jobId: id, role: 'owner' } })
      if (owners <= 1) {
        return reply.code(409).send({
          error: 'last_owner',
          message: '这是该岗位最后一位负责人，移除后将无人能管理成员。请先指定另一位负责人。',
        })
      }
    }
    await prisma.jobMember.delete({ where: { jobId_userId: { jobId: id, userId } } })
    await audit({
      actorId: req.user!.id, action: 'remove_member', targetType: 'job',
      targetId: id, detail: `userId=${userId}`,
    }, req.log)
    return { ok: true }
  })

  // ── 评分卡 ──────────────────────────────────────────────────────

  /** JD → 评分卡草稿。**只返回草稿,不落库** —— 生成完由 HR 编辑确认后再保存。
   *  AI 生成的评分卡直接生效等于把标准的定义权交给模型。 */
  app.post('/api/jobs/:id/scorecard/draft', { preHandler: [app.requireAuth(), requireJobAccess] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const job = await prisma.job.findUnique({ where: { id } })
    if (!job) return reply.code(404).send({ error: 'not_found' })
    if (!job.jdRaw.trim()) return reply.code(400).send({ error: 'empty_jd', message: '请先填写 JD 原文' })

    const r = await draftScorecard(job.title, job.jdRaw)
    if (!r.scorecard) {
      req.log.warn({ jobId: id, error: r.error }, '[scorecard] 草稿生成失败')
      return reply.code(502).send({ error: 'draft_failed', message: '评分卡草稿生成失败,请重试' })
    }
    return r.scorecard
  })

  /** 保存评分卡。直接可编辑,不做版本表—— 历史可解释性由
   *  Evaluation.scorecardSnapshot 承担。 */
  app.put('/api/jobs/:id/scorecard', { preHandler: [app.requireAuth(), requireJobAccess] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const parsed = Scorecard.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_scorecard', details: parsed.error.flatten() })
    }
    const sc = parsed.data
    const w = totalWeight(sc)
    // 权重不等于 100 时加权分的分母就不是 100,档位阈值(85/70/55)会全部失真。
    // 前端有滑块自动归一,这里是兜底。
    if (Math.round(w) !== 100) {
      return reply.code(400).send({ error: 'bad_weight', message: `各维度权重之和须为 100,当前为 ${w}` })
    }

    const job = await prisma.job.findUnique({ where: { id } })
    if (!job) return reply.code(404).send({ error: 'not_found' })

    const data = {
      gates: JSON.stringify(sc.gates),
      dimensions: JSON.stringify(sc.dimensions),
      updatedBy: req.user!.id,
    }
    const saved = await prisma.scorecard.upsert({
      where: { jobId: id },
      create: { jobId: id, ...data },
      update: data,
    })
    await audit({
      actorId: req.user!.id, action: 'replace_scorecard', targetType: 'job',
      targetId: id, targetLabel: job.title, detail: '保存评分卡',
    }, req.log)
    return { id: saved.id, updatedAt: saved.updatedAt }
  })

  /** 从别的岗位复制评分卡(评分卡的复用方式):一次深拷贝,**之后完全独立**。
   *  不做模板表、不做版本谱系、不做差异同步。 */
  app.post('/api/jobs/:id/scorecard/copy-from/:sourceJobId', { preHandler: [app.requireAuth(), requireJobAccess] }, async (req, reply) => {
    const p = z.object({ id: z.string(), sourceJobId: z.string() }).parse(req.params)
    // 源岗位也要可见;不可见与「没有评分卡」同一个 404,不泄露岗位是否存在。
    if (!(await canAccessJob(req, p.sourceJobId))) return reply.code(404).send({ error: 'source_has_no_scorecard' })
    const src = await prisma.scorecard.findUnique({ where: { jobId: p.sourceJobId } })
    if (!src) return reply.code(404).send({ error: 'source_has_no_scorecard' })

    const data = { gates: src.gates, dimensions: src.dimensions, updatedBy: req.user!.id }
    const saved = await prisma.scorecard.upsert({
      where: { jobId: p.id },
      create: { jobId: p.id, ...data },
      update: data,
    })
    await audit({
      actorId: req.user!.id, action: 'replace_scorecard', targetType: 'job',
      targetId: p.id, detail: `复制自岗位 ${p.sourceJobId}`,
    }, req.log)
    return { id: saved.id, updatedAt: saved.updatedAt }
  })
}
