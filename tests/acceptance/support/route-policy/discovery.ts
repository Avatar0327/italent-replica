/**
 * 发现探测（F-039 PR-B4a，docs/08_设计/F-039_PR-B_设计.md B-08 步骤一，Tier 0）：全允许的授权替身对每条已声明端点
 * 发一次占位请求（路径参数占位、写请求体 `{}`，沿用 PR-A 边界探测的请求），得到结果 O* 与授权请求轨迹 T*；
 * 有 id 参数的端点再把第一个 id 换成 `not-a-uuid` 观测非法标识。**全允许只用于发现授权请求，不下结论**——
 * 验证（只给表备选的最小授权集、撤权）是 PR-B4b 的步骤二。
 *   P0   T* 的每个授权器请求必须被本端点显式表里某条义务（任意用途）认领，否则 PROBE_ADMISSION_UNCLAIMED（抓表漏登）；
 *   P3   非法标识的观测码与根节点 invalidId 相等；没写却观测到 400 / 404 也是 MISMATCH:invalidId；
 *   映射 映射不了的授权动作 → PROBE_ACTION_UNMAPPED。
 * 未达（gap）：表里有授权器类义务（任意用途）、轨迹却是空的（验参 / 加载失败没触达授权点）→ 记原因，不算验证通过，
 * 交 PR-B4b 的覆盖台账与 Tier 1 成功样本补测。事实按模块冻结在 baseline/probe/<模块>.json。
 */
import { type ManifestRoute, routeManifest } from '@italent/api';
import { ORG_EMPLOYEE_APP } from '@italent/domain';
import type { Db } from '@italent/db';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedTenantWithMember, tenantApi } from '../tenant-api.js';
import { canonicalJson } from './baseline.js';
import type { Finding } from './compare.js';
import { type AuthorizerDouble, createAuthorizerDouble } from './double.js';
import { domainConstants } from './domains.js';
import { observe, PLACEHOLDER_UUID, UUID_PARAM } from './probe.js';
import type { KnownGap } from './probe-known-gaps.js';
import { permClaims } from './request-perms.js';
import { REQUIRED } from './required/index.js';
import type { RequiredTable } from './required/types.js';
import { moduleDirs } from './scan.js';

export interface Observed {
  readonly status: number;
  readonly code?: string;
  readonly reason?: string;
}

/** 未达原因（B-08 步骤二第 2 点；后三项由 PR-B4b 的守卫内部备选判定填入，本 PR 只定义接口）。 */
export const UNREACHED_REASONS = [
  'validation',
  'not-found',
  'not-asked',
  'inner-branch-unknown',
  'inner-branch-unsampled',
  'inner-branch-not-standalone',
] as const;
export type UnreachedReason = (typeof UNREACHED_REASONS)[number];

export interface EndpointDiscovery {
  /** O*：全允许下占位请求的结果。 */
  readonly all: Observed;
  /** T*：被问到的授权器权限键（排序去重）。 */
  readonly trace: readonly string[];
  /** 范围类查询（data.scope.all 请求与范围提供器查询）。 */
  readonly scopeQueries: readonly string[];
  /** 字段提供器查询（fields:<对象>）。 */
  readonly fieldQueries: readonly string[];
  /** 非法标识观测；没有 id 参数的端点没有这一项。 */
  readonly invalidId?: Observed;
  /** 映射不了的授权动作。 */
  readonly unmapped?: readonly string[];
  /** 表里有授权器类义务（任意用途）却没问到。 */
  readonly gap?: { readonly reason: UnreachedReason };
  /** PR-B4b 预留：守卫内部 HR 路径不能独立成功的入口，非参与人 HR 的拒绝码转换（DEC-362 第 2 条）。 */
  readonly denialShift?: string;
}

export interface DiscoveryRig {
  readonly double: AuthorizerDouble;
  /** 已发出的请求数（PR 描述附请求数与耗时）。 */
  readonly sent: number;
  send(method: string, path: string, body?: unknown): Promise<Response>;
}

/** 一个真实租户成员 + 授权替身装配的完整应用；返回路由清单供枚举。 */
export async function createRig(db: Db): Promise<{ rig: DiscoveryRig; manifest: ReturnType<typeof routeManifest> }> {
  const double = createAuthorizerDouble();
  const { tenant, user } = await seedTenantWithMember(db, 'fw-discovery');
  const api = tenantApi(db, { authorize: double.authorize });
  let sent = 0;
  const rig: DiscoveryRig = {
    double,
    get sent() {
      return sent;
    },
    send(method, path, body) {
      sent += 1;
      // 写请求带占位 If-Match：否则 REVISION_REQUIRED 的预检先于标识校验与授权，遮蔽非法标识观测并把本该触达
      // 授权点的写端点记成未达（相对 PR-A 边界探测请求的唯一补充，PR-B4a 偏离点）
      return api.request(method, path, {
        tenant: tenant.id,
        user: user.id,
        body,
        ...(method === 'GET' ? {} : { ifMatch: 1 }),
      });
    },
  };
  return { rig, manifest: routeManifest(api.app) };
}

/**
 * 路径占位：id 类参数 → 固定 UUID；`appCode` / `kind` 这类取值受限的参数 → 域内第一个合法值（相对 PR-A 边界探测的
 * `probe` 占位的补充：否则验参先在这些参数上失败，遮蔽后面的授权点与非法标识观测）；其余 → `probe`。
 */
function placeholderFor(routePath: string, name: string): string {
  if (UUID_PARAM.test(name)) return PLACEHOLDER_UUID;
  if (name === 'appCode') return ORG_EMPLOYEE_APP;
  const domains = domainConstants();
  if (name === 'kind' && routePath.includes('/personnel/')) return domains['personnel.subset']?.[0] ?? 'probe';
  if (name === 'kind' && routePath.includes('/job/')) return domains['job.kind']?.[0] ?? 'probe';
  return 'probe';
}

export const instantiate = (routePath: string): string =>
  routePath.replace(/:([A-Za-z]+)/g, (_match, name: string) => placeholderFor(routePath, name));

/** 第一个 id 类参数换成 `not-a-uuid`，其余照常占位；没有 id 参数返回 undefined。 */
export function invalidIdPath(routePath: string): string | undefined {
  let replaced = false;
  const result = routePath.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    if (!replaced && UUID_PARAM.test(name)) {
      replaced = true;
      return 'not-a-uuid';
    }
    return placeholderFor(routePath, name);
  });
  return replaced ? result : undefined;
}

const sameObservation = (a: Observed, b: Observed) =>
  a.status === b.status && a.code === b.code && a.reason === b.reason;

/**
 * P3 是否适用：非法标识的观测必须是验参类结果（400 / 404），并且与占位请求的结果 O* 不同。
 * 观测等于 O* 说明失败发生在别处（如 360 链接的令牌先于标识校验一律 404），观测不携带标识校验信息；
 * 其他状态（平台非运营 403、自助服务未绑定 403 …）说明没有触达标识校验。不适用的不算通过，B4b 的覆盖台账接手。
 */
export function p3Applicable(found: EndpointDiscovery): boolean {
  const seen = found.invalidId;
  return !!seen && (seen.status === 400 || seen.status === 404) && !sameObservation(seen, found.all);
}

const AUTHORIZER_DIMENSIONS = ['obj:', 'btn:', 'admin:'];

function unreachedReason(status: number): UnreachedReason {
  if (status === 400) return 'validation';
  if (status === 404) return 'not-found';
  return 'not-asked';
}

async function send(rig: DiscoveryRig, route: ManifestRoute, routePath: string) {
  rig.double.configure({});
  rig.double.reset();
  const response = await rig.send(route.method, routePath, route.method === 'GET' ? undefined : {});
  return { outcome: await observe(response), double: rig.double };
}

/** 对一条端点做发现探测。`table` 只用来判定"未达"（gap），不影响轨迹。 */
export async function discoverRoute(
  rig: DiscoveryRig,
  route: ManifestRoute,
  table: RequiredTable = REQUIRED,
): Promise<EndpointDiscovery> {
  const { outcome, double } = await send(rig, route, instantiate(route.path));
  const trace = double.permKeys();
  const unmapped = double.unmapped();
  const scopeQueries = double.scopeKeys();
  const fieldQueries = double.fieldKeys();
  const invalidPath = invalidIdPath(route.path);
  const invalidId = invalidPath ? (await send(rig, route, invalidPath)).outcome : undefined;
  const obligations = table[`${route.method} ${route.path}`] ?? [];
  // 任意用途的授权器类义务（准入 / 披露 / 守卫内部 / 条件准入）：它们的验证都要先触达授权点
  const needsAuthorizer = obligations.some((o) => AUTHORIZER_DIMENSIONS.some((prefix) => o.perm.startsWith(prefix)));
  return {
    all: outcome,
    trace,
    scopeQueries,
    fieldQueries,
    ...(invalidId ? { invalidId } : {}),
    ...(unmapped.length ? { unmapped } : {}),
    ...(needsAuthorizer && trace.length === 0 ? { gap: { reason: unreachedReason(outcome.status) } } : {}),
  };
}

export async function discoverAll(
  rig: DiscoveryRig,
  routes: readonly ManifestRoute[],
  table: RequiredTable = REQUIRED,
): Promise<Record<string, EndpointDiscovery>> {
  const out: Record<string, EndpointDiscovery> = {};
  // 串行：所有请求共用一个替身，并行会让轨迹互相串线
  for (const route of routes) out[`${route.method} ${route.path}`] = await discoverRoute(rig, route, table);
  return out;
}

/** P0 / P3 / 映射。缺发现事实不静默放过。`knownGaps` 见 probe-known-gaps.ts：只在整库检查时传入。 */
export function checkDiscovery(
  discoveries: Readonly<Record<string, EndpointDiscovery>>,
  table: RequiredTable,
  routes: readonly ManifestRoute[],
  knownGaps?: readonly KnownGap[],
): Finding[] {
  const findings: Finding[] = [];
  const matched = new Map<string, number>();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    const report = (code: string, detail: string) => findings.push({ route: key, code, detail });
    const found = discoveries[key];
    if (!found) {
      report('PROBE_DISCOVERY_MISSING', '没有发现事实（先用 ROUTE_POLICY_UPDATE_BASELINE=1 生成）');
      continue;
    }
    for (const action of found.unmapped ?? []) report('PROBE_ACTION_UNMAPPED', `授权动作 ${action} 没有对应的权限键`);
    const obligations = table[key] ?? [];
    for (const requested of found.trace) {
      if (obligations.some((o) => permClaims(o.perm, requested))) continue;
      const known = knownGaps?.find((gap) => gap.matches(key, requested));
      if (known) matched.set(known.id, (matched.get(known.id) ?? 0) + 1);
      else report('PROBE_ADMISSION_UNCLAIMED', `全允许下被问到 ${requested}，显式表没有任何义务认领（表漏登 / 错登）`);
    }
    if (p3Applicable(found)) checkInvalidId(route, found.invalidId!, report);
  }
  for (const gap of knownGaps ?? []) {
    const actual = matched.get(gap.id) ?? 0;
    if (actual !== gap.count) {
      findings.push({
        route: `known-gap:${gap.id}`,
        code: 'PROBE_KNOWN_GAP_STALE',
        detail: `登记 ${gap.count} 个，实际命中 ${actual} 个（表已补则删规则，新增漏登须审定而不是改数字）`,
      });
    }
  }
  return findings;
}

function checkInvalidId(route: ManifestRoute, seen: Observed, report: (code: string, detail: string) => void): void {
  const declared = route.policy.invalidId;
  const label = `${seen.status}${seen.code ? ` ${seen.code}` : ''}`;
  if (!declared) {
    if (seen.status === 400 || seen.status === 404) {
      report('MISMATCH:invalidId', `非法标识观测到 ${label}，但声明没有 invalidId`);
    }
    return;
  }
  const same =
    declared.status === seen.status &&
    declared.code === seen.code &&
    (declared.reason === undefined || declared.reason === seen.reason);
  if (!same) {
    const want = `${declared.status} ${declared.code}${declared.reason ? `/${declared.reason}` : ''}`;
    report('MISMATCH:invalidId', `声明 invalidId ${want}，观测到 ${label}${seen.reason ? `/${seen.reason}` : ''}`);
  }
}

/** ---- 按模块冻结（逐字节比较；ROUTE_POLICY_UPDATE_BASELINE=1 重新生成并随 PR 评审） ---- */
export const PROBE_DIR = path.resolve(process.cwd(), 'tests/acceptance/support/route-policy/baseline/probe');
export const probeFilePath = (module: string) => path.join(PROBE_DIR, `${module}.json`);

const moduleOf = (endpointKey: string) => moduleDirs(endpointKey.slice(endpointKey.indexOf(' ') + 1)).module;

export function groupByModule(
  discoveries: Readonly<Record<string, EndpointDiscovery>>,
): Record<string, Record<string, EndpointDiscovery>> {
  const groups: Record<string, Record<string, EndpointDiscovery>> = {};
  for (const [key, found] of Object.entries(discoveries)) (groups[moduleOf(key)] ??= {})[key] = found;
  return groups;
}

export function writeFrozenProbes(discoveries: Readonly<Record<string, EndpointDiscovery>>): void {
  mkdirSync(PROBE_DIR, { recursive: true });
  for (const file of readdirSync(PROBE_DIR)) if (file.endsWith('.json')) rmSync(path.join(PROBE_DIR, file));
  for (const [module, entries] of Object.entries(groupByModule(discoveries))) {
    writeFileSync(probeFilePath(module), canonicalJson(entries));
  }
}

export function readFrozenProbes(): Record<string, EndpointDiscovery> {
  if (!existsSync(PROBE_DIR)) return {};
  return Object.assign(
    {},
    ...readdirSync(PROBE_DIR)
      .filter((file) => file.endsWith('.json'))
      .map((file) => JSON.parse(readFileSync(path.join(PROBE_DIR, file), 'utf8')) as Record<string, EndpointDiscovery>),
  );
}
