import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5070,
    proxy: {
      '/api': { target: 'http://localhost:4070', changeOrigin: true },
    },
  },
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
  test: {
    // 现有测试都是纯逻辑,不需要 DOM
    environment: 'node',
    globals: true,
  },
})
