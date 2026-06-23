import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 游戏 web 端。开发服默认连本机游戏服务器（VITE_GAME_API，默认 :8790）。
// 注：@v0idchain/core/browser 是工作区内的 TS 源码，Vite 会用 esbuild 直接处理（.js 导入解析到同名 .ts）。
export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
});
