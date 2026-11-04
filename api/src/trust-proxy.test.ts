import { afterEach, describe, expect, it, vi } from 'vitest'

// 限流按 req.ip 分桶:只有来自可信反代(默认 loopback)的 X-Forwarded-For 才能改写 req.ip。
// 无条件 trustProxy:true 时,客户端换个 XFF 就能绕过限流。
async function ipOf(remoteAddress: string, xff: string, env: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.resetModules()
  const { buildApp } = await import('./app.js')
  const { disconnectDb } = await import('./db.js')
  const app = await buildApp()
  app.get('/_ip', async (req) => ({ ip: req.ip }))
  await app.ready()
  const res = await app.inject({ method: 'GET', url: '/_ip', remoteAddress, headers: { 'x-forwarded-for': xff } })
  await app.close()
  await disconnectDb()
  return res.json().ip as string
}

afterEach(() => vi.unstubAllEnvs())

describe('trustProxy', () => {
  it('默认 loopback:本机 nginx 转发的 XFF 被采信', async () => {
    expect(await ipOf('127.0.0.1', '198.51.100.7')).toBe('198.51.100.7')
  })
  it('默认 loopback:非可信来源直连时伪造的 XFF 被忽略', async () => {
    expect(await ipOf('203.0.113.9', '198.51.100.99')).toBe('203.0.113.9')
  })
  it('TRUST_PROXY 可指定其他反代网段', async () => {
    expect(await ipOf('192.0.2.5', '198.51.100.7', { TRUST_PROXY: '192.0.2.0/24' })).toBe('198.51.100.7')
  })
})
