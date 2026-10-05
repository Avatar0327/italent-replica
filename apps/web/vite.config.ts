import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // 开发期把 /api 转发给本地后端（apps/api 默认 3000 端口）
    proxy: { '/api': { target: 'http://localhost:3000' } },
  },
});
