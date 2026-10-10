/**
 * 证据依赖变化的集中报告（F-072 PR-2，docs/08_设计/F-072_闭包边界降噪_方案.md §3）。
 * 旧报告按证据单元逐根出 `EVIDENCE_STALE`：一个共享依赖变了，每个引用它的根各一条（`tenant-time.ts` 一处改动 403 条）。
 * 这里改成按**唯一变更节点**出一条，附完整反向影响清单（全部证据单元 → 全部义务）：
 *   变更节点 C = Δd（摘要变）∪ Δe（直接边变）∪ Δb（绑定指纹变）∪ Δr（证据单元自身变或未登记）；
 *   impacts(x) = R_reg(x) ∪ R_cur(x)：登记图与当前图**各自**求可达再取并，不在并图上求（并图会拼出两个快照里都不存在的路径）。
 * 本文件只做登记 ↔ 当前的比较，不读源码；旧逐根算法作 oracle 只在测试里（AC-PRM-FW-02-report）。
 */
import { walk } from './evidence-closure.js';
import type { Registry } from './evidence-graph.js';

/** 报告里的一条复核项：端点标签 + 义务 / 登记项标签。 */
export interface Use {
  /** 报告里的端点标签（Finding.route）。 */
  readonly route: string;
  /** 复核清单里的一条（义务 / 登记项）。 */
  readonly label: string;
}

export type StaleKind = 'digest' | 'edge' | 'binding' | 'root';

export interface Impact {
  readonly root: string;
  /** 链取自哪个快照：根在当前图里仍能到变更节点用 cur，否则用 reg。 */
  readonly snapshot: 'cur' | 'reg';
  readonly chain: readonly string[];
  /** 该证据单元的全部义务 / 登记项。 */
  readonly uses: readonly Use[];
  /** root = node 且 node ∈ Δr：证据单元自身变化。 */
  readonly self: boolean;
  /** 这条影响里旧逐根算法确有闭包集合 / 依赖摘要变化归因到该节点（只是标注，不是分组存在的条件）。 */
  readonly closureChanged: boolean;
}

export interface StaleGroup {
  readonly node: string;
  readonly kinds: readonly StaleKind[];
  /** G_cur(x) \ G_reg(x)。 */
  readonly added?: readonly string[];
  /** G_reg(x) \ G_cur(x)。 */
  readonly removed?: readonly string[];
  /** 完整，不截断，按 route、label 排序。 */
  readonly impacts: readonly Impact[];
}

export interface ReportInput {
  /** 登记（`units` 是要比较的证据单元摘要）。 */
  readonly reg: Registry;
  /** 由当前源码算出的登记。 */
  readonly cur: Registry;
  /** 当前的证据单元（根）→ 它的全部义务 / 登记项。 */
  readonly roots: ReadonlyMap<string, readonly Use[]>;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const fileOf = (id: string) => id.slice(0, id.indexOf('#'));
const nameOf = (id: string) => id.slice(id.indexOf('#') + 1);
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

const digestOf = (r: Registry, id: string): string | undefined => r.nodes[id]?.[0];
const unitDigestOf = (r: Registry, id: string): string | undefined => r.units[fileOf(id)]?.[nameOf(id)];
const bindingOf = (r: Registry, id: string): string | undefined => r.nodes[id]?.[1] ?? r.unitBindings[id];
const present = (r: Registry, id: string) => id in r.nodes || id in r.unitBindings;

/** 一个快照：每个根的闭包（walk 的 parents）与反向索引 R_G(x)。未登记的根在登记侧视为空闭包。 */
interface Side {
  readonly registry: Registry;
  readonly parents: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly reach: ReadonlyMap<string, ReadonlySet<string>>;
}

function sideOf(registry: Registry, roots: Iterable<string>, registered: (root: string) => boolean): Side {
  const parents = new Map<string, ReadonlyMap<string, string>>();
  const reach = new Map<string, Set<string>>();
  const add = (node: string, root: string) => reach.set(node, (reach.get(node) ?? new Set()).add(root));
  for (const root of roots) {
    const closure = registered(root) ? walk(root, (id) => registry.graph[id] ?? []).parents : new Map<string, string>();
    parents.set(root, closure);
    add(root, root);
    for (const node of closure.keys()) add(node, root);
  }
  return { registry, parents, reach };
}

/** 从根沿 parents 回溯到节点的最短链（含两端）。 */
function chainTo(parents: ReadonlyMap<string, string>, root: string, node: string): string[] {
  const chain = [node];
  for (let up = parents.get(node); up !== undefined; up = parents.get(up)) chain.unshift(up);
  return node === root ? [root] : chain;
}

function changedNodes(reg: Registry, cur: Registry, roots: Iterable<string>) {
  const ids = new Set([
    ...Object.keys(reg.nodes),
    ...Object.keys(cur.nodes),
    ...Object.keys(reg.unitBindings),
    ...Object.keys(cur.unitBindings),
    ...Object.keys(reg.graph),
    ...Object.keys(cur.graph),
  ]);
  const both = (id: string) => id in reg.nodes && id in cur.nodes;
  return {
    digest: new Set([...ids].filter((id) => both(id) && digestOf(reg, id) !== digestOf(cur, id))),
    edge: new Set([...ids].filter((id) => !sameSet(reg.graph[id] ?? [], cur.graph[id] ?? []))),
    binding: new Set(
      [...ids].filter((id) => present(reg, id) && present(cur, id) && bindingOf(reg, id) !== bindingOf(cur, id)),
    ),
    // 证据单元自身摘要变化，或闭包没有登记（unitBindings 是登记标记）
    root: new Set(
      [...roots].filter((id) => unitDigestOf(reg, id) !== unitDigestOf(cur, id) || reg.unitBindings[id] === undefined),
    ),
  };
}

/** 旧逐根算法在某个根上的三元组集合（added / removed / changed），归因 closureChanged 用。 */
function triplesOf(reg: Side, cur: Side, root: string) {
  const [a, b] = [new Set(reg.parents.get(root)!.keys()), new Set(cur.parents.get(root)!.keys())];
  return {
    added: new Set([...b].filter((y) => !a.has(y))),
    removed: new Set([...a].filter((y) => !b.has(y))),
    changed: new Set([...a].filter((y) => b.has(y) && digestOf(reg.registry, y) !== digestOf(cur.registry, y))),
  };
}

const sortKey = (uses: readonly Use[] | undefined, root: string) => [uses?.[0]?.route ?? root, uses?.[0]?.label ?? ''];

export function staleGroups(input: ReportInput): StaleGroup[] {
  const { reg, cur, roots } = input;
  const rootIds = [...roots.keys()];
  const [regSide, curSide] = [
    sideOf(reg, rootIds, (root) => reg.unitBindings[root] !== undefined),
    sideOf(cur, rootIds, () => true),
  ];
  const delta = changedNodes(reg, cur, rootIds);
  const all = new Set([...delta.digest, ...delta.edge, ...delta.binding, ...delta.root]);
  const triples = new Map(rootIds.map((r) => [r, triplesOf(regSide, curSide, r)]));
  // 节点 t 在某一快照上的闭包（含自身），只在边变化的节点上用到
  const closures = new Map<string, Set<string>>();
  const closureOf = (side: Side, tag: string, t: string) => {
    const key = `${tag}|${t}`;
    if (!closures.has(key)) {
      const parents = walk(t, (id) => side.registry.graph[id] ?? []).parents;
      closures.set(key, new Set([t, ...parents.keys()]));
    }
    return closures.get(key)!;
  };

  const groups: StaleGroup[] = [];
  for (const node of [...all].sort(compareText)) {
    const kinds: StaleKind[] = [
      ...(delta.digest.has(node) ? (['digest'] as const) : []),
      ...(delta.edge.has(node) ? (['edge'] as const) : []),
      ...(delta.binding.has(node) ? (['binding'] as const) : []),
      ...(delta.root.has(node) ? (['root'] as const) : []),
    ];
    const was = reg.graph[node] ?? [];
    const now = cur.graph[node] ?? [];
    const added = now.filter((d) => !was.includes(d));
    const removed = was.filter((d) => !now.includes(d));
    const affected =
      kinds.length === 1 && kinds[0] === 'root'
        ? [node]
        : [...new Set([...(regSide.reach.get(node) ?? []), ...(curSide.reach.get(node) ?? [])])];
    const closureChanged = (root: string): boolean => {
      const t = triples.get(root)!;
      if (t.changed.has(node)) return true;
      const viaAdded =
        curSide.reach.get(node)?.has(root) &&
        added.some((d) => [...closureOf(curSide, 'cur', d)].some((y) => t.added.has(y)));
      const viaRemoved =
        regSide.reach.get(node)?.has(root) &&
        removed.some((d) => [...closureOf(regSide, 'reg', d)].some((y) => t.removed.has(y)));
      return delta.edge.has(node) && Boolean(viaAdded || viaRemoved);
    };
    const impacts = affected
      .map((root): Impact => {
        const inCur = root === node || curSide.parents.get(root)!.has(node);
        const side = inCur ? curSide : regSide;
        return {
          root,
          snapshot: inCur ? 'cur' : 'reg',
          chain: chainTo(side.parents.get(root)!, root, node),
          uses: roots.get(root) ?? [],
          self: root === node && delta.root.has(node),
          closureChanged: closureChanged(root),
        };
      })
      .sort((a, b) => {
        const [ka, kb] = [sortKey(a.uses, a.root), sortKey(b.uses, b.root)];
        return compareText(ka[0]!, kb[0]!) || compareText(ka[1]!, kb[1]!) || compareText(a.root, b.root);
      });
    if (!impacts.length) continue; // 登记里残留、当前没有任何根能到：由 EVIDENCE_UNUSED 报
    groups.push({
      node,
      kinds,
      ...(kinds.includes('edge') ? { added, removed } : {}),
      impacts,
    });
  }
  return groups;
}

/** 每个依赖被改时要复核的证据单元数与义务数（同一义务只算一次），从 R_cur 计算（F-072 §3.2 规则 6）。 */
export function impactCounts(
  graph: Registry['graph'],
  roots: ReadonlyMap<string, readonly Use[]>,
): Map<string, { units: number; obligations: number }> {
  const side = sideOf({ units: {}, unitBindings: {}, nodes: {}, graph }, roots.keys(), () => true);
  return new Map(
    [...side.reach].map(([node, rs]) => {
      const labels = new Set([...rs].flatMap((r) => (roots.get(r) ?? []).map((u) => u.label)));
      return [node, { units: rs.size, obligations: labels.size }];
    }),
  );
}

const ROOT_ONLY = '证据单元自身变化，依赖闭包未变';
const PATH_ONLY = '仅绑定 / 路径变化';
const ONE_SIDE = '该节点只在一侧快照可达，闭包变化见对应的边变化组';

/** 组内所有 impact 的 closureChanged 都是 false 时，按种类写明原因（§3.2 规则 7）。 */
function reasonOf(kinds: readonly StaleKind[]): string {
  if (kinds.length === 1 && kinds[0] === 'root') return ROOT_ONLY;
  return kinds.some((k) => k === 'edge' || k === 'binding') ? PATH_ONLY : ONE_SIDE;
}

/** 一个变更节点一条文本：变化说明 + 受影响计数 + 逐条（义务 + 链），全部列出，不截断。 */
export function formatGroup(group: StaleGroup, bindingText?: (node: string) => string): string {
  const { node, kinds, impacts } = group;
  const edges = [...(group.added ?? []).map((d) => `+${d}`), ...(group.removed ?? []).map((d) => `-${d}`)].join('、');
  const changes = [
    ...(kinds.includes('root') ? [`证据单元 ${node} 自身已变化（摘要变化或未登记）`] : []),
    ...(kinds.includes('digest') ? [`依赖 ${node} 已变化（摘要）`] : []),
    ...(kinds.includes('edge') ? [`依赖 ${node} 的直接依赖变化：${edges}`] : []),
    ...(kinds.includes('binding')
      ? [`依赖 ${node} 绑定变化（当前绑定清单：${bindingText?.(node) ?? '见源码'}；旧清单用 explain-graph-diff 查看）`]
      : []),
  ];
  const obligations = new Set(impacts.flatMap((i) => i.uses.map((u) => u.label))).size;
  const unchanged = impacts.every((i) => !i.closureChanged);
  const scope = `受影响 ${impacts.length} 个证据单元 / ${obligations} 条义务`;
  const note = unchanged ? `（其中 0 个闭包集合变化：${reasonOf(kinds)}）` : '';
  return [
    `${changes.join('；')}。`,
    `  ${scope}${note}，逐条复核：`,
    ...impacts.flatMap((i) =>
      (i.uses.length ? i.uses.map((u) => u.label) : [i.root]).map(
        (label) => `  - ${label}  链(${i.snapshot})：${i.chain.join(' → ')}`,
      ),
    ),
  ].join('\n');
}
