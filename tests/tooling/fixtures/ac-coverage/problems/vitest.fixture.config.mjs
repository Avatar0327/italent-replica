// 夹具专用 Vitest 配置：只收集本目录的 *.fixture.js，不进主测试（主配置只匹配 *.test.ts）。
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: { include: ['*.fixture.js'], environment: 'node' },
});
