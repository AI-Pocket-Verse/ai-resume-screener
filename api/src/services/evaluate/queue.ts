// 评估队列。与 ParseJob 同构(同一套 4 段范式),但挂在【投递】上而非文件上:
// 解析属于文件、评估属于投递,生命周期不同(解析自动、评估手动)。
import type { FastifyBaseLogger } from 'fastify'
import { Scorecard, type DimensionScore } from '@ai-resume-screener/shared'
import { prisma } from '../../db.js'
import { evaluateResume } from './evaluate.js'
import { mergeResume } from './merge.js'
import { computePeerContext } from './peers.js'
import { evalPromptVersion } from './prompt.js'
import { parseLang, type Lang } from '../../utils/lang.js'
import { PARSER_VERSION } from '../parse/prompt.js'
import { notifyEvalBatchIfDone } from '../notify/batch.js'
import { resolveCandidate } from '../dedup/resolve.js'

const TICK_MS = 5_000
const BATCH = 10
const MAX_ATTEMPTS = 3
const running = new Set<string>()

/** 指数退避。`attempt` 从 1 起(调用点是 `job.attempt + 1`),指数减 1 才取得到
 *  首档 —— 与 parse/queue.ts 同一套。MAX_ATTEMPTS=3 → 实际是 30s → 2min。 */
function retryDelayMs(attempt: number): number {
  return 30_000 * 4 ** Math.max(0, attempt - 1)
}

/** 跑一次评估并落库。失败抛错,由调用方决定退避还是终止。
 *  导出是为了让 seed / 验证脚本走**同一条生产路径** —— 脚本另写一份落库逻辑
 *  必然与这里漂移(横向定位就是这么漏掉过的)。 */
export async function runEvaluation(applicationId: string, tier: 'screen' | 'deep', lang: Lang = 'zh'): Promise<void> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { job: { include: { team: true, scorecard: true } } },
  })
  if (!app) throw new Error(`Application ${applicationId} 不存在`)
  if (!app.job.scorecard) throw new Error('该岗位还没有评分卡')

  // ⚠️ **必须走 resolveCandidate**:合并只写 mergedIntoId、不动子行,所以简历
  // 可能挂在被合并掉的那条记录名下。用裸 candidateId 查的话,合并过的候选人
  // 要么评的是过期的旧简历,要么直接「没有解析完成的简历」重试到死 ——
  // 而界面上他明明有简历。resolve.ts 把这条纪律标成唯一的风险点,
  // 这里(打分输入)正是最要命的那一处。
  const resolved = await resolveCandidate(app.candidateId)
  const parsedFile = resolved
    ? await prisma.resumeFile.findFirst({
        where: { candidateId: { in: resolved.mergedIds }, parsed: { isNot: null } },
        orderBy: { uploadedAt: 'desc' },
        include: { parsed: true },
      })
    : null
  if (!parsedFile?.parsed) throw new Error('该候选人还没有解析完成的简历')

  const scorecard = Scorecard.parse({
    gates: JSON.parse(app.job.scorecard.gates),
    dimensions: JSON.parse(app.job.scorecard.dimensions),
  })

  // 读【合并视图】:raw 叠加人工修正,derived 重算。不这样做的话,HR 的纠错
  // 对打分毫无影响。
  const resume = mergeResume(
    JSON.parse(parsedFile.parsed.raw),
    JSON.parse(parsedFile.parsed.editedFields),
  )

  const r = await evaluateResume({
    jobTitle: app.job.title,
    teamName: app.job.team.name,
    jdSummary: app.job.jdRaw.slice(0, 2000),
    scorecard,
    resume,
    tier,
    lang,
  })
  if (!r.output || !r.grade) throw new Error(r.error ?? '评估失败')

  // 横向定位:同岗位其他人的维度分。由代码算 —— 数据现成,让模型"感觉"排名
  // 只会引入幻觉(它根本看不到别人的分)。只有精评需要。
  let peerContext = null
  if (tier === 'deep') {
    const peers = await prisma.evaluation.findMany({
      where: { application: { jobId: app.jobId }, applicationId: { not: applicationId } },
      orderBy: { createdAt: 'desc' },
      select: { applicationId: true, scores: true },
    })
    // 同一个人可能有多条评估,只取每人最新的一条参与比较。
    const latestPerPerson = new Map<string, DimensionScore[]>()
    for (const p of peers) {
      if (!latestPerPerson.has(p.applicationId)) {
        latestPerPerson.set(p.applicationId, JSON.parse(p.scores))
      }
    }
    peerContext = computePeerContext(r.output.scores, [...latestPerPerson.values()], scorecard.dimensions)
  }

  // ⚠️ LLM 调用已结束才开事务 —— 不在事务里跨 LLM 调用(单次分钟级,会长时间持锁)。
  await prisma.evaluation.create({
    data: {
      applicationId,
      tier,
      scorecardSnapshot: JSON.stringify(scorecard),
      scorecardId: app.job.scorecard.id,
      promptVersion: evalPromptVersion(lang),
      parserVersion: PARSER_VERSION,
      providerId: r.providerId,
      model: r.model,
      gateResults: JSON.stringify(r.gateResults),
      scores: JSON.stringify(r.output.scores),
      highlights: JSON.stringify(r.output.highlights),
      concerns: JSON.stringify(r.output.concerns),
      summary: r.output.summary,
      grade: r.grade.grade,
      weightedScore: r.grade.weightedScore,
      latencyMs: r.latencyMs,
      // 精评的三项独有产出与逐维度计算过程一起存,供 UI 直接渲染。
      extras: JSON.stringify({
        breakdown: r.grade.breakdown,
        ...(r.deep ?? {}),
        ...(peerContext ? { peerContext } : {}),
      }),
    },
  })
}

async function runJob(jobId: string, log?: FastifyBaseLogger): Promise<void> {
  const job = await prisma.evalJob.findUnique({ where: { id: jobId } })
  if (!job || job.status !== 'queued') return

  await prisma.evalJob.update({
    where: { id: jobId },
    data: { status: 'running', startedAt: new Date(), attempt: job.attempt + 1 },
  })

  try {
    await runEvaluation(job.applicationId, job.tier as 'screen' | 'deep', parseLang(job.lang))
    await prisma.evalJob.update({
      where: { id: jobId },
      data: { status: 'done', finishedAt: new Date(), activeKey: null, lastError: null },
    })
    await notifyEvalBatchIfDone(job.batchId, log)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    const attempt = job.attempt + 1
    log?.error?.({ err: e, jobId, applicationId: job.applicationId, attempt }, '[eval] 评估失败')

    if (attempt < MAX_ATTEMPTS) {
      await prisma.evalJob.update({
        where: { id: jobId },
        data: { status: 'queued', nextRunAt: new Date(Date.now() + retryDelayMs(attempt)), lastError: detail.slice(0, 300) },
      })
    } else {
      await prisma.evalJob.update({
        where: { id: jobId },
        data: { status: 'failed', finishedAt: new Date(), activeKey: null, lastError: detail.slice(0, 300) },
      })
      // 失败也算这批跑完 —— 否则一份失败就永远等不到通知。
      await notifyEvalBatchIfDone(job.batchId, log)
    }
  }
}

async function tick(log?: FastifyBaseLogger): Promise<void> {
  const due = await prisma.evalJob.findMany({
    where: { status: 'queued', nextRunAt: { lte: new Date() } },
    orderBy: { nextRunAt: 'asc' },
    take: BATCH,
  })
  for (const job of due) {
    if (running.has(job.id)) continue
    running.add(job.id)
    void runJob(job.id, log)
      .catch((e) => log?.error?.({ err: e, jobId: job.id }, '[eval] runJob 未捕获异常'))
      .finally(() => running.delete(job.id))
  }
}

/** 启动对账:重启时 running 的都是被中断的孤儿,重新排队。
 *  评估会**新建**一条 Evaluation(不是 upsert),所以重跑会多出一条记录 ——
 *  这是可接受的:「当前有效结论」按规则取最新一条,多出来的旧记录只是历史。 */
async function reconcile(log?: FastifyBaseLogger): Promise<void> {
  const { count } = await prisma.evalJob.updateMany({
    where: { status: 'running' },
    data: { status: 'queued', nextRunAt: new Date(), lastError: 'restarted' },
  })
  if (count) log?.warn?.({ count }, '[eval] 服务重启,已把中断的评估任务重新排队')
}

/** 卡死兜底:running 超过 STUCK_MS 的任务重新排队。
 *
 *  单进程不需要租约,但**单进程不代表任务不会卡死** —— runJob 的 catch 里那次
 *  写库若自己也失败(SQLITE_BUSY 最常见),job 就永久停在 running:activeKey
 *  占死(重新分析永远返回 queued:false)、批次通知因为「还有非终态」永不触发,
 *  只有重启才能自愈。 */
const STUCK_MS = 30 * 60_000

async function sweepStuck(log?: FastifyBaseLogger): Promise<void> {
  const { count } = await prisma.evalJob.updateMany({
    where: { status: 'running', startedAt: { lt: new Date(Date.now() - STUCK_MS) } },
    data: { status: 'queued', nextRunAt: new Date(), lastError: 'stuck_requeued' },
  })
  if (count) log?.warn?.({ count }, '[eval] 有任务卡在 running 超过 30 分钟,已重新排队')
}

let timer: ReturnType<typeof setInterval> | null = null

export function startEvalQueue(log?: FastifyBaseLogger): void {
  if (timer) return
  void reconcile(log)
    .catch((e) => log?.warn?.({ err: e }, '[eval] reconcile 失败'))
    .finally(() => {
      timer = setInterval(() => {
        void tick(log)
        void sweepStuck(log).catch(() => { /* 兜底本身失败不该打断 tick */ })
      }, TICK_MS)
      timer.unref?.()
    })
}

export function stopEvalQueue(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** 入队。activeKey = "<applicationId>:<tier>" 且 @@unique → 重复入队由 DB 挡掉。 */
export async function enqueueEval(
  applicationId: string,
  tier: 'screen' | 'deep',
  batch?: { batchId: string; createdBy: string | null },
  lang: Lang = 'zh',
): Promise<{ queued: boolean }> {
  try {
    await prisma.evalJob.create({
      data: {
        applicationId, tier, activeKey: `${applicationId}:${tier}`,
        batchId: batch?.batchId, createdBy: batch?.createdBy, lang,
      },
    })
    return { queued: true }
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return { queued: false }
    throw e
  }
}
