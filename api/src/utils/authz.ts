import type { FastifyReply, FastifyRequest } from 'fastify'
import { prisma } from '../db.js'
import { env, normPhone } from '../env.js'

export { normPhone }

/**
 * 可见性。**按岗位,不按上传者**。
 *
 *   登录即可用 —— SSO 已经回答了「是不是本公司的人」,日常操作不再加档。
 *   看得到什么由「参与哪些岗位」决定:候选人属于岗位,不属于录入他的那个人。
 *
 * 为什么不按上传者:招聘是多人协作的(HR 录入 → 面试官看评估 → 主管拍板)。
 * 按上传者隔离会让面试官打不开任何东西,而「给用人部门看评估结论」正是这个
 * 产品的主要价值;而且人一休假,他名下的候选人对全公司不可达。
 *
 * 超管是唯一的全局角色,负责隔离之后没人能做的三件事:全公司视图、
 * 合规删除(跨岗位候选人谁都删不干净)、审计日志(被审计者不该自己看)。
 */

/** 超管。
 *
 *  - 本地单用户模式(未配置 WHOAMI_URL):唯一的本地用户就是超管,否则他看不到任何岗位。
 *  - 接入登录后:手机号在 ADMIN_MOBILES 里的人。拿不到手机号时直接不是 —— 短路而不是
 *    报错:飞书按应用权限决定下不下发 mobile,拿不到是正常状态,不该让整个请求失败。 */
export function isSuperAdmin(req: FastifyRequest): boolean {
  if (!env.WHOAMI_URL) return Boolean(req.user)
  const mobile = req.user?.mobile
  return !!mobile && env.ADMIN_MOBILES.has(normPhone(mobile))
}

/**
 * 当前用户的本地 User 行,登录时 JIT 建档。
 *
 * 锚点是 **open_id 而不是 auth 的 cuid**:cuid 在 auth 库重置/迁移后会变,
 * 用它建档会让同一个人分叉成两条本地记录 —— 岗位成员关系、上传归属全部对不上。
 */
export async function currentUser(req: FastifyRequest): Promise<{ id: string; ssoId: string } | null> {
  const sso = req.user
  if (!sso?.open_id) return null

  const data = {
    name: sso.name,
    email: sso.email ?? null,
    mobile: sso.mobile ?? null,
    avatarUrl: sso.avatar_url ?? null,
    lastSeenAt: new Date(),
  }
  // upsert 而不是「查不到再建」:并发的首次请求会同时命中,先查后插必然撞
  // 唯一约束。upsert 由 DB 保证只有一条。
  return prisma.user.upsert({
    where: { ssoId: sso.open_id },
    create: { ssoId: sso.open_id, ...data },
    update: data,
    select: { id: true, ssoId: true },
  })
}

/**
 * 当前用户能看到的岗位 id。
 *
 * **所有涉及候选人数据的查询都必须从这里取范围**,而不是各自写 `where`。
 * 71 处查询点逐个加过滤是漏一处就越权、且漏的那处平时完全正常的模式 ——
 * 让「忘记过滤」在结构上不可能发生,比靠 review 逐处盯可靠得多。
 *
 * 返回 null 表示【不受限】(超管),调用方据此跳过过滤;返回数组则是白名单,
 * 空数组 = 一个岗位都看不到。**不要用空数组表示不受限**,那是最容易写反的地方。
 */
export async function visibleJobIds(req: FastifyRequest): Promise<string[] | null> {
  if (isSuperAdmin(req)) return null
  const me = await currentUser(req)
  if (!me) return []
  const rows = await prisma.jobMember.findMany({
    where: { userId: me.id },
    select: { jobId: true },
  })
  return rows.map((r) => r.jobId)
}

/** 把可见范围转成 Prisma 的 where 片段。超管得到 `{}`(不加限制)。 */
export function jobScopeWhere(jobIds: string[] | null): { jobId?: { in: string[] } } {
  return jobIds === null ? {} : { jobId: { in: jobIds } }
}

/** 能否访问某个岗位。 */
export async function canAccessJob(req: FastifyRequest, jobId: string): Promise<boolean> {
  const ids = await visibleJobIds(req)
  return ids === null || ids.includes(jobId)
}

/**
 * 能否访问某个候选人。
 *
 * 候选人本身不带岗位 —— 他是全局唯一的主体。可见性由「他有没有投过你看得到
 * 的岗位」决定,所以要从子表反查。**合并/打标签/忽略提示这类写操作同样要过
 * 这一关**:只读接口挡住了、写接口没挡,等于留了一扇后门(而且从写操作的
 * 成败还能反推出这个人存在)。
 */
export async function canAccessCandidate(req: FastifyRequest, candidateId: string): Promise<boolean> {
  const scope = await visibleJobIds(req)
  if (scope === null) return true
  if (scope.length === 0) return false
  const hit = await prisma.resumeFile.findFirst({
    where: { candidateId, jobId: { in: scope } },
    select: { id: true },
  })
  if (hit) return true
  // 简历可能已被删(purge 只删文件不删投递记录),投递仍能证明关联。
  const app = await prisma.application.findFirst({
    where: { candidateId, jobId: { in: scope } },
    select: { id: true },
  })
  return Boolean(app)
}

/** 岗位的 owner(建岗者)或超管 —— 只有他们能增删成员。 */
export async function canManageJob(req: FastifyRequest, jobId: string): Promise<boolean> {
  if (isSuperAdmin(req)) return true
  const me = await currentUser(req)
  if (!me) return false
  const m = await prisma.jobMember.findUnique({
    where: { jobId_userId: { jobId, userId: me.id } },
    select: { role: true },
  })
  return m?.role === 'owner'
}

// ── preHandler ────────────────────────────────────────────────────

export async function requireSuperAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (isSuperAdmin(req)) return
  return reply.code(403).send({ error: 'forbidden', message: '需要超级管理员权限' })
}

/** 路由参数里的 :id 是岗位 id 时用它。非成员一律 404 而不是 403 ——
 *  403 等于告诉对方「这个岗位存在,只是你没权限」,那本身就是信息泄露。 */
export async function requireJobAccess(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const jobId = (req.params as { id?: string })?.id
  if (!jobId) return
  if (await canAccessJob(req, jobId)) return
  return reply.code(404).send({ error: 'not_found' })
}

export async function requireJobManage(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const jobId = (req.params as { id?: string })?.id
  if (!jobId) return
  if (await canManageJob(req, jobId)) return
  return reply.code(403).send({ error: 'forbidden', message: '只有岗位创建者可以管理成员' })
}
