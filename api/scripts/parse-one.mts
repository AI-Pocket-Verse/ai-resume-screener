// 单份简历端到端解析(渲染 → 抽取 → 派生),不经队列、不写库。
//
// 用途:换 provider / 改 prompt / 调渲染参数后,拿真实简历当场看解析质量。
// 这是「解析准不准」唯一靠谱的验证方式 —— 单测只能保证代码按预期跑,
// 保证不了模型抽得对。
//
//   node --env-file=.env.dev --import tsx scripts/parse-one.mts <file.pdf>
//
// ⚠️ 跑真实简历会把 PII 打到终端。看完请清屏,不要把输出贴进任何地方。
import { basename, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { renderPdf } from '../src/services/render.js'
import { extractResume } from '../src/services/parse/extract.js'
import { deriveFields } from '../src/services/parse/derive.js'
import { PARSER_VERSION, PROMPT_VERSION } from '../src/services/parse/prompt.js'

const file = process.argv[2]
if (!file) {
  console.error('usage: node --env-file=.env.dev --import tsx scripts/parse-one.mts <file>')
  process.exit(1)
}

const buf = await readFile(file)
const sha256 = createHash('sha256').update(buf).digest('hex')
const ext = extname(file).toLowerCase()

console.log(`[parse] ${basename(file)}  ${(buf.length / 1024).toFixed(0)}KB  sha=${sha256.slice(0, 12)}`)
console.log(`[parse] parser=${PARSER_VERSION} prompt=${PROMPT_VERSION}`)

let imagePaths: string[] | undefined
let text: string | undefined

if (ext === '.pdf') {
  const t0 = Date.now()
  const r = await renderPdf(file, sha256)
  console.log(`[render] ${r.pagePaths.length}/${r.totalPages} 页  ${Date.now() - t0}ms${r.truncated ? '  ⚠️ 已截断' : ''}`)
  imagePaths = r.pagePaths
} else if (ext === '.docx') {
  const mammoth = await import('mammoth')
  const { value } = await mammoth.convertToHtml({ buffer: buf })
  text = value
  console.log(`[docx] → ${value.length} 字`)
} else if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
  imagePaths = [file]
} else {
  text = buf.toString('utf8')
  console.log(`[text] ${text.length} 字`)
}

const r = await extractResume({ imagePaths, text })
console.log(`[llm] ${r.latencyMs}ms  model=${r.model}  mode=${r.deliveryMode}`)
if (r.droppedSkills.length) console.log(`[llm] ⚠️ 词表外技能已丢弃: ${r.droppedSkills.join(', ')}`)

if (!r.data) {
  console.error(`[llm] ❌ ${r.error}`)
  console.error(`原文前 400 字:\n${r.rawText.slice(0, 400)}`)
  process.exit(1)
}

const d = r.data
console.log('\n=== basic ===')
console.log(d.basic)
console.log(`\n=== education (${d.education.length}) ===`)
for (const e of d.education) console.log(`  ${e.start}~${e.end}  ${e.school} ${e.major ?? ''} ${e.degree ?? ''}`)
console.log(`\n=== work (${d.work.length}) ===`)
for (const w of d.work) {
  console.log(`  ${w.start}~${w.end}  ${w.company} / ${w.title ?? '—'}  职责${w.responsibilities.length} 业绩${w.achievements.length}`)
}
console.log(`\n=== project (${d.project.length}) ===`)
for (const p of d.project) console.log(`  [work#${p.workIndex ?? '独立'}] ${p.name}  栈:${p.techStack.join('/') || '—'}`)
console.log(`\n=== skill (${d.skill.length}) ===`)
console.log('  ' + d.skill.map((s) => `${s.name}${s.level ? `(${s.level})` : ''}`).join('、'))
console.log(`\n=== cert (${d.cert.length}) ===`)
for (const c of d.cert) console.log(`  ${c.issuedAt ?? '—'} ${c.name}`)

if (d.injectionSuspected) {
  console.log(`\n⚠️ 疑似提示注入: ${d.injectionEvidence}`)
}

console.log('\n=== derived(代码算,不是 LLM 算)===')
console.log(deriveFields(d))
