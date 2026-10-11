import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vitest/config';
import base from '../../../../vitest.config.js';

export default mergeConfig(base, {
  test: {
    setupFiles: [fileURLToPath(new URL('./registry-omission.setup.ts', import.meta.url))],
    maxWorkers: 1,
    fsModuleCache: true,
  },
});
