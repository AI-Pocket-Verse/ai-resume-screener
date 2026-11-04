import type { ResumeExtraction } from '@ai-resume-screener/shared'
import { prisma } from '../../db.js'
import { collectIdentifiers } from './normalize.js'
import { weakMatch } from './match.js'

export interface AttachResult {
  candidateId: string
  /** 'created' 新建 | 'matched' 命中已有主体(强匹配) */
  outcome: 'created' | 'matched'
  /** 强匹配时命中的字段,给 UI 的轻提示用。 */
  matchedBy?: 'phone' | 'email'
  /** 弱匹配提示,建了 DuplicateHint。 */
  hints: Array<{ otherId: string; otherName: string | null; matchedField: string }>
}

/**
 * 把一份解析完的简历挂到候选人主体上,顺带做去重。
 *
 * 强匹配靠 `CandidateIdentifier` 上的 `@@unique([kind, valueHash])`:
 * **先查,查不到就建;建的时候撞约束说明有人抢先了,退化成「命中已有主体」。**
 * 单靠「先查后插」在 llmSemaphore=3 的并发下会建出两个候选人,而且后建的那个
 * identifier 全部插入失败(被唯一约束挡掉),它身上一个联系方式都没有 ——
 * 从此再也匹配不上任何简历,只能靠人工发现。批量上传同一个人的两份简历
 * (从两个渠道收到)就会触发,是很现实的场景。
 */
export async function attachResume(
  resumeFileId: string,
  extraction: ResumeExtraction,
): Promise<AttachResult> {
  const identifiers = collectIdentifiers(extraction.basic)
  const name = extraction.basic.name?.trim() || null

  // 1) 强匹配。**查全部联系方式,不是第一个命中就收工**:手机命中 A、邮箱
  //    属于 B 时,只认第一个的话 B 永远不会被发现是同一人 —— 本该合并的两条
  //    就这么静默分叉了。这里把命中的都拿回来,由 pickPrimary 决定归到谁。
  const hits = identifiers.length
    ? await prisma.candidateIdentifier.findMany({
      where: { OR: identifiers.map((id) => ({ kind: id.kind, valueHash: id.valueHash })) },
      select: { kind: true, candidateId: true },
    })
    : []

  if (hits.length > 0) {
    const primary = await pickPrimary(hits.map((h) => h.candidateId))
    await linkFile(resumeFileId, primary.id)
    await addMissingIdentifiers(primary.id, identifiers)
    await renameWithAlias(primary, name)
    return {
      candidateId: primary.id,
      outcome: 'matched',
      matchedBy: hits[0]!.kind as 'phone' | 'email',
      hints: [],
    }
  }

  // 2) 没有强匹配 → 建新候选人。**建档与写 identifier 同一个事务**:
  //    分两步的话,中间崩溃/并发会留下一个没有任何联系方式的孤儿候选人。
  let candidate: { id: string }
  try {
    candidate = await prisma.$transaction(async (tx) => {
      const c = await tx.candidate.create({ data: { name } })
      for (const id of identifiers) {
        await tx.candidateIdentifier.create({
          data: { candidateId: c.id, kind: id.kind, valueHash: id.valueHash, valueEnc: id.valueEnc },
        })
      }
      return c
    })
  } catch (e) {
    // 唯一约束冲突 = 并发的另一份简历刚刚为同一个人建了档。整个事务已回滚
    // (不会留下半个候选人),重查一次归到那个人身上 —— 这正是「先查后插」
    // 缺的那一环。
    if (!isUniqueViolation(e) || identifiers.length === 0) throw e
    const raced = await prisma.candidateIdentifier.findMany({
      where: { OR: identifiers.map((id) => ({ kind: id.kind, valueHash: id.valueHash })) },
      select: { kind: true, candidateId: true },
    })
    if (!raced.length) throw e
    const primary = await pickPrimary(raced.map((h) => h.candidateId))
    await linkFile(resumeFileId, primary.id)
    await addMissingIdentifiers(primary.id, identifiers)
    await renameWithAlias(primary, name)
    return {
      candidateId: primary.id,
      outcome: 'matched',
      matchedBy: raced[0]!.kind as 'phone' | 'email',
      hints: [],
    }
  }
  await linkFile(resumeFileId, candidate.id)

  // 3) 弱匹配:同名的人里找同校同届 / 同公司同期。**只提示,不合并。**
  const hints: AttachResult['hints'] = []
  if (name) {
    const sameName = await prisma.candidate.findMany({
      where: { name, id: { not: candidate.id }, mergedIntoId: null },
      select: {
        id: true, name: true,
        resumeFiles: { where: { parsed: { isNot: null } }, select: { parsed: { select: { raw: true } } }, take: 1 },
      },
      take: 20,
    })
    for (const other of sameName) {
      const raw = other.resumeFiles[0]?.parsed?.raw
      if (!raw) continue
      // 一条坏 JSON 不该让整份简历入库失败 —— 去重提示是锦上添花,
      // 而这里正处在「简历解析完、要落库」的主链路上。
      let otherExtraction: ResumeExtraction
      try {
        otherExtraction = JSON.parse(raw) as ResumeExtraction
      } catch { continue }
      const m = weakMatch(extraction, otherExtraction)
      if (!m) continue
      await prisma.duplicateHint.create({
        data: { candidateId: candidate.id, otherId: other.id, matchedField: m.matchedField, score: m.score },
      }).catch(() => { /* 已提示过 */ })
      hints.push({ otherId: other.id, otherName: other.name, matchedField: m.matchedField })
    }
  }

  return { candidateId: candidate.id, outcome: 'created', hints }
}

/** Prisma 的唯一约束冲突。用 code 判而不是匹配错误文本 —— 文本会随版本变。 */
function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string })?.code === 'P2002'
}

/**
 * 一组命中的候选人 id → 归属的主记录。
 *
 * 命中多个是正常的(手机属于 A、邮箱属于 B,说明 A 和 B 其实是同一个人)。
 * 这里只挑一个归档,**不自动合并** A 和 B —— 自动合并两个已有主体风险太大
 * (一次误判要人工拆),留给弱匹配提示 + 人工确认。
 */
async function pickPrimary(
  candidateIds: string[],
): Promise<{ id: string; name: string | null }> {
  const rows = await prisma.candidate.findMany({
    where: { id: { in: [...new Set(candidateIds)] } },
    select: { id: true, name: true, mergedIntoId: true, createdAt: true },
    orderBy: { createdAt: 'asc' }, // 归到最早建的那个,结果稳定不随查询顺序漂
  })
  const first = rows[0]
  if (!first) throw new Error('pickPrimary: 命中的候选人全都不存在')
  // 命中的是已被合并的记录时,归到它的主记录上,避免形成链式。
  if (!first.mergedIntoId) return { id: first.id, name: first.name }
  const owner = await prisma.candidate.findUnique({
    where: { id: first.mergedIntoId },
    select: { id: true, name: true },
  })
  return owner ?? { id: first.id, name: first.name }
}

/**
 * 姓名不一致时保留最新的,旧的进 aliases —— 改名/英文名/曾用名都很常见。
 *
 * ⚠️ 旧名必须取**主记录**的 name。曾经这里查的是命中行所属的候选人、写的却是
 * 主记录:命中已合并记录时,存进 alias 的是副记录的名字,而主记录**原来的名字
 * 被新名直接覆盖、没有进 alias** —— 一个曾用名就这么永久丢了,而 alias 里
 * 反倒多出一个本就该在别处的名字。
 */
async function renameWithAlias(
  primary: { id: string; name: string | null },
  name: string | null,
): Promise<void> {
  if (!name || !primary.name || primary.name === name) return
  await prisma.candidateAlias.create({
    data: { candidateId: primary.id, alias: primary.name },
  }).catch(() => { /* 已存在 */ })
  await prisma.candidate.update({ where: { id: primary.id }, data: { name } })
}

async function linkFile(resumeFileId: string, candidateId: string): Promise<void> {
  await prisma.resumeFile.update({ where: { id: resumeFileId }, data: { candidateId } })
  await prisma.candidate.update({ where: { id: candidateId }, data: { lastActivityAt: new Date() } })
}

/** 补齐这个人身上还没有的联系方式。**多值是刻意的**:张三首投用 A 号建档、
 *  后来合并进 B 号,如果只留一个 hash,他用 A 号再投时就查不到了 ——
 *  合并做得越多、后续去重越漏。 */
async function addMissingIdentifiers(
  candidateId: string,
  identifiers: ReturnType<typeof collectIdentifiers>,
): Promise<void> {
  for (const id of identifiers) {
    await prisma.candidateIdentifier.create({
      data: { candidateId, kind: id.kind, valueHash: id.valueHash, valueEnc: id.valueEnc },
    }).catch(() => { /* 唯一约束:已属于某人,跳过 */ })
  }
}

export class MergeError extends Error {
  constructor(public readonly code: 'not_found' | 'would_chain' | 'same_candidate', message: string) {
    super(message)
  }
}

/**
 * 人工合并。**只写 mergedIntoId,不动任何子行** —— 撤销就是把它置回 null,
 * 不需要行级回滚器。
 */
export async function mergeCandidates(
  fromId: string,
  intoId: string,
  actorId: string,
  reason?: string,
): Promise<void> {
  if (fromId === intoId) throw new MergeError('same_candidate', '不能与自己合并')

  // 校验与写入**在同一个事务里**。分开做的话,两个 HR 同时对交叉的候选人做
  // 合并(A→B 与 B→C)会各自通过校验、然后双双写入,造出 A→B→C 的链 ——
  // 而 resolveCandidate 只解一层,链上的数据会开始「时隐时现」,是最难排查的
  // 那类故障。概率低,但代价是脏数据,而防住它只要把检查挪进来。
  await prisma.$transaction(async (tx) => {
    const [from, into] = await Promise.all([
      tx.candidate.findUnique({ where: { id: fromId }, select: { id: true } }),
      tx.candidate.findUnique({ where: { id: intoId }, select: { id: true, mergedIntoId: true } }),
    ])
    if (!from || !into) throw new MergeError('not_found', '候选人不存在')

    // **禁止链式**:目标自身必须是主记录。允许 A→B→C 的话,resolveCandidate 就得
    // 递归,而一条坏数据会把查询拖进死循环 —— 所以在写入时挡死,读取侧只解一层。
    if (into.mergedIntoId) {
      throw new MergeError('would_chain', '目标候选人已被合并到别处,请直接合并到最终的主记录')
    }
    // 反向也要挡:把 B 合进 A 时,若已有人合进了 B,合完就成了链。
    const hasIncoming = await tx.candidate.count({ where: { mergedIntoId: fromId } })
    if (hasIncoming > 0) {
      throw new MergeError('would_chain', '该候选人下已合并了其他记录,请先撤销')
    }

    await tx.candidate.update({ where: { id: fromId }, data: { mergedIntoId: intoId } })
    await tx.mergeLog.create({
      data: { fromCandidateId: fromId, intoCandidateId: intoId, autoMerged: false, reason, createdBy: actorId },
    })
    // 合并后两边的相互提示就没意义了。
    await tx.duplicateHint.updateMany({
      where: { OR: [{ candidateId: fromId, otherId: intoId }, { candidateId: intoId, otherId: fromId }] },
      data: { dismissedAt: new Date(), dismissedBy: actorId },
    })
  })
}

/** 撤销合并。MergeLog **永久保留**(只打 undoneAt),任何时候可再拆。 */
export async function undoMerge(fromId: string, actorId: string): Promise<void> {
  const c = await prisma.candidate.findUnique({ where: { id: fromId }, select: { mergedIntoId: true } })
  if (!c?.mergedIntoId) throw new MergeError('not_found', '该候选人未被合并')

  await prisma.$transaction([
    prisma.candidate.update({ where: { id: fromId }, data: { mergedIntoId: null } }),
    prisma.mergeLog.updateMany({
      where: { fromCandidateId: fromId, undoneAt: null },
      data: { undoneAt: new Date(), undoneBy: actorId },
    }),
  ])
}
