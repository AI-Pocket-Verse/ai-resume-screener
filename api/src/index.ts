import { execFile } from 'node:child_process'

import { buildApp } from './app.js'
import { env } from './env.js'
import { startEvalQueue } from './services/evaluate/queue.js'
import { startParseQueue } from './services/parse/queue.js'
import { isNotifyConfigured } from './services/notify/gateway.js'
import { ensureDefaultTeam } from './services/bootstrap.js'
import { describeChannel, llmConfig, LLM_PURPOSES } from './services/llm.js'

// 模型配置有误时在启动阶段就退出,并列出全部问题(见 resolveLlmConfig)。
let channels: ReturnType<typeof llmConfig>
try {
  channels = llmConfig()
} catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}

const app = await buildApp()
// 建岗位要先选团队,而界面上没有建团队的入口:空库时自动建一个「默认团队」。
await ensureDefaultTeam()

/** 外部程序自检:只打日志,不阻止启动 —— 缺了的话对应任务会带明确错误码失败。 */
function probe(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve('MISSING')
      const out = `${stdout}${stderr}`.trim().split('\n')[0] ?? ''
      resolve(err && !out ? `ERROR (${err.message})` : `ok (${out})`)
    })
  })
}

// 队列在 listen 之后再起:先能接请求,再开始烧算力。
// 启动对账会把上次进程中断的任务重新排队(解析幂等,重跑只多一次渲染)。
app
  .listen({ port: env.PORT, host: env.HOST })
  .then(async () => {
    console.log(`[resume-api] listening on http://${env.HOST}:${env.PORT}`)
    console.log(`[resume-api] auth: ${env.WHOAMI_URL ? `SSO via ${env.WHOAMI_URL}` : 'local single-user mode'}`)
    console.log(`[resume-api] feishu notify: ${isNotifyConfigured() ? `via ${env.AUTH_API_BASE}` : 'off (AUTH_API_BASE / INTERNAL_API_TOKEN not set)'}`)
    for (const p of LLM_PURPOSES) console.log(`[resume-api] LLM ${describeChannel(p)}`)
    const usesClaudeCli = LLM_PURPOSES.some((p) => channels[p].provider === 'claude')
    const claudeBin = env.CLAUDE_BIN ?? 'claude'
    // 渲染实际调用的是 pdfinfo(预检)和 pdftocairo(出图),两个都要能跑。
    const [pdfinfo, pdftocairo, claude] = await Promise.all([
      probe('pdfinfo', ['-v']), probe('pdftocairo', ['-v']),
      usesClaudeCli ? probe(claudeBin, ['--version']) : Promise.resolve('not used'),
    ])
    const poppler = pdfinfo === 'MISSING' || pdftocairo === 'MISSING' ? 'MISSING' : `${pdfinfo} / ${pdftocairo}`
    console.log(`[resume-api] pdfinfo + pdftocairo (PDF rendering): ${poppler}`)
    console.log(`[resume-api] ${claudeBin} (Claude Code CLI): ${claude}`)
    if (poppler === 'MISSING' || claude === 'MISSING') {
      console.error('[resume-api] ⚠️ missing external programs, see README「外部依赖」')
    }
    startParseQueue(app.log)
    startEvalQueue(app.log)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
