/**
 * 现状必测基准的生成与冻结（F-039 PR-A §4.2 限定版，DEC-300 / DEC-303）：
 *   routes[`METHOD 最终路径`] = { module, edge（边界探测）, primitives（静态原语探测） }，domains = 分支域常量。
 * 生成过程只读运行时路由表（方法 / 最终路径）、源码与 HTTP 响应，不读任何声明；冻结文件逐字节比较，
 * 改动须 `ROUTE_POLICY_UPDATE_BASELINE=1 pnpm test -- AC-PRM-FW-02` 重新生成并随 PR 评审。
 */
import type { RouteManifest } from '@italent/api';
import type { Db } from '@italent/db';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { tenantApi } from '../tenant-api.js';
import type { ObservedContract, ObservedRoute } from './contract.js';
import { domainConstants } from './domains.js';
import { scanPrimitives } from './primitives.js';
import { probeEdges } from './probe.js';
import { closureText, indexSources, matchRegistrations, moduleDirs, scanRegistrations } from './scan.js';

export type { ObservedContract, ObservedRoute } from './contract.js';

export const BASELINE_PATH = path.resolve(
  process.cwd(),
  'tests/acceptance/support/route-policy/baseline/observed-contract.json',
);

/** 键排序、两空格缩进、末尾换行的规范化 JSON（冻结文件格式；目录已加入 .prettierignore）。 */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, item]) => [k, sort(item)]),
      );
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

export async function observeContract(
  db: Db,
  api: ReturnType<typeof tenantApi>,
  manifest: RouteManifest,
): Promise<ObservedContract> {
  const index = indexSources();
  const registrations = scanRegistrations(index);
  const edges = await probeEdges(db, api, manifest);
  const routes: Record<string, ObservedRoute> = {};
  for (const route of manifest.declared) {
    const { module, prefix, subApp, dirs } = moduleDirs(route.path);
    const localPath = subApp ? route.path.slice(prefix.length) || '/' : route.path;
    const hits = matchRegistrations(registrations, route.method, localPath, dirs);
    if (!hits.length) throw new Error(`静态注册扫描找不到 ${route.method} ${route.path}（${localPath}）`);
    // 深闭包（6 层）供准入类维度；近闭包（3 层）供命令内前提 / 字段提取 / 范围 / 复核等更贴近处理函数的维度
    const deep = hits.map((hit) => closureText(index, hit, 6)).join('\n');
    const near = hits.map((hit) => closureText(index, hit, 3)).join('\n');
    const key = `${route.method} ${route.path}`;
    const edge = edges[key];
    if (!edge) throw new Error(`边界探测缺少 ${key}`);
    routes[key] = { module, edge, primitives: scanPrimitives({ deep, near }, route.method, module) };
  }
  return { routes, domains: domainConstants() };
}

export function readFrozenContract(): ObservedContract | undefined {
  if (!existsSync(BASELINE_PATH)) return undefined;
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as ObservedContract;
}

export function writeFrozenContract(contract: ObservedContract): void {
  mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, canonicalJson(contract));
}
