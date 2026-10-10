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
import { MAX_DEPTH } from './support/route-policy/evidence-closure.js';
import type { Graph, Registry } from './support/route-policy/evidence-graph.js';
import { impactCounts, type StaleGroup, staleGroups, type Use } from './support/route-policy/evidence-report.js';
import {
  checkEvidence,
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
const digestOf = (r: Registry, id: string) => r.nodes[id]?.[0] ?? r.units[fileOf(id)]?.[nameOf(id)];
const bindingOf = (r: Registry, id: string) => r.nodes[id]?.[1] ?? r.unitBindings[id];
const present = (r: Registry, id: string) => id in r.nodes || id in r.unitBindings;

interface Oracle {
  readonly dd: Set<string>;
  readonly de: Set<string>;
  readonly db: Set<string>;
  readonly dr: Set<string>;
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
  const dd = new Set(
    [...ids].filter((id) => id in reg.nodes && id in cur.nodes && reg.nodes[id]![0] !== cur.nodes[id]![0]),
  );
  const graphIds = new Set([...Object.keys(reg.graph), ...Object.keys(cur.graph), ...ids]);
  const de = new Set([...graphIds].filter((id) => !sameSet(reg.graph[id] ?? [], cur.graph[id] ?? [])));
  const db = new Set(
    [...ids].filter((id) => present(reg, id) && present(cur, id) && bindingOf(reg, id) !== bindingOf(cur, id)),
  );
  const unitDigest = (x: Registry, r: string) => x.units[fileOf(r)]?.[nameOf(r)];
  const dr = new Set(
    [...roots.keys()].filter((r) => unitDigest(reg, r) !== unitDigest(cur, r) || !(r in reg.unitBindings)),
  );
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
  return { dd, de, db, dr, ...maps };
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
    // 影响集合完整：除纯根变化外恰为 R_reg ∪ R_cur（不多不少）
    if (!(g.kinds.length === 1 && g.kinds[0] === 'root')) {
      const expected = new Set([...(o.rReg.get(g.node) ?? []), ...(o.rCur.get(g.node) ?? [])]);
      expect(new Set(g.impacts.map((i) => i.root)), `影响集合：${g.node}`).toEqual(expected);
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
  return { table, reg, cur, roots, groups: staleGroups({ reg, cur, roots }), found };
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
    [...roots().keys()].filter((r) => r === id || dist(REGISTRY.graph, r).has(id)).length;

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
    const counts = impactCounts(REGISTRY.graph, roots());
    const target = 'apps/api/src/modules/permission/module-access.ts#terms';
    const reaching = [...roots()].filter(([r]) => r === target || dist(REGISTRY.graph, r).has(target));
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
