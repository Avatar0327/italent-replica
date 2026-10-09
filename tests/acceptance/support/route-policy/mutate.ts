/**
 * 突变套件（F-039 PR-A §4.4「mutation-sensitivity」限定版）：对一条真实声明施加第 5 轮列出的各类削弱，交给比较器，
 * 期望每个突变都被报出。只生成基准**能观测到**对应事实的突变（如基准观测到按钮才做 button→none），
 * 因为比较器对前提 / 守卫按名字比较、对维度按基准观测比较；基准观测不到的声明内容本来就允许多登。
 */
import type { ManifestRoute, RoutePolicy } from '@italent/api';
import type { ObservedContract, ObservedRoute } from './contract.js';
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

/** 删 any / all 的一个分支：只在该分支独有一个基准也观测到的维度时生成（否则不可能被发现）。 */
function deleteBranches(route: ManifestRoute, observed: ObservedRoute): ManifestRoute[] {
  const out: ManifestRoute[] = [];
  const observedDims = new Set(Object.keys(observed.primitives));
  const visit = (policy: RoutePolicy, replace: (next: RoutePolicy) => RoutePolicy): void => {
    if (policy.kind !== 'any' && policy.kind !== 'all') return;
    if (policy.of.length < 2) return;
    const branchDims = policy.of.map((b) => features(b).dims);
    policy.of.forEach((_branch, index) => {
      const others = new Set(branchDims.flatMap((dims, i) => (i === index ? [] : [...dims])));
      const unique = [...branchDims[index]!].filter((d) => !others.has(d) && observedDims.has(d));
      if (!unique.length) return;
      const next = { ...policy, of: policy.of.filter((_b, i) => i !== index) } as RoutePolicy;
      out.push({ ...route, policy: replace(next) });
    });
  };
  visit(route.policy, (next) => next);
  return out;
}

function deleteOptional(route: ManifestRoute, observed: ObservedRoute): ManifestRoute | undefined {
  const optional = route.policy.optional;
  if (!optional || !Object.keys(optional).length) return undefined;
  const base = features({ ...route.policy, optional: {} } as RoutePolicy).dims;
  const withOptional = features(route.policy).dims;
  const unique = [...withOptional].filter((d) => !base.has(d) && Object.hasOwn(observed.primitives, d));
  if (!unique.length) return undefined;
  const { optional: _dropped, ...rest } = route.policy;
  return { ...route, policy: rest as RoutePolicy };
}

function kindToMember(route: ManifestRoute, observed: ObservedRoute): ManifestRoute | undefined {
  const declared = features(route.policy);
  if (!declared.privileged) return undefined;
  const detectable =
    ['admin', 'object', 'button', 'self', 'relation'].some((d) => Object.hasOwn(observed.primitives, d)) ||
    (observed.edge.member.status === 403 && observed.edge.member.code === 'FORBIDDEN');
  if (!detectable) return undefined;
  const member: RoutePolicy = {
    kind: 'member',
    reason: '突变',
    fields: { mode: 'none', reason: '突变' },
    ...(route.policy.write ? { write: route.policy.write } : {}),
  };
  return { ...route, policy: member };
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
  const push = (name: string, mutated: ManifestRoute | undefined) => {
    const mutation = MUTATIONS.find((m) => m.name === name)!;
    if (mutated) out.push({ name, expected: mutation.expected, route: mutated });
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
