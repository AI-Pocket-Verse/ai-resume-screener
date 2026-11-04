import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { prisma, disconnectDb } from '../db.js'
import { env } from '../env.js'
import { collectIdentifiers } from '../services/dedup/normalize.js'
import { normPhone } from './authz.js'

// 可见性是安全边界:纯函数测得再全,漏挂一处过滤照样越权,而且平时完全正常。
// 所以这里以【具体身份】打真实请求,而不是只测判定函数。

const SUPER_PHONE = '13800138000'
const COOKIE = 'sso_session=fake'

function whoami(openId: string, mobile: string | null): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({
      authenticated: true,
      user: {
        id: `uid-${openId}`, open_id: openId, name: `用户${openId}`,
        mobile, last_login_at: new Date(0).toISOString(),
      },
      session: {
        id: 's', user_id: `uid-${openId}`, remember_me: false,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        last_seen_at: new Date(0).toISOString(),
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
}

type App = Awaited<ReturnType<typeof buildApp>>
let alice: App   // 建了岗位 A
let bob: App     // 建了岗位 B,与 A 无关
let boss: App    // 超管(手机号在 ADMIN_MOBILES 里)
let jobA = ''
let jobB = ''

const call = (app: App, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as 'GET', url, payload: payload ?? {}, headers: { cookie: COOKIE } })

beforeAll(async () => {
  for (const t of ['candidateTag', 'duplicateHint', 'application', 'resumeFile', 'candidate', 'jobMember', 'job', 'team', 'user'] as const) {
    // @ts-expect-error 动态表名,顺序按外键依赖
    await prisma[t].deleteMany()
  }
  alice = await buildApp({ authFetch: whoami('ou_alice', '13800138001') })
  bob = await buildApp({ authFetch: whoami('ou_bob', '13800138002') })
  boss = await buildApp({ authFetch: whoami('ou_boss', SUPER_PHONE) })

  const team = await prisma.team.create({ data: { name: '研发', ownerId: 'x' } })
  const ra = await call(alice, 'POST', '/api/jobs', { teamId: team.id, title: '岗位A' })
  jobA = ra.json().id
  const rb = await call(bob, 'POST', '/api/jobs', { teamId: team.id, title: '岗位B' })
  jobB = rb.json().id
})

afterAll(async () => {
  await Promise.all([alice?.close(), bob?.close(), boss?.close()])
  await disconnectDb()
})

describe('normPhone', () => {
  // 飞书按账号返回 +86 / 86 / 裸号都有可能。不归一化的话超管判定会在某些
  // 账号上**静默**失配 —— 人还在,权限没了,且没有任何提示。
  it('剥国家码与分隔符', () => {
    expect(normPhone('+8613800138000')).toBe('13800138000')
    expect(normPhone('86 138 0013 8000')).toBe('13800138000')
    expect(normPhone('13800138000')).toBe('13800138000')
  })
})

describe('岗位可见性', () => {
  it('建岗者自动成为 owner,能看到自己的岗位', async () => {
    const list = await call(alice, 'GET', '/api/jobs')
    expect(list.json().map((j: { id: string }) => j.id)).toEqual([jobA])
  })

  // 岗位名本身就泄露招聘计划(「在招 CTO」往往比简历更敏感)。
  it('列表里看不到别人的岗位', async () => {
    const list = await call(bob, 'GET', '/api/jobs')
    const ids = list.json().map((j: { id: string }) => j.id)
    expect(ids).toEqual([jobB])
    expect(ids).not.toContain(jobA)
  })

  // 用 404 而不是 403:403 等于确认「这个岗位存在,只是你没权限」,
  // 那本身就是信息泄露。
  it('直接访问别人的岗位 → 404,不是 403', async () => {
    expect((await call(bob, 'GET', `/api/jobs/${jobA}`)).statusCode).toBe(404)
    expect((await call(bob, 'GET', `/api/jobs/${jobA}/candidates`)).statusCode).toBe(404)
    expect((await call(bob, 'PATCH', `/api/jobs/${jobA}`, { title: '改' })).statusCode).toBe(404)
  })

  it('往别人的岗位传简历 → 404', async () => {
    const r = await call(bob, 'POST', '/api/files/paste', {
      jobId: jobA, text: '张三，前端工程师，五年经验，熟悉 React 与 TypeScript。',
    })
    expect(r.statusCode).toBe(404)
  })

  it('上传不带 jobId → 400(不存在无主简历)', async () => {
    const r = await call(alice, 'POST', '/api/files/paste', {
      text: '李四，后端工程师，三年经验，熟悉 Java 与 Spring。',
    })
    expect(r.statusCode).toBe(400)
  })
})

describe('成员管理', () => {
  it('加成员后对方立刻看得到该岗位', async () => {
    const me = await call(bob, 'GET', '/api/me')
    const bobId = me.json().id

    expect((await call(bob, 'GET', `/api/jobs/${jobA}`)).statusCode).toBe(404)
    const add = await call(alice, 'POST', `/api/jobs/${jobA}/members`, { userId: bobId })
    expect(add.statusCode).toBe(201)
    expect((await call(bob, 'GET', `/api/jobs/${jobA}`)).statusCode).toBe(200)
  })

  it('非 owner 不能加人', async () => {
    const me = await call(bob, 'GET', '/api/me')
    const r = await call(bob, 'POST', `/api/jobs/${jobA}/members`, { userId: me.json().id })
    expect(r.statusCode).toBe(403)
  })

  // 移除最后一个 owner 会让岗位永久无人可管 —— 连加人的入口都没了,
  // 恢复它只能直接改库。
  it('不能移除最后一位 owner', async () => {
    const members = await call(alice, 'GET', `/api/jobs/${jobA}/members`)
    const owner = members.json().members.find((m: { role: string }) => m.role === 'owner')
    const r = await call(alice, 'DELETE', `/api/jobs/${jobA}/members/${owner.userId}`)
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toBe('last_owner')
  })

  it('重复添加是幂等的,不报错', async () => {
    const me = await call(bob, 'GET', '/api/me')
    const r = await call(alice, 'POST', `/api/jobs/${jobA}/members`, { userId: me.json().id })
    expect(r.statusCode).toBe(200)
    expect(r.json().duplicate).toBe(true)
  })
})

describe('超管', () => {
  it('ADMIN_MOBILES 里的超管看得到全部岗位', async () => {
    const list = await call(boss, 'GET', '/api/jobs')
    const ids = list.json().map((j: { id: string }) => j.id)
    expect(ids).toContain(jobA)
    expect(ids).toContain(jobB)
  })

  it('/api/me 如实报告超管身份', async () => {
    expect((await call(boss, 'GET', '/api/me')).json().isSuperAdmin).toBe(true)
    expect((await call(alice, 'GET', '/api/me')).json().isSuperAdmin).toBe(false)
  })

  // 隔离之后这三件事没有别的合法调用者:跨岗位候选人谁都删不干净,
  // 而审计日志由被审计者自己看就失去了意义。
  it('高危操作只有超管能做', async () => {
    for (const [m, u] of [['GET', '/api/audit'], ['POST', '/api/candidates/bulk-delete']] as const) {
      expect((await call(alice, m, u, { ids: ['x'] })).statusCode, `${m} ${u}`).toBe(403)
    }
    expect((await call(boss, 'GET', '/api/audit')).statusCode).toBe(200)
  })
})

describe('候选人级可见性', () => {
  // 只读接口挡住、写接口没挡 = 留了一扇后门,而且从写操作的成败还能反推出
  // 这个候选人存在。这几条守的就是那扇门。
  it('对别人岗位下的候选人做写操作 → 404', async () => {
    const other = await prisma.candidate.create({ data: { name: '别人的候选人' } })
    await prisma.resumeFile.create({
      data: {
        candidateId: other.id, jobId: jobB, source: 'upload', sha256: `s-${Date.now()}`,
        filename: 'x.pdf', mimeType: 'application/pdf', bytes: 1,
        storagePath: '/tmp/x.pdf', uploadedById: 'u',
      },
    })

    const mine = await prisma.candidate.create({ data: { name: '我的候选人' } })
    await prisma.resumeFile.create({
      data: {
        candidateId: mine.id, jobId: jobA, source: 'upload', sha256: `s2-${Date.now()}`,
        filename: 'y.pdf', mimeType: 'application/pdf', bytes: 1,
        storagePath: '/tmp/y.pdf', uploadedById: 'u',
      },
    })

    // alice 只在岗位 A(以及被加进来的 jobA),看不到 jobB 下的人
    expect((await call(alice, 'GET', `/api/candidates/${other.id}`)).statusCode).toBe(404)
    expect((await call(alice, 'POST', `/api/candidates/${other.id}/undo-merge`)).statusCode).toBe(404)
    expect((await call(alice, 'POST', `/api/candidates/${other.id}/tags`, {
      jobId: jobA, label: '内推',
    })).statusCode).toBe(404)
    // 合并:把别人的合并到自己的 → 拒绝(否则等于把数据拉过来)
    expect((await call(alice, 'POST', `/api/candidates/${other.id}/merge`, {
      intoId: mine.id,
    })).statusCode).toBe(404)
    // 反向:把自己的推给别人 → 同样拒绝
    expect((await call(alice, 'POST', `/api/candidates/${mine.id}/merge`, {
      intoId: other.id,
    })).statusCode).toBe(404)

    // 自己岗位下的候选人正常可读
    expect((await call(alice, 'GET', `/api/candidates/${mine.id}`)).statusCode).toBe(200)
  })
})

describe('未登录', () => {
  it('业务路由一律拒绝', async () => {
    const anon = await buildApp({
      authFetch: (async () => new Response(JSON.stringify({ authenticated: false }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    })
    try {
      for (const u of ['/api/jobs', '/api/me', '/api/files', '/api/users']) {
        expect([401, 503], u).toContain((await anon.inject({ method: 'GET', url: u })).statusCode)
      }
    } finally {
      await anon.close()
    }
  })
})

// 写接口的越权:读接口挡住了、写接口没挡,等于留后门(见 canAccessCandidate 注释)。
// cuid 不可枚举,但链接、通知深链、被移出岗位前的收藏都可能让人拿到别人的 id。
describe('写接口:引用别人岗位 / 候选人的 id', () => {
  let bobCandidate = ''
  beforeAll(async () => {
    const c = await prisma.candidate.create({ data: { name: 'B岗的候选人' } })
    bobCandidate = c.id
    await prisma.application.create({ data: { candidateId: c.id, jobId: jobB, createdById: 'x' } })
    await prisma.scorecard.upsert({
      where: { jobId: jobB },
      create: { jobId: jobB, gates: '[]', dimensions: '[{"key":"secret","label":"B岗机密标准"}]', updatedBy: 'x' },
      update: {},
    })
  })

  it('不能把别人岗位的候选人挂到自己岗位下', async () => {
    const r = await call(alice, 'POST', '/api/applications', { candidateId: bobCandidate, jobId: jobA })
    expect(r.statusCode).toBe(404)
    // 没有留下投递记录,候选人对 alice 仍不可见
    expect(await prisma.application.count({ where: { candidateId: bobCandidate, jobId: jobA } })).toBe(0)
    expect((await call(alice, 'GET', `/api/candidates/${bobCandidate}`)).statusCode).toBe(404)
  })

  it('不能复制别人岗位的评分卡,且与「源岗位没有评分卡」不可区分', async () => {
    const r = await call(alice, 'POST', `/api/jobs/${jobA}/scorecard/copy-from/${jobB}`)
    expect(r.statusCode).toBe(404)
    const none = await call(alice, 'POST', `/api/jobs/${jobA}/scorecard/copy-from/job-does-not-exist`)
    expect(none.statusCode).toBe(404)
    expect(r.json()).toEqual(none.json())
    expect((await call(alice, 'GET', `/api/jobs/${jobA}`)).json().scorecard).toBeNull()
  })

  it('自己可见的岗位之间仍可复制评分卡,并留下审计', async () => {
    const jobA2 = (await call(alice, 'POST', '/api/jobs', { teamId: (await prisma.team.findFirst())!.id, title: '岗位A2' })).json().id
    await prisma.scorecard.upsert({
      where: { jobId: jobA2 },
      create: { jobId: jobA2, gates: '[]', dimensions: '[{"key":"ok","label":"可复制"}]', updatedBy: 'x' },
      update: {},
    })
    const r = await call(alice, 'POST', `/api/jobs/${jobA}/scorecard/copy-from/${jobA2}`)
    expect(r.statusCode).toBe(200)
    const log = await prisma.auditLog.findFirst({ where: { targetType: 'job', targetId: jobA, action: 'replace_scorecard' } })
    expect(log).not.toBeNull()
    expect(log!.detail).toContain(jobA2)
  })

  it('改岗位信息会留下审计(只记字段名,不记内容)', async () => {
    const r = await call(alice, 'PATCH', `/api/jobs/${jobA}`, { title: '岗位A-改名', status: 'paused' })
    expect(r.statusCode).toBe(200)
    const log = await prisma.auditLog.findFirst({ where: { targetType: 'job', targetId: jobA, action: 'update_job' } })
    expect(log).not.toBeNull()
    expect(log!.detail).toContain('title')
    expect(log!.detail).toContain('status')
    expect(log!.detail).not.toContain('岗位A-改名')
  })
})

describe('DELETE /api/jobs/:id 的 force 参数', () => {
  // z.coerce.boolean() 把任何非空字符串(含 "false"、"0")都当成 true,会误删整岗数据。
  it.each(['false', '0'])('force=%s 不能当成 true:有候选人时仍返回 409 且数据保留', async (v) => {
    const job = (await call(bob, 'POST', '/api/jobs', { teamId: (await prisma.team.findFirst())!.id, title: `删除测试-${v}` })).json().id
    const c = await prisma.candidate.create({ data: { name: '待删岗位的候选人' } })
    await prisma.application.create({ data: { candidateId: c.id, jobId: job, createdById: 'x' } })
    const r = await call(bob, 'DELETE', `/api/jobs/${job}?force=${v}`)
    expect(r.statusCode).toBe(409)
    expect(await prisma.job.count({ where: { id: job } })).toBe(1)
    expect(await prisma.application.count({ where: { jobId: job } })).toBe(1)
  })

  it('force=true 才会级联删除', async () => {
    const job = (await call(bob, 'POST', '/api/jobs', { teamId: (await prisma.team.findFirst())!.id, title: '删除测试-true' })).json().id
    const c = await prisma.candidate.create({ data: { name: '将被级联的投递' } })
    await prisma.application.create({ data: { candidateId: c.id, jobId: job, createdById: 'x' } })
    const r = await call(bob, 'DELETE', `/api/jobs/${job}?force=true`)
    expect(r.statusCode).toBe(200)
    expect(r.json().removedApplications).toBe(1)
  })
})

describe('M1:候选人全局字段不得跨岗位泄露', () => {
  // 强匹配后候选人主体是全局的:岗位 B 的简历里的备用手机、邮箱、新姓名都会并进同一个
  // Candidate。详情接口只过滤了 files / applications / tags,这三项原样返回就是泄露。
  const parsedRaw = (basic: Record<string, string>) => JSON.stringify({
    basic: { name: null, phone: null, email: null, city: null, expectedTitle: null, expectedSalary: null, summary: null, ...basic },
    education: [], work: [], project: [], skill: [], cert: [],
    injectionSuspected: false, injectionEvidence: null,
  })

  async function addResume(candidateId: string, jid: string, sha: string, basic: Record<string, string>, edited = '{}') {
    const f = await prisma.resumeFile.create({
      data: {
        candidateId, jobId: jid, source: 'upload', sha256: sha, filename: `${sha}.pdf`,
        mimeType: 'application/pdf', bytes: 1, storagePath: `/tmp/${sha}.pdf`, uploadedById: 'u',
        parseState: 'parsed',
      },
    })
    await prisma.resumeParsed.create({
      data: {
        resumeFileId: f.id, parserVersion: 't', promptVersion: 't', providerId: 'claude',
        deliveryMode: 'text', raw: parsedRaw(basic), editedFields: edited,
      },
    })
    return f
  }

  let cid = ''
  beforeAll(async () => {
    // 岗位 A(alice 可见)里姓名「张甲」手机 P;岗位 B(alice 不可见)里姓名「李乙」、手机 P + 备用手机 Q + 邮箱 E。
    const c = await prisma.candidate.create({ data: { name: '李乙' } })
    cid = c.id
    await addResume(cid, jobA, `m1-a-${Date.now()}`, { name: '张甲', phone: '13800138003' })
    await addResume(cid, jobB, `m1-b-${Date.now()}`, { name: '李乙', phone: '13800138003', email: 'secret@example.com' }, JSON.stringify({ basic: { phone: '13800138004' } }))
    for (const i of collectIdentifiers({ phone: '13800138003', email: 'secret@example.com' })) {
      await prisma.candidateIdentifier.create({ data: { candidateId: cid, ...i, isPrimary: i.kind === 'phone' } })
    }
    for (const i of collectIdentifiers({ phone: '13800138004' })) {
      await prisma.candidateIdentifier.create({ data: { candidateId: cid, ...i } })
    }
    await prisma.candidateAlias.createMany({ data: [{ candidateId: cid, alias: '张甲' }, { candidateId: cid, alias: '王丙' }] })
  })

  it('非超管只看到可见简历里出现过的联系方式、曾用名与姓名', async () => {
    const r = await call(alice, 'GET', `/api/candidates/${cid}`)
    expect(r.statusCode).toBe(200)
    const body = r.json()
    const values = body.identifiers.map((i: { value: string }) => i.value)
    expect(values).toEqual(['13800138003'])
    expect(body.aliases).toEqual(['张甲'])
    expect(body.name).toBe('张甲')
  })

  it('超管看到全部(行为不变)', async () => {
    const body = (await call(boss, 'GET', `/api/candidates/${cid}`)).json()
    expect(body.identifiers.map((i: { value: string }) => i.value).sort()).toEqual(['13800138003', '13800138004', 'secret@example.com'])
    expect(body.aliases.sort()).toEqual(['张甲', '王丙'])
    expect(body.name).toBe('李乙')
  })

  it('人工纠错(editedFields)后的联系方式在可见简历里也算可见', async () => {
    const f = await prisma.resumeFile.findFirstOrThrow({ where: { candidateId: cid, jobId: jobA } })
    await prisma.resumeParsed.update({ where: { resumeFileId: f.id }, data: { editedFields: JSON.stringify({ basic: { phone: '13800138004' } }) } })
    const body = (await call(alice, 'GET', `/api/candidates/${cid}`)).json()
    // 纠错值与原抽取值都出现在可见简历里;岗位 B 才有的邮箱仍不可见
    expect(body.identifiers.map((i: { value: string }) => i.value).sort()).toEqual(['13800138003', '13800138004'])
  })

  it('岗位候选人列表:本岗位简历解析失败时不回退到全局姓名', async () => {
    const c = await prisma.candidate.create({ data: { name: '别岗位的姓名' } })
    await prisma.application.create({ data: { candidateId: c.id, jobId: jobA, createdById: 'x' } })
    await prisma.resumeFile.create({
      data: {
        candidateId: c.id, jobId: jobA, source: 'upload', sha256: `m1-fail-${Date.now()}`, filename: 'f.pdf',
        mimeType: 'application/pdf', bytes: 1, storagePath: '/tmp/f.pdf', uploadedById: 'u', parseState: 'failed',
      },
    })
    const rows = (await call(alice, 'GET', `/api/jobs/${jobA}/candidates`)).json() as Array<{ candidateId: string; name: string }>
    const row = rows.find((x) => x.candidateId === c.id)!
    expect(row.name).not.toBe('别岗位的姓名')
  })
})

describe('M2:删除岗位清理孤儿文件并写审计', () => {
  async function seedFile(candidateId: string, jid: string, sha: string) {
    const uploads = join(env.DATA_DIR, 'uploads')
    const pages = join(env.DATA_DIR, 'resume-pages', sha)
    await mkdir(uploads, { recursive: true })
    await mkdir(pages, { recursive: true })
    const storagePath = join(uploads, `${sha}.pdf`)
    await writeFile(storagePath, 'x')
    await writeFile(join(pages, 'page-01.png'), 'x')
    await prisma.resumeFile.create({
      data: {
        candidateId, jobId: jid, source: 'upload', sha256: sha, filename: `${sha}.pdf`,
        mimeType: 'application/pdf', bytes: 1, storagePath, uploadedById: 'u',
      },
    })
    return { storagePath, pages }
  }

  it('force 删岗后:独占的原件 / 页图 / 孤儿候选人被清理,共享 sha 与仍有投递的候选人保留,并写 delete_job 审计', async () => {
    const teamId = (await prisma.team.findFirst())!.id
    const job = (await call(bob, 'POST', '/api/jobs', { teamId, title: 'M2-待删' })).json().id as string
    const stamp = Date.now()
    const orphan = await prisma.candidate.create({ data: { name: 'M2孤儿' } })
    const shared = await prisma.candidate.create({ data: { name: 'M2共享' } })
    await prisma.application.create({ data: { candidateId: orphan.id, jobId: job, createdById: 'x' } })
    await prisma.application.create({ data: { candidateId: shared.id, jobId: job, createdById: 'x' } })
    const solo = await seedFile(orphan.id, job, `m2-solo-${stamp}`)
    await seedFile(shared.id, job, `m2-shared-${stamp}`)
    const keep = await seedFile(shared.id, jobB, `m2-shared-${stamp}`) // 同 sha 另一岗位仍引用
    await prisma.mergeLog.create({ data: { fromCandidateId: orphan.id, intoCandidateId: shared.id, reason: 'M2自由文本', createdBy: 'x' } })

    const r = await call(bob, 'DELETE', `/api/jobs/${job}?force=true`)
    expect(r.statusCode).toBe(200)

    expect(existsSync(solo.storagePath)).toBe(false)
    expect(existsSync(solo.pages)).toBe(false)
    expect(existsSync(keep.storagePath)).toBe(true)
    expect(existsSync(keep.pages)).toBe(true)
    expect(await prisma.candidate.count({ where: { id: orphan.id } })).toBe(0)
    expect(await prisma.candidate.count({ where: { id: shared.id } })).toBe(1)
    const log = await prisma.auditLog.findFirst({ where: { action: 'delete_job', targetId: job } })
    expect(log).not.toBeNull()
    expect(log!.detail ?? '').not.toContain('M2')
    // 孤儿候选人的 MergeLog 自由文本一并清掉
    expect((await prisma.mergeLog.findFirst({ where: { fromCandidateId: orphan.id } }))?.reason ?? null).toBeNull()
  })

  it('成员增删写审计,detail 只记 userId', async () => {
    const teamId = (await prisma.team.findFirst())!.id
    const job = (await call(alice, 'POST', '/api/jobs', { teamId, title: 'M2-成员' })).json().id as string
    const bobId = (await call(bob, 'GET', '/api/me')).json().id as string
    expect((await call(alice, 'POST', `/api/jobs/${job}/members`, { userId: bobId })).statusCode).toBe(201)
    expect((await call(alice, 'DELETE', `/api/jobs/${job}/members/${bobId}`)).statusCode).toBe(200)
    const add = await prisma.auditLog.findFirst({ where: { action: 'add_member', targetId: job } })
    const rm = await prisma.auditLog.findFirst({ where: { action: 'remove_member', targetId: job } })
    expect(add?.detail).toContain(bobId)
    expect(rm?.detail).toContain(bobId)
  })
})

describe('L2:GET /api/teams 的岗位数只统计可见岗位', () => {
  it('非成员看到团队但岗位数不含他人的岗位,超管统计全部', async () => {
    const team = await prisma.team.create({ data: { name: `L2-${Date.now()}`, ownerId: 'x' } })
    const mine = (await call(alice, 'POST', '/api/jobs', { teamId: team.id, title: 'L2-alice' })).json().id as string
    await call(bob, 'POST', '/api/jobs', { teamId: team.id, title: 'L2-bob' })
    const pick = async (app: App) =>
      (await call(app, 'GET', '/api/teams')).json().find((t: { id: string }) => t.id === team.id)
    expect((await pick(alice))._count.jobs).toBe(1)
    expect((await pick(boss))._count.jobs).toBe(2)
    expect(mine).toBeTruthy()
  })
})

describe('L5:彻底删除清空 MergeLog 自由文本', () => {
  it('purge 后涉及该候选人的 MergeLog.reason 为空', async () => {
    const a = await prisma.candidate.create({ data: { name: 'L5甲' } })
    const b = await prisma.candidate.create({ data: { name: 'L5乙' } })
    const log = await prisma.mergeLog.create({ data: { fromCandidateId: a.id, intoCandidateId: b.id, reason: 'L5-含姓名的自由文本', createdBy: 'x' } })
    const r = await call(boss, 'DELETE', `/api/candidates/${a.id}`)
    expect(r.statusCode).toBe(200)
    expect((await prisma.mergeLog.findUniqueOrThrow({ where: { id: log.id } })).reason).toBeNull()
  })
})
