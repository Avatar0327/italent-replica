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
import { objectFacts } from './objects.js';
import { scanPrimitives } from './primitives.js';
import { probeEdges } from './probe.js';
import { closureText, indexSources, matchRegistrations, moduleDirs, scanMaxDepth, scanRegistrations } from './scan.js';

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
  const maxDepth = scanMaxDepth();
  const index = indexSources();
  const registrations = scanRegistrations(index);
  const edges = await probeEdges(db, api, manifest);
  const routes: Record<string, ObservedRoute> = {};
  for (const route of manifest.declared) {
    const { module, prefix, subApp, dirs } = moduleDirs(route.path);
    const localPath = subApp ? route.path.slice(prefix.length) || '/' : route.path;
    const hits = matchRegistrations(registrations, route.method, localPath, dirs);
    if (!hits.length) throw new Error(`静态注册扫描找不到 ${route.method} ${route.path}（${localPath}）`);
    // 深闭包默认 6 层（F-231 可配置）；近闭包固定 3 层，维持命令内前提 / 字段 / 范围等维度的口径。
    const deep = hits.map((hit) => closureText(index, hit, maxDepth)).join('\n');
    const near = hits.map((hit) => closureText(index, hit, 3)).join('\n');
    const key = `${route.method} ${route.path}`;
    const edge = edges[key];
    if (!edge) throw new Error(`边界探测缺少 ${key}`);
    // 准入 / 披露的区分只由必需项显式表决定（required/，DEC-348②）：这里扫完整闭包，不做语法切分
    const primitives = scanPrimitives({ deep, near }, route.method, module, route.path);
    const objects = objectFacts(index, near, module, dirs);
    routes[key] = { module, edge, primitives: { ...primitives, ...(objects.length ? { objectOp: objects } : {}) } };
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
