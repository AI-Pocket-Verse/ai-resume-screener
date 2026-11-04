import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { ResumeExtraction } from '@ai-resume-screener/shared'
import { prisma } from '../../db.js'
import { attachResume } from './merge.js'
import { collectIdentifiers } from './normalize.js'
import { resolveCandidate } from './resolve.js'

// attachResume 全是 DB 交互,纯函数测试(dedup.test.ts)一行都覆盖不到它 ——
// 而它恰恰是「同一个人的两份简历会不会分裂成两条记录」的唯一决定者。

function ex(basic: Partial<ResumeExtraction['basic']>): ResumeExtraction {
  return {
    basic: {
      name: null, phone: null, email: null, city: null,
      expectedTitle: null, expectedSalary: null, summary: null,
      ...basic,
    },
    education: [], work: [], project: [], skill: [], cert: [],
    injectionSuspected: false, injectionEvidence: null,
  }
}

let seq = 0
/** 简历现在必须归属岗位(上传时就选),测试也得先有个岗位。 */
let jobId = ''
async function ensureJob(): Promise<string> {
  if (jobId) return jobId
  const team = await prisma.team.create({ data: { name: `T-${Date.now()}`, ownerId: 'test-user' } })
  const job = await prisma.job.create({
    data: { teamId: team.id, title: '测试岗位', jdRaw: '', createdBy: 'test-user' },
  })
  jobId = job.id
  return jobId
}

async function newFile(): Promise<string> {
  seq += 1
  const f = await prisma.resumeFile.create({
    data: {
      source: 'upload', jobId: await ensureJob(),
      sha256: `sha-${Date.now()}-${seq}`, filename: `r${seq}.pdf`,
      mimeType: 'application/pdf', bytes: 1, storagePath: `/tmp/r${seq}.pdf`,
      uploadedById: 'test-user',
    },
  })
  return f.id
}

beforeEach(async () => {
  // 顺序按外键依赖:子表先删。岗位保留(newFile 复用同一个)。
  await prisma.duplicateHint.deleteMany()
  await prisma.application.deleteMany()
  await prisma.candidateAlias.deleteMany()
  await prisma.candidateIdentifier.deleteMany()
  await prisma.resumeFile.deleteMany()
  await prisma.candidate.deleteMany()
})

afterAll(async () => { await prisma.$disconnect() })

describe('attachResume · 强匹配', () => {
  it('同一手机号的两份简历归到同一个候选人', async () => {
    const a = await attachResume(await newFile(), ex({ name: '张三', phone: '13800138001' }))
    const b = await attachResume(await newFile(), ex({ name: '张三', phone: '138-0013-8001' }))
    expect(a.outcome).toBe('created')
    expect(b.outcome).toBe('matched')
    expect(b.candidateId).toBe(a.candidateId)
    expect(await prisma.candidate.count()).toBe(1)
  })

  // 【核心回归】llmSemaphore=3,同一个人的两份简历(两个渠道收到)会并发解析。
  // 曾经的「先查后插」在这里各建一个候选人,而后建的那个 identifier 全部撞
  // 唯一约束被静默吞掉 —— 它身上一个联系方式都没有,从此再也匹配不上任何简历,
  // 只能靠人工发现。
  it('并发上传同一个人 → 只建一个候选人,且身上有联系方式', async () => {
    const [f1, f2, f3] = await Promise.all([newFile(), newFile(), newFile()])
    const results = await Promise.all([
      attachResume(f1, ex({ name: '李四', phone: '13800138002' })),
      attachResume(f2, ex({ name: '李四', phone: '13800138002' })),
      attachResume(f3, ex({ name: '李四', phone: '13800138002' })),
    ])

    expect(await prisma.candidate.count()).toBe(1)
    // 三次调用必须都指向那唯一的一个人。
    expect(new Set(results.map((r) => r.candidateId)).size).toBe(1)

    const only = await prisma.candidate.findFirstOrThrow()
    const ids = await prisma.candidateIdentifier.count({ where: { candidateId: only.id } })
    expect(ids).toBeGreaterThan(0) // 孤儿候选人的判据:一个 identifier 都没有

    // 三份简历都得挂上去,一份都不能掉。
    const files = await prisma.resumeFile.count({ where: { candidateId: only.id } })
    expect(files).toBe(3)
  })

  // 手机命中 A、邮箱属于 B,说明 A 和 B 其实是同一个人。只认第一个命中的话,
  // B 永远不会被发现,两条记录就此静默分叉。
  it('多个联系方式命中不同候选人时不会漏掉后面的', async () => {
    const a = await attachResume(await newFile(), ex({ name: '王五', phone: '13800138003' }))
    const b = await attachResume(await newFile(), ex({ name: '王五(英)', email: 'wang@example.com' }))
    expect(a.candidateId).not.toBe(b.candidateId)

    // 第三份同时带上两个联系方式 —— 必须归到已有的某一个,而不是又建第三个。
    const c = await attachResume(
      await newFile(),
      ex({ name: '王五', phone: '13800138003', email: 'wang@example.com' }),
    )
    expect(c.outcome).toBe('matched')
    expect([a.candidateId, b.candidateId]).toContain(c.candidateId)
    expect(await prisma.candidate.count()).toBe(2) // 没有凭空多出第三个
  })

  it('新联系方式补录到已有候选人身上', async () => {
    const a = await attachResume(await newFile(), ex({ name: '赵六', phone: '13800138004' }))
    await attachResume(await newFile(), ex({ name: '赵六', phone: '13800138004', email: 'zhao@example.com' }))
    const kinds = await prisma.candidateIdentifier.findMany({
      where: { candidateId: a.candidateId }, select: { kind: true },
    })
    expect(kinds.map((k) => k.kind).sort()).toEqual(['email', 'phone'])
  })
})

describe('attachResume · 姓名与别名', () => {
  it('改名时保留新名,旧名进 alias', async () => {
    const a = await attachResume(await newFile(), ex({ name: '陈某某', phone: '13800138005' }))
    await attachResume(await newFile(), ex({ name: 'Chen Moumou', phone: '13800138005' }))

    const c = await prisma.candidate.findUniqueOrThrow({ where: { id: a.candidateId } })
    expect(c.name).toBe('Chen Moumou')
    const aliases = await prisma.candidateAlias.findMany({ where: { candidateId: a.candidateId } })
    expect(aliases.map((x) => x.alias)).toEqual(['陈某某'])
  })

  // 命中的是【已被合并的副记录】时,曾经存进 alias 的是副记录的名字,而主记录
  // 原来的名字被新名直接覆盖、没有进 alias —— 一个曾用名就这么永久丢了。
  it('命中已合并的记录时,进 alias 的是主记录的旧名(不是副记录的)', async () => {
    const primary = await prisma.candidate.create({ data: { name: '主记录原名' } })
    const merged = await prisma.candidate.create({
      data: { name: '副记录名', mergedIntoId: primary.id },
    })
    // valueHash 必须用真实的归一化 + 哈希算,手写一个字符串是匹配不上的。
    const [phoneId] = collectIdentifiers({ phone: '13800138006' })
    await prisma.candidateIdentifier.create({
      data: {
        candidateId: merged.id, kind: phoneId!.kind,
        valueHash: phoneId!.valueHash, valueEnc: phoneId!.valueEnc,
      },
    })

    const r = await attachResume(await newFile(), ex({ name: '最新的名字', phone: '13800138006' }))

    // 归到主记录,不是副记录 —— 否则就形成了链。
    expect(r.candidateId).toBe(primary.id)
    const after = await prisma.candidate.findUniqueOrThrow({ where: { id: primary.id } })
    expect(after.name).toBe('最新的名字')
    const aliases = await prisma.candidateAlias.findMany({ where: { candidateId: primary.id } })
    expect(aliases.map((x) => x.alias)).toEqual(['主记录原名'])
    // 副记录的名字不该跑到主记录的 alias 里。
    expect(aliases.map((x) => x.alias)).not.toContain('副记录名')
  })

  it('归档后 resolveCandidate 能一起查到两条记录的简历', async () => {
    const primary = await prisma.candidate.create({ data: { name: '甲' } })
    const merged = await prisma.candidate.create({ data: { name: '乙', mergedIntoId: primary.id } })
    const resolved = await resolveCandidate(merged.id)
    expect(resolved?.primaryId).toBe(primary.id)
    expect(resolved?.mergedIds.sort()).toEqual([primary.id, merged.id].sort())
  })
})

describe('attachResume · 没有联系方式', () => {
  // 简历上没写手机邮箱是常事(尤其作品集 PDF)。不能因此报错,也不能把所有
  // 「无联系方式」的人合成同一个。
  it('无任何联系方式 → 每份各建一个候选人,不互相合并', async () => {
    const a = await attachResume(await newFile(), ex({ name: '无联系方式甲' }))
    const b = await attachResume(await newFile(), ex({ name: '无联系方式乙' }))
    expect(a.outcome).toBe('created')
    expect(b.outcome).toBe('created')
    expect(a.candidateId).not.toBe(b.candidateId)
  })
})
