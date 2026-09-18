import { defineConfig } from 'vite'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
export default defineConfig({
  base: './',
  optimizeDeps: { exclude: ['@mtcute/wasm'] },
  build: { rollupOptions: { input: { app: resolve(here,'index.html'), secretTool: resolve(here,'secret-tool.html') } } },
})
