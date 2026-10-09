/**
 * 声明 vs 现状必测基准的比较器（F-039 PR-A §4.4「declaration-not-weaker」限定版）。内存比较，不发请求。
 * - 弱于现状（WEAKER:<维度>）：基准观测到的维度 / 守卫 / 前提 / 分支域，声明里没有 → 失败（DEC-300 的核心要求）。
 * - 过度声明（OVERDECLARED:<维度>）：只在静态探测能可靠否定的维度上双向报——身份（public / platform / tenant）、
 *   成员之外的特权、写入口、管理员能力、本人绑定、目录内已知守卫名。对象 / 范围 / 字段 / 关系 / 按钮的“声明多于
 *   现状”需要多维身份探测才能否定，按 DEC-303 留给 PR-B（§10.6）。目录外的守卫名是接管阶段才实现的登记名，不报。
 */
import type { ManifestRoute } from '@italent/api';
import type { ObservedContract, ObservedRoute } from './contract.js';
import { features, type Identity, preconditionName } from './features.js';
import { KNOWN_GUARDS } from './primitives.js';

export interface Finding {
  readonly route: string;
  readonly code: string;
  readonly detail: string;
}

/** 双向比较的维度。 */
const BOTH_WAYS = ['admin', 'self'] as const;
/** 只查"声明不得弱于现状"的维度。 */
const WEAKER_ONLY = [
  'object',
  'button',
  'scope',
  'fieldsOut',
  'fieldsIn',
  'relation',
  'own',
  'failureAudit',
  'postcheck',
] as const;

/** 匿名请求不被 401 拦下的路由不经成员中间件（/healthz、360 链接作答：令牌不对按 404）。 */
export function observedIdentity(key: string, route: ObservedRoute): Identity {
  if (route.edge.anonymous.status !== 401) return 'public';
  if (key.includes(' /api/platform/')) return 'platform';
  return 'tenant';
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * 蕴含关系（声明侧）：self / own 自带范围（本人即范围）；self 的叠加授权器自带对象权限，本人数据即 own；
 * relation 由关系定位自带范围；写入口登记了字段编辑权提取（requireObjectWrite）即蕴含对象写操作权。
 */
export function declaredHas(dims: ReadonlySet<string>, dim: string): boolean {
  if (dims.has(dim)) return true;
  const self = dims.has('self');
  if (dim === 'scope') return self || dims.has('own') || dims.has('relation');
  if (dim === 'object') return self || dims.has('fieldsIn');
  if (dim === 'own') return self;
  return false;
}

/** 蕴含关系（基准侧）：观测到字段编辑权校验即观测到对象写操作权。 */
function observedHas(dims: ReadonlySet<string>, dim: string): boolean {
  return dims.has(dim) || (dim === 'object' && dims.has('fieldsIn'));
}

function compareIdentity(observed: ObservedRoute, key: string, declared: ReturnType<typeof features>) {
  const out: [string, string][] = [];
  const identity = observedIdentity(key, observed);
  if (identity !== declared.identity) {
    // 平台运营身份降成租户成员是削弱；其余身份不一致是登记错
    const code = identity === 'platform' && declared.identity === 'tenant' ? 'WEAKER:identity' : 'MISMATCH:identity';
    out.push([code, `基准 ${identity}，声明 ${declared.identity}`]);
  }
  const member = observed.edge.member;
  if (member.status === 403 && member.code === 'FORBIDDEN' && !declared.privileged && identity === 'tenant') {
    out.push(['WEAKER:privilege', '仅成员身份被 403 FORBIDDEN，声明却不要求成员之外的权限']);
  }
  if (member.status >= 200 && member.status < 300 && declared.privileged && identity === 'tenant') {
    out.push(['OVERDECLARED:privilege', `仅成员身份得到 ${member.status}，声明却要求成员之外的权限`]);
  }
  return out;
}

export function compareRoute(contract: ObservedContract, route: ManifestRoute): Finding[] {
  const key = `${route.method} ${route.path}`;
  const observed = contract.routes[key];
  if (!observed) return [{ route: key, code: 'BASELINE_MISSING', detail: '基准没有这条端点，先重新探测' }];
  const declared = features(route.policy);
  const findings: Finding[] = [];
  const report = (code: string, detail: string) => findings.push({ route: key, code, detail });
  for (const [code, detail] of compareIdentity(observed, key, declared)) report(code, detail);

  // 写路由必有 write；GET 不得有 write
  if (route.method !== 'GET' && !declared.dims.has('write')) report('WEAKER:write', '写路由没有 write');
  if (route.method === 'GET' && declared.dims.has('write')) report('OVERDECLARED:write', 'GET 路由带 write');

  const observedDims = new Set(Object.keys(observed.primitives));
  const names = (dim: string) => observed.primitives[dim]?.join(', ') ?? '';
  for (const dim of [...BOTH_WAYS, ...WEAKER_ONLY]) {
    if (observedDims.has(dim) && !declaredHas(declared.dims, dim)) {
      report(`WEAKER:${dim}`, `现状有 ${names(dim)}，声明没有 ${dim}`);
    }
  }
  for (const dim of BOTH_WAYS) {
    if (declared.dims.has(dim) && !observedHas(observedDims, dim)) {
      report(`OVERDECLARED:${dim}`, `声明有 ${dim}，现状代码里没有对应原语`);
    }
  }

  // 守卫按名字：观测到的必须声明；声明了目录内已知、但现状没有的，过度声明
  const observedGuards = observed.primitives['guard'] ?? [];
  for (const guard of observedGuards) {
    if (!declared.guards.has(guard)) report('WEAKER:guard', `现状有守卫 ${guard}，声明没有`);
  }
  for (const guard of declared.guards) {
    if (KNOWN_GUARDS.has(guard) && !observedGuards.includes(guard)) {
      report('OVERDECLARED:guard', `声明守卫 ${guard}，现状代码里没有`);
    }
  }

  // 前提：现状观测到的名字必须都在声明里（允许多登）
  for (const name of observed.primitives['precondition'] ?? []) {
    if (!declared.preconditions.has(preconditionName(name))) {
      report('WEAKER:precondition', `现状有前提 ${name}，声明没有`);
    }
  }

  // 分支域：每个选择器的键集合必须与某个登记域集合相等
  const domains = Object.entries(contract.domains);
  for (const keys of declared.selectors) {
    if (domains.some(([, values]) => sameSet(keys, [...values].sort()))) continue;
    const superset = domains.find(([, values]) => keys.every((k) => values.includes(k)));
    if (superset) report('WEAKER:domain', `选择器分支 ${keys.join('/')} 少于登记域 ${superset[0]}`);
    else report('MISMATCH:domain', `选择器分支 ${keys.join('/')} 不是任何登记域`);
  }
  return findings;
}

export function compareDeclarations(contract: ObservedContract, routes: readonly ManifestRoute[]): Finding[] {
  return routes.flatMap((route) => compareRoute(contract, route));
}
