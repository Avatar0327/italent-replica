/**
 * AC-PRM-FW-02（续，F-072 PR-2 集中报告，docs/08_设计/F-072_闭包边界降噪_方案.md §3、§6 测试 8～14；DEC-374①、DEC-388④）：
 * 一个共享依赖变了，`EVIDENCE_STALE` 按“唯一变更节点”集中报告一条，附完整反向影响清单（全部证据单元 → 全部义务）；
 * 影响集合在新、旧两个快照上分别求可达再取并（不在并图上求）。旧逐根算法作 oracle（只在本文件），逐条核对每条影响（A1～A5）。
 * 零行为变化：只读源码，不发请求。
 *
 * 与方案文字的一处出入（按 §3.2 公式与 A2 为准）：§6 测试 10 写“A 组的 impacts 不含 R”，但 R_reg(A) ∋ R（旧图 R→A），
 * 公式要求取并，所以 A 组含 R，且只以 snapshot 'reg' 出现；测试 10 断言“任何关于 X 的报告都不含 R、A 组不经 cur 快照连到 R”。
 */
import { describe, expect, it } from 'vitest';
import type { Finding } from './support/route-policy/compare.js';
import { EVIDENCE_BOUNDARY, inBoundary } from './support/route-policy/evidence-boundary.js';
import { MAX_DEPTH } from './support/route-policy/evidence-closure.js';
import type { Graph, Registry } from './support/route-policy/evidence-graph.js';
import { impactCounts, type StaleGroup, staleGroups, type Use } from './support/route-policy/evidence-report.js';
import {
  checkEvidence,
  closureReports,
  currentRegistry,
  REGISTRY,
  repoSource,
  type SourceReader,
  unitText,
  usesOf,
} from './support/route-policy/evidence.js';
import { REQUIRED } from './support/route-policy/required/index.js';
import { TENANT_SETTINGS } from './support/route-policy/required/tenant-settings.js';
import type { RequiredTable } from './support/route-policy/required/types.js';

const FX = 'apps/api/src/modules/fx';
const readerOf =
  (files: Record<string, string>): SourceReader =>
  (file) =>
    files[file] ?? repoSource(file);
/** 当前源码算出的图（R_cur 的依据；与登记同步时等于登记图，但统计应以当前源码为准）。 */
let currentGraph: Graph | undefined;
const curGraph = () => (currentGraph ??= currentRegistry(REQUIRED).graph);
const show = (found: readonly Finding[]) => found.map((f) => `${f.route} ${f.code}: ${f.detail}`).join('\n');

// ---------------------------------------------------------------------------------------------------------------
// oracle：独立实现（不复用被测代码的 walk / 影响集合），旧逐根算法 + A1～A5（方案 §3.3、§3.4）
// ---------------------------------------------------------------------------------------------------------------

type Roots = ReadonlyMap<string, readonly Use[]>;
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
const fileOf = (id: string) => id.slice(0, id.indexOf('#'));
const nameOf = (id: string) => id.slice(id.indexOf('#') + 1);

/** 朴素广度优先：到各节点的最短层数（含 MAX_DEPTH 上限，根自身为 0）。 */
function dist(graph: Graph, root: string): Map<string, number> {
  const out = new Map<string, number>([[root, 0]]);
  let layer = [root];
  for (let depth = 1; depth <= MAX_DEPTH && layer.length; depth++) {
    const next: string[] = [];
    for (const id of layer) {
      for (const dep of graph[id] ?? []) {
        if (out.has(dep)) continue;
        out.set(dep, depth);
        next.push(dep);
      }
    }
    layer = next;
  }
  return out;
}
/** Cl_G(r)：不含根自身；未登记的根在登记侧视为空闭包（与“依赖闭包没有登记”一致）。 */
function closure(registry: Registry, root: string, registered = true): Set<string> {
  if (!registered) return new Set();
  const nodes = new Set(dist(registry.graph, root).keys());
  nodes.delete(root);
  return nodes;
}
/** 旧逐根算法的 D[y]：只看依赖节点记录（nodes），不回退到证据单元摘要——节点记录缺失就是“没有登记”。 */
const digestOf = (r: Registry, id: string) => r.nodes[id]?.[0];

interface Oracle {
  readonly dd: Set<string>;
  readonly de: Set<string>;
  readonly db: Set<string>;
  readonly dr: Set<string>;
  /** 只有证据单元层面的变化（单元摘要 / 单元绑定 / 未登记），节点层面没变：影响只有它自己。 */
  readonly unitLevel: Set<string>;
  readonly rReg: Map<string, Set<string>>;
  readonly rCur: Map<string, Set<string>>;
  readonly added: Map<string, Set<string>>;
  readonly removed: Map<string, Set<string>>;
  readonly changed: Map<string, Set<string>>;
  readonly clReg: Map<string, Set<string>>;
  readonly clCur: Map<string, Set<string>>;
}

function oracleOf(reg: Registry, cur: Registry, roots: Roots): Oracle {
  const ids = new Set([
    ...Object.keys(reg.nodes),
    ...Object.keys(cur.nodes),
    ...Object.keys(reg.unitBindings),
    ...Object.keys(cur.unitBindings),
  ]);
  // Δd：节点摘要变；登记图仍引用、但 nodes 记录缺失的节点也算（登记副本不一致，旧版报为“新增依赖”）
  const regRefs = new Set(Object.values(reg.graph).flat());
  const dd = new Set(
    Object.keys(cur.nodes).filter(
      (id) => digestOf(reg, id) !== digestOf(cur, id) && (id in reg.nodes || regRefs.has(id)),
    ),
  );
  const graphIds = new Set([...Object.keys(reg.graph), ...Object.keys(cur.graph), ...ids]);
  const de = new Set([...graphIds].filter((id) => !sameSet(reg.graph[id] ?? [], cur.graph[id] ?? [])));
  // Δb：节点层面（nodes 记录）与证据单元层面（unitBindings）各自比较，两边都有才算
  const bn = new Set(Object.keys(cur.nodes).filter((id) => id in reg.nodes && reg.nodes[id]![1] !== cur.nodes[id]![1]));
  const bu = new Set(
    Object.keys(cur.unitBindings).filter(
      (id) => id in reg.unitBindings && reg.unitBindings[id] !== cur.unitBindings[id],
    ),
  );
  const db = new Set([...bn, ...bu]);
  const unitDigest = (x: Registry, r: string) => x.units[fileOf(r)]?.[nameOf(r)];
  const dr = new Set(
    [...roots.keys()].filter((r) => unitDigest(reg, r) !== unitDigest(cur, r) || !(r in reg.unitBindings)),
  );
  const unitLevel = new Set([...dr, ...bu].filter((x) => !dd.has(x) && !de.has(x) && !bn.has(x)));
  const maps = {
    rReg: new Map<string, Set<string>>(),
    rCur: new Map<string, Set<string>>(),
    added: new Map<string, Set<string>>(),
    removed: new Map<string, Set<string>>(),
    changed: new Map<string, Set<string>>(),
    clReg: new Map<string, Set<string>>(),
    clCur: new Map<string, Set<string>>(),
  };
  const push = (map: Map<string, Set<string>>, key: string, value: string) =>
    map.set(key, (map.get(key) ?? new Set()).add(value));
  for (const r of roots.keys()) {
    const [a, b] = [closure(reg, r, r in reg.unitBindings), closure(cur, r)];
    maps.clReg.set(r, a);
    maps.clCur.set(r, b);
    for (const x of [r, ...a]) push(maps.rReg, x, r);
    for (const x of [r, ...b]) push(maps.rCur, x, r);
    maps.added.set(r, new Set([...b].filter((y) => !a.has(y))));
    maps.removed.set(r, new Set([...a].filter((y) => !b.has(y))));
    maps.changed.set(r, new Set([...a].filter((y) => b.has(y) && digestOf(reg, y) !== digestOf(cur, y))));
  }
  return { dd, de, db, dr, unitLevel, ...maps };
}

/** 方案 §3.4 的归因：(x, r) 对上有三元组归因到 x。返回 `${x}|${r}` 与已被覆盖的三元组。 */
function attribution(o: Oracle, reg: Registry, cur: Registry) {
  const pairs = new Set<string>();
  const covered = new Set<string>();
  const cl = (registry: Registry, t: string) => new Set([t, ...closure(registry, t)]);
  for (const [r, set] of o.changed) {
    for (const y of set) {
      pairs.add(`${y}|${r}`);
      covered.add(`${r}|${y}|changed`);
    }
  }
  for (const x of o.de) {
    const [addedX, removedX] = [
      (cur.graph[x] ?? []).filter((d) => !(reg.graph[x] ?? []).includes(d)),
      (reg.graph[x] ?? []).filter((d) => !(cur.graph[x] ?? []).includes(d)),
    ];
    for (const r of o.rCur.get(x) ?? []) {
      for (const t of addedX) {
        for (const y of cl(cur, t)) {
          if (!o.added.get(r)!.has(y)) continue;
          pairs.add(`${x}|${r}`);
          covered.add(`${r}|${y}|added`);
        }
      }
    }
    for (const r of o.rReg.get(x) ?? []) {
      for (const t of removedX) {
        for (const y of cl(reg, t)) {
          if (!o.removed.get(r)!.has(y)) continue;
          pairs.add(`${x}|${r}`);
          covered.add(`${r}|${y}|removed`);
        }
      }
    }
  }
  return { pairs, covered };
}

/** A1～A4（A5 的 depth-limit 口径见 AC-PRM-FW-02-storage，未解析项的集合见各夹具的 checkEvidence 断言）。 */
function assertOracle(reg: Registry, cur: Registry, roots: Roots, groups: readonly StaleGroup[]) {
  const o = oracleOf(reg, cur, roots);
  const { pairs, covered } = attribution(o, reg, cur);
  const second = new Map(staleGroups({ reg, cur, roots }).map((g) => [g.node, g]));
  const byNode = new Map(groups.map((g) => [g.node, g]));
  expect(byNode.size, '同一节点出了多条').toBe(groups.length);
  // A1 完整：每个三元组都归因到某个 group，且该 group 的这条 impact 标了 closureChanged
  const missing = [...covered].filter((key) => {
    const [r, y, kind] = key.split('|') as [string, string, string];
    return !groups.some(
      (g) => g.impacts.some((i) => i.root === r && i.closureChanged) && attributedTo(o, reg, cur, g.node, r, y, kind),
    );
  });
  expect(missing.slice(0, 5), 'A1：有三元组没有归因到任何 group').toEqual([]);
  const legacyCount = [...o.added.values(), ...o.removed.values(), ...o.changed.values()].reduce(
    (n, s) => n + s.size,
    0,
  );
  expect(covered.size, 'A1：三元组都应被某个变更节点归因').toBe(legacyCount);
  for (const r of o.dr) {
    const own = groups.filter((g) => g.node === r && g.kinds.includes('root'));
    expect(own, `A1：根 ${r} 自身变化`).toHaveLength(1);
    expect(own[0]!.impacts.find((i) => i.root === r)?.self, `A1：${r} self`).toBe(true);
  }
  for (const g of groups) {
    // A2 逐条可靠
    for (const i of g.impacts) {
      const ok =
        (o.rReg.get(g.node)?.has(i.root) ?? false) || (o.rCur.get(g.node)?.has(i.root) ?? false) || i.root === g.node;
      expect(ok, `A2：${g.node} 的影响 ${i.root} 不可达`).toBe(true);
    }
    // 影响集合完整：证据单元层面的变化只列它自己，其余恰为 R_reg ∪ R_cur（不多不少）
    const roots2 = o.unitLevel.has(g.node)
      ? new Set([g.node])
      : new Set([...(o.rReg.get(g.node) ?? []), ...(o.rCur.get(g.node) ?? [])]);
    expect(new Set(g.impacts.map((i) => i.root)), `影响集合：${g.node}`).toEqual(roots2);
    // 链：起于根、止于变更节点，相邻两跳确是所取快照上的直接边，长度最短，且稳定
    for (const i of g.impacts) {
      const graph = i.snapshot === 'cur' ? cur.graph : reg.graph;
      expect(i.chain[0], `链起点：${g.node} × ${i.root}`).toBe(i.root);
      expect(i.chain.at(-1), `链终点：${g.node} × ${i.root}`).toBe(g.node);
      for (let k = 1; k < i.chain.length; k++) {
        expect(graph[i.chain[k - 1]!] ?? [], `链上的边：${i.chain.join(' → ')}`).toContain(i.chain[k]);
      }
      if (i.root !== g.node)
        expect(i.chain.length - 1, `最短链：${i.chain.join(' → ')}`).toBe(dist(graph, i.root).get(g.node));
      expect(second.get(g.node)?.impacts.find((x) => x.root === i.root)?.chain, '链输出不稳定').toEqual(i.chain);
    }
    // A3 标注正确
    for (const i of g.impacts) {
      expect(i.closureChanged, `A3：${g.node} × ${i.root} closureChanged`).toBe(pairs.has(`${g.node}|${i.root}`));
      expect(i.self, `A3：${g.node} × ${i.root} self`).toBe(i.root === g.node && o.dr.has(g.node));
    }
    // A4 无凭空分组
    const expected = [
      ...(o.dd.has(g.node) ? ['digest'] : []),
      ...(o.de.has(g.node) ? ['edge'] : []),
      ...(o.db.has(g.node) ? ['binding'] : []),
      ...(o.dr.has(g.node) ? ['root'] : []),
    ];
    expect([...g.kinds].sort(), `A4：${g.node} 的 kinds`).toEqual(expected.sort());
  }
  const changed = new Set([...o.dd, ...o.de, ...o.db, ...o.dr]);
  const grouped = new Set(groups.map((g) => g.node));
  const absent = [...changed].filter((x) => {
    const affected = o.unitLevel.has(x) ? [x] : [...(o.rReg.get(x) ?? []), ...(o.rCur.get(x) ?? [])];
    return affected.length > 0 && !grouped.has(x);
  });
  expect(absent.slice(0, 5), '变更节点没有出组').toEqual([]);
  for (const g of groups) expect(changed.has(g.node), `A4：${g.node} 不在变更节点集合里`).toBe(true);
  return o;
}

/** 单个三元组是否能归因到 x（A1 用：避免只凭 (x, r) 对粗略放过）。 */
function attributedTo(o: Oracle, reg: Registry, cur: Registry, x: string, r: string, y: string, kind: string): boolean {
  if (kind === 'changed') return x === y;
  const [side, rSet] = kind === 'added' ? [cur, o.rCur] : [reg, o.rReg];
  if (!o.de.has(x) || !rSet.get(x)?.has(r)) return false;
  const [now, was] = [cur.graph[x] ?? [], reg.graph[x] ?? []];
  const ts = kind === 'added' ? now.filter((d) => !was.includes(d)) : was.filter((d) => !now.includes(d));
  return ts.some((t) => t === y || closure(side, t).has(y));
}

// ---------------------------------------------------------------------------------------------------------------
// 夹具构造
// ---------------------------------------------------------------------------------------------------------------

const use = (root: string, index = 1): Use => ({ route: `GET ${root}`, label: `GET ${root} #${index} perm:${root}` });

/** 手写登记：node → 直接依赖；每个出现的节点都有摘要与绑定指纹，根另有单元摘要。 */
function synth(
  graph: Graph,
  roots: readonly string[],
  digests: Record<string, string> = {},
  bindings: Record<string, string> = {},
  unitDigests: Record<string, string> = {},
): Registry {
  const all = new Set([...Object.keys(graph), ...Object.values(graph).flat(), ...roots]);
  const targets = new Set(Object.values(graph).flat());
  const nodes = Object.fromEntries(
    [...all].filter((id) => targets.has(id)).map((id) => [id, [digests[id] ?? 'd0', bindings[id] ?? 'b0']] as const),
  );
  const units: Record<string, Record<string, string>> = {};
  for (const r of roots) (units[fileOf(r)] ??= {})[nameOf(r)] = unitDigests[r] ?? digests[r] ?? 'd0';
  return { units, unitBindings: Object.fromEntries(roots.map((r) => [r, bindings[r] ?? 'b0'])), nodes, graph };
}
const rootsOf = (...ids: string[]): Roots => new Map(ids.map((id) => [id, [use(id)]]));

function fixtureRun(files: Record<string, string>, patch: Record<string, string>, ...units: string[]) {
  const table: RequiredTable = Object.fromEntries(
    units.map((unit, i) => [
      `GET /api/tenant/fx${i}`,
      [{ perm: `btn:Fx${i}#open@list`, at: [{ role: 'call' as const, unit, anchor: 'return' }] }],
    ]),
  );
  const reg = currentRegistry(table, readerOf(files), false);
  const cur = currentRegistry(table, readerOf({ ...files, ...patch }), false);
  const roots = usesOf(table, false);
  const found = checkEvidence(table, {
    read: readerOf({ ...files, ...patch }),
    branch: false,
    registry: reg,
    digests: reg.units,
  });
  const read = readerOf({ ...files, ...patch });
  expect(unresolvedKeys(found), 'A5：未解析项集合').toEqual(expectedUnresolved(table, read, false));
  return { table, reg, cur, roots, groups: staleGroups({ reg, cur, roots }), found };
}

/** A5：除 depth-limit 口径外，未解析项的完整集合与旧算法（逐根源码解析的 closureReports）逐项相等。 */
function unresolvedKeys(found: readonly Finding[]) {
  return found
    .filter((f) => f.code === 'EVIDENCE_CLOSURE_UNRESOLVED')
    .map((f) => f.detail)
    .sort();
}
function expectedUnresolved(table: RequiredTable, read: SourceReader, branch: false | undefined = undefined) {
  const reports = closureReports(table, read, branch === undefined ? undefined : false);
  return reports
    .flatMap((r) => r.unresolved.map((u) => ({ unit: r.unit, u })))
    .filter(({ u }) => u.file.startsWith('apps/api/src/modules/') && !inBoundary(u.file, EVIDENCE_BOUNDARY))
    .map(({ unit, u }) => `${unit} 的依赖闭包有解析不了的项：${u.reason} ${u.detail}（${u.file}）`)
    .sort();
}

// ---------------------------------------------------------------------------------------------------------------
// 8、14 真实表
// ---------------------------------------------------------------------------------------------------------------

describe('AC-PRM-FW-02 集中报告：真实表（F-072 测试 8、14）', () => {
  const roots = () => usesOf(REQUIRED);
  /** 在函数体末尾加一个不改依赖 / 绑定的语句 → 只有摘要变化。 */
  const touch = (id: string) => {
    const text = unitText(repoSource, id);
    const end = text.lastIndexOf('}');
    const file = fileOf(id);
    return { file, text: repoSource(file).replace(text, `${text.slice(0, end)}void 0; ${text.slice(end)}`) };
  };
  const independentCount = (id: string) =>
    [...roots().keys()].filter((r) => r === id || dist(curGraph(), r).has(id)).length;

  it('改一个被多个根引用的依赖（domain/qualification/catalog.ts 的某函数）→ 恰好 1 条，impacts 数 = R_cur 实测，含每个根的全部 uses', () => {
    const rootIds = new Set(roots().keys());
    const candidates = Object.keys(REGISTRY.nodes).filter(
      (id) => fileOf(id).endsWith('domain/src/qualification/catalog.ts') && !rootIds.has(id),
    );
    const target = candidates
      .filter((id) => /^(export )?function /.test(safeText(id)))
      .sort((a, b) => independentCount(b) - independentCount(a))[0]!;
    expect(independentCount(target), `${target} 被引用的根太少`).toBeGreaterThan(5);
    const { file, text } = touch(target);
    const reader = readerOf({ [file]: text });
    const cur = currentRegistry(REQUIRED, reader);
    const found = checkEvidence(REQUIRED, { read: reader }).filter((f) => f.code === 'EVIDENCE_STALE');
    expect(found, show(found)).toHaveLength(1);
    const group = found[0]!.group!;
    expect(group.node).toBe(target);
    expect(group.kinds).toEqual(['digest']);
    expect(group.impacts).toHaveLength(independentCount(target));
    for (const impact of group.impacts) expect(impact.uses).toEqual(roots().get(impact.root));
    expect(found[0]!.detail).toContain(`受影响 ${group.impacts.length} 个证据单元`);
    expect(found[0]!.detail).not.toMatch(/共 \d+ 处/);
    expect(found[0]!.route).toBe('*');
    assertOracle(REGISTRY, cur, roots(), [group]);
  });

  const safeText = (id: string) => {
    try {
      return unitText(repoSource, id);
    } catch {
      return '';
    }
  };

  it('留在闭包的不变：module-access.ts#terms 改动 → 1 条，impacts = 实测根数（审查时 380）', () => {
    const target = 'apps/api/src/modules/permission/module-access.ts#terms';
    const { file, text } = touch(target);
    const found = checkEvidence(REQUIRED, { read: readerOf({ [file]: text }) }).filter(
      (f) => f.code === 'EVIDENCE_STALE',
    );
    expect(found, show(found)).toHaveLength(1);
    expect(found[0]!.group!.node).toBe(target);
    expect(found[0]!.group!.impacts).toHaveLength(independentCount(target));
    expect(independentCount(target)).toBeGreaterThan(300);
  });

  it('依赖牵连的义务数分布从 R_cur 计算：同一义务只算一次，与独立实现一致', () => {
    const counts = impactCounts(curGraph(), roots());
    const target = 'apps/api/src/modules/permission/module-access.ts#terms';
    const reaching = [...roots()].filter(([r]) => r === target || dist(curGraph(), r).has(target));
    expect(counts.get(target)).toEqual({
      units: reaching.length,
      obligations: new Set(reaching.flatMap(([, uses]) => uses.map((u) => u.label))).size,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 10、11、12 合成登记：并图虚假影响、链快照、根同时是依赖
// ---------------------------------------------------------------------------------------------------------------

describe('AC-PRM-FW-02 集中报告：分快照求影响（F-072 测试 10、11、12）', () => {
  const [R, A, B, X, Y] = ['R', 'A', 'B', 'X', 'Y'].map((n) => `r.ts#${n}`) as [string, string, string, string, string];

  it('并图虚假影响：旧 R→A→Y，新 R→B→Y 且新增 A→X；任何关于 X 的报告都不含 R，A 组只以 reg 快照连到 R', () => {
    const reg = synth({ [R]: [A], [A]: [Y] }, [R]);
    const cur = synth({ [R]: [B], [B]: [Y], [A]: [Y, X] }, [R]);
    const roots = rootsOf(R);
    const groups = staleGroups({ reg, cur, roots });
    assertOracle(reg, cur, roots, groups);
    expect(groups.filter((g) => g.node === X)).toEqual([]);
    const a = groups.find((g) => g.node === A)!;
    expect(a.added).toEqual([X]);
    expect(a.impacts.map((i) => [i.root, i.snapshot])).toEqual([[R, 'reg']]);
    expect(a.impacts[0]!.closureChanged).toBe(false);
    // 并图上 R 能走到 X；分快照没有任何一条 impact 的链在 cur 快照上经 A 连到 X
    expect(groups.flatMap((g) => g.impacts).filter((i) => i.snapshot === 'cur' && i.chain.includes(X))).toEqual([]);
  });

  it('链快照：根在新图仍可达 → cur；节点没删但该根已不可达 → reg', () => {
    const reg = synth({ [R]: [A], [A]: [Y] }, [R], { [Y]: 'old' });
    const cur = synth({ [R]: [B], [B]: [Y], [A]: [Y] }, [R], { [Y]: 'new' });
    const roots = rootsOf(R);
    const groups = staleGroups({ reg, cur, roots });
    assertOracle(reg, cur, roots, groups);
    const y = groups.find((g) => g.node === Y)!;
    expect(y.impacts.map((i) => [i.snapshot, i.chain])).toEqual([['cur', [R, B, Y]]]);
    const a = groups.find((g) => g.node === A);
    // A 自身没变（图、摘要、绑定都同），不出组；根的边变化出在 R 上，R 在两个快照里都是影响
    expect(a).toBeUndefined();
    const r = groups.find((g) => g.node === R)!;
    expect(r.kinds).toEqual(['edge']);
    const changedA = synth({ [R]: [B], [B]: [Y], [A]: [Y, X] }, [R]);
    const regA = synth({ [R]: [A], [A]: [Y] }, [R]);
    const forA = staleGroups({ reg: regA, cur: changedA, roots }).find((g) => g.node === A)!;
    expect(forA.impacts.map((i) => [i.snapshot, i.chain])).toEqual([['reg', [R, A]]]);
  });

  it('证据单元自身改动且它也是别人的依赖 → 1 条，kinds 含 root 与 digest', () => {
    const [R1, R2] = ['a.ts#R1', 'b.ts#R2'] as const;
    const reg = synth({ [R2]: [R1], [R1]: [Y] }, [R1, R2]);
    const cur = synth({ [R2]: [R1], [R1]: [Y] }, [R1, R2], { [R1]: 'new' });
    const roots = rootsOf(R1, R2);
    const groups = staleGroups({ reg, cur, roots });
    assertOracle(reg, cur, roots, groups);
    expect(groups).toHaveLength(1);
    expect([...groups[0]!.kinds].sort()).toEqual(['digest', 'root']);
    expect(groups[0]!.impacts.map((i) => [i.root, i.self])).toEqual([
      [R1, true],
      [R2, false],
    ]);
  });
});

describe('AC-PRM-FW-02 集中报告：纯根变化（F-072 测试 12b，R2-2）', () => {
  it('tenant-settings 路由处理函数里 requirePermission 的 action 实参改掉、锚点同步 → 1 条，kinds = [root]，自身', () => {
    const key = 'GET /api/tenant/settings/:key';
    const original = TENANT_SETTINGS[key]![0]!;
    const [call, ...rest] = original.at;
    const anchor = call!.anchor.replace('tenant.settings.read', 'tenant.settings.write');
    const table: RequiredTable = { [key]: [{ ...original, at: [{ ...call!, anchor }, ...rest] }] };
    const file = 'apps/api/src/modules/tenant-settings/routes.ts';
    const patched = repoSource(file).replace(
      "action: 'tenant.settings.read', resource: key })",
      "action: 'tenant.settings.write', resource: key })",
    );
    expect(patched).not.toBe(repoSource(file));
    const reg = currentRegistry({ [key]: [{ ...original }] }, repoSource);
    const reader = readerOf({ [file]: patched });
    const cur = currentRegistry(table, reader);
    const roots = usesOf(table);
    const groups = staleGroups({ reg, cur, roots });
    const o = assertOracle(reg, cur, roots, groups);
    expect([...o.added.values(), ...o.removed.values(), ...o.changed.values()].every((s) => s.size === 0)).toBe(true);
    const unit = `${file}#route:${key}`;
    expect(o.dr).toEqual(new Set([unit]));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kinds).toEqual(['root']);
    expect(groups[0]!.impacts.map((i) => [i.root, i.self, i.closureChanged])).toEqual([[unit, true, false]]);
    const found = checkEvidence(table, { read: reader, registry: reg, digests: reg.units }).filter(
      (f) => f.code === 'EVIDENCE_STALE',
    );
    expect(found, show(found)).toHaveLength(1);
    expect(found[0]!.detail).toContain('证据单元自身变化');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 9 极限夹具
// ---------------------------------------------------------------------------------------------------------------

type Adjacency = Record<string, readonly string[]>;
const pad = (n: number) => String(n).padStart(2, '0');
function sourceOf(adjacency: Adjacency, bodies: Record<string, string> = {}): string {
  return Object.entries(adjacency)
    .map(([name, deps]) => {
      const body = bodies[name] ?? (deps.length ? deps.map((d) => `${d}(x)`).join(' + ') : 'x');
      return `${name === 'gate' ? 'export ' : ''}function ${name}(x: number): number {\n  return ${body};\n}\n`;
    })
    .join('\n');
}
const chainAdj = (length: number, tail: Adjacency = {}): Adjacency => {
  const out: Record<string, string[]> = { gate: ['n01'] };
  for (let i = 1; i < length; i++) out[`n${pad(i)}`] = [`n${pad(i + 1)}`];
  return { ...out, ...tail };
};

describe('AC-PRM-FW-02 集中报告：极限夹具 A1～A5（F-072 测试 9）', () => {
  const DEEP = `${FX}/deep.ts`;
  const gateOf = (adjacency: Adjacency, bodies?: Record<string, string>) => ({ [DEEP]: sourceOf(adjacency, bodies) });
  const unit = `${DEEP}#gate`;

  it('环 A↔B：改环里一个节点的实现，多个节点同时改（摘要 + 边）', () => {
    const cycle = { gate: ['ping'], ping: ['pong'], pong: ['ping', 'leaf'], leaf: [] };
    const files = gateOf(cycle);
    const one = fixtureRun(files, gateOf(cycle, { pong: 'ping(x) + leaf(x) + 1' }), unit);
    assertOracle(one.reg, one.cur, one.roots, one.groups);
    expect(one.groups.map((g) => g.node)).toEqual([`${DEEP}#pong`]);
    const many = fixtureRun(
      files,
      gateOf({ ...cycle, ping: ['pong', 'leaf'] }, { pong: 'ping(x) + leaf(x) + 1', leaf: 'x + 2' }),
      unit,
    );
    assertOracle(many.reg, many.cur, many.roots, many.groups);
    expect(many.groups.map((g) => g.node).sort()).toEqual([`${DEEP}#leaf`, `${DEEP}#ping`, `${DEEP}#pong`]);
  });

  it('40 / 41 层链：路径缩短后才进入上限内', () => {
    const long = chainAdj(44);
    const files = gateOf({ ...long, n44: [] });
    const shortcut = gateOf({ ...long, n44: [], gate: ['n01', 'n12'] });
    const run = fixtureRun(files, shortcut, unit);
    assertOracle(run.reg, run.cur, run.roots, run.groups);
    const tail = run.groups.find((g) => g.node === unit)!;
    expect(tail.kinds).toContain('edge');
    // 旧图里 n43 在第 43 层越界，不在闭包里；新图经捷径进入上限内 → 归因到 gate 的边变化
    expect(closureOf(run.reg, unit).has(`${DEEP}#n43`)).toBe(false);
    expect(closureOf(run.cur, unit).has(`${DEEP}#n43`)).toBe(true);
  });

  it('上限层同层交叉边 / 回指根：改上限层节点的实现，A1～A5 成立', () => {
    const cross: Adjacency = { ...chainAdj(39), n39: ['z40', 'a40'], z40: ['a40'], a40: [] };
    const back: Adjacency = { ...chainAdj(39), n39: ['n40'], n40: ['gate'] };
    for (const shape of [cross, back]) {
      const last = shape['a40'] ? 'a40' : 'n40';
      const run = fixtureRun(
        gateOf(shape),
        gateOf(shape, { [last]: last === 'a40' ? 'x + 7' : 'x ? gate(0) : 9' }),
        unit,
      );
      assertOracle(run.reg, run.cur, run.roots, run.groups);
      expect(run.groups.length).toBeGreaterThan(0);
    }
  });

  it('unresolved（动态 import、命名空间计算属性）：集合不变，集中报告照出', () => {
    const gate =
      "import * as helpers from './h.js';\n" +
      'export function gate(kind: string) {\n  return helpers[kind](kind);\n}\n';
    const h = 'export function a() {\n  return 1;\n}\n';
    const files = { [`${FX}/gate.ts`]: gate, [`${FX}/h.ts`]: h };
    const run = fixtureRun(
      files,
      { [`${FX}/gate.ts`]: gate.replace('helpers[kind](kind)', 'helpers[kind](kind) + 1') },
      `${FX}/gate.ts#gate`,
    );
    assertOracle(run.reg, run.cur, run.roots, run.groups);
    expect(run.found.filter((f) => f.code === 'EVIDENCE_CLOSURE_UNRESOLVED').length).toBe(1);
    expect(run.found.filter((f) => f.code === 'EVIDENCE_STALE')).toHaveLength(1);
    const dyn = `export async function gate() {\n  const { a } = await import('./h.js');\n  return a();\n}\n`;
    const dynFiles = { [`${FX}/gate.ts`]: dyn, [`${FX}/h.ts`]: h };
    const run2 = fixtureRun(dynFiles, { [`${FX}/h.ts`]: h.replace('return 1', 'return 2') }, `${FX}/gate.ts#gate`);
    assertOracle(run2.reg, run2.cur, run2.roots, run2.groups);
    expect(run2.groups.map((g) => g.node)).toEqual([`${FX}/h.ts#a`]);
  });
});

const closureOf = (registry: Registry, root: string) => closure(registry, root);

// ---------------------------------------------------------------------------------------------------------------
// 13 oracle 随机变异
// ---------------------------------------------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('AC-PRM-FW-02 集中报告：oracle 随机变异（F-072 测试 13）', () => {
  it('真实登记上固定种子改 30 个节点（摘要 / 加边 / 删边 / 绑定 / 别名交换 / 纯根），A1～A4 逐条成立', () => {
    const rand = mulberry32(20261010);
    const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;
    const roots = usesOf(REQUIRED);
    const nodeIds = Object.keys(REGISTRY.nodes);
    const graphIds = Object.keys(REGISTRY.graph);
    const reg = {
      units: structuredClone(REGISTRY.units) as Record<string, Record<string, string>>,
      unitBindings: { ...REGISTRY.unitBindings },
      nodes: { ...REGISTRY.nodes } as Record<string, readonly [string, string]>,
      graph: { ...REGISTRY.graph } as Record<string, readonly string[]>,
    };
    const kinds = ['digest', 'addEdge', 'removeEdge', 'binding', 'alias', 'root'] as const;
    const done = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const kind = kinds[i % kinds.length]!;
      done.add(kind);
      if (kind === 'digest') {
        const id = pick(nodeIds);
        reg.nodes[id] = [`m${i}${reg.nodes[id]![0].slice(2)}`, reg.nodes[id]![1]];
      } else if (kind === 'addEdge') {
        const from = pick(graphIds);
        const to = pick(nodeIds);
        reg.graph[from] = [...(reg.graph[from] ?? []).filter((d) => d !== to), to].sort();
      } else if (kind === 'removeEdge') {
        const from = pick(graphIds);
        reg.graph[from] = (reg.graph[from] ?? []).slice(1);
      } else if (kind === 'binding' || kind === 'alias') {
        // 别名交换：邻接与摘要都不变，只有绑定指纹变（登记侧改指纹等价于这类源码变化）
        const id = pick(nodeIds);
        reg.nodes[id] = [reg.nodes[id]![0], `x${i}${reg.nodes[id]![1].slice(2)}`];
      } else {
        const unit = pick([...roots.keys()]);
        const units = reg.units[fileOf(unit)]!;
        units[nameOf(unit)] = `z${i}${units[nameOf(unit)]!.slice(2)}`;
      }
    }
    expect(done.size).toBe(kinds.length);
    const groups = staleGroups({ reg, cur: REGISTRY, roots });
    expect(groups.length).toBeGreaterThan(10);
    assertOracle(reg, REGISTRY, roots, groups);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 输出形态
// ---------------------------------------------------------------------------------------------------------------

describe('AC-PRM-FW-02 集中报告：输出形态（F-072 §3.2 规则 1、3、7）', () => {
  const lib = `${FX}/lib.ts`;
  const files = {
    [`${FX}/g1.ts`]: "import { shared } from './lib.js';\nexport function g1() {\n  return shared();\n}\n",
    [`${FX}/g2.ts`]: "import { shared } from './lib.js';\nexport function g2() {\n  return shared() + 1;\n}\n",
    [lib]: 'export function shared() {\n  return 1;\n}\n',
  };
  const run = (patch: Record<string, string>) => fixtureRun(files, patch, `${FX}/g1.ts#g1`, `${FX}/g2.ts#g2`);

  it('一个节点一条；同一证据单元出现在多条里是正确的；全部列出，不截断', () => {
    const body = (n: number) => `export function shared() {\n  return ${n};\n}\n`;
    const one = run({ [lib]: body(2) });
    const stale = one.found.filter((f) => f.code === 'EVIDENCE_STALE');
    expect(stale).toHaveLength(1);
    expect(stale[0]!.detail).toContain('依赖');
    expect(stale[0]!.detail).toContain('已变化（摘要）');
    expect(stale[0]!.detail).toContain('受影响 2 个证据单元 / 2 条义务，逐条复核：');
    expect(stale[0]!.detail).toContain('链(cur)：');
    expect(stale[0]!.detail).toContain(`${FX}/g1.ts#g1 → ${lib}#shared`);
    const both = run({
      [lib]: body(2),
      [`${FX}/g1.ts`]: files[`${FX}/g1.ts`].replace('return shared();', 'return shared() + 1;'),
    });
    const groups = both.found.filter((f) => f.code === 'EVIDENCE_STALE');
    // shared（摘要）与 g1（证据单元自身，同时是别人的依赖？否：g1 只作根）各一条
    expect(groups.map((f) => f.group!.node).sort()).toEqual([`${FX}/g1.ts#g1`, `${lib}#shared`]);
  });

  it('rule 7：闭包没变的组按种类写明原因', () => {
    const rebound = run({
      [`${FX}/g1.ts`]: "import { shared as other } from './lib.js';\nexport function g1() {\n  return other();\n}\n",
    });
    const texts = rebound.found.filter((f) => f.code === 'EVIDENCE_STALE').map((f) => f.detail);
    expect(texts.length).toBeGreaterThan(0);
    const root = run({ [`${FX}/g2.ts`]: files[`${FX}/g2.ts`].replace('+ 1', '+ 2') });
    expect(root.found.filter((f) => f.code === 'EVIDENCE_STALE')[0]!.detail).toContain(
      '证据单元自身变化，依赖闭包未变',
    );
  });

  it('不截断：一次改 7 个共享函数 → 7 条，每条都带完整影响清单，文本没有 “共 N 处”', () => {
    const fns = Array.from({ length: 7 }, (_, i) => `f${i}`);
    const base = fns.map((f, i) => `export function ${f}() {\n  return ${i};\n}\n`).join('');
    const bumped = fns.map((f, i) => `export function ${f}() {\n  return ${i + 100};\n}\n`).join('');
    const calls = fns.map((f) => `${f}()`).join(' + ');
    const gate = `import { ${fns.join(', ')} } from './lib.js';\nexport function gate() {\n  return ${calls};\n}\n`;
    const many = fixtureRun({ [`${FX}/gate.ts`]: gate, [lib]: base }, { [lib]: bumped }, `${FX}/gate.ts#gate`);
    const stale = many.found.filter((f) => f.code === 'EVIDENCE_STALE');
    expect(stale).toHaveLength(7);
    expect(stale.every((f) => f.group!.impacts.length === 1 && !/共 \d+ 处/.test(f.detail))).toBe(true);
    assertOracle(many.reg, many.cur, many.roots, many.groups);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 第 1 轮审查 P2-1：登记副本不一致时，集中报告不得少于旧版
// ---------------------------------------------------------------------------------------------------------------

describe('AC-PRM-FW-02 集中报告：登记缺项 / 副本不一致不丢失（#212 第 1 轮 P2-1）', () => {
  const roots = () => usesOf(REQUIRED);
  const rootIds = () => new Set(roots().keys());
  /** 每个节点被多少个根（含自身为根）到达：对所有根各做一次朴素 BFS 累加，只算一次。 */
  let counts: Map<string, number> | undefined;
  const reachCount = (id: string) => {
    if (!counts) {
      counts = new Map();
      for (const root of roots().keys()) {
        for (const node of dist(REGISTRY.graph, root).keys()) counts.set(node, (counts.get(node) ?? 0) + 1);
      }
    }
    return counts.get(id) ?? 0;
  };
  const without = <T>(record: Readonly<Record<string, T>>, key: string) =>
    Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
  const stale = (reg: Registry) =>
    checkEvidence(REQUIRED, { registry: reg }).filter((f) => f.code === 'EVIDENCE_STALE');

  /** 登记里删掉某个节点的 nodes 记录，图仍引用它：旧版对每个引用它的根报“新增依赖”。 */
  const dropped = (id: string): Registry => ({ ...REGISTRY, nodes: without(REGISTRY.nodes, id) });

  const candidates = () =>
    Object.keys(REGISTRY.nodes)
      .filter((id) => reachCount(id) > 20)
      .sort((a, b) => reachCount(b) - reachCount(a));

  it('图仍引用节点但 nodes.ts 缺记录（叶子 / 非叶子 / 兼作根的依赖）：每个引用它的根都在报告里', () => {
    const all = candidates();
    const leaf = all.find((id) => !(id in REGISTRY.graph) && !rootIds().has(id));
    const inner = all.find((id) => id in REGISTRY.graph && !rootIds().has(id));
    const dual = all.find((id) => rootIds().has(id));
    expect([leaf, inner, dual].every(Boolean), '真实登记里找不到三类样本').toBe(true);
    for (const id of [leaf!, inner!, dual!]) {
      const reg = dropped(id);
      const found = stale(reg);
      expect(found, `${id}\n${show(found)}`).toHaveLength(1);
      const group = found[0]!.group!;
      expect(group.node).toBe(id);
      expect(group.kinds).toContain('digest');
      expect(group.impacts).toHaveLength(reachCount(id));
      expect(
        group.impacts.every((i) => i.root === id || i.closureChanged),
        `${id} 每条影响都有闭包级变化`,
      ).toBe(true);
      assertOracle(reg, REGISTRY, roots(), staleGroups({ reg, cur: REGISTRY, roots: roots() }));
    }
  });

  it('terms 的节点行被删（审查复现）：旧版 405 条 → 新版 1 条，405 个根都在', () => {
    const id = 'apps/api/src/modules/permission/module-access.ts#terms';
    const found = stale(dropped(id));
    expect(found).toHaveLength(1);
    expect(found[0]!.group!.impacts).toHaveLength(reachCount(id));
    expect(reachCount(id)).toBeGreaterThan(300);
  });

  it('某单元既是证据根又是依赖，只有 unitBindings 指纹过期：只出该根自己（旧版 1 条）', () => {
    const unit = 'apps/api/src/audit/routes.ts#auditContext';
    expect(rootIds().has(unit) && unit in REGISTRY.nodes, '样本应兼作根与依赖').toBe(true);
    const reg = { ...REGISTRY, unitBindings: { ...REGISTRY.unitBindings, [unit]: 'stale0000000' } };
    const found = stale(reg);
    expect(found, show(found)).toHaveLength(1);
    const group = found[0]!.group!;
    expect(group.node).toBe(unit);
    expect(group.kinds).toEqual(['binding']);
    expect(group.impacts.map((i) => [i.root, i.closureChanged])).toEqual([[unit, false]]);
    assertOracle(reg, REGISTRY, roots(), staleGroups({ reg, cur: REGISTRY, roots: roots() }));
  });

  it('两个 PR 分别解决 units.ts / nodes.ts 冲突后留下的第二种不一致：节点记录与单元指纹各自过期都能报', () => {
    const unit = 'apps/api/src/audit/routes.ts#auditContext';
    const reg: Registry = {
      ...REGISTRY,
      nodes: { ...REGISTRY.nodes, [unit]: [REGISTRY.nodes[unit]![0], 'stale1111111'] },
      unitBindings: { ...REGISTRY.unitBindings, [unit]: 'stale2222222' },
    };
    const groups = staleGroups({ reg, cur: REGISTRY, roots: roots() });
    assertOracle(reg, REGISTRY, roots(), groups);
    const group = groups.find((g) => g.node === unit)!;
    expect(group.kinds).toEqual(['binding']);
    expect(group.impacts.length).toBe(reachCount(unit));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 第 1 轮审查 P3-1：区分力（纯绑定变化组、长链中间跳、unresolved 集合）
// ---------------------------------------------------------------------------------------------------------------

describe('AC-PRM-FW-02 集中报告：区分力（#212 第 1 轮 P3-1）', () => {
  const HELPER = 'export function a() {\n  return 1;\n}\nexport function b() {\n  return 2;\n}\n';
  const GATE = "import { r } from './mid.js';\nexport function gate() {\n  return r();\n}\n";
  const mid = (a: string, b: string) =>
    `import { ${a} as fmt, ${b} as tz } from './h.js';\nexport function r() {\n  return fmt() + tz();\n}\n`;
  const files = { [`${FX}/gate.ts`]: GATE, [`${FX}/mid.ts`]: mid('a', 'b'), [`${FX}/h.ts`]: HELPER };

  it('纯绑定变化（别名交换，摘要与邻接都不变）必须出一个 kinds = [binding] 的组，列全引用它的根', () => {
    const run = fixtureRun(files, { [`${FX}/mid.ts`]: mid('b', 'a') }, `${FX}/gate.ts#gate`);
    assertOracle(run.reg, run.cur, run.roots, run.groups);
    const group = run.groups.find((g) => g.node === `${FX}/mid.ts#r`);
    expect(group?.kinds).toEqual(['binding']);
    expect(group?.impacts.map((i) => [i.root, i.snapshot, i.closureChanged])).toEqual([
      [`${FX}/gate.ts#gate`, 'cur', false],
    ]);
    const stale = run.found.filter((f) => f.code === 'EVIDENCE_STALE');
    expect(stale).toHaveLength(1);
    expect(stale[0]!.detail).toContain('绑定变化');
    expect(stale[0]!.detail).toContain('仅绑定 / 路径变化');
  });

  it('长度大于 5 的链：每一跳都是真实直接边、长度最短、逐跳输出（中间跳不能丢）', () => {
    const adjacency = chainAdj(12, { n12: [] });
    const run = fixtureRun(
      { [`${FX}/deep.ts`]: sourceOf(adjacency) },
      { [`${FX}/deep.ts`]: sourceOf(adjacency, { n12: 'x + 5' }) },
      `${FX}/deep.ts#gate`,
    );
    assertOracle(run.reg, run.cur, run.roots, run.groups);
    const impact = run.groups.find((g) => g.node.endsWith('#n12'))!.impacts[0]!;
    expect(impact.chain).toHaveLength(13);
    expect(impact.chain.map((id) => id.split('#')[1])).toEqual([
      'gate',
      ...Array.from({ length: 12 }, (_, i) => `n${pad(i + 1)}`),
    ]);
    const text = run.found.find((f) => f.group?.node.endsWith('#n12'))!.detail;
    for (const node of impact.chain) expect(text).toContain(node);
  });
});

describe('AC-PRM-FW-02 集中报告：纯证据根第一次成为依赖不算摘要变化（#212 第 2 轮 P2-R2-1）', () => {
  const files = {
    [`${FX}/r.ts`]: "import { a } from './h.js';\nexport function R() {\n  return a();\n}\n",
    [`${FX}/h.ts`]: 'export function a() {\n  return 1;\n}\n',
    [`${FX}/s.ts`]: 'export function S() {\n  return 1;\n}\n',
  };
  const S = `${FX}/s.ts#S`;
  const R = `${FX}/r.ts#R`;

  it('R、S 都是证据根，R 调用 a()、S 返回 1；只把 S 改成调用 R → 只出 S 一组（旧逐根实现同），不出 R 的 digest 组', () => {
    const patch = {
      [`${FX}/s.ts`]: "import { R } from './r.js';\nexport function S() {\n  return R();\n}\n",
    };
    const run = fixtureRun(files, patch, R, S);
    // 登记里 R 是有出边的纯根：有 graph 键、没有 nodes 记录，这是正常生成结果
    expect(R in run.reg.graph && !(R in run.reg.nodes)).toBe(true);
    assertOracle(run.reg, run.cur, run.roots, run.groups);
    expect(run.groups.map((g) => g.node)).toEqual([S]);
    expect(run.groups[0]!.impacts.map((i) => i.root)).toEqual([S]);
    const stale = run.found.filter((f) => f.code === 'EVIDENCE_STALE');
    expect(stale, show(stale)).toHaveLength(1);
    expect(stale.some((f) => f.detail.includes('R 已变化') || f.detail.includes(`依赖 ${R} 已变化`))).toBe(false);
  });

  it('新增证据根引用一个原本只作根的辅助函数：同样不报该辅助函数的 digest 组', () => {
    const two = { ...files, [`${FX}/t.ts`]: 'export function T() {\n  return 2;\n}\n' };
    const patch = { [`${FX}/t.ts`]: "import { R } from './r.js';\nexport function T() {\n  return R();\n}\n" };
    const run = fixtureRun(two, patch, R, `${FX}/t.ts#T`);
    assertOracle(run.reg, run.cur, run.roots, run.groups);
    expect(run.groups.map((g) => g.node)).toEqual([`${FX}/t.ts#T`]);
  });

  it('纯根与依赖之间的其余转换：叶子根首次成为依赖、根不再是依赖（仍是根）、根改为被另一个根依赖——都只出真正变化的那一组', () => {
    const leafRoot = { ...files, [`${FX}/r.ts`]: 'export function R() {\n  return 3;\n}\n' };
    const callR = "import { R } from './r.js';\nexport function S() {\n  return R();\n}\n";
    const first = fixtureRun(leafRoot, { [`${FX}/s.ts`]: callR }, R, S);
    assertOracle(first.reg, first.cur, first.roots, first.groups);
    expect(first.groups.map((g) => g.node)).toEqual([S]);

    const dependent = { ...files, [`${FX}/s.ts`]: callR };
    const stops = fixtureRun(dependent, { [`${FX}/s.ts`]: files[`${FX}/s.ts`] }, R, S);
    assertOracle(stops.reg, stops.cur, stops.roots, stops.groups);
    expect(stops.groups.map((g) => g.node)).toEqual([S]);

    // 已经是依赖的根，自己的实现改了：节点摘要变化，引用它的根（S）和它自己都在影响里
    const edited = fixtureRun(
      dependent,
      { [`${FX}/r.ts`]: files[`${FX}/r.ts`].replace('return a()', 'return a() + 1') },
      R,
      S,
    );
    assertOracle(edited.reg, edited.cur, edited.roots, edited.groups);
    const group = edited.groups.find((g) => g.node === R)!;
    expect([...group.kinds].sort()).toEqual(['digest', 'root']);
    expect(group.impacts.map((i) => i.root).sort()).toEqual([R, S].sort());
  });
});
