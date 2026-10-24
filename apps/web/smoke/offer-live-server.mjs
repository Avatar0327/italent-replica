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
  const { startOfferBackend } = await loader.ssrLoadModule('/apps/web/smoke/offer-live-backend.ts');
  const backend = await startOfferBackend();
  console.log(`F298_READY ${JSON.stringify(backend.manifest)}`);
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
