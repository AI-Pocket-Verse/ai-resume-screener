import { prisma } from '../db.js'

/**
 * 团队表为空时建一个「默认团队」,让新部署的实例开箱即可建岗位(建岗要先选团队)。
 * 并发 / 重复调用安全:团队名唯一,撞约束(P2002)说明别处已建好,视为成功。
 */
export async function ensureDefaultTeam(): Promise<void> {
  if ((await prisma.team.count()) > 0) return
  try {
    await prisma.team.create({ data: { name: '默认团队', ownerId: 'system' } })
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002') throw e
  }
}
