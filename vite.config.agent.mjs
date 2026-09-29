// Agent Web 控制台构建配置（产物进 agent/src/public，随后由 agent/build.mjs 以 SEA assets 嵌入二进制）
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  root: 'agent/console',
  plugins: [vue()],
  build: {
    outDir: '../src/public',
    emptyOutDir: true
  }
})
