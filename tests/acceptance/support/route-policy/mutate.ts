/**
 * 突变套件（F-039 PR-A §4.4「mutation-sensitivity」限定版）：对一条真实声明施加第 5 轮列出的各类削弱，交给比较器，
 * 期望每个突变都被报出。只生成基准**能观测到**对应事实的突变（如基准观测到按钮才做 button→none），
 * 因为比较器对前提 / 守卫按名字比较、对维度按基准观测比较；基准观测不到的声明内容本来就允许多登。
 */
import type { ManifestRoute, RoutePolicy } from '@italent/api';
import type { ObservedContract, ObservedRoute } from './contract.js';
import { declaredHas } from './compare.js';
import { features, LEDGER_ONLY_FOOTPRINTS, preconditionName } from './features.js';

export interface Mutation {
  readonly name: string;
  /** 期望比较器报出的码（前缀匹配）。 */
  readonly expected: string;
}

export interface Mutant {
  readonly name: string;
  readonly expected: string;
  readonly route: ManifestRoute;
}

export const MUTATIONS: readonly Mutation[] = [
  { name: 'button→none', expected: 'WEAKER:button' },
  { name: 'scope→none', expected: 'WEAKER:scope' },
  { name: 'fields→none', expected: 'WEAKER:fieldsOut' },
  { name: 'write.fields→none', expected: 'WEAKER:fieldsIn' },
  { name: 'delete-write', expected: 'WEAKER:write' },
  { name: 'postcheck→none', expected: 'WEAKER:postcheck' },
  { name: 'delete-precondition', expected: 'WEAKER:precondition' },
  { name: 'delete-guard', expected: 'WEAKER:guard' },
  { name: 'delete-branch', expected: 'WEAKER:' },
  { name: 'delete-optional', expected: 'WEAKER:' },
  { name: 'kind→member', expected: 'WEAKER:' },
  { name: 'domain-drop-value', expected: 'WEAKER:domain' },
  { name: 'delete-failureAudit', expected: 'WEAKER:failureAudit' },
];

type Mutable = Record<string, unknown>;
const NONE = { none: true as const, reason: '突变' };

/** 深拷贝后对声明树的每个节点（含 any / all / optional 分支）应用 visit；visit 返回替换后的节点。 */
function transform(policy: RoutePolicy, visit: (node: Mutable) => Mutable | null): RoutePolicy | null {
  const node = structuredClone(policy) as unknown as Mutable;
  if (Array.isArray(node['of'])) {
    const branches = (node['of'] as RoutePolicy[]).map((b) => transform(b, visit)).filter((b) => b !== null);
    node['of'] = branches;
  }
  if (node['optional'] && typeof node['optional'] === 'object') {
    const optional: Mutable = {};
    for (const [name, branch] of Object.entries(node['optional'] as Record<string, RoutePolicy>)) {
      const next = transform(branch, visit);
      if (next) optional[name] = next;
    }
    node['optional'] = optional;
  }
  return visit(node) as RoutePolicy | null;
}

function withPolicy(route: ManifestRoute, policy: RoutePolicy | null): ManifestRoute | undefined {
  return policy ? { ...route, policy } : undefined;
}

const isNone = (value: unknown): boolean => !!value && typeof value === 'object' && 'none' in (value as object);

function buttonsToNone(route: ManifestRoute): ManifestRoute | undefined {
  let changed = false;
  const policy = transform(route.policy, (node) => {
    if (node['kind'] === 'object' || node['kind'] === 'self') {
      if (node['button'] && !isNone(node['button'])) {
        node['button'] = NONE;
        changed = true;
      }
      if (node['operation'] === 'button') {
        node['operation'] = 'view'; // "只校验按钮"的路由：去掉按钮校验就退化成普通查看
        changed = true;
      }
      const rows = node['rows'] as Mutable | undefined;
      if (rows?.['button'] && !isNone(rows['button'])) {
        rows['button'] = NONE;
        changed = true;
      }
    }
    return node;
  });
  return changed ? withPolicy(route, policy) : undefined;
}

function scopesToNone(route: ManifestRoute): ManifestRoute | undefined {
  let changed = false;
  const declared = features(route.policy);
  if (declared.dims.has('self') || declared.dims.has('own')) return undefined; // 本人绑定隐含范围，删不掉
  const policy = transform(route.policy, (node) => {
    const scope = node['scope'] as Mutable | undefined;
    if (!scope) return node;
    const active = 'byObject' in scope ? true : scope['mode'] !== 'none';
    if (active) {
      node['scope'] = { mode: 'none', reason: '突变' };
      changed = true;
    }
    return node;
  });
  return changed ? withPolicy(route, policy) : undefined;
}

function fieldsToNone(route: ManifestRoute): ManifestRoute | undefined {
  let changed = false;
  const policy = transform(route.policy, (node) => {
    const fields = node['fields'] as Mutable | undefined;
    if (fields && fields['mode'] !== 'none') {
      node['fields'] = { mode: 'none', reason: '突变' };
      changed = true;
    }
    return node;
  });
  return changed ? withPolicy(route, policy) : undefined;
}

function writeFieldsToNone(route: ManifestRoute): ManifestRoute | undefined {
  let changed = false;
  const policy = transform(route.policy, (node) => {
    const write = node['write'] as Mutable | undefined;
    if (write && !isNone(write['fields'])) {
      write['fields'] = NONE;
      changed = true;
    }
    const rows = node['rows'] as Mutable | undefined;
    if (rows && !isNone(rows['fields'])) {
      rows['fields'] = NONE;
      changed = true;
    }
    return node;
  });
  return changed ? withPolicy(route, policy) : undefined;
}

function deleteWrite(route: ManifestRoute): ManifestRoute | undefined {
  if (route.method === 'GET') return undefined;
  let changed = false;
  const policy = transform(route.policy, (node) => {
    if (node['write']) {
      delete node['write'];
      changed = true;
    }
    return node;
  });
  return changed ? withPolicy(route, policy) : undefined;
}

function postcheckToNone(route: ManifestRoute): ManifestRoute | undefined {
  let changed = false;
  const policy = transform(route.policy, (node) => {
    const write = node['write'] as Mutable | undefined;
    if (!write) return node;
    if (typeof write['footprint'] === 'string' && !LEDGER_ONLY_FOOTPRINTS.test(write['footprint'])) {
      write['footprint'] = NONE;
      changed = true;
    }
    if (typeof write['result'] === 'string' || (write['result'] && 'generic' in (write['result'] as object))) {
      write['result'] = NONE;
      changed = true;
    }
    return node;
  });
  return changed ? withPolicy(route, policy) : undefined;
}

function deleteNamed(route: ManifestRoute, field: 'preconditions' | 'guards', name: string): ManifestRoute | undefined {
  let changed = false;
  const policy = transform(route.policy, (node) => {
    const holder = field === 'preconditions' ? (node['write'] as Mutable | undefined) : node;
    const list = holder?.[field] as string[] | undefined;
    if (!list) return node;
    const matches = (item: string) => (field === 'preconditions' ? preconditionName(item) === name : item === name);
    if (list.some(matches)) {
      holder![field] = list.filter((item) => !matches(item));
      changed = true;
    }
    return node;
  });
  return changed ? withPolicy(route, policy) : undefined;
}

/**
 * 突变是否“原则上可被发现”：突变后的声明丢掉了某个基准观测到、原声明满足的维度 / 守卫 / 前提，或丢掉了
 * 仅成员 403 所要求的特权。只有这样的突变才进套件（基准观测不到的内容本来允许多登）。
 */
function detectable(original: RoutePolicy, mutated: RoutePolicy, observed: ObservedRoute): boolean {
  const before = features(original);
  const after = features(mutated);
  for (const dim of Object.keys(observed.primitives)) {
    if (declaredHas(before.dims, dim) && !declaredHas(after.dims, dim)) return true;
  }
  for (const guard of observed.primitives['guard'] ?? []) {
    if (before.guards.has(guard) && !after.guards.has(guard)) return true;
  }
  for (const name of observed.primitives['precondition'] ?? []) {
    if (before.preconditions.has(name) && !after.preconditions.has(name)) return true;
  }
  const member = observed.edge.member;
  return member.status === 403 && member.code === 'FORBIDDEN' && before.privileged && !after.privileged;
}

/** 删 any / all 的一个分支（含嵌套组合）。 */
function deleteBranches(route: ManifestRoute, observed: ObservedRoute): ManifestRoute[] {
  const out: ManifestRoute[] = [];
  const policy = route.policy;
  if ((policy.kind !== 'any' && policy.kind !== 'all') || policy.of.length < 2) return out;
  policy.of.forEach((_branch, index) => {
    const mutated = { ...policy, of: policy.of.filter((_b, i) => i !== index) } as RoutePolicy;
    if (detectable(policy, mutated, observed)) out.push({ ...route, policy: mutated });
  });
  return out;
}

function deleteOptional(route: ManifestRoute, observed: ObservedRoute): ManifestRoute | undefined {
  if (!route.policy.optional || !Object.keys(route.policy.optional).length) return undefined;
  const { optional: _dropped, ...rest } = route.policy;
  const mutated = rest as RoutePolicy;
  return detectable(route.policy, mutated, observed) ? { ...route, policy: mutated } : undefined;
}

function kindToMember(route: ManifestRoute, observed: ObservedRoute): ManifestRoute | undefined {
  if (!features(route.policy).privileged) return undefined;
  const mutated: RoutePolicy = {
    kind: 'member',
    reason: '突变',
    fields: { mode: 'none', reason: '突变' },
    ...(route.policy.write ? { write: route.policy.write } : {}),
  };
  return detectable(route.policy, mutated, observed) ? { ...route, policy: mutated } : undefined;
}

function dropDomainValues(route: ManifestRoute): ManifestRoute[] {
  const out: ManifestRoute[] = [];
  let counter = 0;
  const total = features(route.policy).selectors.length;
  for (let target = 0; target < total; target++) {
    counter = 0;
    const policy = transform(route.policy, (node) => {
      for (const key of ['object', 'operation', 'button', 'relation']) {
        const selector = node[key] as Mutable | undefined;
        if (!selector || typeof selector !== 'object' || !('from' in selector)) continue;
        if (counter++ !== target) continue;
        if (selector['map']) {
          const map = { ...(selector['map'] as Record<string, unknown>) };
          const [first] = Object.keys(map);
          if (first !== undefined && Object.keys(map).length > 1) {
            delete map[first];
            selector['map'] = map;
          }
        } else if (Array.isArray(selector['domain']) && selector['domain'].length > 1) {
          selector['domain'] = (selector['domain'] as string[]).slice(1);
        }
      }
      return node;
    });
    if (policy && JSON.stringify(policy) !== JSON.stringify(route.policy)) out.push({ ...route, policy });
  }
  return out;
}

function deleteFailureAudit(route: ManifestRoute): ManifestRoute | undefined {
  let changed = false;
  const policy = transform(route.policy, (node) => {
    if (node['failureAudit']) {
      delete node['failureAudit'];
      changed = true;
    }
    return node;
  });
  return changed ? withPolicy(route, policy) : undefined;
}

export function mutantsOf(route: ManifestRoute, contract: ObservedContract): Mutant[] {
  const observed = contract.routes[`${route.method} ${route.path}`];
  if (!observed) return [];
  const has = (dim: string) => Object.hasOwn(observed.primitives, dim);
  const declared = features(route.policy);
  const out: Mutant[] = [];
  // 等价突变（按蕴含关系没有丢掉任何基准观测到的义务，如关系定位自带范围）不进套件
  // 删 write 与删分支域值不靠维度判定（写路由必有 write、选择器域按集合相等），不过滤
  const push = (name: string, mutated: ManifestRoute | undefined) => {
    const mutation = MUTATIONS.find((m) => m.name === name)!;
    const structural = name === 'delete-write' || name === 'domain-drop-value';
    if (mutated && (structural || detectable(route.policy, mutated.policy, observed))) {
      out.push({ name, expected: mutation.expected, route: mutated });
    }
  };
  if (has('button')) push('button→none', buttonsToNone(route));
  if (has('scope')) push('scope→none', scopesToNone(route));
  if (has('fieldsOut')) push('fields→none', fieldsToNone(route));
  if (has('fieldsIn')) push('write.fields→none', writeFieldsToNone(route));
  push('delete-write', deleteWrite(route));
  if (has('postcheck')) push('postcheck→none', postcheckToNone(route));
  for (const name of observed.primitives['precondition'] ?? []) {
    if (declared.preconditions.has(name)) push('delete-precondition', deleteNamed(route, 'preconditions', name));
  }
  for (const name of observed.primitives['guard'] ?? []) {
    if (declared.guards.has(name)) push('delete-guard', deleteNamed(route, 'guards', name));
  }
  for (const mutated of deleteBranches(route, observed)) push('delete-branch', mutated);
  push('delete-optional', deleteOptional(route, observed));
  push('kind→member', kindToMember(route, observed));
  for (const mutated of dropDomainValues(route)) push('domain-drop-value', mutated);
  if (has('failureAudit')) push('delete-failureAudit', deleteFailureAudit(route));
  return out;
}
