import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.FE0_PORT ?? 4179);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('FE0_PORT must be between 1024 and 65535');
const url = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './smoke',
  testMatch: process.env.FE0_LIVE ? '**/*.live.spec.ts' : '**/*.smoke.spec.ts',
  outputDir: process.env.FE0_LIVE ? '../../.demo/fe0-smoke/live' : '../../.demo/fe0-smoke/results',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { baseURL: process.env.FE0_BASE_URL ?? url, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.FE0_BROWSER_CHANNEL } }],
  webServer: process.env.FE0_BASE_URL
    ? undefined
    : {
        command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
        url,
        reuseExistingServer: false,
      },
});
