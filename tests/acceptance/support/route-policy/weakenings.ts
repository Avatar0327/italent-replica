/**
 * 必须施加的弱化反例（F-039 PR-A 实现审第 1 轮 P2-1）：按声明树的**结构**生成，不经比较器、不读 features，
 * 生成的每一个都必须被比较器报出（WEAKER:* / MISMATCH:*）。与 mutate.ts 的突变套件互补：突变套件按基准观测到
 * 的维度逐类削弱；这里覆盖组合与绑定类削弱——删 all 的分支、all → any、any 的分支降为普通成员、
 * 关系降为普通成员、动态选择器换成别的域、必需准入分支移进 optional（实现审第 2 轮 P2-1 残项：可选分支只决定
 * 附加披露，不能顶替必需授权）、单个叶子准入（按钮 / 对象数据操作）移进 optional（实现审第 3 轮）。
 */
import type { ManifestRoute, RoutePolicy } from '@italent/api';
import type { ObservedContract } from './contract.js';
import { declaredPerms, objectsOf, type PermMap, scopeMatches } from './perms.js';
import { locate } from './required-mutate.js';
import type { Obligation, RequiredTable } from './required/types.js';
import { mapSelectors, type SelectorSite } from './selectors.js';

export type WeakeningKind =
  | 'all-drop-branch'
  | 'all→any'
  | 'any-branch→member'
  | 'relation→member'
  | 'selector→domain'
  | 'required→optional'
  | 'leaf→optional'
  | 'selector→value'
  | 'selector→path'
  | 'selector→from';

export interface Weakening {
  readonly kind: WeakeningKind;
  /** 节点在声明树里的位置（如 `of[1].optional.view`），便于定位。 */
  readonly at: string;
  readonly route: ManifestRoute;
}

export const WEAKENING_KINDS: readonly WeakeningKind[] = [
  'all-drop-branch',
  'all→any',
  'any-branch→member',
  'relation→member',
  'selector→domain',
  'required→optional',
  'leaf→optional',
  'selector→value',
  'selector→path',
  'selector→from',
];

type Node = Record<string, unknown>;
const SELECTOR_KEYS = ['object', 'operation', 'button', 'relation'] as const;

function member(node: Node): Node {
  return {
    kind: 'member',
    reason: '弱化反例',
    fields: { mode: 'none', reason: '弱化反例' },
    ...(node['write'] ? { write: node['write'] } : {}),
  };
}

/** 声明树里的每个节点（含 any / all 分支、optional 分支）及其路径。 */
function* nodes(node: Node, at = ''): Generator<[string, Node]> {
  yield [at, node];
  if (Array.isArray(node['of'])) {
    for (const [i, branch] of (node['of'] as Node[]).entries()) yield* nodes(branch, `${at}of[${i}].`);
  }
  if (node['rows'] && typeof node['rows'] === 'object') yield [`${at}rows.`, node['rows'] as Node];
  if (node['failureAudit'] && typeof node['failureAudit'] === 'object') {
    yield [`${at}failureAudit.`, node['failureAudit'] as Node];
  }
  for (const [name, branch] of Object.entries((node['optional'] as Record<string, Node> | undefined) ?? {})) {
    yield* nodes(branch, `${at}optional.${name}.`);
  }
}

/** 深拷贝声明，在拷贝里按路径找到同一个节点并就地修改。 */
function edit(route: ManifestRoute, at: string, change: (node: Node) => void): ManifestRoute {
  const root = structuredClone(route.policy) as unknown as Node;
  for (const [path, node] of nodes(root)) if (path === at) change(node);
  return { ...route, policy: root as unknown as RoutePolicy };
}

function replaceAt(route: ManifestRoute, at: string, next: (node: Node) => Node): ManifestRoute {
  const root = structuredClone(route.policy) as unknown as Node;
  if (at === '') return { ...route, policy: next(root) as unknown as RoutePolicy };
  for (const [path, node] of nodes(root)) {
    if (!Array.isArray(node['of'])) continue;
    const branches = node['of'] as Node[];
    for (const [i, branch] of branches.entries()) if (`${path}of[${i}].` === at) branches[i] = next(branch);
  }
  return { ...route, policy: root as unknown as RoutePolicy };
}

/** 把 all 的第 i 个分支从 of 移进同一节点的 optional（其余登记不变）。 */
function moveToOptional(node: Node, i: number): void {
  const [moved] = (node['of'] as Node[]).splice(i, 1);
  node['optional'] = { ...((node['optional'] as Node | undefined) ?? {}), [`moved${i}`]: moved };
}

/** 整个准入降为普通成员，原准入整体挪进 optional（write 留在根上）。 */
function admissionToOptional(policy: Node): Node {
  const { write, optional, ...admission } = policy;
  return {
    kind: 'member',
    reason: '弱化反例',
    fields: { mode: 'none', reason: '弱化反例' },
    ...(write ? { write } : {}),
    optional: { ...((optional as Node | undefined) ?? {}), moved: admission },
  };
}

const NONE = { none: true, reason: '弱化反例' };
const NO_SCOPE = { mode: 'none', reason: '弱化反例' };
const NO_FIELDS = { mode: 'none', reason: '弱化反例' };

/**
 * 单个叶子准入移进根上的 optional：按钮（准入节点按钮改为 none，另挂一个只判该按钮的可选对象节点），或对象数据
 * 操作（准入节点退为只判按钮 / 普通成员，另挂一个只判该对象操作的可选节点）。其余登记不变。
 */
function leafToOptional(route: ManifestRoute, at: string, leaf: 'button' | 'operation'): ManifestRoute {
  const root = structuredClone(route.policy) as unknown as Node;
  let moved: Node | undefined;
  for (const [path, node] of nodes(root)) {
    if (path !== at) continue;
    if (leaf === 'button') {
      moved = { kind: 'object', object: node['object'], operation: 'button', button: node['button'] };
      node['button'] = NONE;
      // 同一按钮在逐行（rows.button）上重复登记的，一并移走：否则逐行按钮仍在准入里，不算移动了这个叶子
      const rows = node['rows'] as Node | undefined;
      if (rows?.['button']) rows['button'] = NONE;
    } else {
      moved = { kind: 'object', object: node['object'], operation: node['operation'], button: NONE };
      // 逐行的数据操作选择器同属这个叶子，一并移走
      const rows = node['rows'] as Node | undefined;
      if (rows?.['operation']) delete rows['operation'];
      if (node['button'] && !(node['button'] as Node)['none']) node['operation'] = 'button';
      else {
        const replacement = member(node);
        for (const key of Object.keys(node)) delete node[key];
        Object.assign(node, replacement);
      }
    }
  }
  if (!moved) return route;
  const optional = (root['optional'] as Node | undefined) ?? {};
  root['optional'] = { ...optional, [`moved${leaf}`]: { ...moved, scope: NO_SCOPE, fields: NO_FIELDS } };
  return { ...route, policy: root as unknown as RoutePolicy };
}

function isSelector(value: unknown): value is Node {
  return !!value && typeof value === 'object' && 'from' in value;
}

function selectorKeys(selector: Node): string[] {
  if (selector['map']) return Object.keys(selector['map'] as Node).sort();
  return [...((selector['domain'] as string[] | undefined) ?? [])].sort();
}

/** 与当前分支键不相交的另一个登记域（换成它就是“职务域冒充合同域”）。 */
function foreignDomain(contract: ObservedContract, keys: readonly string[]): string[] | undefined {
  const domains = Object.values(contract.domains).map((values) => [...values].sort());
  return domains.find((values) => values.length > 1 && values.every((v) => !keys.includes(v)));
}

function swapDomain(selector: Node, values: readonly string[]): void {
  if (selector['map']) {
    const [first] = Object.values(selector['map'] as Node);
    selector['map'] = Object.fromEntries(values.map((v) => [v, first]));
  } else selector['domain'] = [...values];
}

/** 按选择器位置（mapSelectors 的 position）定位并就地修改拷贝里的 map 选择器。 */
function editSelector(route: ManifestRoute, site: SelectorSite, change: (selector: Node) => void): ManifestRoute {
  const root = structuredClone(route.policy) as unknown as Node;
  let node = root;
  for (const segment of site.position.split('.').slice(0, -1)) {
    const indexed = /^(\w+)\[(\d+)\]$/.exec(segment);
    node = indexed ? (node[indexed[1]!] as Node[])[Number(indexed[2])]! : (node[segment] as Node);
  }
  change(node[site.field] as Node);
  return { ...route, policy: root as unknown as RoutePolicy };
}

const NEXT_SOURCE = { param: 'body', body: 'query', query: 'param' } as const;

/**
 * map 选择器的输入来源 / 映射值弱化（设计 B-07）：值全换成同域另一个合法值（映射里至少有两种不同的值才有“另一个”可换，
 * 如任职导入预览的 view / view 不生成）、path 改成另一个参数名、from 在 param / body / query 之间换。
 */
function selectorWeakenings(route: ManifestRoute): Weakening[] {
  return mapSelectors(route.policy).flatMap((site) => {
    const values = Object.values(site.map);
    const distinct = new Set(values.map((value) => JSON.stringify(value)));
    const weaken = (kind: WeakeningKind, change: (selector: Node) => void): Weakening => ({
      kind,
      at: site.position,
      route: editSelector(route, site, change),
    });
    return [
      ...(distinct.size >= 2
        ? [
            weaken('selector→value', (selector) => {
              selector['map'] = Object.fromEntries(Object.keys(site.map).map((key) => [key, values[0]]));
            }),
          ]
        : []),
      weaken('selector→path', (selector) => (selector['path'] = site.path === 'kind' ? 'object' : 'kind')),
      weaken('selector→from', (selector) => (selector['from'] = NEXT_SOURCE[site.from])),
    ];
  });
}

export function weakeningsOf(route: ManifestRoute, contract: ObservedContract): Weakening[] {
  const out: Weakening[] = selectorWeakenings(route);
  const push = (kind: WeakeningKind, at: string, mutated: ManifestRoute) => out.push({ kind, at, route: mutated });
  for (const [at, node] of nodes(route.policy as unknown as Node)) {
    // 可选分支不参与准入（只决定响应里的附加披露）：删可选分支由突变套件 delete-optional 覆盖
    if (at.includes('optional.')) continue;
    const branches = Array.isArray(node['of']) ? (node['of'] as Node[]) : undefined;
    if (node['kind'] === 'all' && branches && branches.length >= 2) {
      for (let i = 0; i < branches.length; i++) {
        push(
          'all-drop-branch',
          `${at}of[${i}]`,
          edit(route, at, (n) => (n['of'] as Node[]).splice(i, 1)),
        );
      }
      push(
        'all→any',
        at,
        edit(route, at, (n) => (n['kind'] = 'any')),
      );
      for (let i = 0; i < branches.length; i++) {
        push(
          'required→optional',
          `${at}of[${i}]`,
          edit(route, at, (n) => moveToOptional(n, i)),
        );
      }
    }
    if (at === '' && !['member', 'public', 'own'].includes(node['kind'] as string)) {
      push('required→optional', 'root', replaceAt(route, '', admissionToOptional));
    }
    if (node['kind'] === 'any' && branches) {
      for (let i = 0; i < branches.length; i++) {
        push('any-branch→member', `${at}of[${i}]`, replaceAt(route, `${at}of[${i}].`, member));
      }
    }
    if (node['kind'] === 'relation') push('relation→member', at, replaceAt(route, at, member));
    if (node['kind'] === 'object') {
      const button = node['button'] as Node | undefined;
      if (button && !button['none'] && node['operation'] !== 'button') {
        push('leaf→optional', `${at}button`, leafToOptional(route, at, 'button'));
      }
      if (node['operation'] !== 'button') {
        push('leaf→optional', `${at}operation`, leafToOptional(route, at, 'operation'));
      }
    }
    for (const key of [...SELECTOR_KEYS, 'objectType']) {
      const selector = node[key];
      if (!isSelector(selector)) continue;
      const foreign = foreignDomain(contract, selectorKeys(selector));
      if (!foreign) continue;
      push(
        'selector→domain',
        `${at}${key}`,
        edit(route, at, (n) => swapDomain(n[key] as Node, foreign)),
      );
    }
  }
  return out;
}

// ---- 披露语义与范围绑定（F-039 PR-B1，B-01 / B-03）------------------------------------------------------------------
// 按声明结构与表的披露义务生成（不经比较器筛选），每一个都必须报出 expected。与上面的弱化互补：上面逐类削弱准入 / 选择器，
// 这里削弱披露分支的结构与独立范围，以及多承载节点备选里“范围换位”。

export const DISCLOSURE_WEAKENING_KINDS = [
  'disclosure→any-member',
  'disclosure→nested',
  'disclosure→moved',
  'scope→sibling',
  'disclosure-scope→none',
  'disclosure-scope→wrong-predicate',
  'scope→foreign-object',
  'scope→partial-object',
] as const;
export type DisclosureWeakeningKind = (typeof DISCLOSURE_WEAKENING_KINDS)[number];

export interface DisclosureWeakening {
  readonly kind: DisclosureWeakeningKind;
  readonly at: string;
  readonly expected: string;
  readonly route: ManifestRoute;
}

const MEMBER_BRANCH = (): Node => ({
  kind: 'member',
  reason: '弱化反例',
  fields: { mode: 'none', reason: '弱化反例' },
});

/** 披露分支（含其 of 子节点）里的所有节点。 */
function* branchNodes(node: Node): Generator<Node> {
  yield node;
  for (const child of (node['of'] as Node[] | undefined) ?? []) yield* branchNodes(child);
}

const moduleOf = (key: string) => key.split(' ')[1]!.split('/').slice(0, 4).join('/');

/** 同模块（路径前四段）里已登记的、与 mode 相同但名字不同的范围名字。 */
function otherScopeName(table: RequiredTable, key: string, mode: string, used: string): string | undefined {
  for (const [other, obligations] of Object.entries(table)) {
    if (moduleOf(other) !== moduleOf(key)) continue;
    for (const o of obligations) {
      const need = o.need;
      const name = need?.scope === mode ? (need.locator ?? need.predicate ?? need.guard) : undefined;
      if (name && name !== used) return name;
    }
  }
  return undefined;
}

const scopeNames = (scope: Node): [string, string] | undefined => {
  if (scope['mode'] === 'point') return ['locator', String(scope['locator'])];
  if (scope['mode'] === 'list') return ['predicate', String(scope['predicate'])];
  return undefined;
};

export function disclosureWeakeningsOf(route: ManifestRoute, table: RequiredTable): DisclosureWeakening[] {
  const key = `${route.method} ${route.path}`;
  const obligations = table[key] ?? [];
  const out: DisclosureWeakening[] = [];
  const push = (kind: DisclosureWeakeningKind, at: string, expected: string, mutated: ManifestRoute) =>
    out.push({ kind, at, expected, route: mutated });
  const rootOf = () => structuredClone(route.policy) as unknown as Node;
  const make = (root: Node): ManifestRoute => ({ ...route, policy: root as unknown as RoutePolicy });
  const declared = (route.policy as unknown as Node)['optional'] as Record<string, Node> | undefined;

  for (const name of new Set(
    obligations.filter((o) => o.purpose?.startsWith('disclosure:')).map((o) => o.purpose!.slice(11)),
  )) {
    if (!declared?.[name]) continue;
    const edit = (change: (root: Node, optional: Record<string, Node>) => void) => {
      const root = rootOf();
      change(root, root['optional'] as Record<string, Node>);
      return make(root);
    };
    push(
      'disclosure→any-member',
      `optional.${name}`,
      'DISCLOSURE_WEAK',
      edit((_r, optional) => (optional[name] = { kind: 'any', of: [optional[name]!, MEMBER_BRANCH()] })),
    );
    push(
      'disclosure→nested',
      `optional.${name}`,
      'OPTIONAL_NESTED',
      edit((_r, optional) => (optional[name] = { ...MEMBER_BRANCH(), optional: { inner: optional[name]! } })),
    );
    const branches = (route.policy as unknown as Node)['of'];
    if (Array.isArray(branches)) {
      for (let i = 0; i < branches.length; i++) {
        push(
          'disclosure→moved',
          `of[${i}].optional.${name}`,
          'OPTIONAL_POSITION',
          edit((root, optional) => {
            const child = (root['of'] as Node[])[i]!;
            child['optional'] = { ...((child['optional'] as Node | undefined) ?? {}), [name]: optional[name]! };
            delete optional[name];
          }),
        );
      }
    }
    const scoped = obligations.filter((o) => o.purpose === `disclosure:${name}` && o.need && o.need.scope !== 'none');
    if (!scoped.length) continue;
    push(
      'disclosure-scope→none',
      `optional.${name}`,
      'DISCLOSURE_WEAK',
      edit((_r, optional) => {
        for (const node of branchNodes(optional[name]!))
          if (node['scope']) node['scope'] = { mode: 'none', reason: '弱化反例' };
      }),
    );
    const mode = scoped[0]!.need!.scope;
    const used = scoped[0]!.need!.locator ?? scoped[0]!.need!.predicate ?? scoped[0]!.need!.guard ?? '';
    const other = otherScopeName(table, key, mode, used);
    if (other) {
      push(
        'disclosure-scope→wrong-predicate',
        `optional.${name}`,
        'DISCLOSURE_WEAK',
        edit((_r, optional) => {
          for (const node of branchNodes(optional[name]!)) {
            const names = node['scope'] ? scopeNames(node['scope'] as Node) : undefined;
            if (names) (node['scope'] as Node)[names[0]] = other;
          }
        }),
      );
    }
  }

  // scope→sibling：含 ≥2 个承载节点的准入备选里，交换每一对范围不同的承载节点的范围。
  // 两个节点提供同一组权限（如人员子集列表：同一查看权由 personScope 列表节点与 employeeId 点校验节点共同提供）时，
  // 交换后每条义务仍有满足 need 的来源，need 按权限键绑定看不出差别，该对不生成（PR 描述记为局限）。
  const swapped = new Set<string>();
  for (const [i, alt] of declaredPerms(route.policy).alternatives.entries()) {
    const carriers = new Map<string, { scopes: string; perms: Set<string> }>();
    for (const [perm, sources] of alt) {
      if (!/^(obj|admin):/.test(perm)) continue;
      for (const s of sources.filter((x) => x.carrier)) {
        const one = carriers.get(s.path) ?? { scopes: JSON.stringify(s.scopes), perms: new Set<string>() };
        carriers.set(s.path, { ...one, perms: one.perms.add(perm) });
      }
    }
    const paths = [...carriers.keys()];
    for (const [a, pathA] of paths.entries()) {
      for (const pathB of paths.slice(a + 1)) {
        const [one, other] = [carriers.get(pathA)!, carriers.get(pathB)!];
        const samePerms = [...one.perms].sort().join() === [...other.perms].sort().join();
        if (one.scopes === other.scopes || samePerms || swapped.has(`${pathA}|${pathB}`)) continue;
        swapped.add(`${pathA}|${pathB}`);
        const root = rootOf();
        const [nodeA, nodeB] = [locate(root, pathA)!, locate(root, pathB)!];
        [nodeA['scope'], nodeB['scope']] = [nodeB['scope'], nodeA['scope']];
        push('scope→sibling', `备选${i + 1}:${pathA || 'root'}↔${pathB || 'root'}`, 'REQUIRED_MISSING', make(root));
      }
    }
  }
  scopeBindingWeakenings(route, obligations, (kind, at, expected, mutate) => {
    const root = rootOf();
    mutate(root);
    push(kind, at, expected, make(root));
  });
  return out;
}

/**
 * 范围按实际对象绑定（#162 审查 P2-1）：对每个“唯一满足 need 的来源节点”（准入备选或披露分支里、同一权限没有第二个
 * 满足 need 的来源），① 把节点范围改成只登记给无关对象的 byObject（scope→foreign-object）；② 动态对象（映射 / 域有
 * 多个对象）只给第一个对象保留原范围、其余 `*:none`（scope→partial-object，原范围为 none 时无差别不生成）。
 * 准入里的来源期望 REQUIRED_MISSING，披露分支里的来源期望 DISCLOSURE_WEAK。
 */
function scopeBindingWeakenings(
  route: ManifestRoute,
  obligations: readonly Obligation[],
  push: (kind: DisclosureWeakeningKind, at: string, expected: string, mutate: (root: Node) => void) => void,
): void {
  const decl = declaredPerms(route.policy);
  const seen = new Set<string>();
  const visit = (alts: readonly PermMap[], owned: readonly Obligation[], expected: string, label: string) => {
    for (const [i, alt] of alts.entries()) {
      for (const o of owned.filter((x) => x.need && !x.or)) {
        const matching = new Set(
          (alt.get(o.perm) ?? [])
            .filter((src) => src.carrier && scopeMatches(src.scopes, o.need))
            .map((src) => src.path),
        );
        if (matching.size !== 1) continue;
        const [path] = [...matching] as [string];
        if (seen.has(`${expected}|${path}`)) continue;
        seen.add(`${expected}|${path}`);
        const node = locate(rootOfPolicy(route), path);
        const original = node?.['scope'] as Node | undefined;
        if (!node || !original || typeof original !== 'object') continue;
        const at = `${label}备选${i + 1}:${path || 'root'}`;
        push('scope→foreign-object', at, expected, (root) => {
          locate(root, path)!['scope'] = { byObject: { 'Fixture.Unrelated': original } };
        });
        const objects = objectsOf(node['object']);
        if (objects && objects.length > 1 && original['mode'] !== 'none' && !('byObject' in original)) {
          push('scope→partial-object', at, expected, (root) => {
            locate(root, path)!['scope'] = {
              byObject: { [objects[0]!]: original, '*': { mode: 'none', reason: '弱化反例' } },
            };
          });
        }
      }
    }
  };
  visit(
    decl.alternatives,
    obligations.filter((o) => o.purpose === undefined),
    'REQUIRED_MISSING',
    '',
  );
  for (const [name, branch] of decl.optional) {
    visit(
      branch.alternatives,
      obligations.filter((o) => o.purpose === `disclosure:${name}`),
      'DISCLOSURE_WEAK',
      `optional.${name}.`,
    );
  }
}

const rootOfPolicy = (route: ManifestRoute) => route.policy as unknown as Node;
