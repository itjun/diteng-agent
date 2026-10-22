import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// renderer 的构建产物由 Electron 以 file:// 加载，base 必须是相对路径
const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // src/shared 位于 vite root（src/renderer）之外，显式放行项目根目录
    fs: {
      allow: [projectRoot],
    },
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
});
