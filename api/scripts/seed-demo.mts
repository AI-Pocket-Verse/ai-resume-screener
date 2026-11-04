// 一键造演示数据:岗位 → AI 评分卡 → 四份虚构简历 → 粗评全部 → 精评最强的一位。
//
//   pnpm dev          # 先在一个终端把服务跑起来(本地单用户模式)
//   pnpm demo         # 另一个终端:按系统语言造一套
//   pnpm demo en      # 或指定 zh / en
//
// 走的是和界面完全相同的 HTTP 接口(粘贴简历 → 解析队列 → 评估队列),请求带 X-Lang,
// 所以评分卡、评估结论、面试追问都是对应语言。数据见 demo-data.mts,全部虚构。
// 只支持本地模式:接了飞书登录后脚本拿不到会话,请在界面里手动操作。
// API 地址默认 http://127.0.0.1:4070,可用 API_URL 覆盖;WEB_URL 只用于最后打印链接。
import { DEMO } from './demo-data.mjs'

type Lang = 'zh' | 'en'

function systemLang(): Lang {
  const loc = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale
  return /^zh/i.test(loc) ? 'zh' : 'en'
}

const arg = process.argv[2]
if (arg && arg !== 'zh' && arg !== 'en') {
  console.error('usage: pnpm demo [zh|en]')
  process.exit(1)
}
const lang: Lang = (arg as Lang | undefined) ?? systemLang()
const data = DEMO[lang]
const API = (process.env.API_URL ?? 'http://127.0.0.1:4070').replace(/\/$/, '')
const WEB = (process.env.WEB_URL ?? 'http://localhost:5070').replace(/\/$/, '')
const say = (zh: string, en: string) => console.log(`[demo] ${lang === 'zh' ? zh : en}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(API + path, {
    method,
    headers: { 'X-Lang': lang, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => {
    throw new Error(lang === 'zh' ? `连不上 ${API},请先运行 pnpm dev` : `Cannot reach ${API}. Run pnpm dev first.`)
  })
  const json = await r.json().catch(() => null)
  if (r.status === 401) {
    throw new Error(lang === 'zh' ? '需要登录:演示脚本只支持本地单用户模式' : 'Login required: the demo script only works in local single-user mode')
  }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(json)}`)
  return json as T
}

/** 每 5 秒查一次,直到 done() 为真;超时抛错(模型调用每份约 1-2 分钟)。 */
async function waitFor(what: string, done: () => Promise<boolean>, minutes = 20): Promise<void> {
  const deadline = Date.now() + minutes * 60_000
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`)
    await sleep(5000)
  }
}

interface Row { applicationId: string; name: string | null; verdict: { grade: string | null; score: number | null; source: string } | null }

const teams = await api<Array<{ id: string }>>('GET', '/api/teams')
if (!teams.length) throw new Error('no team')
const jobs = await api<Array<{ id: string; title: string }>>('GET', '/api/jobs')
// 同名岗位已存在 → 不重建,只把没跑完的步骤补上(脚本中途被打断后可以直接重跑)。
let jobId = jobs.find((j) => j.title === data.job.title)?.id
if (jobId) {
  say(`已有岗位「${data.job.title}」,继续未完成的步骤`, `Job "${data.job.title}" already exists; continuing unfinished steps`)
} else {
  jobId = (await api<{ id: string }>('POST', '/api/jobs', {
    teamId: teams[0]!.id, title: data.job.title, jdRaw: data.job.jd,
    location: data.job.location, level: data.job.level, headcount: data.job.headcount,
  })).id
  say(`已建岗位「${data.job.title}」,正在按 JD 生成评分卡…`, `Created job "${data.job.title}". Drafting the scorecard from the JD…`)
  const draft = await api<unknown>('POST', `/api/jobs/${jobId}/scorecard/draft`)
  await api('PUT', `/api/jobs/${jobId}/scorecard`, draft)

  say(`上传 ${data.resumes.length} 份简历并解析(每份约 1-2 分钟,并行进行)…`,
    `Uploading ${data.resumes.length} resumes and parsing them (about 1-2 minutes each, in parallel)…`)
  const fileIds: string[] = []
  for (const r of data.resumes) {
    fileIds.push((await api<{ id: string }>('POST', '/api/files/paste', { jobId, text: r.text, filename: r.filename })).id)
  }
  // 逐个查这几份的状态(文件列表接口不按岗位过滤,库里已有别的简历时数不准)
  await waitFor('parse', async () => {
    const states = await Promise.all(fileIds.map((id) => api<{ parseState: string }>('GET', `/api/files/${id}`)))
    return states.every((f) => f.parseState === 'parsed' || f.parseState === 'failed')
  })
}
const candidates = () => api<Row[]>('GET', `/api/jobs/${jobId}/candidates`)

const todo = (await candidates()).filter((c) => !c.verdict)
if (todo.length) {
  say(`粗评 ${todo.length} 位候选人…`, `Screening ${todo.length} candidates…`)
  await api('POST', '/api/evaluations', { applicationIds: todo.map((c) => c.applicationId), tier: 'screen' })
}
let screened: Row[] = []
await waitFor('screen', async () => {
  screened = await candidates()
  return screened.every((c) => c.verdict)
})

if (!screened.some((c) => c.verdict?.source === 'deep')) {
  const best = [...screened].sort((a, b) => (b.verdict?.score ?? 0) - (a.verdict?.score ?? 0))[0]!
  say(`精评得分最高的 ${best.name}…`, `Running a deep evaluation on the top candidate, ${best.name}…`)
  await api('POST', '/api/evaluations', { applicationIds: [best.applicationId], tier: 'deep' })
  await waitFor('deep', async () => (await candidates()).find((x) => x.applicationId === best.applicationId)?.verdict?.source === 'deep')
}

say(`完成:${WEB}/?job=${jobId}`, `Done: ${WEB}/?job=${jobId}`)
