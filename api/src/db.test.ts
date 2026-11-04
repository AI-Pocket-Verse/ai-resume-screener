import { afterAll, describe, expect, it } from 'vitest'
import { disconnectDb, initDb, prisma } from './db.js'

afterAll(async () => { await disconnectDb() })

describe('initDb', () => {
  // 默认 secure_delete=OFF:被删行的 PII 会残留在库文件空闲页,「彻底删除」就名不副实。
  it('开启 secure_delete', async () => {
    await initDb()
    const rows = await prisma.$queryRawUnsafe<Array<{ secure_delete: number | bigint }>>('PRAGMA secure_delete')
    expect(Number(rows[0]?.secure_delete)).toBe(1)
  })
})
