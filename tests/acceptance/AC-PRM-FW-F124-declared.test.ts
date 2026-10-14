/**
 * AC-PRM-FW-F124（DEC-475④，取代 DEC-468）：F-039 共享测试不再断言跨模块的全局精确数，改为各模块在
 * `required/declared/<模块>.ts` 声明自己的条目集合；共享测试逐模块比较“实际集合 = 声明集合”，并要求每个实际条目都有归属模块。
 * 本文件证明新检查与原精确计数同样严格：临时多出一个未声明条目、删掉一个已声明条目、条目没有归属模块，都判红，
 * 且失败信息列出差异键（不是只报一个数字）。
 */
import { describe, expect, it } from 'vitest';
import { DECLARED } from './support/route-policy/required/declared/index.js';
import { REQUIRED_BY_MODULE } from './support/route-policy/required/index.js';
import {
  DECLARED_KINDS,
  declarationDifferences,
  declaredItems,
  routeOwner,
  type DeclaredKind,
} from './support/route-policy/module-declared.js';

const owner = (id: string) => (id.startsWith('A') ? 'alpha' : id.startsWith('B') ? 'beta' : undefined);

describe('declarationDifferences：逐模块逐项相等', () => {
  it('实际集合与各模块声明一致 → 无差异', () => {
    expect(declarationDifferences('样例', ['A1', 'A2', 'B1'], { alpha: ['A1', 'A2'], beta: ['B1'] }, owner)).toEqual(
      [],
    );
  });

  it('多出一个未声明条目 → 判红，信息列出该键和所属模块', () => {
    const found = declarationDifferences(
      '样例',
      ['A1', 'A2', 'A3', 'B1'],
      { alpha: ['A1', 'A2'], beta: ['B1'] },
      owner,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('alpha');
    expect(found[0]).toContain('A3');
  });

  it('删掉一个已声明条目（实际里没有了）→ 判红，信息列出失效的声明键', () => {
    const found = declarationDifferences('样例', ['A1', 'B1'], { alpha: ['A1', 'A2'], beta: ['B1'] }, owner);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('alpha');
    expect(found[0]).toContain('A2');
  });

  it('一增一减（总数不变）也判红——全局计数看不出，逐项比较看得出', () => {
    const found = declarationDifferences('样例', ['A1', 'A3', 'B1'], { alpha: ['A1', 'A2'], beta: ['B1'] }, owner);
    expect(found.join('\n')).toContain('A3');
    expect(found.join('\n')).toContain('A2');
  });

  it('实际条目没有归属模块 → 判红（无主条目）', () => {
    const found = declarationDifferences('样例', ['A1', 'Z9'], { alpha: ['A1'] }, owner);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('无主');
    expect(found[0]).toContain('Z9');
  });

  it('同一条目被两个模块重复声明 → 判红', () => {
    const found = declarationDifferences('样例', ['A1'], { alpha: ['A1'], beta: ['A1'] }, owner);
    expect(found.join('\n')).toContain('重复声明');
  });

  it('条目声明在别的模块名下（实际归属 alpha）→ 判红', () => {
    const found = declarationDifferences('样例', ['A1'], { beta: ['A1'] }, owner);
    expect(found.join('\n')).toContain('beta');
    expect(found.join('\n')).toContain('alpha');
  });
});

describe('真实声明 × 同样严格', () => {
  // 第 2 轮：除多承载节点 / 同状态码异错误体 / 已知缺口外，再纳入“活动键授权请求”（F075b 的 48 个入口）、
  // “选择器位置”（31）与“输入来源端点”（23）——这些原先也是跨模块的全局精确数。
  const kinds: DeclaredKind[] = [
    'multiCarrierAdmission',
    'sameStatusInvalidId',
    'knownGapPairs',
    'activityKeyRequests',
    'selectorSites',
    'branchInputEndpoints',
  ];

  it('声明种类与实现登记的种类完全一致（新增种类必须同步补反例）', () => {
    expect(Object.keys(DECLARED_KINDS).sort()).toEqual([...kinds].sort());
  });

  it('每个 required/<模块>.ts 都有声明文件接入（兑现“只改本模块声明文件”，含暂无条目的空声明）', () => {
    expect(Object.keys(DECLARED).sort()).toEqual(Object.keys(REQUIRED_BY_MODULE).sort());
  });

  it('每个声明模块都是 required/ 里真实存在的模块', () => {
    for (const module of Object.keys(DECLARED)) expect(Object.keys(REQUIRED_BY_MODULE), module).toContain(module);
  });

  it.each(kinds)('%s：声明非空，且每个声明条目的归属就是声明它的模块', (kind) => {
    const all = Object.entries(declaredItems(kind));
    expect(all.length).toBeGreaterThan(0);
    for (const [module, items] of all)
      for (const id of items) expect(routeOwner(DECLARED_KINDS[kind].routeOf(id)), id).toBe(module);
  });

  it.each(kinds)('%s：实际 = 全部声明 → 无差异', (kind) => {
    const declared = declaredItems(kind);
    const actual = Object.values(declared).flat();
    expect(declarationDifferences(kind, actual, declared, DECLARED_KINDS[kind].ownerOf)).toEqual([]);
  });

  it.each(kinds)('%s：临时多出一个未声明条目（取自该模块登记表里的真实路由）→ 判红', (kind) => {
    const declared = declaredItems(kind);
    const [module, items] = Object.entries(declared)[0]!;
    const extra = Object.keys(REQUIRED_BY_MODULE[module]!).find((key) => !items.some((id) => id.startsWith(key)))!;
    const forged = DECLARED_KINDS[kind].forge(extra);
    const found = declarationDifferences(
      kind,
      [...Object.values(declared).flat(), forged],
      declared,
      DECLARED_KINDS[kind].ownerOf,
    );
    expect(found.join('\n')).toContain(extra);
    expect(found.join('\n')).toContain(module);
  });

  it.each(kinds)('%s：每个模块各自删掉一个已声明条目 → 都判红', (kind) => {
    const declared = declaredItems(kind);
    for (const [module, items] of Object.entries(declared)) {
      const removed = items[0]!;
      const actual = Object.values(declared)
        .flat()
        .filter((id) => id !== removed);
      const found = declarationDifferences(kind, actual, declared, DECLARED_KINDS[kind].ownerOf);
      expect(found.join('\n'), `${module} ${removed}`).toContain(removed.replace('\t', ' '));
    }
  });

  it.each(kinds)('%s：实际条目不在任何模块登记表里 → 判红（无主）', (kind) => {
    const declared = declaredItems(kind);
    const forged = DECLARED_KINDS[kind].forge('GET /api/tenant/nowhere/:id');
    const found = declarationDifferences(
      kind,
      [...Object.values(declared).flat(), forged],
      declared,
      DECLARED_KINDS[kind].ownerOf,
    );
    expect(found.join('\n')).toContain('无主');
  });

  it.each(kinds)('%s：只更新所属模块的声明即可通过（不必改共享测试）', (kind) => {
    const declared = declaredItems(kind);
    const [module, items] = Object.entries(declared)[0]!;
    const extra = Object.keys(REQUIRED_BY_MODULE[module]!).find((key) => !items.some((id) => id.startsWith(key)))!;
    const forged = DECLARED_KINDS[kind].forge(extra);
    const actual = [...Object.values(declared).flat(), forged];
    const updated = { ...declared, [module]: [...items, forged] };
    expect(declarationDifferences(kind, actual, updated, DECLARED_KINDS[kind].ownerOf)).toEqual([]);
  });

  it.each(kinds)('%s：条目重复声明 / 声明挂在别的模块名下 → 判红', (kind) => {
    const declared = declaredItems(kind);
    const [module, items] = Object.entries(declared)[0]!;
    const actual = Object.values(declared).flat();
    const duplicated = { ...declared, [module]: [...items, items[0]!] };
    expect(declarationDifferences(kind, actual, duplicated, DECLARED_KINDS[kind].ownerOf).join('\n')).toContain(
      '重复声明',
    );
    const other = Object.keys(REQUIRED_BY_MODULE).find((m) => m !== module)!;
    const moved = { ...declared, [module]: items.slice(1), [other]: [...(declared[other] ?? []), items[0]!] };
    const found = declarationDifferences(kind, actual, moved, DECLARED_KINDS[kind].ownerOf).join('\n');
    expect(found).toContain(`${module} 多出`);
    expect(found).toContain(`${other} 声明已失效`);
  });
});
