import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// 渲染层根 = 本文件所在目录（clients/desktop/src/renderer）。
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  // base 用相对路径：Electron 生产时用 file:// 经 loadFile 加载 dist/index.html，
  // 绝对 '/assets/...' 会解析到文件系统根而 404；'./' 让资源相对 index.html 解析。
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    // 单页应用；不分 chunk 以保持产物简单（Electron 本地加载，无需 CDN 缓存策略）。
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
