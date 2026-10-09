/**
 * 必须施加的弱化反例（F-039 PR-A 实现审第 1 轮 P2-1）：按声明树的**结构**生成，不经比较器、不读 features，
 * 生成的每一个都必须被比较器报出（WEAKER:* / MISMATCH:*）。与 mutate.ts 的突变套件互补：突变套件按基准观测到
 * 的维度逐类削弱；这里覆盖组合与绑定类削弱——删 all 的分支、all → any、any 的分支降为普通成员、
 * 关系降为普通成员、动态选择器换成别的域、必需准入分支移进 optional（实现审第 2 轮 P2-1 残项：可选分支只决定
 * 附加披露，不能顶替必需授权）、单个叶子准入（按钮 / 对象数据操作）移进 optional（实现审第 3 轮）。
 */
import type { ManifestRoute, RoutePolicy } from '@italent/api';
import type { ObservedContract } from './contract.js';

export type WeakeningKind =
  | 'all-drop-branch'
  | 'all→any'
  | 'any-branch→member'
  | 'relation→member'
  | 'selector→domain'
  | 'required→optional'
  | 'leaf→optional';

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
    } else {
      moved = { kind: 'object', object: node['object'], operation: node['operation'], button: NONE };
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

export function weakeningsOf(route: ManifestRoute, contract: ObservedContract): Weakening[] {
  const out: Weakening[] = [];
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
