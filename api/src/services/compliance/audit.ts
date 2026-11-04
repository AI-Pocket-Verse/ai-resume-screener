import type { FastifyBaseLogger } from 'fastify'
import { prisma } from '../../db.js'

/**
 * 审计日志。PII 明文存储的核心配套 —— 防护不是靠加密,
 * 而是**访问控制 + 审计 + 最小留存**这三件事。少了审计这一环,
 * 「谁看了谁的简历」就完全无从追溯,那个权衡也就不成立了。
 */
export type AuditAction =
  | 'view_pii'      // 查看候选人完整联系方式
  | 'view_file'     // 打开/下载简历原件
  | 'export'
  | 'delete'
  | 'merge'
  | 'undo_merge'
  | 'update_job'        // 改岗位信息(detail 只记被改的字段名)
  | 'replace_scorecard' // 保存 / 复制评分卡(覆盖整张评分卡)
  | 'delete_job'         // 删岗位(detail 只记投递数 / 文件数)
  | 'add_member'        // 岗位加成员(detail 只记 userId)
  | 'remove_member'     // 岗位移除成员(detail 只记 userId)

export interface AuditInput {
  actorId: string
  action: AuditAction
  targetType: 'candidate' | 'resume_file' | 'application' | 'job'
  targetId?: string
  /** 目标的可读标签快照。**硬删后 targetId 会悬空** —— 存一份标签,
   *  审计记录在删除之后仍然读得懂。很便宜,漏了就补不回来。 */
  targetLabel?: string | null
  detail?: string
}

/** **绝不抛**:审计写失败不该让用户的正常操作失败(那会变成一个可用性问题),
 *  但必须留下告警 —— 审计静默失效比没有审计更危险。 */
export async function audit(input: AuditInput, log?: FastifyBaseLogger): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        targetLabel: input.targetLabel ?? null,
        detail: input.detail,
      },
    })
  } catch (e) {
    log?.error?.({ err: e, action: input.action, targetId: input.targetId }, '[audit] 审计日志写入失败')
  }
}
