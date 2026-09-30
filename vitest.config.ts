import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// 工作区包通过 `@italent/source` 条件直接解析到 src/*.ts，测试无需先构建。
const sourceConditions = ['@italent/source', ...defaultServerConditions];

export default defineConfig({
  resolve: { conditions: sourceConditions },
  ssr: { resolve: { conditions: sourceConditions, externalConditions: ['@italent/source'] } },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    // 每个测试文件各建一个库；PGlite 冷启动较慢，放宽超时
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
