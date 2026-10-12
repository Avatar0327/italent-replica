/**
 * DEC-430①：生成物合并后重算、迁移编号合并时分配；DEC-439④：授权版本合并时定号。
 * 1. pnpm merge:main 的纯函数（scripts/merge-main-lib.mjs）：生成物白名单、迁移改号、快照三方合并、“只改计数”冲突识别；
 * 2. 生成物开关（generated-gate.ts）：PR 上只警告、GENERATED_STRICT=1 判红；
 * 3. 端点计数比较（endpoint-counts.ts）；
 * 4. 授权版本定号（planGrantVersion 等，DEC-439④）。
 */
import { readFileSync } from 'node:fs';
import { STANDARD_GRANT_DIGEST, STANDARD_GRANT_VERSION } from '@italent/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyConflict,
  GRANT_HISTORY_PATH,
  type GrantHistoryEntry,
  GRANTS_PATH,
  type Journal,
  type JournalEntry,
  isGeneratedPath,
  maskNumbers,
  merge3,
  parseGrantHistory,
  planGrantVersion,
  planRenumber,
  readGrantConstants,
  rebaseSnapshots,
  resolveGrantConflict,
  type Snapshot,
  takeOursForCounts,
  writeGrantConstants,
  writeGrantHistory,
} from '../scripts/merge-main-lib.mjs';
import { countDrift } from './acceptance/support/route-policy/endpoint-counts.js';
import {
  DEFAULT_GENERATED_STRICT,
  generatedGate,
  generatedStrict,
  textDrift,
} from './acceptance/support/route-policy/generated-gate.js';

const entry = (idx: number, name: string, when: number): JournalEntry => ({
  idx,
  version: '7',
  when,
  tag: `${String(idx).padStart(4, '0')}_${name}`,
  breakpoints: true,
});
const journal = (...entries: JournalEntry[]): Journal => ({ version: '7', dialect: 'postgresql', entries });

describe('生成物白名单：只有这些路径的冲突自动取 main 版本', () => {
  it.each([
    'tests/acceptance/support/route-policy/required/digests/nodes.ts',
    'tests/acceptance/support/route-policy/required/digests/graph/api-modules-org.ts',
    'tests/acceptance/support/route-policy/baseline/observed-contract.json',
    'tests/acceptance/support/route-policy/baseline/recorded.json',
    'tests/acceptance/support/route-policy/baseline/endpoint-counts.json',
    'tests/acceptance/support/route-policy/baseline/probe/org.json',
    'packages/db/migrations/meta/_journal.json',
    'packages/db/migrations/meta/0106_snapshot.json',
  ])('%s 是生成物', (file) => expect(isGeneratedPath(file)).toBe(true));

  it.each([
    'tests/acceptance/support/route-policy/baseline/probe-known-gaps.json',
    'tests/acceptance/support/route-policy/baseline/probe-redundant-observations.json',
    'tests/acceptance/support/route-policy/required/org.ts',
    'tests/acceptance/AC-PRM-FW-01.test.ts',
    'packages/db/migrations/0106_succession.sql',
    'packages/db/src/schema/succession.ts',
    'apps/api/src/app.ts',
  ])('%s 不是生成物（人工维护或业务文件）', (file) => expect(isGeneratedPath(file)).toBe(false));
});

describe('迁移编号合并时分配（planRenumber）', () => {
  const base = [entry(0, 'init', 100), entry(1, 'org', 200)];

  it('本分支与 main 各加了 0002：本分支的改成 0003，when 大于 main 最后一条，分叉点是 0001', () => {
    const main = journal(...base, entry(2, 'main_a', 400));
    const branch = journal(...base, entry(2, 'branch_x', 300));
    const plan = planRenumber(main, branch);
    expect(plan.changed).toBe(true);
    expect(plan.forkIdx).toBe(1);
    expect(plan.renames.map((r) => [r.from.tag, r.to.tag])).toEqual([['0002_branch_x', '0003_branch_x']]);
    expect(plan.journal.entries.map((e) => [e.idx, e.tag, e.when])).toEqual([
      [0, '0000_init', 100],
      [1, '0001_org', 200],
      [2, '0002_main_a', 400],
      [3, '0003_branch_x', 401],
    ]);
  });

  it('多条本分支迁移保持原顺序、when 严格递增；比 main 晚的原 when 保留', () => {
    const main = journal(...base, entry(2, 'main_a', 400), entry(3, 'main_b', 500));
    const branch = journal(...base, entry(2, 'x', 450), entry(3, 'y', 900));
    const { journal: out, renames } = planRenumber(main, branch);
    expect(renames.map((r) => r.to.tag)).toEqual(['0004_x', '0005_y']);
    expect(out.entries.slice(-2).map((e) => e.when)).toEqual([501, 900]);
    const whens = out.entries.map((e) => e.when);
    expect(whens.every((w, i) => i === 0 || w > whens[i - 1]!)).toBe(true);
  });

  it('已经接在 main 之后（重复运行）：不改号；本分支没有自己的迁移：计划为空', () => {
    const main = journal(...base, entry(2, 'main_a', 400));
    const branch = journal(...base, entry(2, 'main_a', 400), entry(3, 'x', 500));
    expect(planRenumber(main, branch).changed).toBe(false);
    expect(planRenumber(planRenumber(main, branch).journal, branch).changed).toBe(false);
    const none = planRenumber(main, journal(...base));
    expect(none.renames).toEqual([]);
    expect(none.journal).toEqual(main);
  });
});

describe('快照三方合并（merge3 / rebaseSnapshots）', () => {
  const table = (columns: string[]) => ({ columns: Object.fromEntries(columns.map((c) => [c, { type: 'text' }])) });
  const snap = (id: string, prevId: string, tables: Record<string, unknown>): Snapshot => ({
    id,
    prevId,
    version: '7',
    tables,
  });

  it('main 加表、本分支加另一张表并给旧表加列：合并后三者都在，prevId 接到 main 最新快照', () => {
    const fork = snap('f', 'e', { org: table(['id']) });
    const mainLast = snap('m', 'f', { org: table(['id']), job: table(['id']) });
    const own1 = snap('b1', 'f', { org: table(['id', 'code']), succ: table(['id']) });
    const own2 = snap('b2', 'b1', { org: table(['id', 'code']), succ: table(['id', 'level']) });
    const { snapshots, conflicts } = rebaseSnapshots(fork, [own1, own2], mainLast);
    expect(conflicts).toEqual([]);
    expect(snapshots.map((s) => [s.id, s.prevId])).toEqual([
      ['b1', 'm'],
      ['b2', 'b1'],
    ]);
    expect(snapshots[1]!['tables']).toEqual({
      org: table(['id', 'code']),
      job: table(['id']),
      succ: table(['id', 'level']),
    });
  });

  it('本分支删掉的键在合并结果里也删掉；main 没动的键取本分支', () => {
    const merged = merge3({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 2, c: 3 });
    expect(merged).toEqual({ value: { a: 1, c: 3 }, conflicts: [] });
  });

  it('两边把同一处改成不同的值：报冲突（脚本停下交人工）', () => {
    const fork = snap('f', 'e', { org: table(['id']) });
    const mainLast = snap('m', 'f', { org: { columns: { id: { type: 'uuid' } } } });
    const own = snap('b', 'f', { org: { columns: { id: { type: 'integer' } } } });
    const { conflicts } = rebaseSnapshots(fork, [own], mainLast);
    expect(conflicts).toEqual(['b: tables.org.columns.id.type']);
  });
});

describe('生成物开关（GENERATED_STRICT）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('默认警告；1 / true 严格；0 / false 警告', () => {
    expect(DEFAULT_GENERATED_STRICT).toBe(false);
    expect(generatedStrict({})).toBe(false);
    expect(generatedStrict({ GENERATED_STRICT: '' })).toBe(false);
    expect(generatedStrict({ GENERATED_STRICT: '1' })).toBe(true);
    expect(generatedStrict({ GENERATED_STRICT: 'TRUE' })).toBe(true);
    expect(generatedStrict({ GENERATED_STRICT: '0' })).toBe(false);
  });

  it('警告模式放行并输出报告与 ::warning 注解；严格模式原样返回', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(generatedGate('冻结基准', ['observed-contract.json 与生成结果不一致'], String, { strict: false })).toEqual(
      [],
    );
    const text = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('observed-contract.json 与生成结果不一致');
    expect(text).toContain('::warning');
    expect(text).toContain('pnpm merge:main');
    expect(generatedGate('冻结基准', ['x'], String, { strict: true })).toEqual(['x']);
  });

  it('环境变量 GENERATED_STRICT=1（不传参数）判红', () => {
    vi.stubEnv('GENERATED_STRICT', '1');
    expect(generatedGate('端点计数', ['总数 593（冻结 592）'])).toEqual(['总数 593（冻结 592）']);
  });

  it('textDrift：相同为空，不同或缺文件各一行', () => {
    expect(textDrift('a.json', '{}', '{}')).toEqual([]);
    expect(textDrift('a.json', '{}', '[]')).toEqual(['a.json 与生成结果不一致']);
    expect(textDrift('a.json', '{}', undefined)).toEqual(['a.json 缺少（应由生成器写出）']);
  });
});

describe('端点计数比较（countDrift）', () => {
  const stored = { total: 3, byModule: { org: 2, job: 1 } };

  it('一致为空；总数与模块差异逐项列出；totalOnly 只比总数；缺文件报一行', () => {
    expect(countDrift(stored, stored)).toEqual([]);
    const actual = { total: 4, byModule: { org: 2, job: 1, succession: 1 } };
    expect(countDrift(actual, stored)).toEqual(['总数 4（冻结 3）', 'succession 1（冻结 0）']);
    expect(countDrift(actual, stored, { totalOnly: true })).toEqual(['总数 4（冻结 3）']);
    expect(countDrift(actual, undefined)).toEqual(['endpoint-counts.json 不存在']);
  });
});

describe('“只改计数”的业务冲突（classifyConflict / takeOursForCounts）', () => {
  const hunk = (ours: string, base: string, theirs: string) =>
    `<<<<<<< HEAD\n${ours}||||||| merge-base\n${base}=======\n${theirs}>>>>>>> origin/main\n`;
  // 真实案例：本分支把字面量改为读 endpoint-counts.json，main 把 592 改成 593
  const counts = hunk(
    '    expect(declared).toHaveLength(counts.total);\n',
    '    expect(declared).toHaveLength(592);\n',
    '    expect(declared).toHaveLength(593);\n',
  );
  const total = hunk(
    'const TOTAL = readCounts().total;\n',
    'const TOTAL = 592; // 端点总数\n',
    'const TOTAL = 593; // 端点总数\n',
  );
  const mixed = hunk(
    '    expect(declared).toHaveLength(counts.total);\n',
    '    expect(declared).toHaveLength(592);\n',
    '    expect(declared.filter(isPublic)).toHaveLength(593);\n',
  );

  it('main 一侧每处冲突都只改了数字字面量：识别为只改计数', () => {
    const text = `import x from 'y';\n${counts}\nmid();\n${total}tail();\n`;
    expect(classifyConflict(text)).toEqual({ hunks: 2, countOnly: true });
  });

  it('有一处冲突 main 改了数字以外的内容：不算只改计数', () => {
    expect(classifyConflict(`${counts}${mixed}`)).toEqual({ hunks: 2, countOnly: false });
    expect(classifyConflict(mixed).countOnly).toBe(false);
  });

  it('没有分叉点内容（非 diff3）或没有冲突：不算只改计数', () => {
    const noBase = '<<<<<<< HEAD\na(1);\n=======\na(2);\n>>>>>>> origin/main\n';
    expect(classifyConflict(noBase)).toEqual({ hunks: 1, countOnly: false });
    expect(classifyConflict('a(1);\n')).toEqual({ hunks: 0, countOnly: false });
  });

  it('标识符里的数字不当计数：AC-PRM-FW-01 → 02、v1 → v2 不算只改计数', () => {
    expect(classifyConflict(hunk('x\n', "run('AC-PRM-FW-01');\n", "run('AC-PRM-FW-02');\n")).countOnly).toBe(false);
    expect(classifyConflict(hunk('x\n', 'api.v1(3);\n', 'api.v2(3);\n')).countOnly).toBe(false);
    expect(maskNumbers('toHaveLength(1_024); x = 0.5; FW-01')).toBe('toHaveLength(#); x = #; FW-01');
  });

  it('takeOursForCounts 只把只改计数的冲突处取本分支一侧，其余冲突原样保留', () => {
    expect(takeOursForCounts(`head\n${counts}tail\n`)).toEqual({
      text: 'head\n    expect(declared).toHaveLength(counts.total);\ntail\n',
      remaining: 0,
    });
    const out = takeOursForCounts(`${total}${mixed}`);
    expect(out.remaining).toBe(1);
    expect(out.text).toBe(`const TOTAL = readCounts().total;\n${mixed}`);
    expect(classifyConflict(out.text)).toEqual({ hunks: 1, countOnly: false });
  });
});

describe('授权版本合并时定号（DEC-439④）', () => {
  const D = (n: number) => String(n).repeat(16).slice(0, 16);
  const h = (version: number, digest: string, ...comments: string[]): GrantHistoryEntry => ({
    version,
    digest,
    comments,
  });
  const lines = (...xs: string[]) => xs.map((x) => `${x}\n`).join('');
  const versionLine = (version: number) => `export const STANDARD_GRANT_VERSION = ${version};`;
  const digestLine = (digest: string) => `export const STANDARD_GRANT_DIGEST = '${digest}';`;
  const grantsTs = (version: number, digest: string) =>
    lines('/** 说明 */', versionLine(version), digestLine(digest), '', 'export const X = 1;');
  const historyTs = (entries: string) =>
    lines("  it('版本历史', () => {", '    // 说明', '    const HISTORY: Record<number, string> = {') +
    entries +
    lines('    };', '    expect(HISTORY).toBeDefined();', '  });');
  const mainHistory = [h(16, D(1), 'B7a'), h(17, D(2), 'B7b')];
  const main = { version: 17, digest: D(2) };

  it('本分支改了编码、写的是过期占位（与 main 撞号 17）：定为 main + 1 = 18，指纹取合并结果，注释沿用本分支', () => {
    const plan = planGrantVersion({
      main,
      mainHistory,
      branch: { version: 17, digest: D(3) },
      branchHistory: [h(16, D(1), 'B7a'), h(17, D(3), 'B6b：模板复制按钮')],
      mergedDigest: D(4),
      label: 'claude/x（merge:main 定号，DEC-439④）',
    });
    expect(plan).toMatchObject({ bumped: true, changed: true, version: 18, digest: D(4) });
    expect(plan.history).toEqual([...mainHistory, h(18, D(4), 'B6b：模板复制按钮')]);
  });

  it('本分支在分支里递增过两次：并成 main + 1 一行，注释合并；没写历史行就用 label', () => {
    const many = planGrantVersion({
      main,
      mainHistory,
      branch: { version: 19, digest: D(5) },
      branchHistory: [...mainHistory.slice(0, 1), h(17, D(6), 'a'), h(18, D(7), 'b'), h(19, D(5), 'b')],
      mergedDigest: D(8),
      label: 'L',
    });
    expect(many.history.at(-1)).toEqual(h(18, D(8), 'a', 'b'));
    const bare = planGrantVersion({
      main,
      mainHistory,
      branch: { version: 16, digest: D(1) },
      branchHistory: mainHistory.slice(0, 1),
      mergedDigest: D(9),
      label: 'L',
    });
    expect(bare.history.at(-1)).toEqual(h(18, D(9), 'L'));
  });

  it('合并结果指纹等于 main：本分支没改编码（或与 main 改得一样），全部取 main', () => {
    const plan = planGrantVersion({
      main,
      mainHistory,
      branch: { version: 16, digest: D(1) },
      branchHistory: mainHistory.slice(0, 1),
      mergedDigest: D(2),
      label: 'L',
    });
    expect(plan).toMatchObject({ bumped: false, changed: true, version: 17, digest: D(2), history: mainHistory });
  });

  it('重复运行（分支已含 main 且已定号）：结果不变，changed 为假', () => {
    const history = [...mainHistory, h(18, D(4), 'B6b')];
    const input = { main, mainHistory, branch: { version: 18, digest: D(4) }, branchHistory: history, label: 'L' };
    const plan = planGrantVersion({ ...input, mergedDigest: D(4) });
    expect(plan).toMatchObject({ bumped: true, changed: false, version: 18, history });
  });

  it('main 自身的常量与历史最后一行对不上：拒绝定号', () => {
    expect(() =>
      planGrantVersion({
        main: { version: 18, digest: D(2) },
        mainHistory,
        branch: undefined,
        branchHistory: [],
        mergedDigest: D(4),
        label: 'L',
      }),
    ).toThrow(/对不上/);
  });

  it('读写常量与 HISTORY：只改这两行与 HISTORY 块，其余原样；注释行保留', () => {
    const ts = grantsTs(17, D(2));
    expect(readGrantConstants(ts)).toEqual({ version: 17, digest: D(2) });
    expect(writeGrantConstants(ts, { version: 18, digest: D(4) })).toBe(grantsTs(18, D(4)));
    expect(() => readGrantConstants('export const X = 1;\n')).toThrow();
    const text = historyTs(`      // B7a\n      16: '${D(1)}',\n      // B7b\n      // 第二行\n      17: '${D(2)}',\n`);
    expect(parseGrantHistory(text)).toEqual([h(16, D(1), 'B7a'), h(17, D(2), 'B7b', '第二行')]);
    const out = writeGrantHistory(text, [...parseGrantHistory(text), h(18, D(4), 'B6b')]);
    expect(out).toBe(
      historyTs(
        lines(
          '      // B7a',
          `      16: '${D(1)}',`,
          '      // B7b',
          '      // 第二行',
          `      17: '${D(2)}',`,
          '      // B6b',
          `      18: '${D(4)}',`,
        ),
      ),
    );
    expect(() => parseGrantHistory(historyTs(`      16: '${D(1)}',\n      foo(),\n`))).toThrow(/无法识别/);
  });

  it('仓库里的两个文件可解析，且与 @italent/domain 导出的常量一致', () => {
    expect(readGrantConstants(readFileSync(GRANTS_PATH, 'utf8'))).toEqual({
      version: STANDARD_GRANT_VERSION,
      digest: STANDARD_GRANT_DIGEST,
    });
    expect(parseGrantHistory(readFileSync(GRANT_HISTORY_PATH, 'utf8')).at(-1)).toMatchObject({
      version: STANDARD_GRANT_VERSION,
      digest: STANDARD_GRANT_DIGEST,
    });
  });

  const hunk = (ours: string, base: string, theirs: string) =>
    `<<<<<<< HEAD\n${ours}||||||| merge-base\n${base}=======\n${theirs}>>>>>>> origin/main\n`;

  it('standard-grants.ts：只冲突在 version / 指纹两行时取 main 一侧；业务代码冲突照旧停下', () => {
    const constants = hunk(
      `export const STANDARD_GRANT_VERSION = 18;\nexport const STANDARD_GRANT_DIGEST = '${D(3)}';\n`,
      `export const STANDARD_GRANT_VERSION = 17;\nexport const STANDARD_GRANT_DIGEST = '${D(2)}';\n`,
      `export const STANDARD_GRANT_VERSION = 18;\nexport const STANDARD_GRANT_DIGEST = '${D(4)}';\n`,
    );
    expect(resolveGrantConflict(GRANTS_PATH, `/** x */\n${constants}tail\n`)).toEqual({
      text: lines('/** x */', versionLine(18), digestLine(D(4)), 'tail'),
      remaining: 0,
    });
    const business = hunk("approve('a');\n", '', "approve('b');\n");
    expect(resolveGrantConflict(GRANTS_PATH, `${constants}${business}`)!.remaining).toBe(1);
    // 常量与业务代码挤在同一处冲突里：不自动处理
    const mixed = hunk(
      `export const STANDARD_GRANT_VERSION = 18;\nconst a = 1;\n`,
      '',
      'export const STANDARD_GRANT_VERSION = 18;\n',
    );
    expect(resolveGrantConflict(GRANTS_PATH, mixed)!.remaining).toBe(1);
    expect(resolveGrantConflict('apps/api/src/app.ts', constants)).toBeNull();
  });

  it('F061 测试：只在 HISTORY 内的条目 / 注释冲突取 main 一侧；HISTORY 之外的同形冲突照旧停下', () => {
    const entries = hunk(`      // B6b\n      18: '${D(3)}',\n`, '', `      // B7c\n      18: '${D(4)}',\n`);
    const inside = historyTs(`      17: '${D(2)}',\n${entries}`);
    const resolved = resolveGrantConflict(GRANT_HISTORY_PATH, inside)!;
    expect(resolved.remaining).toBe(0);
    expect(parseGrantHistory(resolved.text)).toEqual([h(17, D(2)), h(18, D(4), 'B7c')]);
    const outside = `const OTHER = {\n${entries}};\n${historyTs(`      17: '${D(2)}',\n`)}`;
    expect(resolveGrantConflict(GRANT_HISTORY_PATH, outside)!.remaining).toBe(1);
    const afterHistory = `${historyTs(`      17: '${D(2)}',\n`)}${hunk('    // a\n', '', '    // b\n')}`;
    expect(resolveGrantConflict(GRANT_HISTORY_PATH, afterHistory)!.remaining).toBe(1);
  });
});
