import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { env } from '../../env.js'
import { prisma } from '../../db.js'
import { resolveCandidate } from '../dedup/resolve.js'

export interface PurgeResult {
  candidateIds: string[]
  filesDeleted: number
  bytesFreed: number
  renderDirsDeleted: number
}

/**
 * 彻底删除一个候选人:DB 记录 + 原件 + 渲染页图。
 *
 * 连同**被合并进来的记录**一起删 —— 它们在 UI 上就是同一个人,只删主记录
 * 会留下一堆指向空处的孤儿。
 *
 * ⚠️ **删除不追溯历史备份**(已知边界):部署方若定期备份数据库和 DATA_DIR,
 * 备份里的副本不受影响,PII 的实际最长留存 = 删除时间 + 备份保留期。
 * 对外描述数据处理方式时必须按这个实情表述。
 */
export async function purgeCandidate(candidateId: string): Promise<PurgeResult> {
  const resolved = await resolveCandidate(candidateId)
  if (!resolved) return { candidateIds: [], filesDeleted: 0, bytesFreed: 0, renderDirsDeleted: 0 }

  const files = await prisma.resumeFile.findMany({
    where: { candidateId: { in: resolved.mergedIds } },
    select: { id: true, sha256: true, storagePath: true, bytes: true },
  })

  // 先删 DB 再删文件。反过来的话,删文件成功、删 DB 失败,会留下指向不存在
  // 文件的记录 —— 界面上是一条打不开的简历,比彻底消失更难排查。
  //
  // ⚠️ **ResumeFile 必须显式删**:它对 Candidate 是 `onDelete: SetNull`(不是
  // Cascade),只删 Candidate 的话这些行原地存活、只是 candidateId 变 null,
  // 而 ResumeParsed(cascade 挂在 ResumeFile 上)也跟着留下 —— 它的 raw 里是
  // **含姓名/手机/邮箱的完整 JSON**。更糟的是下面按 sha256 数引用时会数到这些
  // 没删掉的行,`stillUsed > 0` 恒成立 → 物理原件与渲染图一个都删不掉,
  // 接口却返回「已彻底删除」。
  //
  // DuplicateHint 的 candidateId/otherId 是裸字符串没有外键,也要一并清,
  // 否则对面那位的详情页会一直挂着一条「疑似与 (空) 是同一人」且点不动。
  await prisma.$transaction([
    prisma.resumeFile.deleteMany({ where: { candidateId: { in: resolved.mergedIds } } }),
    prisma.duplicateHint.deleteMany({
      where: {
        OR: [
          { candidateId: { in: resolved.mergedIds } },
          { otherId: { in: resolved.mergedIds } },
        ],
      },
    }),
    prisma.candidate.deleteMany({ where: { id: { in: resolved.mergedIds } } }),
  ])

  const { filesDeleted, bytesFreed, renderDirsDeleted } = await removeUnreferencedFiles(files)
  await clearMergeLogReasons(resolved.mergedIds)

  return { candidateIds: resolved.mergedIds, filesDeleted, bytesFreed, renderDirsDeleted }
}

export interface FileRef { sha256: string; storagePath: string; bytes: number }

/**
 * 删物理原件与渲染页图,**仅限已无任何 ResumeFile 引用的 sha256**。
 * 调用前必须已提交对应的 DB 删除(先删 DB 再删文件,理由见 purgeCandidate)。
 * 彻底删除候选人与删除岗位共用这一份逻辑,引用计数口径只此一处。
 */
export async function removeUnreferencedFiles(files: FileRef[]): Promise<Omit<PurgeResult, 'candidateIds'>> {
  let filesDeleted = 0
  let bytesFreed = 0
  let renderDirsDeleted = 0
  // 同一个人可能有多条 sha256 相同的记录(同一份简历传了两次)—— 按 sha 去重,
  // 否则同一个物理文件会被数两次,filesDeleted/bytesFreed 翻倍虚报。
  const seenSha = new Set<string>()
  for (const f of files) {
    if (seenSha.has(f.sha256)) continue
    seenSha.add(f.sha256)
    // 同一份文件可能被别人也上传过(sha256 相同 → 同一个物理文件)。
    // **还有别人引用就不能删物理文件**,否则会连带弄坏另一个候选人的简历。
    // 用一句 count 判断即可,不需要维护一个每次增删都可能写错的 refCount 字段。
    const stillUsed = await prisma.resumeFile.count({ where: { sha256: f.sha256 } })
    if (stillUsed > 0) continue

    await rm(f.storagePath, { force: true }).then(() => {
      filesDeleted += 1
      bytesFreed += f.bytes
    }).catch(() => { /* 文件已不在,当作已删 */ })

    await rm(join(env.DATA_DIR, 'resume-pages', f.sha256), { recursive: true, force: true })
      .then(() => { renderDirsDeleted += 1 })
      .catch(() => { /* 没渲染过 */ })
  }

  return { filesDeleted, bytesFreed, renderDirsDeleted }
}

/** 候选人彻底删除后,MergeLog.reason 是自由文本(可能含姓名 / 联系方式),清空;合并关系本身只含 id,保留。 */
export async function clearMergeLogReasons(candidateIds: string[]): Promise<void> {
  if (!candidateIds.length) return
  await prisma.mergeLog.updateMany({
    where: { OR: [{ fromCandidateId: { in: candidateIds } }, { intoCandidateId: { in: candidateIds } }] },
    data: { reason: null },
  })
}

/**
 * 删岗位后清理不再有任何简历与投递的候选人(只在该岗位投递过的人,删岗后没有界面能再找到他)。
 * 仍被其他候选人合并引用的主记录保留。
 */
export async function removeOrphanCandidates(candidateIds: string[]): Promise<number> {
  const ids = [...new Set(candidateIds)]
  if (!ids.length) return 0
  const orphans = await prisma.candidate.findMany({
    where: {
      id: { in: ids },
      resumeFiles: { none: {} },
      applications: { none: {} },
      mergedFrom: { none: {} },
    },
    select: { id: true },
  })
  const orphanIds = orphans.map((o) => o.id)
  if (!orphanIds.length) return 0
  await prisma.$transaction([
    prisma.duplicateHint.deleteMany({
      where: { OR: [{ candidateId: { in: orphanIds } }, { otherId: { in: orphanIds } }] },
    }),
    prisma.candidate.deleteMany({ where: { id: { in: orphanIds } } }),
  ])
  await clearMergeLogReasons(orphanIds)
  return orphanIds.length
}
