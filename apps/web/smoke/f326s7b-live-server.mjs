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
  const { startAutoVariableBackend } = await loader.ssrLoadModule('/apps/web/smoke/f326s7b-live-backend.ts');
  const backend = await startAutoVariableBackend();
  console.log(`F326S7B_READY ${JSON.stringify(backend.manifest)}`);
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
