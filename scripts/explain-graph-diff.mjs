#!/usr/bin/env node
// 证据登记差异说明（F-072 PR-1，只读，不入 CI）：对比 merge-base（或给定 ref）与工作区的 required/digests/，
// 逐项核对每个变化的节点能否由本分支改过的源码文件解释（docs/08_设计/F-072_闭包边界降噪_方案.md §4.4）。
// 用法：node scripts/explain-graph-diff.mjs [<base-ref>]      缺省 base = git merge-base origin/main HEAD
// 退出码：有待说明项为 1，否则 0。待说明项要在 PR 描述里逐条说明。
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
  root,
  configFile: fileURLToPath(new URL('../vitest.config.ts', import.meta.url)), // 工作区包的 @italent/source 解析条件
  logLevel: 'error',
  server: { middlewareMode: true },
  appType: 'custom',
});
try {
  const { explainFromGit, formatExplanation } = await server.ssrLoadModule(
    '/tests/acceptance/support/route-policy/explain-graph-diff.ts',
  );
  const { items } = explainFromGit(root, process.argv[2]);
  console.log(formatExplanation(items));
  process.exitCode = items.some((item) => !item.explained) ? 1 : 0;
} finally {
  await server.close();
}
