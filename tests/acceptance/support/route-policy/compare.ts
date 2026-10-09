/**
 * 声明 vs 现状必测基准的比较器（F-039 PR-A §4.4「declaration-not-weaker」限定版）。内存比较，不发请求。
 * 声明先展开成析取范式（features.ts），**每个备选准入路径**都要满足基准观测到的义务（实现审第 1 轮 P2-1）：
 * - 必备维度：基准观测到、且不由“或”关系原语吸收的维度，每个备选都要有（WEAKER:<维度>）；
 * - “或”关系（primitives.ts DISJUNCTIONS，如流程查看 = 管理员 或 对象查看、IDP 查看人 = HR 或 参与人）：
 *   每个备选至少满足其中一支（WEAKER:or）；
 * - 守卫 / 命令内前提按名字，每个备选都要有；
 * - 动态选择器的分支键必须等于**本路由**处理函数绑定的某个域（基准 domain 维度），不能借用别的模块的同形域。
 * 过度声明（OVERDECLARED:<维度>）只在静态探测能可靠否定的维度上报：身份、成员之外的特权、写入口、管理员能力、
 * 本人绑定、目录内已知守卫名。对象 / 范围 / 字段 / 关系 / 按钮的“声明多于现状”需要多维身份探测，按 DEC-303 留给 PR-B。
 */
import type { ManifestRoute } from '@italent/api';
import type { ObservedContract, ObservedRoute } from './contract.js';
import { type Alternative, declared, type Declared, type Identity, preconditionName } from './features.js';
import { DISJUNCTIONS, GUARD_FACTS, KNOWN_GUARDS, type Obligation } from './primitives.js';

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
  'scopePoint',
  'fieldsOut',
  'fieldsIn',
  'relation',
  'own',
  'failureAudit',
  'postcheck',
] as const;
/**
 * 可选分支（不参与准入）只决定响应里按权限附加的披露（canEdit / canApply、接收行、组织字段…），处理函数为此做的
 * 对象 / 按钮 / 范围判定与出口裁剪会被静态探测观测到，可由可选分支满足；准入专属的义务（管理员、本人、关系、
 * 本人数据、点校验、写入字段、复核）不行。
 */
const OPTIONAL_SATISFIES: ReadonlySet<string> = new Set(['fieldsOut', 'button', 'object', 'scope']);

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
 * 点范围只能由点校验（point / guard 范围）或本人 / 关系定位满足。
 */
export function declaredHas(dims: ReadonlySet<string>, dim: string): boolean {
  if (dims.has(dim)) return true;
  const self = dims.has('self');
  if (dim === 'scope' || dim === 'scopePoint') return self || dims.has('own') || dims.has('relation');
  if (dim === 'object') return self || dims.has('fieldsIn');
  if (dim === 'own') return self;
  return false;
}

/** 蕴含关系（基准侧）：观测到字段编辑权校验即观测到对象写操作权。 */
function observedHas(dims: ReadonlySet<string>, dim: string): boolean {
  return dims.has(dim) || (dim === 'object' && dims.has('fieldsIn'));
}

function compareIdentity(observed: ObservedRoute, key: string, decl: Declared): [string, string][] {
  const out: [string, string][] = [];
  const identity = observedIdentity(key, observed);
  if (identity !== decl.identity) {
    // 平台运营身份降成租户成员是削弱；其余身份不一致是登记错
    const code = identity === 'platform' && decl.identity === 'tenant' ? 'WEAKER:identity' : 'MISMATCH:identity';
    out.push([code, `基准 ${identity}，声明 ${decl.identity}`]);
  }
  if (identity !== 'tenant') return out;
  const member = observed.edge.member;
  const open = decl.alternatives.filter((alt) => !alt.privileged).length;
  if (member.status === 403 && member.code === 'FORBIDDEN' && open > 0) {
    out.push(['WEAKER:privilege', `仅成员身份被 403 FORBIDDEN，声明却有 ${open} 个备选不要求成员之外的权限`]);
  }
  if (member.status >= 200 && member.status < 300 && open === 0) {
    out.push(['OVERDECLARED:privilege', `仅成员身份得到 ${member.status}，声明却要求成员之外的权限`]);
  }
  return out;
}

/** 一个备选（并上可选分支里能满足出口类维度的部分）的维度集合。 */
function altDims(alt: Alternative, optional: Alternative): Set<string> {
  const dims = new Set(alt.dims);
  for (const dim of optional.dims) if (OPTIONAL_SATISFIES.has(dim)) dims.add(dim);
  return dims;
}

/** 对象 × 数据操作是否有对象节点覆盖（编码 * = 任一对象；可选分支的披露判定也算）。 */
function coversObject(alt: Alternative, optional: Alternative, code: string, op: string): boolean {
  const has = (set: ReadonlySet<string>) =>
    code === '*' ? [...set].some((entry) => entry.endsWith(`:${op}`)) : set.has(`${code}:${op}`);
  return has(alt.objects) || has(optional.objects);
}

function satisfies(dims: ReadonlySet<string>, alt: Alternative, optional: Alternative, need: Obligation): boolean {
  if (!need.startsWith('obj:')) return declaredHas(dims, need);
  const [, code = '', op = ''] = need.split(':');
  return coversObject(alt, optional, code, op);
}

function compareAlternative(
  observed: ObservedRoute,
  alt: Alternative,
  optional: Alternative,
  label: string,
  report: (code: string, detail: string) => void,
): void {
  const dims = altDims(alt, optional);
  const ors = DISJUNCTIONS.filter((d) => observed.primitives['or']?.includes(d.name));
  const absorbed = new Set<string>(ors.flatMap((d) => d.absorbs));
  for (const guard of observed.primitives['guard'] ?? []) {
    for (const fact of GUARD_FACTS[guard] ?? []) absorbed.add(`obj:${fact}`);
  }
  const names = (dim: string) => observed.primitives[dim]?.join(', ') ?? '';
  for (const dim of [...BOTH_WAYS, ...WEAKER_ONLY]) {
    if (!Object.hasOwn(observed.primitives, dim) || absorbed.has(dim)) continue;
    if (!declaredHas(dims, dim)) report(`WEAKER:${dim}`, `${label}缺 ${dim}（现状有 ${names(dim)}）`);
  }
  for (const or of ors) {
    if (or.branches.some((branch) => branch.every((need) => satisfies(dims, alt, optional, need)))) continue;
    const want = or.branches.map((branch) => branch.join('+')).join(' 或 ');
    report('WEAKER:or', `${label}不满足 ${or.name}（现状要求 ${want}）`);
  }
  // 对象 × 数据操作：每条事实（编码集合:操作）都要有对象节点覆盖（可选分支的披露判定也算）
  for (const fact of observed.primitives['objectOp'] ?? []) {
    if (absorbed.has(`obj:${fact}`)) continue;
    const [codes = '', op = ''] = fact.split(':');
    if (!codes.split('|').some((code) => coversObject(alt, optional, code, op))) {
      report('WEAKER:object', `${label}缺对象操作 ${fact}`);
    }
  }
  for (const guard of observed.primitives['guard'] ?? []) {
    if (!alt.guards.has(guard)) report('WEAKER:guard', `${label}缺守卫 ${guard}`);
  }
  for (const name of observed.primitives['precondition'] ?? []) {
    if (!alt.preconditions.has(preconditionName(name))) report('WEAKER:precondition', `${label}缺前提 ${name}`);
  }
}

/** 选择器分支键必须等于本路由绑定的某个域。 */
function compareSelectors(
  contract: ObservedContract,
  observed: ObservedRoute,
  decl: Declared,
  report: (code: string, detail: string) => void,
): void {
  const bound = (observed.primitives['domain'] ?? []).map((key) => [key, [...(contract.domains[key] ?? [])].sort()]);
  for (const keys of decl.selectors) {
    if (bound.some(([, values]) => sameSet(keys, values as string[]))) continue;
    const superset = bound.find(([, values]) => keys.every((k) => (values as string[]).includes(k)));
    if (superset) report('WEAKER:domain', `选择器分支 ${keys.join('/')} 少于本路由绑定的域 ${superset[0]}`);
    else {
      const names = bound.map(([key]) => key).join(', ') || '（无）';
      report('MISMATCH:domain', `选择器分支 ${keys.join('/')} 不是本路由绑定的域（${names}）`);
    }
  }
}

export function compareRoute(contract: ObservedContract, route: ManifestRoute): Finding[] {
  const key = `${route.method} ${route.path}`;
  const observed = contract.routes[key];
  if (!observed) return [{ route: key, code: 'BASELINE_MISSING', detail: '基准没有这条端点，先重新探测' }];
  const decl = declared(route.policy);
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const report = (code: string, detail: string) => {
    if (seen.has(`${code}|${detail}`)) return;
    seen.add(`${code}|${detail}`);
    findings.push({ route: key, code, detail });
  };
  for (const [code, detail] of compareIdentity(observed, key, decl)) report(code, detail);

  // 写路由必有 write；GET 不得有 write
  if (route.method !== 'GET' && !decl.union.dims.has('write')) report('WEAKER:write', '写路由没有 write');
  if (route.method === 'GET' && decl.union.dims.has('write')) report('OVERDECLARED:write', 'GET 路由带 write');

  const many = decl.alternatives.length > 1;
  decl.alternatives.forEach((alt, i) => {
    compareAlternative(observed, alt, decl.optional, many ? `备选 ${i + 1}/${decl.alternatives.length}：` : '', report);
  });

  // “或”关系原语的各支维度也算观测到（流程查看的管理员分支）
  const ors = DISJUNCTIONS.filter((d) => observed.primitives['or']?.includes(d.name));
  const orDims = ors.flatMap((d) => d.branches.flat()).filter((need) => !need.startsWith('obj:'));
  const observedDims = new Set([...Object.keys(observed.primitives), ...orDims]);
  for (const dim of BOTH_WAYS) {
    if (decl.union.dims.has(dim) && !observedHas(observedDims, dim)) {
      report(`OVERDECLARED:${dim}`, `声明有 ${dim}，现状代码里没有对应原语`);
    }
  }
  const observedGuards = observed.primitives['guard'] ?? [];
  for (const guard of decl.union.guards) {
    if (KNOWN_GUARDS.has(guard) && !observedGuards.includes(guard)) {
      report('OVERDECLARED:guard', `声明守卫 ${guard}，现状代码里没有`);
    }
  }
  compareSelectors(contract, observed, decl, report);
  return findings;
}

export function compareDeclarations(contract: ObservedContract, routes: readonly ManifestRoute[]): Finding[] {
  return routes.flatMap((route) => compareRoute(contract, route));
}
