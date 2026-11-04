// 本 app 专属的生成产物(schema.prisma 的 generator output)。**不要**从
// '@prisma/client' 导入 —— 那是所有产品共用的默认输出目录,谁最后 generate 谁赢。
import { PrismaClient } from '../generated/prisma/index.js'

/**
 * `connection_limit=1` 是**故意的**,不是没调优。
 *
 * `PRAGMA busy_timeout` 是 **per-connection** 的:在 initDb 里设一次,只对连接池
 * 恰好拿到的那一条连接生效,其余连接遇到写锁会立刻抛 SQLITE_BUSY 而不是等待 ——
 * 表现为解析批量跑时偶发「database is locked」,且随机到无法复现。
 *
 * SQLite 本来就只允许一个写者,多条连接换不来写并发;单连接则让所有写在应用层
 * 排队(而不是在 SQLite 层撞锁失败)。读的并发由 WAL 保证,不受这里影响。
 */
function singleConnectionUrl(): string | undefined {
  const url = process.env.DATABASE_URL
  if (!url || url.includes('connection_limit')) return undefined
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`
}

const pinned = singleConnectionUrl()
export const prisma = pinned
  ? new PrismaClient({ datasources: { db: { url: pinned } } })
  : new PrismaClient()

/**
 * 解析队列并发 3会产生并发写。SQLite 默认的 rollback journal 下,
 * 写事务会独占整个库,读也被挡住 —— 表现为界面在后台跑批时整体卡顿。
 * WAL 让读写不互相阻塞,是这个并发模型的前提,所以在启动时就明确打开。
 *
 * busy_timeout:拿不到锁时先自旋等待而不是立刻抛 SQLITE_BUSY。
 *
 * ⚠️ 与之配套的纪律:**不要在事务里跨 LLM 调用**(单次 2 分钟,会长时间持锁)。
 * 正确顺序是「LLM 调用完成 → 拿到结果 → 开事务写入 → 立即提交」。
 */
export async function initDb(): Promise<{ journalMode: string }> {
  // ⚠️ 必须用 $queryRaw 而不是 $executeRaw:`PRAGMA journal_mode=WAL` 会**返回
  // 一行**(新的 journal mode),而 $executeRaw 遇到有结果集的语句会直接抛
  // 「Execute returned results, which is not allowed in SQLite」。
  // busy_timeout 同理返回一行。
  const rows = await prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>(
    'PRAGMA journal_mode=WAL',
  )
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout=5000')
  // secure_delete:被删除行的内容在空闲页里清零。默认 OFF 时「彻底删除」后 PII 仍留在库文件里。
  // 同样返回一行,必须用 $queryRawUnsafe;连接级设置,单连接池下设一次即可。
  await prisma.$queryRawUnsafe('PRAGMA secure_delete=ON')
  const sd = await prisma.$queryRawUnsafe<Array<{ secure_delete: number | bigint }>>('PRAGMA secure_delete')
  if (Number(sd[0]?.secure_delete) !== 1) throw new Error('PRAGMA secure_delete 未生效,拒绝启动(彻底删除的承诺依赖它)')
  // 读回来确认,而不是假定生效 —— 库文件在只读介质或被别的连接锁住时,
  // SQLite 会静默地留在 delete 模式,而我们的并发假设就此失效。
  return { journalMode: rows[0]?.journal_mode ?? 'unknown' }
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect()
}
