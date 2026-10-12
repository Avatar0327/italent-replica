import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './smoke',
  outputDir: '../../.demo/fe0-smoke/results',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [['list']],
  use: { baseURL: process.env.FE0_BASE_URL ?? 'http://127.0.0.1:4179', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.FE0_BASE_URL
    ? undefined
    : {
        command: 'npx --yes pnpm@10.34.6 dev --host 127.0.0.1 --port 4179 --strictPort',
        url: 'http://127.0.0.1:4179',
        reuseExistingServer: false,
      },
});
