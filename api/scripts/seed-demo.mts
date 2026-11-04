// 建一套演示数据:团队 → 岗位 → 评分卡 → 3 位候选人(真实跑解析与评估)。
//
// 这不只是造数据 —— 它走的是【和生产完全相同的服务层】,所以同时是一次
// 端到端集成验证:上传落盘 → 渲染 → 解析 → 去重挂主体 → 建投递 → 评估 → 写库。
// 任何一环的 schema 对不上都会当场炸,而单测覆盖不到这条链。
//
//   node --env-file=.env.dev --import tsx scripts/seed-demo.mts <jd.txt> <a.pdf> ...
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { Scorecard } from '@ai-resume-screener/shared'
import { prisma, initDb } from '../src/db.js'
import { storeResumeFile } from '../src/services/file-store.js'
import { renderPdf } from '../src/services/render.js'
import { extractResume } from '../src/services/parse/extract.js'
import { deriveFields } from '../src/services/parse/derive.js'
import { PARSER_VERSION, PROMPT_VERSION } from '../src/services/parse/prompt.js'
import { attachResume } from '../src/services/dedup/merge.js'
import { draftScorecard } from '../src/services/evaluate/evaluate.js'
import { runEvaluation } from '../src/services/evaluate/queue.js'

const [jdPath, ...files] = process.argv.slice(2)
if (!jdPath || !files.length) {
  console.error('usage: ... seed-demo.mts <jd.txt> <resume.pdf> ...')
  process.exit(1)
}

await initDb()
const jdRaw = await readFile(jdPath, 'utf8')
const jobTitle = jdRaw.split('\n')[0]!.replace(/^#\s*/, '').trim()
const ACTOR = 'seed-script'

const team = await prisma.team.upsert({
  where: { name: '交易平台团队' },
  create: { name: '交易平台团队', description: '负责交易核心链路', ownerId: ACTOR },
  update: {},
})
console.log(`[seed] team ${team.name}`)

let job = await prisma.job.findFirst({ where: { teamId: team.id, title: jobTitle } })
if (!job) {
  job = await prisma.job.create({
    data: { teamId: team.id, title: jobTitle, jdRaw, location: '深圳', level: '高级', createdBy: ACTOR },
  })
}
console.log(`[seed] job ${job.title}`)

// ── 评分卡 ────────────────────────────────────────────────────────
let scorecardRow = await prisma.scorecard.findUnique({ where: { jobId: job.id } })
if (!scorecardRow) {
  console.log('[seed] 按 JD 生成评分卡…')
  const d = await draftScorecard(job.title, jdRaw)
  if (!d.scorecard) throw new Error(`评分卡生成失败: ${d.error}`)
  scorecardRow = await prisma.scorecard.create({
    data: {
      jobId: job.id,
      gates: JSON.stringify(d.scorecard.gates),
      dimensions: JSON.stringify(d.scorecard.dimensions),
      updatedBy: ACTOR,
    },
  })
}
const scorecard = Scorecard.parse({
  gates: JSON.parse(scorecardRow.gates),
  dimensions: JSON.parse(scorecardRow.dimensions),
})
console.log(`[seed] scorecard 维度 ${scorecard.dimensions.length} 个 / 门槛 ${scorecard.gates.length} 条`)

// ── 上传 + 解析 + 去重 ────────────────────────────────────────────
const applicationIds: string[] = []
for (const f of files) {
  const buf = await readFile(f)
  const stored = await storeResumeFile(buf, 'application/pdf')

  let file = await prisma.resumeFile.findFirst({ where: { sha256: stored.sha256 } })
  if (!file) {
    file = await prisma.resumeFile.create({
      data: {
        source: 'upload', sha256: stored.sha256, filename: basename(f),
        mimeType: stored.mimeType, bytes: stored.bytes, storagePath: stored.storagePath,
        uploadedById: ACTOR,
      },
    })
  }

  if (!(await prisma.resumeParsed.findUnique({ where: { resumeFileId: file.id } }))) {
    const r0 = await renderPdf(stored.storagePath, stored.sha256)
    const r = await extractResume({ imagePaths: r0.pagePaths })
    if (!r.data) throw new Error(`解析失败 ${basename(f)}: ${r.error}`)
    await prisma.resumeParsed.create({
      data: {
        resumeFileId: file.id,
        parserVersion: PARSER_VERSION, promptVersion: PROMPT_VERSION,
        providerId: 'claude', model: r.model, deliveryMode: r.deliveryMode,
        raw: JSON.stringify(r.data), derived: JSON.stringify(deriveFields(r.data)),
        latencyMs: r.latencyMs,
      },
    })
    await prisma.resumeFile.update({
      where: { id: file.id },
      data: { parseState: 'parsed', pageCount: r0.totalPages },
    })
    const attached = await attachResume(file.id, r.data)
    console.log(`[seed] parsed ${basename(f)} → ${r.data.basic.name} (${attached.outcome})`)
  }

  const fresh = await prisma.resumeFile.findUnique({ where: { id: file.id } })
  const candidateId = fresh!.candidateId!
  const app = await prisma.application.upsert({
    where: { candidateId_jobId: { candidateId, jobId: job.id } },
    create: { candidateId, jobId: job.id },
    update: {},
  })
  applicationIds.push(app.id)
}

// ── 评估 ──────────────────────────────────────────────────────────
// **直接调队列里的 runEvaluation** —— 和线上点「分析」走的是同一个函数,
// 不另写一份落库逻辑。脚本自己拼一份的话必然与生产路径漂移(横向定位就这么漏过)。
//
// 顺序:先把其余人跑成粗评,最后再对第一个人跑精评 —— 横向定位要拿同岗位其他人
// 的分做基准。真实使用也是这个顺序:先批量粗评,拿不准的那个再单独点精评。
for (const applicationId of applicationIds.slice(1)) {
  if (await prisma.evaluation.findFirst({ where: { applicationId } })) continue
  await runEvaluation(applicationId, 'screen')
  console.log(`[seed] screen ${applicationId}`)
}
if (!(await prisma.evaluation.findFirst({ where: { applicationId: applicationIds[0]!, tier: 'deep' } }))) {
  await runEvaluation(applicationIds[0]!, 'deep')
  console.log(`[seed] deep ${applicationIds[0]}`)
}

// 给第一个人加两个业务标签,顺带验证标签链路。
const first = await prisma.application.findUniqueOrThrow({ where: { id: applicationIds[0]! } })
for (const label of ['内推', '急聘']) {
  await prisma.candidateTag.create({
    data: { candidateId: first.candidateId, label, createdBy: ACTOR },
  }).catch(() => { /* 已存在 */ })
}

console.log('\n[seed] 完成。')
await prisma.$disconnect()
