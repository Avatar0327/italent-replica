import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer, defaultServerConditions } from 'vite';

const require = createRequire(import.meta.url);
const conditions = ['@italent/source', ...defaultServerConditions];
const loader = await createServer({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  configFile: false,
  resolve: {
    conditions,
    alias: [{ find: /^vitest$/, replacement: require.resolve('@playwright/test').replace(/index\.js$/, 'index.mjs') }],
  },
  ssr: { resolve: { conditions, externalConditions: ['@italent/source'] } },
  server: { middlewareMode: true },
  appType: 'custom',
});
try {
  const { startRetirementBackend } = await loader.ssrLoadModule('/apps/web/smoke/retirement-live-backend.ts');
  const backend = await startRetirementBackend();
  process.send(backend.manifest);
  process.once('disconnect', async () => {
    await backend.close();
    await loader.close();
  });
} catch (error) {
  console.error(error);
  await loader.close();
  process.exitCode = 1;
  process.disconnect();
}
