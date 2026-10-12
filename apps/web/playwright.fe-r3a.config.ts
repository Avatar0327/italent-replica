import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

// 单独端口避免并行页面片争用；可显式选择本机已安装浏览器，默认仍使用 Playwright Chromium。
export default defineConfig({
  ...base,
  testMatch: 'AC-FE-R3a.smoke.spec.ts',
  outputDir: '../../.demo/fe-r3a/results',
  use: {
    ...base.use,
    baseURL: process.env.FE0_BASE_URL ?? 'http://127.0.0.1:4187',
    launchOptions: process.env.FE_R3A_CHROME ? { executablePath: process.env.FE_R3A_CHROME } : {},
  },
  webServer: process.env.FE0_BASE_URL
    ? undefined
    : {
        command: 'npx --yes pnpm@10.34.6 dev --host 127.0.0.1 --port 4187 --strictPort',
        url: 'http://127.0.0.1:4187',
        reuseExistingServer: false,
      },
});
