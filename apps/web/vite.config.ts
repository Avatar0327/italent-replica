import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, loadEnv } from 'vite';
import { demoIdentityPlugin } from './dev/demo-identity.ts';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig(({ mode }) => {
  // 只在本 node 进程读取签名密钥（仓库根 .env.local，不入库）；不加 VITE_ 前缀，不会下发到浏览器
  const env = loadEnv(mode, repoRoot, '');
  return {
    plugins: [
      react(),
      // F-025：开发身份切换，插件自身只在 serve + development 挂载
      demoIdentityPlugin({ secret: env.DEV_IDENTITY_SECRET, manifestPath: `${repoRoot}.demo/personas.json` }),
    ],
    resolve: { conditions: ['@italent/source', ...defaultClientConditions] },
    server: {
      // 开发期把 /api 转发给本地后端（apps/api 默认 3000 端口）
      proxy: { '/api': { target: 'http://localhost:3000' } },
    },
  };
});
