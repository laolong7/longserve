import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 渲染进程构建配置：root 指向 renderer，base 用相对路径适配 Electron file:// 加载
export default defineConfig({
  root: 'renderer',
  base: './',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    host: '127.0.0.1', // 强制 IPv4，与 wait-on / Electron 加载地址保持一致
    port: 5173,
    strictPort: true
  }
})
