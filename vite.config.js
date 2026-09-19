import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  base: './',
  optimizeDeps: { exclude: ['@mtcute/wasm'] },
  build: {
    rollupOptions: {
      input: {
        user: resolve(process.cwd(), 'index.html'),
        master: resolve(process.cwd(), 'master.html'),
        secrets: resolve(process.cwd(), 'secret-tool.html'),
      },
    },
  },
})
