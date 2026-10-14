/**
 * 显式表的突变（F-039 PR-A 第 4 轮，修法说明第六节）：按**审定的义务**逐项、逐准入备选在声明树上生成，
 * 不引用比较器、不按能否发现筛选。每个突变都必须报出 expected：
 * - required→none：从第 i 个准入备选里删掉提供该无组准入义务的声明来源 → REQUIRED_MISSING；
 * - required→optional：同上，并把原来源节点挂进根上的 optional → REQUIRED_IN_OPTIONAL（“或”组成员同样）；
 * - or-member→none：备选 i 里“或”组恰有一个组内备选成立（|S|=1）时，对该组内备选的每个权限各删一次 → REQUIRED_MISSING；
 * - or-group→none：|S|>1 时，每个成立的组内备选各删一个权限（整组失效）→ REQUIRED_MISSING（B-05，PR-B1）；
 * - disclosure→none：删掉授予披露的同名 optional 分支 → DISCLOSURE_MISSING；
 * - disclosure→admission：把纯披露分支并进准入（all）→ DISCLOSURE_AS_ADMISSION；
 * - conditional→none：删掉承载条件准入的具名守卫 → REQUIRED_MISSING。
 */
import type { ManifestRoute, RoutePolicy } from '@italent/api';
import { declaredPerms, type PermMap, type PermSource, provides } from './perms.js';
import { satisfiedGroupAlts } from './required.js';
import type { Obligation, RequiredTable } from './required/types.js';

/** 真实声明里每类都至少能施加一次的突变类别；`or-group→none` 需要 |S|>1 的“或”组，现状没有，由夹具覆盖。 */
export const REQUIRED_MUTATION_KINDS = [
  'required→none',
  'required→optional',
  'or-member→none',
  'disclosure→none',
  'disclosure→admission',
  'conditional→none',
] as const;
export const OR_GROUP_KIND = 'or-group→none';
export type RequiredMutationKind = (typeof REQUIRED_MUTATION_KINDS)[number] | typeof OR_GROUP_KIND;

export interface RequiredMutant {
  readonly kind: RequiredMutationKind;
  /** 覆盖键：端点 | 权限 | 备选 i | 来源路径（或“或”组：端点 | group:组名 | 备选 i）。 */
  readonly coverageKey: string;
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

/**
 * 按节点路径（`of[0].optional.x.`）在拷贝里找节点。分支名按 D3 字符集解析；路径没有被完整消费（如名字里带点）
 * 一律抛错，不静默错位到别的分支（PR-B1）。
 */
export function locate(root: Node, nodePath: string): Node | undefined {
  let node: Node | undefined = root;
  let consumed = 0;
  for (const match of nodePath.matchAll(/of\[(\d+)\]\.|optional\.([A-Za-z][A-Za-z0-9]*)\./g)) {
    if (match.index !== consumed) break;
    consumed += match[0].length;
    if (!node) return undefined;
    node =
      match[1] !== undefined
        ? (node['of'] as Node[])[Number(match[1])]
        : (node['optional'] as Record<string, Node>)[match[2]!];
  }
  if (consumed !== nodePath.length) throw new Error(`节点路径含非法分支名或无法解析：${nodePath}`);
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

export const sourcesKey = (sources: readonly PermSource[]) => sources.map((x) => `${x.path}${x.field}`).join(',');
export const coverageKeyOf = (key: string, perm: string, alt: number, sources: readonly PermSource[]) =>
  `${key}|${perm}|${alt + 1}|${sourcesKey(sources)}`;

export function requiredMutants(route: ManifestRoute, table: RequiredTable): RequiredMutant[] {
  const key = `${route.method} ${route.path}`;
  const obligations = table[key] ?? [];
  const decl = declaredPerms(route.policy);
  const out: RequiredMutant[] = [];
  const push = (
    kind: RequiredMutationKind,
    coverageKey: string,
    perm: string,
    at: string,
    expected: string,
    mutated: ManifestRoute,
  ) => out.push({ kind, coverageKey, key, perm, at, expected, route: mutated });

  const stripSources = (sources: readonly PermSource[], perm: string) => (root: Node) => {
    for (const source of sources) removeSource(locate(root, source.path)!, source, perm);
  };
  const toOptional = (sources: readonly PermSource[], perm: string) => (root: Node) => {
    const moved = sources.map((s) => structuredClone(locate(root, s.path)!));
    stripSources(sources, perm)(root);
    const optional = { ...((root['optional'] as Node | undefined) ?? {}) };
    moved.forEach((node, n) => (optional[`moved${n}`] = { ...node, optional: undefined }));
    root['optional'] = optional;
  };
  const required = (o: Obligation, kind: 'required→none' | 'or-member→none', i: number, alt: PermMap) => {
    const sources = alt.get(o.perm)!;
    const at = `备选${i + 1}:${sourcesKey(sources)}`;
    const cover = coverageKeyOf(key, o.perm, i, sources);
    push(kind, cover, o.perm, at, 'REQUIRED_MISSING', mutate(route, stripSources(sources, o.perm)));
    push('required→optional', cover, o.perm, at, 'REQUIRED_IN_OPTIONAL', mutate(route, toOptional(sources, o.perm)));
  };

  const admission = obligations.filter((x) => x.purpose === undefined);
  const groups = new Map<string, Map<string, Obligation[]>>();
  for (const o of admission.filter((x) => x.or)) {
    const [group = '', name = ''] = o.or!.split(':');
    const alts = groups.get(group) ?? new Map<string, Obligation[]>();
    groups.set(group, alts.set(name, [...(alts.get(name) ?? []), o]));
  }
  decl.alternatives.forEach((alt, i) => {
    for (const o of admission.filter((x) => !x.or && provides(alt, x.perm, x.need)))
      required(o, 'required→none', i, alt);
    for (const [group, alts] of groups) {
      const satisfied = satisfiedGroupAlts(alt, alts);
      if (satisfied.length === 1) {
        for (const o of alts.get(satisfied[0]!)!) required(o, 'or-member→none', i, alt);
      } else if (satisfied.length > 1) {
        // 每个成立的组内备选各删一个权限，整组才失效
        const picks = satisfied.map((name) => alts.get(name)![0]!);
        const sources = picks.map((o) => alt.get(o.perm)!);
        push(
          OR_GROUP_KIND,
          `${key}|group:${group}|${i + 1}`,
          picks.map((o) => o.perm).join('+'),
          `备选${i + 1}:组${group}`,
          'REQUIRED_MISSING',
          mutate(route, (root) => picks.forEach((o, n) => stripSources(sources[n]!, o.perm)(root))),
        );
      }
    }
  });

  const disclosures = obligations.filter((o) => o.purpose?.startsWith('disclosure:'));
  for (const name of new Set(disclosures.map((o) => o.purpose!.slice('disclosure:'.length)))) {
    push(
      'disclosure→none',
      `${key}|disclosure:${name}`,
      `disclosure:${name}`,
      `optional.${name}`,
      'DISCLOSURE_MISSING',
      mutate(route, (root) => {
        const optional = { ...((root['optional'] as Node | undefined) ?? {}) };
        delete optional[name];
        root['optional'] = optional;
      }),
    );
  }
  for (const o of disclosures) {
    if (obligations.some((x) => x.perm === o.perm && !x.purpose?.startsWith('disclosure:'))) continue;
    const name = o.purpose!.slice('disclosure:'.length);
    const source = decl.optional.get(name)?.alternatives[0]?.get(o.perm)?.[0];
    if (!source) continue;
    push(
      'disclosure→admission',
      `${key}|${o.perm}|disclosure:${name}`,
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
      `${key}|${o.perm}|${guard}`,
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
