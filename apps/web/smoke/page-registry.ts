import { existsSync, readdirSync } from 'node:fs';
import { APP_IDS } from '../../../packages/domain/src/permission/app-directory.js';
import { collectPages } from '../src/foundation/page-registry.js';

// Playwright 在 Node 里加载，没有 Vite 的 import.meta.glob：按同一规则（src/<模块>/pages.ts）扫目录，
// 再交给页面同一个汇总函数，保证冒烟用例看到的应用与浏览器里一致。
const src = new URL('../src/', import.meta.url);
const names = readdirSync(src, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(new URL(`${entry.name}/pages.ts`, src)))
  .map((entry) => entry.name);
const modules = Object.fromEntries(
  await Promise.all(names.map(async (name) => [`../${name}/pages.ts`, await import(`../src/${name}/pages.ts`)])),
);
export const PAGES = collectPages(modules, APP_IDS);
export const APP_ROUTES = PAGES.apps;
