// 评分快照回归:改完 prompt / 评分卡后,看结果漂移了多少。
//
// **它回答的是「稳不稳」,不是「准不准」** —— 后者需要 HR 真实结论做真值
// (完整 golden set),那个卡在数据上。而「我改了一句 prompt,分变了多少」
// 是改 prompt 时最常问的问题,现在就能答。
//
//   node --env-file=.env.dev --import tsx scripts/eval-regress.mts baseline   # 存基线
//   node --env-file=.env.dev --import tsx scripts/eval-regress.mts check      # 重跑并对比
//
// 样本取库里【已有评估】的全部投递。将来换成真实历史简历时,只需把库里的样本
// 换掉,这个脚本不用改。
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { prisma, initDb } from '../src/db.js'
import { runEvaluation } from '../src/services/evaluate/queue.js'
import { EVAL_PROMPT_VERSION } from '../src/services/evaluate/prompt.js'

const SNAPSHOT = 'eval-baseline.json'

interface Sample {
  applicationId: string
  name: string
  tier: string
  grade: string | null
  weightedScore: number | null
  /** key → 1-5 分。维度级漂移比总分更能说明问题:总分没变不代表内部没抵消。 */
  scores: Record<string, number>
  gatesFailed: string[]
}

async function collect(): Promise<Sample[]> {
  const evals = await prisma.evaluation.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      application: { include: { candidate: { select: { name: true } } } },
    },
  })
  // 一人一条:同一投递可能跑过多次,只取最新。
  const seen = new Set<string>()
  const out: Sample[] = []
  for (const e of evals) {
    if (seen.has(e.applicationId)) continue
    seen.add(e.applicationId)
    const scores: Record<string, number> = {}
    for (const s of JSON.parse(e.scores) as Array<{ key: string; score: number }>) scores[s.key] = s.score
    const gatesFailed = (JSON.parse(e.gateResults) as Array<{ key: string; pass: unknown }>)
      .filter((g) => g.pass === false).map((g) => g.key)
    out.push({
      applicationId: e.applicationId,
      name: e.application.candidate.name ?? '(未知)',
      tier: e.tier,
      grade: e.grade,
      weightedScore: e.weightedScore,
      scores,
      gatesFailed,
    })
  }
  return out.sort((a, b) => a.applicationId.localeCompare(b.applicationId))
}

const mode = process.argv[2] ?? 'check'
await initDb()

if (mode === 'baseline') {
  const samples = await collect()
  if (!samples.length) {
    console.error('库里还没有评估结果,先跑一遍 seed-demo.mts')
    process.exit(1)
  }
  await mkdir(dirname(SNAPSHOT), { recursive: true }).catch(() => {})
  await writeFile(SNAPSHOT, JSON.stringify({ promptVersion: EVAL_PROMPT_VERSION, samples }, null, 2))
  console.log(`[baseline] 已存 ${samples.length} 个样本 → ${SNAPSHOT}`)
  console.log(samples.map((s) => `  ${s.grade} ${s.weightedScore} ${s.name}`).join('\n'))
  await prisma.$disconnect()
} else {
  const raw = await readFile(SNAPSHOT, 'utf8').catch(() => null)
  if (!raw) {
    console.error(`找不到 ${SNAPSHOT},先跑 baseline`)
    process.exit(1)
  }
  const base = JSON.parse(raw) as { promptVersion: string; samples: Sample[] }
  console.log(`[check] 基线 promptVersion=${base.promptVersion} → 当前 ${EVAL_PROMPT_VERSION}`)
  console.log(`[check] 重跑 ${base.samples.length} 个样本…\n`)

  for (const s of base.samples) {
    await runEvaluation(s.applicationId, s.tier as 'screen' | 'deep')
  }
  const now = await collect()
  const byId = new Map(now.map((s) => [s.applicationId, s]))

  let gradeChanged = 0
  let maxScoreDelta = 0
  for (const b of base.samples) {
    const n = byId.get(b.applicationId)
    if (!n) { console.log(`  ⚠️ ${b.name}: 重跑后找不到结果`); continue }

    const delta = (n.weightedScore ?? 0) - (b.weightedScore ?? 0)
    maxScoreDelta = Math.max(maxScoreDelta, Math.abs(delta))
    const gradeMoved = b.grade !== n.grade
    if (gradeMoved) gradeChanged += 1

    const sign = delta > 0 ? `+${delta}` : `${delta}`
    console.log(
      `  ${gradeMoved ? '⚠️' : '  '} ${b.name}: ${b.grade} ${b.weightedScore} → ${n.grade} ${n.weightedScore} (${sign})`,
    )

    // 维度级漂移:总分没变不代表内部没抵消,一个维度 +2、另一个 -2 是真实风险。
    for (const [k, bv] of Object.entries(b.scores)) {
      const nv = n.scores[k]
      if (nv != null && nv !== bv) console.log(`        ${k}: ${bv} → ${nv}`)
    }
    const gateDiff = [
      ...b.gatesFailed.filter((g) => !n.gatesFailed.includes(g)).map((g) => `${g} 由不通过转为通过`),
      ...n.gatesFailed.filter((g) => !b.gatesFailed.includes(g)).map((g) => `${g} 由通过转为不通过`),
    ]
    for (const d of gateDiff) console.log(`        ⚠️ 门槛 ${d}`)
  }

  console.log(`\n[check] 档位变化 ${gradeChanged}/${base.samples.length} 人 · 最大分差 ${maxScoreDelta} 分`)
  // 阈值是经验值:同一 prompt 下重跑本来就有抖动(评估是主观归纳,
  // 它的稳定性风险高于解析层),但档位跳变说明改动实质影响了结论。
  if (gradeChanged > 0) console.log('[check] ⚠️ 有人档位变了 —— 确认这是你想要的改动')
  else if (maxScoreDelta > 8) console.log('[check] ⚠️ 分数漂移偏大,建议再跑一次看是抖动还是真变化')
  else console.log('[check] ✅ 结果稳定')

  await prisma.$disconnect()
}
