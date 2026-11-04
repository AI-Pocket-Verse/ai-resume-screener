// 测试专用的 env 引导。vitest 在任何测试文件 import src/db.ts 之前加载它,
// 也就赶在 Prisma 读 DATABASE_URL 之前。
//
// **为什么必须有**:不钉死的话 `pnpm test` 会打到 .env.dev 指向的开发库,
// 一旦测试里有清库操作就会丢开发数据。
//
// ⚠️ 必须和 package.json 里 `pretest` 用的 URL **完全相同的字符串**,
// 否则 migrate deploy 和测试进程会解析到两个不同的文件,测试报「表不存在」。
// (Prisma 的 file: 是相对 schema.prisma 所在目录 —— 见 .env.example 的说明。)
process.env.DATABASE_URL = 'file:./test.db'

// vitest 默认把 NODE_ENV 设成 "test",而 env.ts 的枚举允许 test,
// 这里显式写出来只是为了让「测试用的是哪套配置」一目了然。
process.env.NODE_ENV = 'test'

// 原件与渲染页图钉到测试专用目录,避免测试往开发的 DATA_DIR 里丢文件。
process.env.DATA_DIR = process.env.DATA_DIR ?? './data-test'

// 授权测试以「某个具体飞书用户」的身份打进来(buildApp 的 authFetch 注入 whoami 结果),
// 所以默认跑在 SSO 模式。地址不会被真正访问。本地单用户模式另有专门的测试。
process.env.WHOAMI_URL = 'http://127.0.0.1:4020/api/whoami'
// 测试用的超管手机号(示例号码)
process.env.ADMIN_MOBILES = '13800138000'
