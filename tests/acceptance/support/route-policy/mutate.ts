/**
 * 突变套件（F-039 PR-A §4.4「mutation-sensitivity」限定版）：对一条真实声明施加第 5 轮列出的各类削弱，交给比较器，
 * 期望每个突变都被报出。生成条件只看**基准观测到的事实**（如基准观测到按钮才做 button→none）与声明结构，
 * 不引用比较器、不按比较器能否发现来筛选（实现审第 1 轮 P2-1）；组合与绑定类削弱另见 weakenings.ts。
 */
import type { ManifestRoute, RoutePolicy } from '@italent/api';
import type { ObservedContract } from './contract.js';
import { LEDGER_ONLY_FOOTPRINTS, preconditionName } from './features.js';
import { DISJUNCTIONS } from './primitives.js';

export interface Mutation {
  readonly name: string;
  /** 期望比较器报出的码（前缀匹配；`|` 分隔的任一，如被“或”关系原语覆盖的维度报 WEAKER:or）。 */
  readonly expected: string;
}

export interface Mutant {
  readonly name: string;
  readonly expected: string;
  readonly route: ManifestRoute;
}

export const MUTATIONS: readonly Mutation[] = [
  { name: 'button→none', expected: 'WEAKER:button|WEAKER:or' },
  { name: 'scope→none', expected: 'WEAKER:scope|WEAKER:or' },
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

/** 声明树里的全部节点（含 any / all / optional 分支）。 */
function nodesOf(policy: RoutePolicy): RoutePolicy[] {
  const children = [...('of' in policy ? policy.of : []), ...Object.values(policy.optional ?? {})];
  return [policy, ...children.flatMap(nodesOf)];
}

/** 本人绑定（self / own）自带范围：删范围是等价突变，不进套件。 */
const bindsSelf = (policy: RoutePolicy) => nodesOf(policy).some((node) => node.kind === 'self' || node.kind === 'own');

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
  if (bindsSelf(route.policy)) return undefined; // 本人绑定隐含范围，删不掉
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

/** 删 any / all 的一个分支（含嵌套组合）。 */
/** 删 all 的一个分支（any 的分支删掉是收紧，不是削弱；any 的削弱见 weakenings.ts any-branch→member）。 */
function deleteBranches(route: ManifestRoute): ManifestRoute[] {
  const policy = route.policy;
  if (policy.kind !== 'all' || policy.of.length < 2) return [];
  return policy.of.map((_branch, index) => ({
    ...route,
    policy: { ...policy, of: policy.of.filter((_b, i) => i !== index) } as RoutePolicy,
  }));
}

/** 准入节点（不含可选分支）。 */
function admissionNodes(policy: RoutePolicy): RoutePolicy[] {
  return [policy, ...('of' in policy ? policy.of.flatMap(admissionNodes) : [])];
}

/** 对象节点登记的 `编码:操作`（选择器展开）。 */
function objectKeys(nodes: readonly RoutePolicy[]): Set<string> {
  const values = (selector: unknown): string[] => {
    if (typeof selector === 'string') return [selector];
    const s = (selector ?? {}) as { map?: Record<string, unknown>; domain?: readonly string[] };
    return s.map ? Object.values(s.map).filter((v): v is string => typeof v === 'string') : [...(s.domain ?? [])];
  };
  const out = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== 'object') continue;
    for (const code of values(node.object)) for (const op of values(node.operation)) out.add(`${code}:${op}`);
  }
  return out;
}

const hasButton = (nodes: readonly RoutePolicy[]) =>
  nodes.some((node) => 'button' in node && !!node.button && !isNone(node.button));

/**
 * 删可选分支：只在可选分支是基准**披露事实**在声明里的唯一来源时才是削弱——披露的对象 × 操作只由可选分支的
 * 对象节点覆盖，或披露的按钮判定而准入节点都不登记按钮（按声明结构与基准事实判断，不经比较器）。
 */
function deleteOptional(route: ManifestRoute, facts: readonly string[], button: boolean): ManifestRoute | undefined {
  const optional = Object.values(route.policy.optional ?? {});
  if (!optional.length) return undefined;
  const admission = objectKeys(admissionNodes(route.policy));
  const extra = objectKeys(optional.flatMap(nodesOf));
  const covers = (keys: Set<string>, fact: string) => {
    const [codes = '', op = ''] = fact.split(':');
    return codes.split('|').some((code) => keys.has(`${code}:${op}`));
  };
  const soleObject = facts.some((fact) => covers(extra, fact) && !covers(admission, fact));
  const soleButton = button && hasButton(optional.flatMap(nodesOf)) && !hasButton(admissionNodes(route.policy));
  if (!soleObject && !soleButton) return undefined;
  const { optional: _dropped, ...rest } = route.policy;
  return { ...route, policy: rest as RoutePolicy };
}

/** 准入降为普通成员：声明本身已是 member / public / own（不要求成员之外的权限）时不施加。 */
function kindToMember(route: ManifestRoute): ManifestRoute | undefined {
  if (['member', 'public', 'own'].includes(route.policy.kind)) return undefined;
  const mutated: RoutePolicy = {
    kind: 'member',
    reason: '突变',
    fields: { mode: 'none', reason: '突变' },
    ...(route.policy.write ? { write: route.policy.write } : {}),
  };
  return { ...route, policy: mutated };
}

function dropDomainValues(route: ManifestRoute): ManifestRoute[] {
  const out: ManifestRoute[] = [];
  let counter = 0;
  const total = nodesOf(route.policy)
    .map((node) => node as unknown as Mutable)
    .flatMap((node) => ['object', 'operation', 'button', 'relation'].map((key) => node[key]))
    .filter((selector) => !!selector && typeof selector === 'object' && 'from' in (selector as object)).length;
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
  // 基准观测到、且是必备义务的维度：被“或”关系原语吸收、又不在其任何一支里的维度（如执行人路由里 HR 范围的解析）
  // 现状不要求，不施加对应削弱
  const ors = DISJUNCTIONS.filter((d) => observed.primitives['or']?.includes(d.name));
  const has = (dim: string) =>
    Object.hasOwn(observed.primitives, dim) &&
    !ors.some((d) => d.absorbs.includes(dim as never) && !d.branches.some((b) => b.includes(dim as never)));
  const named = (field: 'preconditions' | 'guards') =>
    new Set(
      nodesOf(route.policy).flatMap((node) =>
        field === 'guards' ? (node.guards ?? []) : (node.write?.preconditions ?? []).map(preconditionName),
      ),
    );
  const declaredPreconditions = named('preconditions');
  const declaredGuards = named('guards');
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
    if (declaredPreconditions.has(name)) push('delete-precondition', deleteNamed(route, 'preconditions', name));
  }
  for (const name of observed.primitives['guard'] ?? []) {
    if (declaredGuards.has(name)) push('delete-guard', deleteNamed(route, 'guards', name));
  }
  for (const mutated of deleteBranches(route)) push('delete-branch', mutated);
  // 披露事实（disclosure.ts）：删可选分支后由它承载的披露就没有登记了
  const disclose = observed.primitives['disclose'] ?? [];
  const discloseFacts = disclose.filter((d) => d.startsWith('obj:')).map((d) => d.slice(4));
  push('delete-optional', deleteOptional(route, discloseFacts, disclose.includes('button')));
  push('kind→member', kindToMember(route));
  for (const mutated of dropDomainValues(route)) push('domain-drop-value', mutated);
  if (has('failureAudit')) push('delete-failureAudit', deleteFailureAudit(route));
  return out;
}
