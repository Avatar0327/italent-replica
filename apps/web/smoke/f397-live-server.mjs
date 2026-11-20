import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer, defaultServerConditions } from 'vite';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const conditions = ['@italent/source', ...defaultServerConditions];
const loader = await createServer({
  root,
  configFile: false,
  // 验收夹具只使用 expect；在 Playwright 子进程里使用相同断言接口，不启动 Vitest runner。
  resolve: {
    conditions,
    alias: [{ find: /^vitest$/, replacement: require.resolve('@playwright/test').replace(/index\.js$/, 'index.mjs') }],
  },
  ssr: { resolve: { conditions, externalConditions: ['@italent/source'] } },
  server: { middlewareMode: true },
  appType: 'custom',
});
try {
  const { startPortalBackend } = await loader.ssrLoadModule('/apps/web/smoke/f397-live-backend.ts');
  const backend = await startPortalBackend();
  process.send?.(backend.manifest);
  const close = async () => {
    await backend.close();
    await loader.close();
    process.exit(0);
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
} catch (error) {
  console.error(error);
  await loader.close();
  process.exitCode = 1;
}
