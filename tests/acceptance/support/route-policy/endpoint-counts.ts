/**
 * 端点计数（DEC-430①）：总数与按模块统计原先是测试里的字面量（592 等），每个加路由的 PR 都改同几行，合并 main
 * 必冲突。现在由 `ROUTE_POLICY_UPDATE_BASELINE=1 pnpm test -- tests/acceptance/AC-PRM-FW-01.test.ts` 从运行时
 * 路由表生成到 baseline/endpoint-counts.json，测试读文件比较；不一致走生成物开关（generated-gate.ts）。
 * 计数本身只是“有没有重算”的提示：路由是否都声明、显式表键是否等于已声明路由，另有硬断言。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './baseline.js';

export const ENDPOINT_COUNTS_PATH = path.resolve(
  process.cwd(),
  'tests/acceptance/support/route-policy/baseline/endpoint-counts.json',
);

export interface EndpointCounts {
  readonly total: number;
  readonly byModule: Readonly<Record<string, number>>;
}

export function countEndpoints(declared: readonly { readonly module: string }[]): EndpointCounts {
  const byModule: Record<string, number> = {};
  for (const route of declared) byModule[route.module] = (byModule[route.module] ?? 0) + 1;
  return { total: declared.length, byModule };
}

export function readEndpointCounts(): EndpointCounts | undefined {
  if (!existsSync(ENDPOINT_COUNTS_PATH)) return undefined;
  return JSON.parse(readFileSync(ENDPOINT_COUNTS_PATH, 'utf8')) as EndpointCounts;
}

export function writeEndpointCounts(counts: EndpointCounts): void {
  mkdirSync(path.dirname(ENDPOINT_COUNTS_PATH), { recursive: true });
  writeFileSync(ENDPOINT_COUNTS_PATH, canonicalJson(counts));
}

/** 运行时计数与冻结计数的差异，逐项一行；只比总数时传 `{ totalOnly: true }`。 */
export function countDrift(
  actual: EndpointCounts,
  stored: EndpointCounts | undefined,
  options: { readonly totalOnly?: boolean } = {},
): string[] {
  if (!stored) return [`${path.basename(ENDPOINT_COUNTS_PATH)} 不存在`];
  const drift = actual.total === stored.total ? [] : [`总数 ${actual.total}（冻结 ${stored.total}）`];
  if (options.totalOnly) return drift;
  const modules = new Set([...Object.keys(actual.byModule), ...Object.keys(stored.byModule)]);
  for (const module of [...modules].sort()) {
    const now = actual.byModule[module] ?? 0;
    const frozen = stored.byModule[module] ?? 0;
    if (now !== frozen) drift.push(`${module} ${now}（冻结 ${frozen}）`);
  }
  return drift;
}
