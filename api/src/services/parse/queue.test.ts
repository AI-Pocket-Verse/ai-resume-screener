import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import JSZip from 'jszip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { disconnectDb, prisma } from '../../db.js'
import { enqueueParse, startParseQueue, stopParseQueue } from './queue.js'

// 缺 poppler 这类配置问题重试也不会好。旧行为是按 30s → 2min 退避重试 3 次,
// 用户要白等两分多钟、期间一直显示「排队中」,才看到失败。
// 走真实链路:上传接口 → 入队 → 队列 tick → 渲染时找不到 pdfinfo。

const COOKIE = 'sso_session=fake'
const whoami = (async () =>
  new Response(JSON.stringify({
    authenticated: true,
    user: { id: 'uid-q', open_id: 'ou_q', name: 'q', mobile: null, last_login_at: new Date(0).toISOString() },
    session: {
      id: 's', user_id: 'uid-q', remember_me: false,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(), last_seen_at: new Date(0).toISOString(),
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

/** 最小合法 PDF:只需要通过上传时的 magic-byte 校验 */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')

let app: Awaited<ReturnType<typeof buildApp>>
let emptyBin = ''
const origPath = process.env.PATH

beforeAll(async () => {
  app = await buildApp({ authFetch: whoami })
  // 让 pdfinfo / pdftocairo 一定找不到,与本机是否装了 poppler 无关
  emptyBin = await mkdtemp(path.join(tmpdir(), 'no-poppler-'))
  process.env.PATH = emptyBin
})

afterAll(async () => {
  stopParseQueue()
  process.env.PATH = origPath
  await rm(emptyBin, { recursive: true, force: true })
  await app.close()
  await disconnectDb()
})

describe('解析队列:不可恢复的错误', () => {
  it('缺 poppler → 第一次失败就标 failed(poppler_missing),不退避重试', async () => {
    const team = await prisma.team.create({ data: { name: `q-team-${Date.now()}`, ownerId: 'x' } })
    const job = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: COOKIE }, payload: { teamId: team.id, title: 'q-job' },
    })
    const jobId = job.json().id as string

    const boundary = 'xBOUNDARYx'
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="jobId"\r\n\r\n${jobId}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      PDF,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const up = await app.inject({
      method: 'POST', url: '/api/files', payload: body,
      headers: { cookie: COOKIE, 'content-type': `multipart/form-data; boundary=${boundary}` },
    })
    expect(up.statusCode).toBeLessThan(300)
    const fileId = up.json().id as string

    startParseQueue()
    // 队列每 5s tick 一次;给足一次 tick 加执行的时间,但远小于 30s 的首次退避
    let file = await prisma.resumeFile.findUniqueOrThrow({ where: { id: fileId } })
    for (let i = 0; i < 40 && file.parseState !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 250))
      file = await prisma.resumeFile.findUniqueOrThrow({ where: { id: fileId } })
    }
    expect(file.parseState).toBe('failed')
    expect(file.parseError).toBe('poppler_missing')
    const pj = await prisma.parseJob.findFirstOrThrow({ where: { resumeFileId: fileId } })
    expect(pj.attempt).toBe(1)
  }, 20_000)
})

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

async function seedFile(buf: Buffer | null, mimeType: string): Promise<string> {
  const team = await prisma.team.create({ data: { name: `qd-team-${Date.now()}-${Math.random()}`, ownerId: 'x' } })
  const job = await prisma.job.create({ data: { teamId: team.id, title: 'qd-job', jdRaw: '', createdBy: 'x' } })
  const dir = await mkdtemp(path.join(tmpdir(), 'docx-'))
  const storagePath = path.join(dir, 'a.docx')
  if (buf) await writeFile(storagePath, buf)
  const f = await prisma.resumeFile.create({
    data: {
      source: 'upload', jobId: job.id, sha256: `qd-${Date.now()}-${Math.random()}`, filename: 'a.docx',
      mimeType, bytes: buf?.length ?? 1, storagePath, uploadedById: 'x',
    },
  })
  return f.id
}

async function waitFailed(fileId: string) {
  let file = await prisma.resumeFile.findUniqueOrThrow({ where: { id: fileId } })
  for (let i = 0; i < 60 && file.parseState !== 'failed'; i++) {
    await new Promise((r) => setTimeout(r, 250))
    file = await prisma.resumeFile.findUniqueOrThrow({ where: { id: fileId } })
  }
  return file
}

// zip 炸弹:几十 KB 的压缩包解出上百 MB。mammoth 会先全量解压再解析,等不到长度检查就被 OOM 了。
describe('解析队列:docx 解压炸弹', () => {
  it('document.xml 解压后超过 10MB → 永久失败 docx_too_large,不重试', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types/>')
    zip.file('word/document.xml', ' '.repeat(11 * 1024 * 1024))
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    expect(buf.length).toBeLessThan(100 * 1024) // 压缩后很小,绕过落盘的 20MB 校验

    const fileId = await seedFile(buf, DOCX_MIME)
    await enqueueParse(fileId)
    startParseQueue()
    const file = await waitFailed(fileId)
    expect(file.parseError).toBe('docx_too_large')
    expect((await prisma.parseJob.findFirstOrThrow({ where: { resumeFileId: fileId } })).attempt).toBe(1)
  }, 20_000)

  // 中央目录里的解压大小是攻击者可控的:把它改小,只看声明值的检查就会放行,
  // 而 jszip 要等解压完才比对声明值 —— 那时内存已经被撑爆了。
  it('伪造中央目录里的解压大小也拦得住(按实际解压结果判定)', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types/>')
    zip.file('word/document.xml', ' '.repeat(11 * 1024 * 1024))
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    // 把每个中央目录条目的「解压后大小」改成 100 字节
    for (let i = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); i >= 0; i = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), i + 4)) {
      buf.writeUInt32LE(100, i + 24)
    }

    const fileId = await seedFile(buf, DOCX_MIME)
    await enqueueParse(fileId)
    startParseQueue()
    const file = await waitFailed(fileId)
    expect(file.parseError).toBe('docx_too_large')
  }, 20_000)

  it('全部条目合计超过 50MB(document.xml 本身不大)→ docx_too_large', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types/>')
    zip.file('word/document.xml', '<w:document/>')
    zip.file('word/media/big.bin', Buffer.alloc(51 * 1024 * 1024))
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })

    const fileId = await seedFile(buf, DOCX_MIME)
    await enqueueParse(fileId)
    const file = await waitFailed(fileId)
    expect(file.parseError).toBe('docx_too_large')
  }, 20_000)
})

describe('解析队列:重启对账', () => {
  it('reconcile 遇到 attempt 已达上限的 running 任务 → 直接标 failed(max_attempts),不再重排', async () => {
    stopParseQueue()
    const fileId = await seedFile(null, 'text/plain')
    await prisma.resumeFile.update({ where: { id: fileId }, data: { parseState: 'extracting' } })
    const pj = await prisma.parseJob.create({
      data: { resumeFileId: fileId, activeKey: fileId, status: 'running', attempt: 3, startedAt: new Date() },
    })
    // 同时有一条没到上限的,应照旧重排
    const fresh = await seedFile(null, 'text/plain')
    const pj2 = await prisma.parseJob.create({
      data: { resumeFileId: fresh, activeKey: fresh, status: 'running', attempt: 1, startedAt: new Date(), nextRunAt: new Date(Date.now() + 3_600_000) },
    })

    startParseQueue() // 启动即 reconcile
    let row = await prisma.parseJob.findUniqueOrThrow({ where: { id: pj.id } })
    for (let i = 0; i < 40 && row.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 100))
      row = await prisma.parseJob.findUniqueOrThrow({ where: { id: pj.id } })
    }
    expect(row.status).toBe('failed')
    expect(row.lastError).toBe('max_attempts')
    expect(row.activeKey).toBeNull()
    expect((await prisma.resumeFile.findUniqueOrThrow({ where: { id: fileId } })).parseError).toBe('max_attempts')
    expect((await prisma.parseJob.findUniqueOrThrow({ where: { id: pj2.id } })).status).toBe('queued')
  }, 20_000)
})
