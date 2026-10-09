/**
 * 显式表的突变（F-039 PR-A 第 4 轮，修法说明第六节）：按**审定的义务**逐项、逐准入备选在声明树上生成，
 * 不引用比较器、不按能否发现筛选。每个突变都必须报出 expected：
 * - required→none：从第 i 个准入备选里删掉提供该义务的声明来源 → REQUIRED_MISSING；
 * - required→optional：同上，并把原来源节点挂进根上的 optional → REQUIRED_IN_OPTIONAL；
 * - disclosure→none：删掉授予披露的同名 optional 分支 → DISCLOSURE_MISSING；
 * - disclosure→admission：把纯披露分支并进准入（all）→ DISCLOSURE_AS_ADMISSION；
 * - conditional→none：删掉承载条件准入的具名守卫 → REQUIRED_MISSING。
 */
import type { ManifestRoute, RoutePolicy } from '@italent/api';
import { declaredPerms, type PermSource } from './perms.js';
import type { RequiredTable } from './required/types.js';

export const REQUIRED_MUTATION_KINDS = [
  'required→none',
  'required→optional',
  'disclosure→none',
  'disclosure→admission',
  'conditional→none',
] as const;
export type RequiredMutationKind = (typeof REQUIRED_MUTATION_KINDS)[number];

export interface RequiredMutant {
  readonly kind: RequiredMutationKind;
  readonly key: string;
  readonly perm: string;
  /** 被改动的声明位置（节点路径 + 字段，或 optional 名）。 */
  readonly at: string;
  readonly expected: string;
  readonly route: ManifestRoute;
}

type Node = Record<string, unknown>;
const NONE = { none: true, reason: '突变' };
const MEMBER_FIELDS = { mode: 'none', reason: '突变' };

/** 按节点路径（`of[0].optional.x.`）在拷贝里找节点。 */
function locate(root: Node, nodePath: string): Node | undefined {
  let node: Node | undefined = root;
  for (const match of nodePath.matchAll(/of\[(\d+)\]\.|optional\.([^.]+)\./g)) {
    if (!node) return undefined;
    node =
      match[1] !== undefined
        ? (node['of'] as Node[])[Number(match[1])]
        : (node['optional'] as Record<string, Node>)[match[2]!];
  }
  return node;
}

function member(node: Node): Node {
  const keep = Object.fromEntries(['write', 'optional', 'guards'].filter((k) => node[k]).map((k) => [k, node[k]]));
  return { kind: 'member', reason: '突变', fields: MEMBER_FIELDS, ...keep };
}

/** 在节点上删掉一个权限来源（只动这一处登记）。 */
function removeSource(node: Node, source: PermSource, perm: string): void {
  const rows = node['rows'] as Node | undefined;
  switch (source.field) {
    case 'guards':
      node['guards'] = ((node['guards'] as string[]) ?? []).filter((g) => `guard:${g}` !== perm);
      break;
    case 'scope':
      node['scope'] = { mode: 'none', reason: '突变' };
      break;
    case 'operation':
      node['operation'] = 'button';
      break;
    case 'button':
      node['button'] = NONE;
      break;
    case 'rows.operation':
      if (rows) delete rows['operation'];
      break;
    case 'rows.button':
      if (rows) rows['button'] = NONE;
      break;
    case 'rows.relation':
      if (rows) delete rows['relation'];
      break;
    case 'kind': {
      const replacement = member(node);
      for (const key of Object.keys(node)) delete node[key];
      Object.assign(node, replacement);
      break;
    }
  }
}

function mutate(route: ManifestRoute, change: (root: Node) => void): ManifestRoute {
  const root = structuredClone(route.policy) as unknown as Node;
  change(root);
  return { ...route, policy: root as unknown as RoutePolicy };
}

export function requiredMutants(route: ManifestRoute, table: RequiredTable): RequiredMutant[] {
  const key = `${route.method} ${route.path}`;
  const obligations = table[key] ?? [];
  const decl = declaredPerms(route.policy);
  const out: RequiredMutant[] = [];
  const push = (kind: RequiredMutationKind, perm: string, at: string, expected: string, mutated: ManifestRoute) =>
    out.push({ kind, key, perm, at, expected, route: mutated });

  for (const o of obligations.filter((x) => x.purpose === undefined)) {
    decl.alternatives.forEach((alt, i) => {
      const sources = alt.get(o.perm);
      if (!sources) return;
      const at = `备选${i + 1}:${sources.map((s) => `${s.path}${s.field}`).join(',')}`;
      const strip = (root: Node) => {
        for (const source of sources) removeSource(locate(root, source.path)!, source, o.perm);
      };
      push('required→none', o.perm, at, 'REQUIRED_MISSING', mutate(route, strip));
      push(
        'required→optional',
        o.perm,
        at,
        'REQUIRED_IN_OPTIONAL',
        mutate(route, (root) => {
          const moved = sources.map((s) => structuredClone(locate(root, s.path)!));
          strip(root);
          const optional = { ...((root['optional'] as Node | undefined) ?? {}) };
          moved.forEach((node, n) => (optional[`moved${n}`] = { ...node, optional: undefined }));
          root['optional'] = optional;
        }),
      );
    });
  }

  const disclosures = obligations.filter((o) => o.purpose?.startsWith('disclosure:'));
  for (const name of new Set(disclosures.map((o) => o.purpose!.slice('disclosure:'.length)))) {
    const sources = [...(decl.optional.get(name)?.values() ?? [])].flat();
    const paths = [...new Set(sources.map((s) => s.path.replace(new RegExp(`optional\\.${name}\\..*$`), '')))];
    push(
      'disclosure→none',
      `disclosure:${name}`,
      `optional.${name}`,
      'DISCLOSURE_MISSING',
      mutate(route, (root) => {
        for (const owner of paths) {
          const node = locate(root, owner);
          const optional = { ...((node?.['optional'] as Node | undefined) ?? {}) };
          delete optional[name];
          if (node) node['optional'] = optional;
        }
      }),
    );
  }
  for (const o of disclosures) {
    if (obligations.some((x) => x.perm === o.perm && !x.purpose?.startsWith('disclosure:'))) continue;
    const name = o.purpose!.slice('disclosure:'.length);
    const source = decl.optional.get(name)?.get(o.perm)?.[0];
    if (!source) continue;
    push(
      'disclosure→admission',
      o.perm,
      `optional.${name}`,
      'DISCLOSURE_AS_ADMISSION',
      mutate(route, (root) => {
        const branch = { ...structuredClone(locate(root, source.path)!), optional: undefined, write: undefined };
        const { write, ...rest } = structuredClone(root);
        for (const k of Object.keys(root)) delete root[k];
        Object.assign(root, { kind: 'all', of: [rest, branch], fields: MEMBER_FIELDS, ...(write ? { write } : {}) });
      }),
    );
  }

  for (const o of obligations.filter((x) => x.purpose?.startsWith('when:'))) {
    const guard = `guard:${o.purpose!.slice('when:'.length)}`;
    const sources = decl.alternatives.flatMap((alt) => alt.get(guard) ?? []);
    if (!sources.length) continue;
    push(
      'conditional→none',
      o.perm,
      guard,
      'REQUIRED_MISSING',
      mutate(route, (root) => {
        for (const source of sources) removeSource(locate(root, source.path)!, source, guard);
      }),
    );
  }
  return out;
}
