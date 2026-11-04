/**
 * Records the README demo in English and Chinese:
 *
 *   pnpm demo-video [en|zh] → docs/screenshots/{en,zh}/demo.gif + docs/media/demo-{en,zh}.mp4
 *
 * For each language it starts the real api on port 4198 with a throwaway database
 * under .tmp/demo-media/<lang>/, fills it with `api/scripts/seed-demo.mts` (fictional
 * resumes, real model calls, several minutes), and keeps a snapshot of that database
 * so later runs re-record without calling the model again (pass --fresh to re-seed).
 * The built web app is served on port 4199 with /api proxied to the api, and the
 * locally installed Google Chrome is driven with Playwright.
 *
 * Needs ffmpeg on PATH, Playwright's recorder (`pnpm exec playwright install ffmpeg`)
 * and a working model channel in api/.env.dev (run `pnpm bootstrap` first).
 * Set PW_CHANNEL= (empty) to use Playwright's bundled Chromium instead.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const API_DIR = join(ROOT, 'api')
const WORK = join(ROOT, '.tmp/demo-media')
const API_PORT = 4198
const WEB_PORT = 4199
const BASE = `http://localhost:${WEB_PORT}`
const CHANNEL = process.env.PW_CHANNEL ?? 'chrome'
const VIEWPORT = { width: 1280, height: 800 }
const REPO = 'github.com/AI-Pocket-Verse/ai-resume-screener'
const args = process.argv.slice(2)
const FRESH = args.includes('--fresh')
const LANGS = args.filter((a) => a === 'en' || a === 'zh')

// ── captions, and UI strings the script clicks (must match web/src/i18n/messages.ts) ──
const TEXT = {
  en: {
    locale: 'en-US',
    intro: {
      title: 'AI Resume Screener',
      sub: 'Scorecards from the JD, structured resumes, graded candidates',
      lines: ['Every conclusion quotes the resume; a human makes the call', 'Claude, the Anthropic API or any OpenAI-compatible model', 'Self-hosted, English / 简体中文 UI'],
    },
    outro: {
      title: 'Get started',
      sub: 'MIT licensed · ' + REPO,
      lines: [`git clone https://${REPO}.git`, 'cd ai-resume-screener && pnpm install && pnpm bootstrap', 'pnpm dev', 'pnpm demo   # optional: fictional demo data'],
    },
    cap: {
      scorecard: 'AI drafts a scorecard from the JD: weighted dimensions, anchors, hard requirements',
      upload: 'Drop in PDF, image or Word resumes; they are parsed in the background',
      list: 'Every candidate gets a grade from A to D and a one-line summary',
      gates: 'Hard requirements are flagged, never used to reject anyone automatically',
      calc: 'The total is a weighted score you can check step by step',
      dims: 'Every score comes with quotes from the resume',
      deep: 'Deep evaluation: peer ranking, interview questions and a leaning',
      resume: 'The parsed resume; years of experience are computed by code, not the model',
      decide: 'The final decision is yours',
      lang: 'English / 中文 UI, following your system language',
    },
    ui: {
      scorecard: 'Scorecard',
      cancel: 'Cancel',
      upload: 'Upload resumes',
      drop: 'Drag resumes here, or click to choose',
      uploaded: 'Uploaded 1. Parsing now.',
      gradeD: /^Grade D/,
      all: /^All/,
      calc: 'View calculation',
      dims: 'Dimension scores',
      peer: 'Peer comparison',
      verdict: 'Leaning',
      resumeTab: 'Resume',
      evalTab: 'Evaluation',
      advance: 'Advance',
      avatar: 'Local user',
      otherLang: 'Language: 中文',
      otherAvatar: '本地用户',
      backToSystem: '语言：跟随系统',
    },
    upload: {
      file: 'Morgan Lee.pdf',
      html: resumeHtml('Morgan Lee', 'Phone: +1 555-0105 · Email: morgan.lee@example.com', [
        ['Experience', 'Example Logistics Inc. · Backend Engineer · 2019.07-Present<br>Built shipment tracking APIs in Node.js and TypeScript; maintained PostgreSQL and Redis.'],
        ['Education', 'Example University · B.S. Computer Science · 2015.09-2019.06'],
        ['Skills', 'Node.js, TypeScript, PostgreSQL, Redis, Docker'],
      ]),
    },
  },
  zh: {
    locale: 'zh-CN',
    intro: {
      title: 'AI 简历筛选',
      sub: '按 JD 生成评分卡，解析简历，分档打分',
      lines: ['每条结论都附简历原文，由人来拍板', '支持 Claude、Anthropic API 与 OpenAI 兼容接口', '自托管，中文 / English 双语界面'],
    },
    outro: {
      title: '开始使用',
      sub: 'MIT 开源协议 · ' + REPO,
      lines: [`git clone https://${REPO}.git`, 'cd ai-resume-screener && pnpm install && pnpm bootstrap', 'pnpm dev', 'pnpm demo   # 可选：生成虚构演示数据'],
    },
    cap: {
      scorecard: 'AI 按 JD 生成评分卡：维度权重、打分锚点、硬性门槛',
      upload: '拖入 PDF、图片或 Word 简历，后台自动解析',
      list: '每位候选人分成 A-D 档，附一句话总评',
      gates: '硬性门槛只标红，不自动淘汰任何人',
      calc: '总分按权重加权，计算过程一目了然',
      dims: '每个分数都附简历原文引用',
      deep: '精评：横向排名、面试追问建议和倾向',
      resume: '解析后的简历；工作年限由代码计算，不交给模型',
      decide: '最终结论由你来定',
      lang: '中文 / English 界面，默认跟随系统语言',
    },
    ui: {
      scorecard: '评分卡',
      cancel: '取消',
      upload: '上传简历',
      drop: '拖拽简历到这里，或点击选择',
      uploaded: '已上传 1 份，正在解析',
      gradeD: /^D 档/,
      all: /^全部/,
      calc: '看计算过程',
      dims: '维度评分',
      peer: '横向定位',
      verdict: '倾向',
      resumeTab: '简历',
      evalTab: '评估',
      advance: '通过',
      avatar: '本地用户',
      otherLang: '语言：English',
      otherAvatar: 'Local user',
      backToSystem: 'Language: System',
    },
    upload: {
      file: '周八.pdf',
      html: resumeHtml('周八', '手机：13800138005 · 邮箱：zhouba@example.com', [
        ['工作经历', '示例物流有限公司 · 后端工程师 · 2019.07-至今<br>使用 Node.js 与 TypeScript 开发运单跟踪接口，维护 PostgreSQL 与 Redis。'],
        ['教育经历', '示例大学 · 计算机科学与技术 · 本科 · 2015.09-2019.06'],
        ['技能', 'Node.js、TypeScript、PostgreSQL、Redis、Docker'],
      ]),
    },
  },
}

/** 录屏里上传用的那份简历(虚构),渲染成 PDF,走真实的 PDF 解析链路 */
function resumeHtml(name, contact, sections) {
  return `<html><head><meta charset="utf-8"><style>
    body{font-family:-apple-system,"PingFang SC",Helvetica,sans-serif;margin:56px;color:#222;font-size:14px;line-height:1.6}
    h1{margin:0 0 4px;font-size:28px}h2{font-size:16px;border-bottom:1px solid #bbb;padding-bottom:2px;margin-top:22px}
  </style></head><body><h1>${name}</h1><div>${contact}</div>${sections.map(([h, b]) => `<h2>${h}</h2><p>${b}</p>`).join('')}</body></html>`
}

// ── helpers ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...opts })
  if (r.status !== 0) throw new Error(`${cmd} failed: ${cmdArgs.join(' ')}`)
}
const ff = (a) => run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...a])

async function waitForServer(url, ms = 60_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      /* not up yet */
    }
    await sleep(300)
  }
  throw new Error(`server did not start: ${url}`)
}

/** 演示库的文件位置。DATA_DIR 不随快照复制:库里存的是原件的绝对路径,目录不动才对得上 */
const paths = (lang) => {
  const dir = join(WORK, lang)
  return { dir, db: join(dir, 'demo.db'), snap: join(dir, 'seeded.db'), data: join(dir, 'data') }
}
const DB_FILES = ['', '-wal', '-shm']

/** 真实 api:读 api/.env.dev 里的模型配置,其余全部覆盖成演示用的值(本地单用户、不发通知) */
async function startApi(lang) {
  const p = paths(lang)
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(API_PORT),
    DATABASE_URL: `file:${p.db}`,
    DATA_DIR: p.data,
    WEB_PUBLIC_URL: BASE,
    WEB_ORIGIN: BASE,
    WHOAMI_URL: '',
    AUTH_API_BASE: '',
  }
  run('node', ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { cwd: API_DIR, env, stdio: 'ignore' })
  const proc = spawn('node_modules/.bin/tsx', ['--env-file=.env.dev', 'src/index.ts'], { cwd: API_DIR, env, stdio: 'ignore' })
  await waitForServer(`http://127.0.0.1:${API_PORT}/api/me`)
  return proc
}
const stopApi = (proc) => new Promise((r) => { proc.once('exit', r); proc.kill('SIGTERM') })

/** 第一次(或 --fresh)用 seed-demo 真实跑一遍模型,存一份快照;之后每次录制都从快照恢复 */
async function prepareData(lang) {
  const p = paths(lang)
  if (FRESH || !existsSync(p.snap)) {
    await rm(p.dir, { recursive: true, force: true })
    await mkdir(p.dir, { recursive: true })
    const api = await startApi(lang)
    try {
      console.log(`  seeding demo data (${lang}), this calls the model and takes a few minutes…`)
      run('node_modules/.bin/tsx', ['scripts/seed-demo.mts', lang], {
        cwd: API_DIR, env: { ...process.env, API_URL: `http://127.0.0.1:${API_PORT}`, WEB_URL: BASE },
      })
    } finally {
      await stopApi(api)
    }
    for (const s of DB_FILES) if (existsSync(p.db + s)) await copyFile(p.db + s, p.snap + s)
  }
  for (const s of DB_FILES) {
    await rm(p.db + s, { force: true })
    if (existsSync(p.snap + s)) await copyFile(p.snap + s, p.db + s)
  }
}

/** 托管 web/dist,/api 转给 api —— 和生产 nginx 的分工一样 */
function startWeb() {
  const dist = join(ROOT, 'web/dist')
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/api/')) {
      const up = request({ host: '127.0.0.1', port: API_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${API_PORT}` } }, (r) => {
        res.writeHead(r.statusCode, r.headers)
        r.pipe(res)
      })
      up.on('error', () => { res.writeHead(502); res.end() })
      req.pipe(up)
      return
    }
    const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '')
    let file = join(dist, rel)
    if (!(await stat(file).then((s) => s.isFile(), () => false))) file = join(dist, 'index.html')
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  })
  return new Promise((r) => server.listen(WEB_PORT, '127.0.0.1', () => r(server)))
}

/** 录屏里看不到系统鼠标：注入指针、字幕条和全屏标题卡 */
async function installOverlay(page) {
  await page.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      const font = 'font-family:Inter,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif'
      const dot = document.createElement('div')
      dot.style.cssText =
        'position:fixed;z-index:2147483647;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;' +
        'background:rgba(99,102,241,.35);border:2px solid rgba(79,70,229,.95);pointer-events:none;transition:transform .12s;left:-50px;top:-50px'
      document.addEventListener('mousemove', (e) => {
        dot.style.left = `${e.clientX}px`
        dot.style.top = `${e.clientY}px`
      })
      document.addEventListener('mousedown', () => (dot.style.transform = 'scale(.65)'))
      document.addEventListener('mouseup', () => (dot.style.transform = 'scale(1)'))

      const cap = document.createElement('div')
      cap.style.cssText =
        `position:fixed;z-index:2147483646;left:50%;bottom:28px;transform:translateX(-50%);max-width:90%;${font};` +
        'background:rgba(17,24,39,.88);color:#fff;font-size:21px;font-weight:600;padding:12px 26px;border-radius:14px;' +
        'box-shadow:0 8px 30px rgba(0,0,0,.25);pointer-events:none;opacity:0;transition:opacity .3s;white-space:nowrap'

      const card = document.createElement('div')
      card.style.cssText =
        `position:fixed;inset:0;z-index:2147483645;display:flex;flex-direction:column;align-items:center;justify-content:center;${font};` +
        'background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;text-align:center;opacity:0;pointer-events:none;transition:opacity .5s'

      document.body.append(card, cap, dot)
      window.__demo = {
        caption(text) {
          cap.textContent = text
          cap.style.opacity = text ? '1' : '0'
        },
        card({ title, sub, lines, code }) {
          const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
          const items = lines
            .map((l) =>
              code
                ? `<div style="font-family:ui-monospace,Menlo,monospace;font-size:21px;background:rgba(0,0,0,.28);padding:10px 22px;border-radius:10px;margin:6px 0;text-align:left;min-width:720px">$ ${esc(l)}</div>`
                : `<div style="font-size:24px;margin:8px 0;opacity:.95">✓ ${esc(l)}</div>`,
            )
            .join('')
          card.innerHTML =
            `<div style="font-size:64px;font-weight:800;letter-spacing:-.02em">${esc(title)}</div>` +
            `<div style="font-size:26px;opacity:.9;margin:14px 0 36px">${esc(sub)}</div><div>${items}</div>`
          card.style.opacity = '1'
          dot.style.opacity = '0'
        },
        hideCard() {
          card.style.opacity = '0'
          dot.style.opacity = '1'
        },
      }
    })
  })
}

const caption = (page, text) => page.evaluate((t) => window.__demo.caption(t), text)

/** 平滑移动到元素中心再点击，录屏里能看清在点哪 */
async function moveTo(page, locator, pause = 300) {
  await locator.waitFor()
  const inView = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return r.top >= 70 && r.bottom <= innerHeight - 90
  })
  if (!inView) {
    await locator.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }))
    await page.waitForTimeout(700)
  }
  const box = await locator.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 })
  await page.waitForTimeout(pause)
}
async function moveClick(page, locator, pause = 300) {
  await moveTo(page, locator, pause)
  await page.mouse.down()
  await page.mouse.up()
}
/** 把右侧详情里的某一节平滑滚到顶部附近 */
async function scrollToSection(page, text, pause = 2200) {
  // 标题是 <h3>{title}<span>{hint}</span></h3>,精确匹配文字会连提示一起比,所以按包含匹配 h3
  const el = page.locator('h3', { hasText: text }).first()
  await el.waitFor()
  await el.evaluate((n) => n.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  await page.waitForTimeout(pause)
}

// ── recording ───────────────────────────────────────────────────────────
async function record(browser, lang) {
  const { cap, ui, intro, outro, locale, upload } = TEXT[lang]

  // 录屏里上传的 PDF 先渲染好;精评过的那位候选人由种子数据决定,从接口取名字
  const pdf = join(WORK, upload.file)
  const pdfPage = await browser.newPage()
  await pdfPage.setContent(upload.html)
  await pdfPage.pdf({ path: pdf, format: 'A4' })
  await pdfPage.close()
  const jobs = await (await fetch(`${BASE}/api/jobs`)).json()
  const rows = await (await fetch(`${BASE}/api/jobs/${jobs[0].id}/candidates`)).json()
  const star = rows.find((r) => r.verdict?.source === 'deep')?.name
  if (!star) throw new Error('seeded data has no deep evaluation')

  const rawDir = join(WORK, `raw-${lang}`)
  await rm(rawDir, { recursive: true, force: true })
  const context = await browser.newContext({ viewport: VIEWPORT, locale, recordVideo: { dir: rawDir, size: VIEWPORT } })
  const t0 = Date.now()
  const page = await context.newPage()
  await installOverlay(page)
  await page.goto(BASE)
  await page.evaluate((c) => window.__demo.card(c), intro)
  const trim = (Date.now() - t0) / 1000 + 0.6
  await page.getByText(star).first().waitFor()
  await page.waitForTimeout(4200)
  await page.evaluate(() => window.__demo.hideCard())
  await page.waitForTimeout(700)

  // 1. 评分卡
  await caption(page, cap.scorecard)
  await moveClick(page, page.getByRole('button', { name: ui.scorecard, exact: true }))
  await page.waitForTimeout(1600)
  await page.mouse.move(VIEWPORT.width / 2, 420, { steps: 15 })
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 260); await page.waitForTimeout(500) }
  await page.waitForTimeout(900)
  await moveClick(page, page.getByRole('button', { name: ui.cancel, exact: true }))
  await page.waitForTimeout(500)

  // 2. 上传一份 PDF(解析完才会出现在列表里,这里只等上传成功的提示)
  await caption(page, cap.upload)
  await moveClick(page, page.getByRole('button', { name: ui.upload, exact: true }))
  await page.waitForTimeout(500)
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), moveClick(page, page.getByText(ui.drop))])
  await chooser.setFiles(pdf)
  await page.getByText(ui.uploaded).waitFor({ timeout: 30_000 })
  await page.waitForTimeout(2000)
  await moveClick(page, page.getByRole('button', { name: ui.upload, exact: true }))
  await page.waitForTimeout(400)

  // 3. 列表与分档筛选
  await caption(page, cap.list)
  await moveClick(page, page.getByRole('button', { name: ui.gradeD }))
  await page.waitForTimeout(1300)
  await moveClick(page, page.getByRole('button', { name: ui.all }))
  await page.waitForTimeout(900)

  // 4. 精评过的候选人:门槛 → 计算过程 → 维度引用 → 横向定位与倾向
  await caption(page, cap.gates)
  await moveClick(page, page.getByText(star).first())
  await page.waitForTimeout(2600)
  await caption(page, cap.calc)
  await moveClick(page, page.getByText(ui.calc).first())
  await page.waitForTimeout(2600)
  await moveClick(page, page.getByText(ui.calc).first())
  await page.waitForTimeout(400)
  await caption(page, cap.dims)
  await scrollToSection(page, ui.dims, 2800)
  await caption(page, cap.deep)
  await scrollToSection(page, ui.peer, 2200)
  await scrollToSection(page, ui.verdict, 2400)

  // 5. 简历页
  await caption(page, cap.resume)
  await moveClick(page, page.getByRole('button', { name: ui.resumeTab, exact: true }))
  await page.waitForTimeout(2600)
  await moveClick(page, page.getByRole('button', { name: ui.evalTab, exact: true }))
  await page.waitForTimeout(500)

  // 6. 人来拍板
  await caption(page, cap.decide)
  await moveClick(page, page.getByRole('button', { name: ui.advance, exact: true }))
  await page.waitForTimeout(1800)

  // 7. 切换语言再切回跟随系统
  await caption(page, cap.lang)
  await moveClick(page, page.getByRole('button', { name: ui.avatar }))
  await page.waitForTimeout(500)
  await moveClick(page, page.getByText(ui.otherLang, { exact: true }))
  await page.waitForTimeout(2000)
  await moveClick(page, page.getByRole('button', { name: ui.otherAvatar }))
  await page.waitForTimeout(500)
  await moveClick(page, page.getByText(ui.backToSystem, { exact: true }))
  await page.waitForTimeout(1500)

  // 结尾卡片
  await caption(page, '')
  await page.evaluate((c) => window.__demo.card({ ...c, code: true }), outro)
  await page.waitForTimeout(5000)

  await context.close()
  const [webm] = (await readdir(rawDir)).filter((f) => f.endsWith('.webm'))
  const src = join(rawDir, webm)

  const mediaDir = join(ROOT, 'docs/media')
  const imgDir = join(ROOT, 'docs/screenshots', lang)
  await mkdir(mediaDir, { recursive: true })
  await mkdir(imgDir, { recursive: true })
  const mp4 = join(mediaDir, `demo-${lang}.mp4`)
  const gif = join(imgDir, 'demo.gif')
  ff(['-ss', trim.toFixed(2), '-i', src, '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4])
  // GIF 从压好的 MP4 转：录屏原始 webm 的编码噪点会让 GIF 体积翻倍
  ff([
    '-i', mp4,
    '-vf', 'fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
    '-loop', '0', gif,
  ])
  await rm(rawDir, { recursive: true, force: true })
  console.log(`  ✓ docs/media/demo-${lang}.mp4`)
  console.log(`  ✓ docs/screenshots/${lang}/demo.gif`)
}

// ── main ────────────────────────────────────────────────────────────────
if (!existsSync(join(API_DIR, '.env.dev'))) throw new Error('api/.env.dev not found: run `pnpm bootstrap` and configure a model first')
await mkdir(WORK, { recursive: true })
run('pnpm', ['--filter', '@ai-resume-screener/web', 'build'], { cwd: ROOT, stdio: 'ignore' })
const web = await startWeb()
const browser = await chromium.launch(CHANNEL ? { channel: CHANNEL } : {})
try {
  for (const lang of LANGS.length ? LANGS : ['en', 'zh']) {
    console.log(`demo video (${lang})…`)
    await prepareData(lang)
    const api = await startApi(lang)
    try {
      await record(browser, lang)
    } catch (e) {
      const shot = join(WORK, `failed-${lang}.png`)
      await browser.contexts().at(-1)?.pages().at(-1)?.screenshot({ path: shot })
      console.error(`  ✗ failed, screenshot: ${shot}`)
      throw e
    } finally {
      await stopApi(api)
    }
  }
} finally {
  await browser.close()
  web.close()
}
