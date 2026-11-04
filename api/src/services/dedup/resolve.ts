import { prisma } from '../../db.js'

/**
 * 把任意 candidateId 解析到「主记录」。
 *
 * 合并只写 `mergedIntoId`、**不动任何子行**,所以查子表时必须用
 * 「主记录 id + 所有指向它的被合并 id」一起查,否则合并进来的那个人的简历、
 * 投递、标签全都看不见。
 *
 * ⚠️ **纪律性要求**:所有「查候选人的文件/投递/标签」的读路径**必须走这里**。
 * 这是唯一的风险点 —— 漏一处的表现是「数据时隐时现」,极难排查。
 * 所以除本函数外不应再有别的地方直接用裸 candidateId 查子表。
 */
export interface ResolvedCandidate {
  /** 若 id 已被合并,返回合并目标;否则返回自身。 */
  primaryId: string
  /** 主记录 + 所有被合并进来的 id。查子表用 `{ candidateId: { in: mergedIds } }`。 */
  mergedIds: string[]
  /** 供 UI 提示「已与 XX 合并」。 */
  wasRedirected: boolean
}

export async function resolveCandidate(id: string): Promise<ResolvedCandidate | null> {
  const self = await prisma.candidate.findUnique({
    where: { id },
    select: { id: true, mergedIntoId: true },
  })
  if (!self) return null

  // **不做递归**:成环/链式防御放在写入时(合并前校验目标自身 mergedIntoId IS NULL),
  // 这里只解一层。递归解析会让一条坏数据把整个查询拖进死循环。
  const primaryId = self.mergedIntoId ?? self.id
  const merged = await prisma.candidate.findMany({
    where: { mergedIntoId: primaryId },
    select: { id: true },
  })
  return {
    primaryId,
    mergedIds: [primaryId, ...merged.map((m) => m.id)],
    wasRedirected: Boolean(self.mergedIntoId),
  }
}
