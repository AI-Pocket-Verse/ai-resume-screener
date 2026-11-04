import type { FastifyBaseLogger } from 'fastify'
import { prisma } from '../../db.js'
import { env } from '../../env.js'
import { buildEvalDoneCard, buildParseDoneCard } from './cards.js'
import { pickCurrent } from '../evaluate/current.js'
import { isPushable, pushCard } from './gateway.js'
import { parseLang } from '../../utils/lang.js'

/**
 * 批次完成通知。
 *
 * 判定方式:每个 job 走到终态后,查同 batchId 是否还有非终态的 —— 没有就是这批
 * 跑完了。**不需要额外的计数器**,而计数器恰恰是容易写错、写错了又很难发现的东西
 * (漏减一次就永远不通知,多减一次就重复通知)。
 *
 * 幂等性:批次里最后一个 job 只会有一个,所以「查到零个非终态」这件事在正常情况下
 * 只发生一次。真出现并发重复推送,代价也只是多一张卡片,不做额外加锁。
 */

function jobUrl(jobId?: string): string {
  const base = env.WEB_PUBLIC_URL.replace(/\/$/, '')
  return jobId ? `${base}/?job=${jobId}` : `${base}/`
}

/** 解析批次跑完 → 推卡片。best-effort:通知失败绝不影响解析结果。 */
export async function notifyParseBatchIfDone(batchId: string | null, log?: FastifyBaseLogger): Promise<void> {
  if (!batchId) return
  try {
    const pending = await prisma.parseJob.count({
      where: { batchId, status: { in: ['queued', 'running'] } },
    })
    if (pending > 0) return

    const jobs = await prisma.parseJob.findMany({
      where: { batchId },
      select: { status: true, createdBy: true, resumeFileId: true, lang: true },
    })
    if (!jobs.length) return
    const openId = jobs[0]!.createdBy
    if (!isPushable(openId)) return

    // 这批里有多少份检出了疑似操纵内容。检出了却不告诉 HR 等于没检出 ——
    // 他们不会为了看这个逐个点开候选人详情。
    const parsedRows = await prisma.resumeParsed.findMany({
      where: { resumeFileId: { in: jobs.map((j) => j.resumeFileId) } },
      select: { raw: true },
    })
    let injectionSuspected = 0
    for (const p of parsedRows) {
      // 单行坏数据不该让整条通知链断掉 —— 通知是 best-effort 的附加价值。
      try {
        if ((JSON.parse(p.raw) as { injectionSuspected?: unknown }).injectionSuspected === true) {
          injectionSuspected += 1
        }
      } catch { /* 解析不了就当没检出 */ }
    }

    await pushCard(openId, buildParseDoneCard({
      total: jobs.length,
      parsed: jobs.filter((j) => j.status === 'done').length,
      failed: jobs.filter((j) => j.status === 'failed').length,
      injectionSuspected,
      jobUrl: jobUrl(),
    }, parseLang(jobs[0]!.lang)))
  } catch (e) {
    log?.warn?.({ err: e, batchId }, '[notify] 解析完成通知失败')
  }
}

/** 评估批次跑完 → 推卡片,带档位分布。 */
export async function notifyEvalBatchIfDone(batchId: string | null, log?: FastifyBaseLogger): Promise<void> {
  if (!batchId) return
  try {
    const pending = await prisma.evalJob.count({
      where: { batchId, status: { in: ['queued', 'running'] } },
    })
    if (pending > 0) return

    const jobs = await prisma.evalJob.findMany({
      where: { batchId },
      select: { status: true, createdBy: true, applicationId: true, lang: true },
    })
    if (!jobs.length) return
    const openId = jobs[0]!.createdBy
    if (!isPushable(openId)) return
    const lang = parseLang(jobs[0]!.lang)

    const application = await prisma.application.findUnique({
      where: { id: jobs[0]!.applicationId },
      select: { jobId: true, job: { select: { title: true } } },
    })

    // 档位分布取这批人**当前有效结论**的档位,判定统一走 pickCurrent。
    //
    // 曾经这里自己按 createdAt desc 取每人最新一条,有两个问题:
    // ① 跨 tier 比时间,违反 current.ts 定的规则(精评优先,哪怕之后又跑过
    //    粗评)—— 卡片说的档位会和界面上显示的对不上,而卡片正是 HR 判断
    //    「这批人质量如何」的唯一依据;
    // ② 查询不限本批,失败 job 对应的 application 会把**上一次**的旧评估
    //    算进这次的分布,凭空多出几个人。
    const okAppIds = jobs.filter((j) => j.status === 'done').map((j) => j.applicationId)
    const evals = okAppIds.length
      ? await prisma.evaluation.findMany({
        where: { applicationId: { in: okAppIds } },
        select: { id: true, applicationId: true, tier: true, grade: true, weightedScore: true, createdAt: true },
      })
      : []
    const byApp = new Map<string, typeof evals>()
    for (const e of evals) {
      const list = byApp.get(e.applicationId)
      if (list) list.push(e)
      else byApp.set(e.applicationId, [e])
    }
    const grades: Partial<Record<'A' | 'B' | 'C' | 'D', number>> = {}
    for (const list of byApp.values()) {
      const g = pickCurrent(list)?.grade
      if (g) grades[g] = (grades[g] ?? 0) + 1
    }

    await pushCard(openId, buildEvalDoneCard({
      jobTitle: application?.job.title ?? (lang === 'en' ? 'Job' : '岗位'),
      total: jobs.length,
      done: jobs.filter((j) => j.status === 'done').length,
      failed: jobs.filter((j) => j.status === 'failed').length,
      grades,
      jobUrl: jobUrl(application?.jobId),
    }, lang))
  } catch (e) {
    log?.warn?.({ err: e, batchId }, '[notify] 分析完成通知失败')
  }
}
