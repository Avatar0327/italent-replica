import { fileURLToPath } from 'node:url';
import { createServer, defaultServerConditions } from 'vite';

const conditions = ['@italent/source', ...defaultServerConditions];
const loader = await createServer({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  configFile: false,
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['@italent/source'] } },
  server: { middlewareMode: true },
  appType: 'custom',
});
try {
  const entry = '/apps/web/smoke/retirement-settings-live-backend.ts';
  const { startRetirementSettingsBackend } = await loader.ssrLoadModule(entry);
  const backend = await startRetirementSettingsBackend();
  console.log(`RT_SETTINGS_READY ${JSON.stringify(backend.manifest)}`);
  process.once('SIGTERM', async () => {
    await backend.close();
    await loader.close();
    process.exit(0);
  });
} catch (error) {
  console.error(error);
  await loader.close();
  process.exitCode = 1;
}
