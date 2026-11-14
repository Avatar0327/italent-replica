import { fileURLToPath } from 'node:url';
import { createServer, defaultServerConditions } from 'vite';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const conditions = ['@italent/source', ...defaultServerConditions];
const loader = await createServer({
  root,
  configFile: false,
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['@italent/source'] } },
  server: { middlewareMode: true },
  appType: 'custom',
});
try {
  // F2b 冒烟传自己的后端模块（同样导出 startMatrixBackend），缺省为 F2a
  const entry = process.argv[2] ?? '/apps/web/smoke/f326f2a-live-backend.ts';
  const { startMatrixBackend } = await loader.ssrLoadModule(entry);
  const backend = await startMatrixBackend();
  console.log(`F2A_READY ${JSON.stringify(backend.manifest)}`);
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
