import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 在任何测试 import src/db.ts 之前把 DATABASE_URL 钉到 test.db ——
    // 否则 `pnpm test` 会打到开发库。见 test-helpers/setup-env.ts。
    setupFiles: ['./test-helpers/setup-env.ts'],
    // 多个测试文件共用同一个 SQLite 文件,并行跑会互相锁。
    fileParallelism: false,
  },
})
