import { createId } from '@paralleldrive/cuid2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { disconnectDb, prisma } from '../db.js'

// x-upload-batch 由客户端指定:不绑定调用者的话,两个用户用同一个值就会串批次(通知发错人)。

const COOKIE = 'sso_session=fake'
const whoami = (openId: string): typeof fetch =>
  (async () => new Response(JSON.stringify({
    authenticated: true,
    user: { id: `uid-${openId}`, open_id: openId, name: openId, mobile: null, last_login_at: new Date(0).toISOString() },
    session: {
      id: 's', user_id: `uid-${openId}`, remember_me: false,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(), last_seen_at: new Date(0).toISOString(),
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

type App = Awaited<ReturnType<typeof buildApp>>
let u1: App
let u2: App
let teamId = ''

beforeAll(async () => {
  u1 = await buildApp({ authFetch: whoami('ou_batch1') })
  u2 = await buildApp({ authFetch: whoami('ou_batch2') })
  teamId = (await prisma.team.create({ data: { name: `batch-${Date.now()}`, ownerId: 'x' } })).id
})
afterAll(async () => {
  await Promise.all([u1.close(), u2.close()])
  await disconnectDb()
})

async function upload(app: App, batch: string | undefined, seed: string, extra: Record<string, string> = {}): Promise<string> {
  const job = await app.inject({
    method: 'POST', url: '/api/jobs', headers: { cookie: COOKIE }, payload: { teamId, title: `b-${seed}` },
  })
  const jobId = job.json().id as string
  const boundary = 'xBx'
  const pdf = Buffer.from(`%PDF-1.4\n% ${seed}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`)
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="jobId"\r\n\r\n${jobId}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    pdf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const up = await app.inject({
    method: 'POST', url: '/api/files', payload: body,
    headers: {
      cookie: COOKIE, 'content-type': `multipart/form-data; boundary=${boundary}`,
      ...(batch ? { 'x-upload-batch': batch } : {}),
      ...extra,
    },
  })
  expect(up.statusCode).toBe(201)
  const pj = await prisma.parseJob.findFirstOrThrow({ where: { resumeFileId: up.json().id } })
  return pj.batchId!
}

describe('x-upload-batch', () => {
  it('不同用户用同一个批次号,落库的 batchId 不同', async () => {
    const shared = createId()
    const a = await upload(u1, shared, 'a1')
    const b = await upload(u2, shared, 'b1')
    expect(a).not.toBe(b)
  })

  it('同一用户同一批次号的多次上传仍归为一批', async () => {
    const batch = createId()
    expect(await upload(u1, batch, 'a2')).toBe(await upload(u1, batch, 'a3'))
  })

  it('不是 cuid 的批次号被忽略,改用服务端生成的', async () => {
    const a = await upload(u1, '1', 'a4')
    const b = await upload(u2, '1', 'b4')
    expect(a).not.toBe(b)
    expect(a).not.toContain(':1')
    expect(b).not.toBe('1')
  })
})

describe('上传时记下界面语言(只用于完成通知)', () => {
  it('X-Lang: en → 解析任务 lang=en;不带 → zh', async () => {
    const en = await upload(u1, undefined, 'lang-en', { 'x-lang': 'en' })
    const zh = await upload(u1, undefined, 'lang-zh')
    expect((await prisma.parseJob.findFirstOrThrow({ where: { batchId: en } })).lang).toBe('en')
    expect((await prisma.parseJob.findFirstOrThrow({ where: { batchId: zh } })).lang).toBe('zh')
  })
})
