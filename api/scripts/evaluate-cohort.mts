// 用同一个 JD 评估多份简历,看打分【有没有区分度】、门槛【有没有生效】。
// 不经队列、不写库。
//
//   node --env-file=.env.dev --import tsx scripts/evaluate-cohort.mts <jd.txt> <a.pdf> <b.pdf> ...
//
// 为什么必须多份一起看:单份简历看不出打分好坏 —— 5 分制下给谁都是 3、4 分,
// 孤立地看都"挺合理"。只有把不同水平的人放在同一个 JD 下,才能验证
// ① 强弱是否拉得开 ② 硬门槛是否真的拦住了不满足的人。
//
// ⚠️ 跑真实简历会把 PII 打到终端。
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { Scorecard } from '@ai-resume-screener/shared'
import { renderPdf } from '../src/services/render.js'
import { extractResume } from '../src/services/parse/extract.js'
import { deriveFields } from '../src/services/parse/derive.js'
import { draftScorecard, evaluateResume } from '../src/services/evaluate/evaluate.js'
import { computePeerContext } from '../src/services/evaluate/peers.js'
import type { MergedResume } from '../src/services/evaluate/merge.js'

const [jdPath, ...files] = process.argv.slice(2)
if (!jdPath || !files.length) {
  console.error('usage: ... evaluate-cohort.mts <jd.txt> <resume.pdf> [more.pdf ...]')
  process.exit(1)
}

const jdRaw = await readFile(jdPath, 'utf8')
const jobTitle = jdRaw.split('\n')[0]!.replace(/^#\s*/, '').trim()

console.log(`\n━━━ 岗位:${jobTitle} ━━━`)
console.log('[scorecard] 让模型按 JD 生成评分卡草稿…')
const draft = await draftScorecard(jobTitle, jdRaw)
if (!draft.scorecard) {
  console.error(`[scorecard] ❌ ${draft.error}\n${draft.rawText.slice(0, 400)}`)
  process.exit(1)
}
const scorecard = Scorecard.parse(draft.scorecard)
console.log(`[scorecard] 维度 ${scorecard.dimensions.length} 个,权重合计 ${scorecard.dimensions.reduce((s, d) => s + d.weight, 0)}`)
for (const d of scorecard.dimensions) console.log(`  · ${d.label} ${d.weight}%  5分=${d.anchors['5'].slice(0, 34)}…`)
console.log(`[scorecard] 门槛 ${scorecard.gates.length} 条`)
for (const g of scorecard.gates) {
  console.log('nl' in g ? `  · [LLM判] ${g.label}:${g.nl}` : `  · [代码判] ${g.label}:${g.field} ${g.op} ${JSON.stringify(g.value)}`)
}

// ── 解析 ──────────────────────────────────────────────────────────
const parsed: Array<{ file: string; resume: MergedResume }> = []
for (const f of files) {
  const buf = await readFile(f)
  const sha = createHash('sha256').update(buf).digest('hex')
  const r0 = await renderPdf(f, sha)
  const r = await extractResume({ imagePaths: r0.pagePaths })
  if (!r.data) {
    console.error(`[parse] ❌ ${basename(f)}: ${r.error}`)
    continue
  }
  const derived = deriveFields(r.data)
  parsed.push({ file: basename(f), resume: { data: r.data, derived } })
  console.log(`[parse] ${basename(f)}  ${r.latencyMs}ms  ${r.data.basic.name} · ${derived.totalYears ?? '?'}年 · ${derived.currentCompany ?? '—'}`)
}

// ── 评估 ──────────────────────────────────────────────────────────
console.log('\n━━━ 评估 ━━━')
const results = []
for (const p of parsed) {
  const r = await evaluateResume({
    jobTitle, teamName: '技术团队', jdSummary: jdRaw,
    scorecard, resume: p.resume, tier: 'screen',
  })
  if (!r.output || !r.grade) {
    console.error(`[eval] ❌ ${p.file}: ${r.error}\n${r.rawText.slice(0, 300)}`)
    continue
  }
  results.push({ ...p, r })

  const name = p.resume.data.basic.name
  console.log(`\n【${name}】(${p.file})  ${r.grade.grade} 档 · ${r.grade.weightedScore} 分 · ${r.latencyMs}ms`)
  console.log(`  总评:${r.output.summary}`)
  console.log('  门槛:')
  for (const g of r.gateResults) {
    const mark = g.pass === true ? '✅' : g.pass === false ? '❌' : '➖'
    console.log(`    ${mark} [${g.judgedBy === 'code' ? '代码' : 'LLM'}] ${g.label} — ${g.reason ?? ''}`)
  }
  console.log('  维度:')
  for (const b of r.grade.breakdown) {
    const s = r.output.scores.find((x) => x.key === b.key)!
    console.log(`    ${b.label} ${b.score}/5 ×${b.weight}% = ${b.contribution}`)
    console.log(`      理由:${s.reason.slice(0, 80)}`)
    console.log(`      引用:「${(s.evidence[0]?.quote ?? '').slice(0, 60)}」`)
  }
  if (r.output.concerns.length) {
    console.log('  存疑:')
    for (const c of r.output.concerns) console.log(`    · ${c.text.slice(0, 90)}`)
  }
}

// ── 区分度 ────────────────────────────────────────────────────────
console.log('\n━━━ 对照 ━━━')
const sorted = [...results].sort((a, b) => b.r.grade!.weightedScore - a.r.grade!.weightedScore)
for (const s of sorted) {
  const gateFail = s.r.gateResults.filter((g) => g.pass === false).length
  console.log(`  ${s.r.grade!.grade}  ${String(s.r.grade!.weightedScore).padStart(3)} 分  ${s.resume.data.basic.name}` +
    `  (${s.resume.derived.totalYears ?? '?'}年${gateFail ? `,门槛未过 ${gateFail} 条` : ''})`)
}
if (sorted.length >= 2) {
  const spread = sorted[0]!.r.grade!.weightedScore - sorted.at(-1)!.r.grade!.weightedScore
  // 区分度是评分卡质量的核心指标。分差小说明 anchors 写得太笼统
  // (「技术能力强」这种锚点等于没有),或者选的维度对这批人根本不区分。
  console.log(`\n  最高最低分差 ${spread} 分 —— ${
    spread >= 30 ? '✅ 区分度足够' : '⚠️ 偏小,检查 anchors 是否写得够具体、维度是否真的区分人'
  }`)
}

// 横向定位(精评独有产出之一)用第一个人演示。
if (results.length >= 2) {
  const peer = computePeerContext(
    results[0]!.r.output!.scores,
    results.slice(1).map((x) => x.r.output!.scores),
    scorecard.dimensions,
  )
  console.log(`\n  【${results[0]!.resume.data.basic.name}】的横向定位(${peer?.cohortSize} 人中):`)
  for (const d of peer?.dimensions ?? []) {
    console.log(`    ${d.label}  第 ${d.rank} 名 · ${d.score}分 · 中位数 ${d.median} · ${d.vsMedian === 'above' ? '高于' : d.vsMedian === 'below' ? '低于' : '等于'}中位`)
  }
}
