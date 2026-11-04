import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { disconnectDb, prisma } from '../db.js'
import { ensureDefaultTeam } from './bootstrap.js'

beforeEach(async () => {
  // 子表先删,保证能清空团队
  for (const t of ['candidateTag', 'duplicateHint', 'application', 'resumeFile', 'jobMember', 'job', 'team'] as const) {
    // @ts-expect-error 动态表名,顺序按外键依赖
    await prisma[t].deleteMany()
  }
})
afterAll(async () => { await disconnectDb() })

describe('ensureDefaultTeam', () => {
  it('团队表为空时建「默认团队」', async () => {
    await ensureDefaultTeam()
    const teams = await prisma.team.findMany()
    expect(teams).toHaveLength(1)
    expect(teams[0]).toMatchObject({ name: '默认团队', ownerId: 'system' })
  })

  it('已有团队时不新增', async () => {
    await prisma.team.create({ data: { name: '研发', ownerId: 'x' } })
    await ensureDefaultTeam()
    expect(await prisma.team.count()).toBe(1)
  })

  it('重复与并发调用只产生一个', async () => {
    await Promise.all([ensureDefaultTeam(), ensureDefaultTeam(), ensureDefaultTeam()])
    await ensureDefaultTeam()
    expect(await prisma.team.count()).toBe(1)
  })
})
