import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { disconnectDb, initDb } from './db.js'

const app = await buildApp()

afterAll(async () => {
  await app.close()
  await disconnectDb()
})

describe('resume-api', () => {
  // 解析队列并发 3 会并发写。WAL 是这个并发模型的前提,不是可选优化 ——
  // 静默退回 delete 模式的话,后台跑批时整个界面会被写事务挡住。
  it('SQLite 跑在 WAL 模式', async () => {
    const { journalMode } = await initDb()
    expect(journalMode.toLowerCase()).toBe('wal')
  })

  it('/healthz 不需要登录', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' })
    expect(r.statusCode).toBe(200)
  })

  // 简历里全是个人信息。这条测试守的是「所有业务路由都挂了 requireAuth」——
  // 哪天有人图省事去掉一个 preHandler,这里会立刻转红,而不是等到简历被匿名
  // 拉走才发现。没有 cookie 时 auth 插件走的是「确认未登录」分支 → 401。
  it('业务路由未登录一律拒绝', async () => {
    const gets = [
      '/api/files', '/api/files/whatever',
      '/api/teams', '/api/jobs', '/api/jobs/x', '/api/jobs/x/candidates',
      // 这几条会吐出完整联系方式、审计记录,漏一个就是简历裸奔。
      '/api/candidates/x', '/api/tags', '/api/audit', '/api/evaluations/x',
    ]
    for (const url of gets) {
      const r = await app.inject({ method: 'GET', url })
      expect([401, 503], `GET ${url} 应拒绝`).toContain(r.statusCode)
    }

    const writes: Array<[string, string]> = [
      ['POST', '/api/files/paste'],
      ['POST', '/api/teams'],
      ['POST', '/api/jobs'],
      ['PUT', '/api/jobs/x/scorecard'],
      ['POST', '/api/jobs/x/scorecard/draft'],
      ['POST', '/api/applications'],
      ['POST', '/api/evaluations'],
      ['POST', '/api/candidates/x/merge'],
      ['POST', '/api/candidates/x/tags'],
      ['DELETE', '/api/candidates/x'],
      ['DELETE', '/api/tags/x'],
      // 阶段④ 新增的路由,一个都不能漏 —— 批删会连原件一起抹掉。
      ['PATCH', '/api/jobs/x'],
      ['DELETE', '/api/jobs/x'],
      ['POST', '/api/candidates/bulk-delete'],
    ]
    for (const [method, url] of writes) {
      const r = await app.inject({ method: method as 'POST', url, payload: {} })
      expect([401, 503], `${method} ${url} 应拒绝`).toContain(r.statusCode)
    }
  })
})
