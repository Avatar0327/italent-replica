/**
 * 跨模块共享的 F-039 精确集合：按模块声明，不再用全局数字（DEC-475④，取代 DEC-468）。
 *
 * 原先 disclosure / discovery 等共享测试里写“24 个端点”“56 个端点”“29 对”这样的全局精确数，每个加路由的 PR 都改同一行，
 * 并行 PR 必冲突。精确计数的用途是发现“意外新增 / 意外消失”，所以这里保持同等严格度，只把一个全局数字换成
 * 逐模块、逐项的显式集合：每个模块在 `required/declared/<模块>.ts` 声明自己的条目；共享测试对每个模块比较
 * “实际集合 = 声明集合”（多出 = 未声明的新条目，少了 = 声明已失效），并要求每个实际条目都归属某个模块。
 * 新增路由只改本模块的声明文件，不再改共享测试。模块 = `required/<模块>.ts`（路由键所在的必需项表）。
 */
import type { ManifestRoute } from '@italent/api';
import { expect } from 'vitest';
import type { EndpointDiscovery } from './discovery.js';
import { BRANCH_INPUTS } from './branch-inputs.js';
import { declaredPerms } from './perms.js';
import { KNOWN_GAPS } from './probe-known-gaps.js';
import { DECLARED } from './required/declared/index.js';
import { REQUIRED_BY_MODULE } from './required/index.js';
import { mapSelectors } from './selectors.js';

export type DeclaredKind =
  | 'multiCarrierAdmission'
  | 'sameStatusInvalidId'
  | 'knownGapPairs'
  | 'activityKeyRequests'
  | 'selectorSites'
  | 'branchInputEndpoints';

/** 一份模块声明：每种条目一个集合；未列出的种类视为该模块没有此类条目。 */
export interface ModuleDeclared {
  /** R1c：含 ≥2 个准入承载节点的备选的端点（`METHOD 最终路径`）。 */
  readonly multiCarrierAdmission?: readonly string[];
  /** 状态码与错误码相同、仅错误体不同的端点（`METHOD 最终路径`），由实际行为证明非法标识声明适用。 */
  readonly sameStatusInvalidId?: readonly string[];
  /** 已知缺口台账里该模块端点的逐对登记 `[端点, 请求键]`。 */
  readonly knownGapPairs?: readonly (readonly [string, string])[];
  /** 发现探测的授权轨迹里仍询问 Activity 查看 / viewAll 键的“端点 × 请求键”（AC-PRM-F075b）。 */
  readonly activityKeyRequests?: readonly (readonly [string, string])[];
  /** 声明里的 `map` 型动态选择器位置 `[端点, 位置]`（AC-PRM-FW-02 选择器绑定）。 */
  readonly selectorSites?: readonly (readonly [string, string])[];
  /** 在输入来源表（BRANCH_INPUTS）里有登记的端点。 */
  readonly branchInputEndpoints?: readonly string[];
}

const ROUTE_OWNER: ReadonlyMap<string, string> = new Map(
  Object.entries(REQUIRED_BY_MODULE).flatMap(([module, table]) => Object.keys(table).map((key) => [key, module])),
);

/** 路由键属于哪个模块（出现在哪个 `required/<模块>.ts` 里）；没登记返回 undefined。 */
export const routeOwner = (routeKey: string): string | undefined => ROUTE_OWNER.get(routeKey);

const PAIR_SEPARATOR = '\t';
const pairId = ([route, key]: readonly [string, string]) => `${route}${PAIR_SEPARATOR}${key}`;

interface KindSpec {
  /** 条目标识 → 它所挂的路由键。 */
  readonly routeOf: (id: string) => string;
  /** 由一个路由键伪造该种类的条目（只供“同样严格”的反例）。 */
  readonly forge: (routeKey: string) => string;
  readonly ownerOf: (id: string) => string | undefined;
}

const routeKeyKind: KindSpec = { routeOf: (id) => id, forge: (key) => key, ownerOf: (id) => routeOwner(id) };

/** “端点 × 第二键”型条目：标识 = `端点\t第二键`，归属看端点。 */
const pairKind = (second: string): KindSpec => ({
  routeOf: (id) => id.split(PAIR_SEPARATOR)[0]!,
  forge: (key) => `${key}${PAIR_SEPARATOR}${second}`,
  ownerOf: (id) => routeOwner(id.split(PAIR_SEPARATOR)[0]!),
});

export const DECLARED_KINDS: Readonly<Record<DeclaredKind, KindSpec>> = {
  multiCarrierAdmission: routeKeyKind,
  sameStatusInvalidId: routeKeyKind,
  knownGapPairs: pairKind('obj:Forged.Object:view'),
  activityKeyRequests: pairKind('obj:Forged.Activity:view'),
  selectorSites: pairKind('object'),
  branchInputEndpoints: routeKeyKind,
};

/** 按模块汇总某一种类的声明（条目标识：路由键，或 `端点\t请求键`）。 */
export function declaredItems(kind: DeclaredKind): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [module, declared] of Object.entries(DECLARED)) {
    const items = declared[kind]?.map((item) => (typeof item === 'string' ? item : pairId(item)));
    if (items?.length) out[module] = items;
  }
  return out;
}

const list = (ids: readonly string[]) => ids.map((id) => id.replace(PAIR_SEPARATOR, ' ')).join('；');

/**
 * 实际集合与各模块声明逐项比较，返回差异（空 = 一致）。逐模块报告，信息列出差异键：
 * 多出 = 实际有而本模块没声明；声明已失效 = 本模块声明了而实际没有，或该条目实际属于别的模块；
 * 无主 = 实际条目不属于任何模块；重复声明 = 同一条目被声明了不止一次。
 */
export function declarationDifferences(
  label: string,
  actual: readonly string[],
  declared: Readonly<Record<string, readonly string[]>>,
  ownerOf: (id: string) => string | undefined,
): string[] {
  const out: string[] = [];
  const unowned = actual.filter((id) => ownerOf(id) === undefined);
  if (unowned.length) out.push(`${label}｜无主（不属于任何模块的登记表）：${list(unowned)}`);

  const seen = new Map<string, number>();
  for (const items of Object.values(declared)) for (const id of items) seen.set(id, (seen.get(id) ?? 0) + 1);
  const duplicated = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  if (duplicated.length) out.push(`${label}｜重复声明：${list(duplicated)}`);

  const actualSet = new Set(actual);
  const modules = new Set([...Object.keys(declared), ...actual.map(ownerOf).filter((m) => m !== undefined)]);
  for (const module of [...modules].sort()) {
    const mine = new Set(declared[module] ?? []);
    const extra = actual.filter((id) => ownerOf(id) === module && !mine.has(id));
    const stale = [...mine].filter((id) => !actualSet.has(id) || ownerOf(id) !== module);
    if (extra.length) out.push(`${label}｜${module} 多出（实际有、本模块未声明）：${list(extra)}`);
    if (stale.length)
      out.push(`${label}｜${module} 声明已失效（本模块声明了、实际没有或实际属于别的模块）：${list(stale)}`);
  }
  return out;
}

/** 共享测试用的断言入口：失败时信息就是差异清单。 */
export function expectDeclared(label: string, kind: DeclaredKind, actual: readonly string[]): void {
  const found = declarationDifferences(label, actual, declaredItems(kind), DECLARED_KINDS[kind].ownerOf);
  expect(found, found.join('\n')).toEqual([]);
}

/** R1c：含 ≥2 个准入承载节点（`obj:` / `admin:` 权限的承载来源）的备选的端点。 */
export function multiCarrierRoutes(routes: readonly ManifestRoute[]): ManifestRoute[] {
  return routes.filter((r) =>
    declaredPerms(r.policy).alternatives.some((alt) => {
      const carriers = [...alt].flatMap(([perm, sources]) =>
        /^(obj|admin):/.test(perm) ? sources.filter((s) => s.carrier).map((s) => s.path) : [],
      );
      return new Set(carriers).size >= 2;
    }),
  );
}

/** 状态码与错误码相同、只有错误体指纹不同的端点（第 3 轮起由实际行为证明非法标识声明适用）。 */
export const sameStatusInvalidIdRoutes = (fresh: Readonly<Record<string, EndpointDiscovery>>): string[] =>
  Object.entries(fresh)
    .filter(([, d]) => d.invalidId && d.invalidId.status === d.all.status && d.invalidId.code === d.all.code)
    .filter(([, d]) => d.invalidId!.reason === d.all.reason && d.invalidId!.error !== d.all.error)
    .map(([k]) => k);

/** 授权轨迹里询问了给定键的“端点\t请求键”（按键顺序、端点顺序稳定）。 */
export const traceRequestIds = (
  probes: Readonly<Record<string, { readonly trace: readonly string[] }>>,
  keys: readonly string[],
): string[] =>
  Object.entries(probes).flatMap(([endpoint, found]) =>
    keys.filter((key) => found.trace.includes(key)).map((key) => pairId([endpoint, key])),
  );

/** 声明里的 map 型选择器位置“端点\t位置”。 */
export const selectorSiteIds = (routes: readonly ManifestRoute[]): string[] =>
  routes.flatMap((r) => mapSelectors(r.policy).map((site) => pairId([`${r.method} ${r.path}`, site.position])));

/** 输入来源表里有登记的端点。 */
export const branchInputEndpointIds = (): string[] => Object.keys(BRANCH_INPUTS);

/** 已知缺口台账的全部登记对（`端点\t请求键`）。 */
export const knownGapPairIds = (): string[] => KNOWN_GAPS.flatMap((g) => g.pairs.map(pairId));
