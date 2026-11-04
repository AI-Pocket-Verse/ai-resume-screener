import { afterAll, describe, expect, it, vi } from 'vitest'

// 开源默认体验:不配 WHOAMI_URL 的本地单用户模式。唯一的本地用户必须是超管,
// 否则他建的岗位之外什么都看不到,删除与审计也全部 403。
// env.ts 在 import 时读 process.env,所以先改 env 再重新 import 整条模块链。
vi.stubEnv('WHOAMI_URL', '')
vi.resetModules()
const { buildApp } = await import('./app.js')
const { disconnectDb, prisma } = await import('./db.js')

const app = await buildApp()

afterAll(async () => {
  await app.close()
  await disconnectDb()
  vi.unstubAllEnvs()
})

describe('本地单用户模式', () => {
  it('无需登录即可访问,且本地用户是超管', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me' })
    expect(res.statusCode).toBe(200)
    expect(res.json().isSuperAdmin).toBe(true)
  })

  it('能建岗位并在列表里看到', async () => {
    const team = await prisma.team.create({ data: { name: `本地团队-${Date.now()}`, ownerId: 'local' } })
    const created = await app.inject({ method: 'POST', url: '/api/jobs', payload: { teamId: team.id, title: '本地岗位' } })
    expect(created.statusCode).toBeLessThan(300)
    const list = await app.inject({ method: 'GET', url: '/api/jobs' })
    expect(list.json().map((j: { title: string }) => j.title)).toContain('本地岗位')
  })

  // DNS rebinding:恶意网页把自己的域名解析到 127.0.0.1 后以同源身份请求 api。
  // 本地模式不鉴权,只能靠 Host 白名单挡住。
  it('Host 不是本机时拒绝(防 DNS rebinding)', async () => {
    const evil = await app.inject({ method: 'GET', url: '/api/me', headers: { host: 'evil.example.com:4070' } })
    expect(evil.statusCode).toBe(421)
    for (const host of ['localhost:4070', '127.0.0.1:4070', '[::1]:4070']) {
      const ok = await app.inject({ method: 'GET', url: '/api/me', headers: { host } })
      expect(ok.statusCode, host).toBe(200)
    }
  })

  // 响应都是按人可见的简历数据,不能被浏览器或共享代理缓存。
  it('接口响应带 Cache-Control: no-store(含错误响应)', async () => {
    for (const url of ['/api/me', '/api/not-exist']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.headers['cache-control'], url).toBe('no-store')
    }
  })
})

