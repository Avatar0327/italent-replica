/**
 * 声明 vs 现状必测基准的比较器（F-039 PR-A §4.4「declaration-not-weaker」限定版）。内存比较，不发请求。
 * 第一道：与必需项显式表硬比对（required.ts，DEC-348②）；准入 / 披露 / 守卫内部 / 条件准入只由表决定。
 * 第二道（本文件）：基准事实先经表分流（admissionPrimitives），只由非准入义务承接的事实不进来；
 * 声明先展开成析取范式（features.ts），**每个备选准入路径**都要满足基准观测到的义务（实现审第 1 轮 P2-1）：
 * - 必备维度：基准观测到、且不由“或”关系原语吸收的维度，每个备选都要有（WEAKER:<维度>）；
 * - “或”关系（primitives.ts DISJUNCTIONS，如流程查看 = 管理员 或 对象查看、IDP 查看人 = HR 或 参与人）：
 *   每个备选至少满足其中一支（WEAKER:or）；
 * - 守卫 / 命令内前提按名字，每个备选都要有；
 * - 动态选择器的分支键必须等于**本路由**处理函数绑定的某个域（基准 domain 维度），不能借用别的模块的同形域；
 *   `map` 型选择器再核对输入来源与逐键值（PR-B2，设计 B-07：端点 + 位置 + 输入来源 + 域 + 映射值）。
 * 过度声明（OVERDECLARED:<维度>）只在静态探测能可靠否定的维度上报：身份、成员之外的特权、写入口、管理员能力、
 * 本人绑定、目录内已知守卫名。对象 / 范围 / 字段 / 关系 / 按钮的“声明多于现状”需要多维身份探测，按 DEC-303 留给 PR-B。
 */
import type { ManifestRoute } from '@italent/api';
import type { ObservedContract, ObservedRoute } from './contract.js';
import { BRANCH_BINDINGS, type BranchBindings } from './domains.js';
import { type Alternative, declared, type Declared, type Identity, preconditionName } from './features.js';
import { DISJUNCTIONS, KNOWN_GUARDS, type Obligation } from './primitives.js';
import { admissionPrimitives, checkRequired } from './required.js';
import { REQUIRED } from './required/index.js';
import type { RequiredTable } from './required/types.js';
import { mapSelectors } from './selectors.js';

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
 * relation 由关系定位自带范围。写入字段（fieldsIn）不再蕴含对象操作：对象操作必须由准入里的对象节点登记，
 * 否则把对象操作单独挪进 optional 会被写字段顶替（实现审第 3 轮 leaf→optional）。
 * 点范围只能由点校验（point / guard 范围）或本人 / 关系定位满足。
 */
export function declaredHas(dims: ReadonlySet<string>, dim: string): boolean {
  if (dims.has(dim)) return true;
  const self = dims.has('self');
  if (dim === 'scope' || dim === 'scopePoint') return self || dims.has('own') || dims.has('relation');
  if (dim === 'object') return self;
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

/** 对象 × 数据操作是否有对象节点覆盖（编码 * = 任一对象）。 */
function coversObject(objects: ReadonlySet<string>, code: string, op: string): boolean {
  // 操作可以是收窄后的取值集合（`create|update`：处理函数把变量收窄到这几个值），覆盖其一即可
  return op
    .split('|')
    .some((one) =>
      code === '*' ? [...objects].some((entry) => entry.endsWith(`:${one}`)) : objects.has(`${code}:${one}`),
    );
}

/** 维度或对象义务（`obj:编码:操作`）是否由给定的维度 / 对象集合满足。 */
function satisfies(dims: ReadonlySet<string>, objects: ReadonlySet<string>, need: Obligation): boolean {
  if (!need.startsWith('obj:')) return declaredHas(dims, need);
  const [, code = '', op = ''] = need.split(':');
  return coversObject(objects, code, op);
}

function compareAlternative(
  observed: ObservedRoute,
  alt: Alternative,
  label: string,
  report: (code: string, detail: string) => void,
): void {
  const dims = alt.dims;
  const ors = DISJUNCTIONS.filter((d) => observed.primitives['or']?.includes(d.name));
  const absorbed = new Set<string>(ors.flatMap((d) => d.absorbs));
  const names = (dim: string) => observed.primitives[dim]?.join(', ') ?? '';
  for (const dim of [...BOTH_WAYS, ...WEAKER_ONLY]) {
    if (!Object.hasOwn(observed.primitives, dim) || absorbed.has(dim)) continue;
    if (!declaredHas(dims, dim)) report(`WEAKER:${dim}`, `${label}缺 ${dim}（现状有 ${names(dim)}）`);
  }
  for (const or of ors) {
    if (or.branches.some((branch) => branch.every((need) => satisfies(dims, alt.objects, need)))) continue;
    const want = or.branches.map((branch) => branch.join('+')).join(' 或 ');
    report('WEAKER:or', `${label}不满足 ${or.name}（现状要求 ${want}）`);
  }
  // 对象 × 数据操作：每条准入事实（编码集合:操作）都要有准入备选里的对象节点覆盖
  for (const fact of observed.primitives['objectOp'] ?? []) {
    if (absorbed.has(`obj:${fact}`)) continue;
    const [codes = '', op = ''] = fact.split(':');
    if (!codes.split('|').some((code) => coversObject(alt.objects, code, op))) {
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

/** 值的规范化比较（键排序），映射值可以是字符串或 `{ code, level }` 这样的按钮引用。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * `map` 型选择器的五元组（设计 B-07）：端点（登记按端点）+ 位置（节点路径 + 字段）+ 输入来源（from / path）+ 域 +
 * 映射值。键集合等于域只是第一层（compareSelectors），这里补输入来源与逐键值；两张表（branch-inputs.ts /
 * domains.ts BRANCH_VALUES）都是审定过的字面量，不来自声明。
 */
function compareBranchBindings(
  key: string,
  route: ManifestRoute,
  bound: readonly (readonly [string, string[]])[],
  bindings: BranchBindings,
  report: (code: string, detail: string) => void,
): void {
  const sites = mapSelectors(route.policy);
  const registered = bindings.inputs[key] ?? [];
  for (const site of sites) {
    const entry = registered.find((e) => e.position === site.position);
    const where = `${site.position}（${site.from}.${site.path}）`;
    if (!entry) {
      report('BRANCH_INPUT_UNBOUND', `选择器 ${where} 没有输入来源登记`);
      continue;
    }
    if (entry.from !== site.from || entry.path !== site.path) {
      report(
        'MISMATCH:branchInput',
        `选择器 ${site.position} 声明取 ${site.from}.${site.path}，登记 ${entry.from}.${entry.path}`,
      );
    }
    const domains = bound.filter(([, values]) => sameSet(site.keys, values)).map(([name]) => name);
    if (!domains.includes(entry.domain)) {
      report(
        'MISMATCH:branchInput',
        `选择器 ${site.position} 登记的域 ${entry.domain} 不是它的分支键对应的本路由绑定域（${domains.join(', ') || '无'}）`,
      );
    }
    const values = (bindings.values[entry.domain] ?? []).filter(
      (v) => v.field === site.field && v.variant === entry.variant,
    );
    if (values.length > 1) {
      report(
        'TABLE_CONFLICT',
        `域 ${entry.domain} 的 ${site.field}${entry.variant ? `#${entry.variant}` : ''} 登记了 ${values.length} 条`,
      );
    }
    if (!values.length) {
      report(
        'BRANCH_VALUE_UNBOUND',
        `域 ${entry.domain} 的 ${site.field}${entry.variant ? `#${entry.variant}` : ''} 没有分支值登记`,
      );
    } else if (!values.some((v) => canonical(v.values) === canonical(site.map))) {
      report('MISMATCH:branchValue', `选择器 ${where} 的映射值与域 ${entry.domain} 的登记不一致`);
    }
  }
  for (const entry of registered) {
    if (!sites.some((site) => site.position === entry.position)) {
      report('MISMATCH:branchInput', `登记了选择器位置 ${entry.position}，声明里该位置没有 map 选择器`);
    }
  }
}

/** 选择器分支键必须等于本路由绑定的某个域；map 选择器再核对输入来源与逐键值。 */
function compareSelectors(
  contract: ObservedContract,
  observed: ObservedRoute,
  decl: Declared,
  where: { readonly key: string; readonly route: ManifestRoute; readonly bindings: BranchBindings },
  report: (code: string, detail: string) => void,
): void {
  const bound = (observed.primitives['domain'] ?? []).map(
    (key) => [key, [...(contract.domains[key] ?? [])].sort()] as const,
  );
  compareBranchBindings(where.key, where.route, bound, where.bindings, report);
  for (const keys of decl.selectors) {
    if (bound.some(([, values]) => sameSet(keys, values))) continue;
    const superset = bound.find(([, values]) => keys.every((k) => values.includes(k)));
    if (superset) report('WEAKER:domain', `选择器分支 ${keys.join('/')} 少于本路由绑定的域 ${superset[0]}`);
    else {
      const names = bound.map(([key]) => key).join(', ') || '（无）';
      report('MISMATCH:domain', `选择器分支 ${keys.join('/')} 不是本路由绑定的域（${names}）`);
    }
  }
}

export function compareRoute(
  contract: ObservedContract,
  route: ManifestRoute,
  table: RequiredTable = REQUIRED,
  bindings: BranchBindings = BRANCH_BINDINGS,
): Finding[] {
  const key = `${route.method} ${route.path}`;
  const raw = contract.routes[key];
  if (!raw) return [{ route: key, code: 'BASELINE_MISSING', detail: '基准没有这条端点，先重新探测' }];
  // 第一道：与必需项显式表硬比对；第二道的输入只留准入义务承接（或无人承接的元数据）的事实
  const findings: Finding[] = checkRequired(table, contract, [route]);
  const observed: ObservedRoute = { ...raw, primitives: admissionPrimitives(raw, table[key] ?? []) };
  const decl = declared(route.policy);
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
    compareAlternative(observed, alt, many ? `备选 ${i + 1}/${decl.alternatives.length}：` : '', report);
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
  compareSelectors(contract, observed, decl, { key, route, bindings }, report);
  return findings;
}

export function compareDeclarations(
  contract: ObservedContract,
  routes: readonly ManifestRoute[],
  table: RequiredTable = REQUIRED,
  bindings: BranchBindings = BRANCH_BINDINGS,
): Finding[] {
  return routes.flatMap((route) => compareRoute(contract, route, table, bindings));
}
