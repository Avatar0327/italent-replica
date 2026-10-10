/**
 * AC-PRM-FW-02（续，F-072 PR-1 图存储，docs/08_设计/F-072_闭包边界降噪_方案.md §4、§6 测试 1～7；DEC-374①）：
 * 证据依赖闭包的登记从“根 → 依赖 → 摘要”平铺（required/digests.ts）改为“节点摘要表 + 直接依赖图”
 * （required/digests/）；闭包在校验时由图推出。报告形态不变（逐根），新增三类发现：图变闭包不变、绑定指纹变化、
 * LEGACY_DIGESTS_PRESENT。depth-limit 按 D-8 ①：与遍历顺序无关，以实际访问集合 V(r) = {r} ∪ Cl(r) 判越界。
 * 零行为变化：只读源码，不发请求。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Finding } from './support/route-policy/compare.js';
import { MAX_DEPTH } from './support/route-policy/evidence-closure.js';
import { areaOf, closureFromGraph, parseRegistry } from './support/route-policy/evidence-graph.js';
import {
  checkEvidence,
  currentDependencies,
  currentRegistry,
  legacyDigestsFindings,
  REGISTRY,
  renderRegistry,
  repoSource,
  type SourceReader,
  unitText,
  usesOf,
} from './support/route-policy/evidence.js';
import { explainGraphDiff } from './support/route-policy/explain-graph-diff.js';
import { REQUIRED } from './support/route-policy/required/index.js';
import type { RequiredTable } from './support/route-policy/required/types.js';

const codes = (found: readonly Finding[]) => found.map((f) => f.code);
const show = (found: readonly Finding[]) => found.map((f) => `${f.route} ${f.code}: ${f.detail}`).join('\n');
const DIGESTS_DIR = new URL('./support/route-policy/required/digests/', import.meta.url);

const FX = 'apps/api/src/modules/fx';
const readerOf =
  (files: Record<string, string>): SourceReader =>
  (file) =>
    files[file] ?? repoSource(file);

/** 夹具：每个根一个端点；锚点取 `return`（夹具函数里都有）。 */
function tableOf(...units: string[]): RequiredTable {
  return Object.fromEntries(
    units.map((unit, i) => [
      `GET /api/tenant/fx${i}`,
      [{ perm: `btn:Fx${i}#open@list`, at: [{ role: 'call' as const, unit, anchor: 'return' }] }],
    ]),
  );
}

/** 夹具基线：用原始源码生成登记，之后只换读取器模拟“源码变了、登记没动”。 */
function baseline(files: Record<string, string>, ...units: string[]) {
  const table = tableOf(...units);
  const registry = currentRegistry(table, readerOf(files), false);
  const check = (patch: Record<string, string> = {}, unused = false) =>
    checkEvidence(table, {
      read: readerOf({ ...files, ...patch }),
      branch: false,
      registry,
      digests: registry.units,
      unused,
      legacyRoot: os.tmpdir(),
    });
  return { table, registry, check };
}

const lines = (text: string) => text.split('\n');

// ---------------------------------------------------------------------------------------------------------------
// 1～2 等价与确定性（真实表）
// ---------------------------------------------------------------------------------------------------------------

describe('AC-PRM-FW-02 图存储：真实表等价与确定性（F-072 测试 1、2）', () => {
  const roots = () => [...usesOf(REQUIRED).keys()].sort();

  it('登记图推出的每个根的闭包，与源码逐层解析的闭包节点集合、摘要全部相等；DIGESTS 逐键相等', () => {
    const legacy = currentDependencies(REQUIRED);
    const mismatched: string[] = [];
    for (const root of roots()) {
      const closure = closureFromGraph(REGISTRY.graph, root);
      const nodes = [...closure.deps.keys()].sort();
      const registered = Object.fromEntries(nodes.map((id) => [id, REGISTRY.nodes[id]?.[0]]));
      const expected = legacy[root] ?? {};
      if (JSON.stringify(Object.keys(expected).sort()) !== JSON.stringify(nodes)) mismatched.push(`${root} 节点集合`);
      else if (nodes.some((id) => registered[id] !== expected[id])) mismatched.push(`${root} 摘要`);
    }
    expect(mismatched).toEqual([]);
    const current = currentRegistry(REQUIRED);
    expect(REGISTRY.units).toEqual(current.units);
    expect(roots().length).toBeGreaterThan(600);
  });

  it('生成两次字节相同；提交的登记文件 = 当前源码生成的内容（登记与源码同步）', () => {
    const first = renderRegistry(currentRegistry(REQUIRED));
    const second = renderRegistry(currentRegistry(REQUIRED));
    expect(second).toEqual(first);
    const onDisk = new Map<string, string>();
    for (const name of ['index.ts', 'units.ts', 'nodes.ts'])
      onDisk.set(name, readFileSync(new URL(name, DIGESTS_DIR), 'utf8'));
    for (const name of readdirSync(new URL('graph/', DIGESTS_DIR)))
      onDisk.set(`graph/${name}`, readFileSync(new URL(`graph/${name}`, DIGESTS_DIR), 'utf8'));
    const generated = Object.entries(first).filter(([name]) => name !== 'index.ts');
    expect([...onDisk.keys()].filter((name) => name !== 'index.ts').sort()).toEqual(
      generated.map(([name]) => name).sort(),
    );
    for (const [name, text] of generated) expect(onDisk.get(name) === text, `${name} 与生成结果不一致`).toBe(true);
  });

  it('nodes.ts 无重复键；graph/* 中每个节点只出现在一个区域文件，且文件名 = 区域', () => {
    const keysOf = (text: string) => [...text.matchAll(/^ {2}'([^']+#[^']+)': /gm)].map((m) => m[1]!);
    const nodes = keysOf(readFileSync(new URL('nodes.ts', DIGESTS_DIR), 'utf8'));
    expect(nodes.length).toBeGreaterThan(3000);
    expect(new Set(nodes).size).toBe(nodes.length);
    const owner = new Map<string, string>();
    for (const name of readdirSync(new URL('graph/', DIGESTS_DIR)).filter((n) => n !== 'index.ts')) {
      const area = name.replace(/\.ts$/, '');
      for (const key of keysOf(readFileSync(new URL(`graph/${name}`, DIGESTS_DIR), 'utf8'))) {
        expect(owner.has(key), `${key} 同时在 ${owner.get(key)} 与 ${area}`).toBe(false);
        owner.set(key, area);
        expect(areaOf(key), key).toBe(area);
      }
    }
    expect(owner.size).toBeGreaterThan(2500);
  });

  it('区域划分：模块 / 其他 api 子目录 / api 根 / domain 子目录 / 测试', () => {
    expect(areaOf('apps/api/src/modules/approval/access.ts#x')).toBe('api-modules-approval');
    expect(areaOf('apps/api/src/modules/transfer/linkage/a.ts#x')).toBe('api-modules-transfer');
    expect(areaOf('apps/api/src/audit/record.ts#x')).toBe('api-audit');
    expect(areaOf('apps/api/src/authorization.ts#x')).toBe('api-root');
    expect(areaOf('packages/domain/src/expression/functions/a.ts#x')).toBe('domain-expression');
    expect(areaOf('packages/domain/src/tenant-time.ts#x')).toBe('domain-root');
    expect(areaOf('tests/acceptance/support/x.ts#x')).toBe('tests');
  });

  it('渲染 → 解析往返：parseRegistry 还原出同一份登记', () => {
    const rendered = renderRegistry(REGISTRY);
    const parsed = parseRegistry(rendered);
    expect(parsed).toEqual(REGISTRY);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3～4 重算的差异面（真实表 / 夹具）
// ---------------------------------------------------------------------------------------------------------------

describe('AC-PRM-FW-02 图存储：重算的差异面（F-072 测试 3、4）', () => {
  const unitSource = (id: string) => {
    try {
      return unitText(repoSource, id);
    } catch {
      return ''; // 同名不唯一的依赖不能作样本
    }
  };
  const changedLines = (before: Record<string, string>, after: Record<string, string>) =>
    Object.keys({ ...before, ...after }).flatMap((name) => {
      const a = new Set(lines(before[name] ?? ''));
      const b = new Set(lines(after[name] ?? ''));
      return [
        ...lines(before[name] ?? '').filter((l) => !b.has(l)),
        ...lines(after[name] ?? '').filter((l) => !a.has(l)),
      ]
        .filter((l) => l.trim())
        .map((l) => `${name}: ${l.trim()}`);
    });

  it('改一个共享函数（不作根）的实现后重算：只有 nodes.ts 的 1 行变化（删 1 行、增 1 行），图与 units 不动', () => {
    const rootSet = new Set(Object.keys(REGISTRY.unitBindings));
    const reach = new Map<string, number>();
    for (const root of rootSet)
      for (const id of closureFromGraph(REGISTRY.graph, root).deps.keys()) reach.set(id, (reach.get(id) ?? 0) + 1);
    const shared = [...reach]
      .filter(([id]) => !rootSet.has(id) && /^(export )?function /.test(unitSource(id)))
      .sort((a, b) => b[1] - a[1])[0]!;
    expect(shared[1], '没有被多个根共享的函数').toBeGreaterThan(50);
    const [file] = shared[0].split('#');
    const text = unitSource(shared[0]);
    const end = text.lastIndexOf('}');
    const touched = repoSource(file!).replace(text, `${text.slice(0, end)}void 0; ${text.slice(end)}`);
    expect(touched).not.toBe(repoSource(file!));
    const patched = currentRegistry(REQUIRED, readerOf({ [file!]: touched }));
    const diff = changedLines(renderRegistry(REGISTRY), renderRegistry(patched));
    expect(diff.length, diff.join('\n')).toBe(2);
    expect(
      diff.every((l) => l.startsWith('nodes.ts: ')),
      diff.join('\n'),
    ).toBe(true);
  });

  it('删除一个根后重算：其独有节点从 nodes.ts 与 graph/* 消失；对残留登记报 EVIDENCE_UNUSED', () => {
    const files = {
      [`${FX}/g1.ts`]: "import { shared } from './s.js';\nexport function g1() {\n  return shared();\n}\n",
      [`${FX}/g2.ts`]:
        "import { shared } from './s.js';\nimport { only } from './o.js';\n" +
        'export function g2() {\n  return shared() + only();\n}\n',
      [`${FX}/s.ts`]: 'export function shared() {\n  return 1;\n}\n',
      [`${FX}/o.ts`]: 'export function only() {\n  return 2;\n}\n',
    };
    const both = baseline(files, `${FX}/g1.ts#g1`, `${FX}/g2.ts#g2`);
    expect(both.check({}, true)).toEqual([]);
    const after = currentRegistry(tableOf(`${FX}/g1.ts#g1`), readerOf(files), false);
    const text = Object.values(renderRegistry(after)).join('\n');
    expect(text).toContain('s.ts#shared');
    expect(text).not.toContain('o.ts#only');
    expect(text).not.toContain('g2.ts#g2');
    const stale = checkEvidence(tableOf(`${FX}/g1.ts#g1`), {
      read: readerOf(files),
      branch: false,
      registry: both.registry,
      digests: both.registry.units,
      unused: true,
      legacyRoot: os.tmpdir(),
    });
    const unused = stale.filter((f) => f.code === 'EVIDENCE_UNUSED').map((f) => f.detail);
    expect(
      unused.some((d) => d.includes('g2.ts#g2')),
      show(stale),
    ).toBe(true);
    expect(
      unused.some((d) => d.includes('o.ts#only')),
      show(stale),
    ).toBe(true);
    expect(
      unused.some((d) => d.includes('s.ts#shared')),
      show(stale),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5 图变 / 绑定变而闭包不变
// ---------------------------------------------------------------------------------------------------------------

const HELPER = 'export function a() {\n  return b();\n}\nexport function b() {\n  return 1;\n}\n';

describe('AC-PRM-FW-02 图存储：图变或绑定变而闭包不变也报（F-072 测试 5、5b）', () => {
  it('导入重绑定：R→A 变为 R→A,B 且两边都有 A→B，闭包与摘要不变 → EVIDENCE_STALE（直接依赖变化）', () => {
    const gate = (second: string) =>
      `import { a as fmt, ${second} as other } from './h.js';\n` +
      'export function gate() {\n  return fmt() + other();\n}\n';
    const files = { [`${FX}/gate.ts`]: gate('a'), [`${FX}/h.ts`]: HELPER };
    const { check, registry } = baseline(files, `${FX}/gate.ts#gate`);
    const unit = `${FX}/gate.ts#gate`;
    const closure = (reg: typeof registry) => [...closureFromGraph(reg.graph, unit).deps.keys()].sort();
    const rebound = currentRegistry(tableOf(unit), readerOf({ ...files, [`${FX}/gate.ts`]: gate('b') }), false);
    expect(closure(registry)).toEqual([`${FX}/h.ts#a`, `${FX}/h.ts#b`]);
    expect(closure(rebound)).toEqual(closure(registry));
    expect(rebound.units).toEqual(registry.units);
    expect(rebound.graph[unit]).toEqual([`${FX}/h.ts#a`, `${FX}/h.ts#b`]);
    expect(registry.graph[unit]).toEqual([`${FX}/h.ts#a`]);
    const found = check({ [`${FX}/gate.ts`]: gate('b') });
    const stale = found.filter((f) => f.code === 'EVIDENCE_STALE');
    expect(stale, show(found)).toHaveLength(1);
    expect(stale[0]!.detail).toContain('直接依赖变化（闭包未变）');
    expect(stale[0]!.detail).toContain(`${FX}/h.ts#b`);
  });

  const MID = `import { a as fmt, b as tz } from './h.js';\nexport function r() {\n  return fmt() + tz();\n}\n`;
  const SWAPPED = MID.replace('{ a as fmt, b as tz }', '{ b as fmt, a as tz }');
  const GATE = "import { r } from './mid.js';\nexport function gate() {\n  return r();\n}\n";
  const aliasFiles = { [`${FX}/gate.ts`]: GATE, [`${FX}/mid.ts`]: MID, [`${FX}/h.ts`]: HELPER };

  it('普通图绑定指纹：模块内辅助 R 交换两个别名绑定（邻接与文本都不变）→ EVIDENCE_STALE（绑定变化，列当前清单）', () => {
    const { check, registry } = baseline(aliasFiles, `${FX}/gate.ts#gate`);
    const swapped = { ...aliasFiles, [`${FX}/mid.ts`]: SWAPPED };
    const swappedRegistry = currentRegistry(tableOf(`${FX}/gate.ts#gate`), readerOf(swapped), false);
    const id = `${FX}/mid.ts#r`;
    expect(swappedRegistry.graph[id]).toEqual(registry.graph[id]);
    expect(swappedRegistry.nodes[id]![0]).toBe(registry.nodes[id]![0]);
    expect(swappedRegistry.nodes[id]![1]).not.toBe(registry.nodes[id]![1]);
    const found = check({ [`${FX}/mid.ts`]: SWAPPED });
    const stale = found.filter((f) => f.code === 'EVIDENCE_STALE');
    expect(stale.length, show(found)).toBeGreaterThan(0);
    const detail = stale.map((f) => f.detail).join('\n');
    expect(detail).toContain('绑定变化');
    expect(detail).toContain(`fmt → import:./h.js`);
    expect(detail).toContain('explain-graph-diff');
    // explain-graph-diff 对同一夹具给出变化的位置与新旧目标
    const explained = explainGraphDiff({
      base: registry,
      head: swappedRegistry,
      diffFiles: new Set([`${FX}/mid.ts`]),
      readBase: readerOf(aliasFiles),
      readHead: readerOf(swapped),
    });
    const item = explained.items.find((i) => i.node === id);
    expect(item?.kind).toBe('binding');
    expect(item?.explained).toBe(true);
    expect(item?.old?.join('\n')).toContain(`fmt → import:./h.js → ${FX}/h.ts#a`);
    expect(item?.new?.join('\n')).toContain(`fmt → import:./h.js → ${FX}/h.ts#b`);
  });

  it('中间文件改转导出、局部新增 import 遮蔽全局，同样报', () => {
    const reexport = (target: string) => `export { ${target} as pick } from './h.js';\n`;
    const gate =
      "import { pick } from './mid.js';\nimport { a, b } from './h.js';\n" +
      'export function gate() {\n  return pick() + a() + b();\n}\n';
    const files = { [`${FX}/gate.ts`]: gate, [`${FX}/mid.ts`]: reexport('a'), [`${FX}/h.ts`]: HELPER };
    const { check } = baseline(files, `${FX}/gate.ts#gate`);
    const found = check({ [`${FX}/mid.ts`]: reexport('b') });
    expect(
      found
        .filter((f) => f.code === 'EVIDENCE_STALE')
        .map((f) => f.detail)
        .join('\n'),
    ).toContain('绑定变化');

    const shadow = (withImport: boolean) =>
      `${withImport ? "import { Intl } from './shim.js';\n" : ''}export function gate() {\n  return Intl.name;\n}\n`;
    const shim = "export const Intl = { name: 'shim' };\n";
    const base = baseline({ [`${FX}/gate.ts`]: shadow(false), [`${FX}/shim.ts`]: shim }, `${FX}/gate.ts#gate`);
    const shadowed = base.check({ [`${FX}/gate.ts`]: shadow(true) });
    expect(codes(shadowed)).toContain('EVIDENCE_STALE');
    expect(base.check()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5c depth-limit（D-8 ①）
// ---------------------------------------------------------------------------------------------------------------

type Adjacency = Record<string, readonly string[]>;
const pad = (n: number) => String(n).padStart(2, '0');

/** 按邻接（源码顺序）生成夹具源码：每个函数 `return A(x) + B(x)`，无依赖则 `return x`。 */
function sourceOf(adjacency: Adjacency): string {
  return Object.entries(adjacency)
    .map(([name, deps]) => {
      const body = deps.length ? deps.map((d) => `${d}(x)`).join(' + ') : 'x';
      return `${name === 'gate' ? 'export ' : ''}function ${name}(x: number): number {\n  return ${body};\n}\n`;
    })
    .join('\n');
}

/** 旧算法（main 1df67cd6）的 depth-limit：同层按源码顺序处理，处理 x 时仍有“当时还没访问过”的依赖即报。 */
function legacyLimited(adjacency: Adjacency, root: string): Set<string> {
  const visited = new Set([root]);
  const limited = new Set<string>();
  let frontier = [...(adjacency[root] ?? [])];
  for (let depth = 1; frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (visited.has(id)) continue;
      visited.add(id);
      const fresh = (adjacency[id] ?? []).filter((d) => !visited.has(d));
      if (depth < MAX_DEPTH) next.push(...fresh);
      else if (fresh.length) limited.add(id);
    }
    frontier = next;
  }
  return limited;
}

describe('AC-PRM-FW-02 图存储：depth-limit 与遍历顺序无关（D-8 ①，F-072 测试 5c）', () => {
  const FILE = `${FX}/deep.ts`;
  const id = (name: string) => `${FILE}#${name}`;
  const shapes = (): Record<string, Adjacency> => {
    const stem = (): Record<string, string[]> => {
      const out: Record<string, string[]> = { gate: ['n01'] };
      for (let i = 1; i < 39; i++) out[`n${pad(i)}`] = [`n${pad(i + 1)}`];
      return out;
    };
    return {
      // R → n01 → … → n39 → {z40, a40}，z40 → a40：旧算法按源码顺序先处理 z40，误报；a40 本来就在闭包里
      cross: { ...stem(), n39: ['z40', 'a40'], z40: ['a40'], a40: [] },
      // R → n01 → … → n40 → R：回指根，根从一开始就算已访问
      backref: { ...stem(), n39: ['n40'], n40: ['gate'] },
      // z40 → b41：确实越界
      beyond: { ...stem(), n39: ['z40', 'a40'], z40: ['b41'], a40: [], b41: [] },
    };
  };

  const run = (adjacency: Adjacency) => {
    const { check, registry } = baseline({ [FILE]: sourceOf(adjacency) }, id('gate'));
    return { registry, found: check() };
  };
  const depthLimited = (found: readonly Finding[]) =>
    found.filter((f) => f.code === 'EVIDENCE_CLOSURE_UNRESOLVED' && f.detail.includes('depth-limit'));

  it('上限层同层交叉边 / 回指根：不报；确实越界：报', () => {
    const { cross, backref, beyond } = shapes();
    expect(depthLimited(run(cross!).found)).toEqual([]);
    expect(depthLimited(run(backref!).found)).toEqual([]);
    const limited = depthLimited(run(beyond!).found);
    expect(limited).toHaveLength(1);
    expect(limited[0]!.detail).toContain('z40');
  });

  it('新集合 ⊆ 旧集合，差集每一项都满足 G(x) ⊆ V(r)（V(r) = {r} ∪ Cl(r)）；回指根新旧都不报', () => {
    for (const [name, adjacency] of Object.entries(shapes())) {
      const { registry } = run(adjacency);
      const closure = closureFromGraph(registry.graph, id('gate'));
      const current = new Set(closure.limited.map((x) => x.split('#')[1]!));
      const legacy = legacyLimited(adjacency, 'gate');
      const visited = new Set(['gate', ...[...closure.deps.keys()].map((x) => x.split('#')[1]!)]);
      expect(
        [...current].filter((x) => !legacy.has(x)),
        `${name}：新集合 ⊄ 旧集合`,
      ).toEqual([]);
      for (const x of [...legacy].filter((y) => !current.has(y))) {
        expect(
          (adjacency[x] ?? []).every((d) => visited.has(d)),
          `${name}：${x} 的依赖不都在 V(r) 里`,
        ).toBe(true);
      }
      if (name === 'backref') expect(legacy.size + current.size).toBe(0);
    }
  });

  it('40 / 41 层纯链：恰在上限时不报，多一层报（新旧一致）', () => {
    for (const length of [MAX_DEPTH, MAX_DEPTH + 1]) {
      const adjacency: Record<string, string[]> = { gate: ['f00'] };
      for (let i = 0; i < length; i++) adjacency[`f${pad(i)}`] = i === length - 1 ? [] : [`f${pad(i + 1)}`];
      const { registry, found } = run(adjacency);
      const closure = closureFromGraph(registry.graph, id('gate'));
      expect(closure.limited.map((x) => x.split('#')[1])).toEqual([...legacyLimited(adjacency, 'gate')]);
      expect(depthLimited(found).length).toBe(length > MAX_DEPTH ? 1 : 0);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 6 旧文件守卫
// ---------------------------------------------------------------------------------------------------------------

describe('AC-PRM-FW-02 图存储：旧 required/digests.ts 守卫（F-072 测试 6）', () => {
  const LEGACY = 'tests/acceptance/support/route-policy/required/digests.ts';

  it('仓库里没有旧文件', () => {
    expect(legacyDigestsFindings()).toEqual([]);
  });

  it('临时放回 required/digests.ts → LEGACY_DIGESTS_PRESENT（全表校验 unused 模式同样带出）', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    mkdirSync(path.dirname(path.join(root, LEGACY)), { recursive: true });
    writeFileSync(path.join(root, LEGACY), 'export const DIGESTS = {};\n');
    const found = legacyDigestsFindings(root);
    expect(codes(found)).toEqual(['LEGACY_DIGESTS_PRESENT']);
    expect(found[0]!.detail).toContain('digests/');
    const { table, registry } = baseline({ [`${FX}/h.ts`]: HELPER }, `${FX}/h.ts#a`);
    const viaCheck = checkEvidence(table, {
      read: readerOf({ [`${FX}/h.ts`]: HELPER }),
      branch: false,
      registry,
      digests: registry.units,
      unused: true,
      legacyRoot: root,
    });
    expect(codes(viaCheck)).toContain('LEGACY_DIGESTS_PRESENT');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 6b explain-graph-diff
// ---------------------------------------------------------------------------------------------------------------

describe('AC-PRM-FW-02 图存储：explain-graph-diff（F-072 测试 5b、6b，§4.4）', () => {
  const GATE_A = "import { a } from './h.js';\nexport function gate() {\n  return a();\n}\n";
  const GATE_NONE = 'export function gate() {\n  return 1;\n}\n';
  const explain = (
    before: Record<string, string>,
    after: Record<string, string>,
    diffFiles: string[],
    units: string[],
  ) => {
    const table = tableOf(...units);
    return explainGraphDiff({
      base: currentRegistry(table, readerOf(before), false),
      head: currentRegistry(table, readerOf(after), false),
      diffFiles: new Set(diffFiles),
      readBase: readerOf(before),
      readHead: readerOf(after),
    });
  };
  const unexplained = (result: ReturnType<typeof explain>) => result.items.filter((i) => !i.explained);

  it('删除最后一个引用，使未修改辅助文件里的节点退出图 → 按 §4.4 ③ 可解释', () => {
    const before = { [`${FX}/gate.ts`]: GATE_A, [`${FX}/h.ts`]: HELPER };
    const after = { [`${FX}/gate.ts`]: GATE_NONE, [`${FX}/h.ts`]: HELPER };
    const result = explain(before, after, [`${FX}/gate.ts`], [`${FX}/gate.ts#gate`]);
    const removed = result.items.filter((i) => i.kind === 'removed').map((i) => i.node);
    expect(removed.sort()).toEqual([`${FX}/h.ts#a`, `${FX}/h.ts#b`]);
    expect(unexplained(result), JSON.stringify(result.items)).toEqual([]);
  });

  it('只改中间文件的转导出，未修改调用方的绑定指纹变化 → 沿解析链按 §4.4 ① 可解释', () => {
    const mid = (target: string) => `export { ${target} as pick } from './h.js';\n`;
    const gate =
      "import { pick } from './mid.js';\nimport { a, b } from './h.js';\n" +
      'export function gate() {\n  return pick() + a() + b();\n}\n';
    const before = { [`${FX}/gate.ts`]: gate, [`${FX}/mid.ts`]: mid('a'), [`${FX}/h.ts`]: HELPER };
    const after = { ...before, [`${FX}/mid.ts`]: mid('b') };
    const result = explain(before, after, [`${FX}/mid.ts`], [`${FX}/gate.ts#gate`]);
    const changed = result.items.find((i) => i.kind === 'binding');
    expect(changed?.node).toBe(`${FX}/gate.ts#gate`);
    expect(changed?.explained).toBe(true);
    expect(changed?.reason).toContain('mid.ts');
    expect(changed?.old?.join('\n')).toContain('pick');
    expect(changed?.new?.join('\n')).not.toEqual(changed?.old?.join('\n'));
    // 同一变化，diff 里没有 mid.ts：解析链上没有任何文件在 diff 里 → 待说明
    expect(unexplained(explain(before, after, [`${FX}/other.ts`], [`${FX}/gate.ts#gate`])).length).toBe(1);
  });

  it('无法沿删除的边解释的删除、未修改文件里的摘要变化 → 列为待说明项', () => {
    const before = { [`${FX}/gate.ts`]: GATE_A, [`${FX}/h.ts`]: HELPER };
    const afterGate = { [`${FX}/gate.ts`]: GATE_NONE, [`${FX}/h.ts`]: HELPER };
    // diff 里没有 gate.ts：删边的起点所在文件不在 diff 里
    const removed = explain(before, afterGate, [`${FX}/other.ts`], [`${FX}/gate.ts#gate`]);
    expect(
      unexplained(removed)
        .map((i) => i.kind)
        .sort(),
    ).toEqual(['digest', 'removed', 'removed']);
    const patchedHelper = { ...before, [`${FX}/h.ts`]: HELPER.replace('return 1', 'return 2') };
    const digest = explain(before, patchedHelper, [`${FX}/gate.ts`], [`${FX}/gate.ts#gate`]);
    expect(unexplained(digest).map((i) => `${i.kind} ${i.node}`)).toEqual([`digest ${FX}/h.ts#b`]);
    const explainedDigest = explain(before, patchedHelper, [`${FX}/h.ts`], [`${FX}/gate.ts#gate`]);
    expect(unexplained(explainedDigest)).toEqual([]);
  });

  it('新增节点不限（§4.4 ②）', () => {
    const before = { [`${FX}/gate.ts`]: GATE_NONE, [`${FX}/h.ts`]: HELPER };
    const after = { ...before, [`${FX}/gate.ts`]: GATE_A };
    const result = explain(before, after, [`${FX}/gate.ts`], [`${FX}/gate.ts#gate`]);
    expect(result.items.filter((i) => i.kind === 'added').length).toBe(2);
    expect(unexplained(result)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 7 回归
// ---------------------------------------------------------------------------------------------------------------

describe('AC-PRM-FW-02 图存储：回归（F-072 测试 7）', () => {
  it('全表校验零发现（含 unused 与旧文件守卫）；没有位于 modules/** 的未解析项', () => {
    const found = checkEvidence(REQUIRED, { unused: true });
    expect(found, show(found)).toEqual([]);
  });

  it('夹具原始源码：零发现；登记只含根 + 可达依赖，叶子节点不出现在 graph', () => {
    const gate = "import { a } from './h.js';\nexport function gate() {\n  return a();\n}\n";
    const files = { [`${FX}/gate.ts`]: gate, [`${FX}/h.ts`]: HELPER };
    const { check, registry } = baseline(files, `${FX}/gate.ts#gate`);
    expect(check({}, true)).toEqual([]);
    expect(Object.keys(registry.graph).sort()).toEqual([`${FX}/gate.ts#gate`, `${FX}/h.ts#a`]);
    expect(Object.keys(registry.nodes).sort()).toEqual([`${FX}/h.ts#a`, `${FX}/h.ts#b`]);
  });
});
