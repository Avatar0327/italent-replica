// ESLint 9 flat config。规则依据：AGENTS.md §6（禁止 import reference/）、§7（单行 ≤120、函数短小）。
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const referenceImportBan = {
  group: ['**/reference/**', 'reference/**'],
  message: 'reference/ 是只读参考（AGENTS.md §6），产品代码禁止 import。',
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'docs/**',
      'reference/**',
      '_private/**',
      '99_临时/**',
      '.demo/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // eslint-config-prettier 会关闭 max-len，这里在其之后重新打开
      'max-len': ['error', { code: 120, ignoreUrls: true, ignoreRegExpLiterals: true }],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
      'no-restricted-imports': ['error', { patterns: [referenceImportBan] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // 纯领域逻辑：不得依赖数据库、网络、文件系统（docs/07_M0/02_技术栈评估.md §6）
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            referenceImportBan,
            {
              group: ['@italent/db', '@italent/api', 'drizzle-orm', 'drizzle-orm/*', 'postgres', 'hono', 'node:*'],
              message: 'packages/domain 只放纯业务规则，不得有 IO 依赖。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // 测试用 describe 嵌套，放宽函数长度
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: { 'max-lines-per-function': 'off' },
  },
);
