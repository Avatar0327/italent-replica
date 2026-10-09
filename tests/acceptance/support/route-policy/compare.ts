/**
 * 声明 vs 现状必测基准的比较器（F-039 PR-A §4.4「declaration-not-weaker」限定版）。内存比较，不发请求。
 * 两个方向都报：基准观测到而声明没有 → WEAKER:<维度>；声明有而基准没有 → OVERDECLARED:<维度>（PR-B 接管时会凭空
 * 多出一道检查，同样是声明与现状不符）。前提与事务内 / 返回后复核只查"声明不得弱于现状"（命令内前提允许多登，
 * 复核登记名允许是接管阶段的守卫名，§10.3）。
 */
import type { ManifestRoute } from '@italent/api';
import type { ObservedContract, ObservedRoute } from './contract.js';
import { features, type Identity, preconditionName } from './features.js';
import { DECLARED_ONLY_GUARDS, KNOWN_GUARDS } from './primitives.js';

export interface Finding {
  readonly route: string;
  readonly code: string;
  readonly detail: string;
}

/** 两边都能表达、双向比较的维度。 */
const DIMENSIONS = [
  'admin',
  'object',
  'button',
  'scope',
  'fieldsOut',
  'fieldsIn',
  'relation',
  'self',
  'own',
  'failureAudit',
] as const;
/** 只查"声明不得弱于现状"的维度。 */
const WEAKER_ONLY = ['postcheck'] as const;

export function observedIdentity(key: string, route: ObservedRoute): Identity {
  if (route.edge.anonymous.status === 200) return 'public';
  if (key.includes(' /api/platform/')) return 'platform';
  return 'tenant';
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * 蕴含关系（声明侧）：self / own 自带范围（本人即范围）；self 的叠加授权器自带对象权限并放行其按钮白名单，本人数据即 own；
 * 写入口登记了字段编辑权提取（requireObjectWrite）即蕴含对象写操作权。
 */
function declaredHas(dims: ReadonlySet<string>, dim: string): boolean {
  if (dims.has(dim)) return true;
  const self = dims.has('self');
  if (dim === 'scope') return self || dims.has('own');
  if (dim === 'object') return self || dims.has('fieldsIn');
  if (dim === 'own' || dim === 'button') return self;
  return false;
}

/** 蕴含关系（基准侧）：观测到字段编辑权校验即观测到对象写操作权。 */
function observedHas(dims: ReadonlySet<string>, dim: string): boolean {
  return dims.has(dim) || (dim === 'object' && dims.has('fieldsIn'));
}

export function compareRoute(contract: ObservedContract, route: ManifestRoute): Finding[] {
  const key = `${route.method} ${route.path}`;
  const observed = contract.routes[key];
  if (!observed) return [{ route: key, code: 'BASELINE_MISSING', detail: '基准没有这条端点，先重新探测' }];
  const declared = features(route.policy);
  const findings: Finding[] = [];
  const report = (code: string, detail: string) => findings.push({ route: key, code, detail });

  // 身份层（边界探测，精确）
  const identity = observedIdentity(key, observed);
  if (identity !== declared.identity) report('MISMATCH:identity', `基准 ${identity}，声明 ${declared.identity}`);
  const member = observed.edge.member;
  if (member.status === 403 && member.code === 'FORBIDDEN' && !declared.privileged) {
    report('WEAKER:privilege', '仅成员身份被 403 FORBIDDEN，声明却不要求成员之外的权限');
  }
  if (member.status >= 200 && member.status < 300 && declared.privileged) {
    report('OVERDECLARED:privilege', `仅成员身份得到 ${member.status}，声明却要求成员之外的权限`);
  }

  // 写路由必有 write；GET 不得有 write
  if (route.method !== 'GET' && !declared.dims.has('write')) report('WEAKER:write', '写路由没有 write');
  if (route.method === 'GET' && declared.dims.has('write')) report('OVERDECLARED:write', 'GET 路由带 write');

  // 维度双向（含蕴含关系）
  const observedDims = new Set(Object.keys(observed.primitives));
  for (const dim of DIMENSIONS) {
    const names = observed.primitives[dim]?.join(', ') ?? '';
    if (observedDims.has(dim) && !declaredHas(declared.dims, dim)) {
      report(`WEAKER:${dim}`, `现状有 ${names}，声明没有 ${dim}`);
    }
    if (declared.dims.has(dim) && !observedHas(observedDims, dim)) {
      report(`OVERDECLARED:${dim}`, `声明有 ${dim}，现状代码里没有对应原语`);
    }
  }
  for (const dim of WEAKER_ONLY) {
    if (observedDims.has(dim) && !declared.dims.has(dim)) {
      report(`WEAKER:${dim}`, `现状有 ${observed.primitives[dim]?.join(', ')}，声明没有 ${dim}`);
    }
  }

  // 守卫按名字双向；不在目录、也不在有证据的仅声明清单里的名字视为过度声明
  const observedGuards = observed.primitives['guard'] ?? [];
  for (const guard of observedGuards) {
    if (!declared.guards.has(guard)) report('WEAKER:guard', `现状有守卫 ${guard}，声明没有`);
  }
  for (const guard of declared.guards) {
    if (observedGuards.includes(guard) || DECLARED_ONLY_GUARDS.has(guard)) continue;
    const why = KNOWN_GUARDS.has(guard) ? '现状代码里没有' : '不在原语目录，也不在有证据的仅声明守卫清单里';
    report('OVERDECLARED:guard', `声明守卫 ${guard}，${why}`);
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
