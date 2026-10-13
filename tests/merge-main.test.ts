/**
 * DEC-430①：生成物合并后重算、迁移编号合并时分配。
 * 1. pnpm merge:main 的纯函数（scripts/merge-main-lib.mjs）：生成物白名单、迁移改号、快照三方合并、“只改计数”冲突识别；
 * 2. 生成物开关（generated-gate.ts）：PR 上只警告、GENERATED_STRICT=1 判红；
 * 3. 端点计数比较（endpoint-counts.ts）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyConflict,
  type Journal,
  type JournalEntry,
  formatStale,
  isGeneratedPath,
  maskNumbers,
  merge3,
  normalizeSql,
  planRenumber,
  rebaseSnapshots,
  type Snapshot,
  sqlDigest,
  takeOursForCounts,
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

describe('SQL 规范化与摘要（normalizeSql / sqlDigest）', () => {
  const sql = 'CREATE TABLE a (id int);\n--> statement-breakpoint\nCREATE INDEX i ON a (id);';

  it('统一换行（CRLF / CR → LF）、去 BOM、去每行尾部空白、去文件尾部空行；行内与行首缩进不动', () => {
    expect(normalizeSql(`\uFEFFCREATE TABLE a (\r\n  id int  \t\r\n);\r\n\r\n`)).toBe('CREATE TABLE a (\n  id int\n);');
    expect(normalizeSql('a\rb\n')).toBe('a\nb');
    expect(normalizeSql('SELECT  1;')).toBe('SELECT  1;');
  });

  it('只差换行风格 / 尾部空白 / 文件尾换行的 SQL 摘要相同；内容有差异则不同；摘要是 64 位十六进制', () => {
    expect(sqlDigest(sql)).toMatch(/^[0-9a-f]{64}$/);
    expect(sqlDigest(`${sql.replaceAll('\n', '\r\n')}\r\n`)).toBe(sqlDigest(sql));
    expect(sqlDigest(`${sql}  \n\n`)).toBe(sqlDigest(sql));
    expect(sqlDigest(sql.replace('int', 'bigint'))).not.toBe(sqlDigest(sql));
  });

  it('读不到或规范化后为空：没有摘要（不能拿空内容当“相同”）', () => {
    expect(sqlDigest(undefined)).toBeUndefined();
    expect(sqlDigest(' \r\n\n')).toBeUndefined();
  });
});

describe('叠放分支：上游已合并但改了号的迁移（planRenumber 按 SQL 内容识别）', () => {
  // 场景（C1 叠在上游 PR 上）：本分支带着上游合并前的旧名迁移 0002/0003，main 上它们已改号为 0005/0006，SQL 相同
  const base = [entry(0, 'init', 100), entry(1, 'org', 200)];
  const main = journal(
    ...base,
    entry(2, 'm1', 400),
    entry(3, 'm2', 500),
    entry(4, 'm3', 600),
    entry(5, 'up_a', 700),
    entry(6, 'up_b', 800),
  );
  const branch = journal(...base, entry(2, 'up_a', 300), entry(3, 'up_b', 350), entry(4, 'mine', 360));
  const files = (rows: Record<string, string>) => (tag: string) => rows[tag];
  const mainSql = files({
    '0002_m1': 'CREATE TABLE m1 (id int);',
    '0003_m2': 'CREATE TABLE m2 (id int);',
    '0004_m3': 'CREATE TABLE m3 (id int);',
    '0005_up_a': 'CREATE TABLE up_a (id int);\n',
    '0006_up_b': 'ALTER TABLE up_a ADD COLUMN x int;\n--> statement-breakpoint\nALTER TABLE up_a ADD COLUMN y int;\n',
  });
  // 本分支的旧名文件：换行风格 / 尾部空白不同，规范化后逐字节相同
  const branchSql = files({
    '0002_up_a': 'CREATE TABLE up_a (id int);  \r\n\r\n',
    '0003_up_b': 'ALTER TABLE up_a ADD COLUMN x int;\r\n--> statement-breakpoint\r\nALTER TABLE up_a ADD COLUMN y int;',
    '0004_mine': 'CREATE TABLE mine (id int);\n',
  });

  it('与 main 上迁移内容相同的旧名迁移识别为已合并：清理不改号，只给真正新增的定号', () => {
    const plan = planRenumber(main, branch, { main: mainSql, branch: branchSql });
    expect(plan.stale.map((s) => [s.from.tag, s.mainEntry.tag])).toEqual([
      ['0002_up_a', '0005_up_a'],
      ['0003_up_b', '0006_up_b'],
    ]);
    expect(plan.renames.map((r) => [r.from.tag, r.to.tag])).toEqual([['0004_mine', '0007_mine']]);
    expect(plan.journal.entries.map((e) => e.tag)).toEqual([...main.entries.map((e) => e.tag), '0007_mine']);
    expect(plan.journal.entries.at(-1)!.when).toBe(801);
    expect(plan.changed).toBe(true);
    // 分叉点 = 真正新增的迁移之前那一条（旧名 0003_up_b 的快照，含上游改动）
    expect(plan.forkIdx).toBe(3);
  });

  it('本分支只有已合并的旧名迁移：全部清理，没有改号，journal 与 main 一致', () => {
    const only = journal(...base, entry(2, 'up_a', 300), entry(3, 'up_b', 350));
    const plan = planRenumber(main, only, { main: mainSql, branch: branchSql });
    expect(plan.stale).toHaveLength(2);
    expect(plan.renames).toEqual([]);
    expect(plan.changed).toBe(true);
    expect(plan.journal).toEqual(main);
    expect(plan.forkIdx).toBeUndefined();
  });

  it('SQL 内容不同（哪怕名字只差编号）不算已合并：照旧当作本分支新增并改号', () => {
    const edited = files({
      ...Object.fromEntries(['0002_up_a', '0003_up_b', '0004_mine'].map((t) => [t, branchSql(t)!])),
      '0003_up_b': 'ALTER TABLE up_a ADD COLUMN z int;',
    });
    const plan = planRenumber(main, branch, { main: mainSql, branch: edited });
    expect(plan.stale.map((s) => s.from.tag)).toEqual(['0002_up_a']);
    expect(plan.renames.map((r) => [r.from.tag, r.to.tag])).toEqual([
      ['0003_up_b', '0007_up_b'],
      ['0004_mine', '0008_mine'],
    ]);
  });

  it('本分支已带着的 main 同名迁移不参与认领：旧名条目不能再认领它，照常当作新增', () => {
    const merged = journal(...base, entry(2, 'x', 300), entry(5, 'up_a', 700));
    const kept = files({ '0002_x': 'CREATE TABLE up_a (id int);', '0005_up_a': 'CREATE TABLE up_a (id int);\n' });
    const again = planRenumber(main, merged, { main: mainSql, branch: kept });
    expect(again.stale).toEqual([]);
    expect(again.renames.map((r) => r.from.tag)).toEqual(['0002_x']);
  });

  it('保护①多对一：多个旧名对应 main 上同一条：不清理，报错停下并列出涉及的名字', () => {
    const dup = journal(...base, entry(2, 'up_a', 300), entry(3, 'up_a_copy', 350));
    const both = files({ '0002_up_a': 'CREATE TABLE up_a (id int);', '0003_up_a_copy': 'CREATE TABLE up_a (id int);' });
    const run = () => planRenumber(main, dup, { main: mainSql, branch: both });
    expect(run).toThrow(/不是一一对应/);
    expect(run).toThrow(/0002_up_a/);
    expect(run).toThrow(/0003_up_a_copy/);
    expect(run).toThrow(/0005_up_a/);
  });

  it('保护①一对多：一个旧名对应 main 上多条相同内容的迁移：不清理，报错停下并列出涉及的名字', () => {
    const twin = journal(...main.entries, entry(7, 'up_a_twin', 900));
    const twinSql = (tag: string) => (tag === '0007_up_a_twin' ? 'CREATE TABLE up_a (id int);\r\n' : mainSql(tag));
    const run = () => planRenumber(twin, branch, { main: twinSql, branch: branchSql });
    expect(run).toThrow(/不是一一对应/);
    expect(run).toThrow(/0002_up_a/);
    expect(run).toThrow(/0005_up_a/);
    expect(run).toThrow(/0007_up_a_twin/);
  });

  it('保护①：对应关系唯一时不受影响（内容不同的旧名与重复内容的 main 迁移互不牵连）', () => {
    const plan = planRenumber(main, branch, { main: mainSql, branch: branchSql });
    expect(plan.stale).toHaveLength(2);
  });

  it('保护②：空迁移或只有注释 / 空白 / 分隔符的 SQL 不参与去重，照常按新增处理', () => {
    const empties = [
      '',
      '  \r\n\n',
      '-- 占位\n',
      '/* 说明\n多行 */\n',
      '--> statement-breakpoint\n;\n',
      '-- a\n/* b */ ;',
    ];
    for (const text of empties) {
      const emptyMain = (tag: string) => (tag === '0005_up_a' ? text : mainSql(tag));
      const only = journal(...base, entry(2, 'blank', 300));
      const plan = planRenumber(main, only, { main: emptyMain, branch: () => text });
      expect(plan.stale, JSON.stringify(text)).toEqual([]);
      expect(
        plan.renames.map((r) => r.from.tag),
        JSON.stringify(text),
      ).toEqual(['0002_blank']);
    }
    // 两边都是占位注释、且 main 上有多条这样的迁移：也不报一对多
    const manyBlank = (tag: string) => (['0005_up_a', '0006_up_b'].includes(tag) ? '-- 占位\n' : mainSql(tag));
    const plan = planRenumber(main, journal(...base, entry(2, 'blank', 300)), {
      main: manyBlank,
      branch: () => '-- 占位\n',
    });
    expect(plan.stale).toEqual([]);
  });

  it('保护②：注释之外有实际语句的 SQL 仍可识别（注释内容不同则摘要不同）', () => {
    expect(sqlDigest('-- 说明\nCREATE TABLE a (id int);')).toMatch(/^[0-9a-f]{64}$/);
    expect(sqlDigest('/* x */ ALTER TABLE a ADD y int;--> statement-breakpoint\n')).toMatch(/^[0-9a-f]{64}$/);
    expect(sqlDigest('-- 说明一\nSELECT 1;')).not.toBe(sqlDigest('-- 说明二\nSELECT 1;'));
  });

  it('保护③：清理的每一对记下 sha256（规范化后），格式化成“旧名 → main 名 sha256=摘要”', () => {
    const plan = planRenumber(main, branch, { main: mainSql, branch: branchSql });
    expect(plan.stale.map((s) => s.digest)).toEqual([
      sqlDigest('CREATE TABLE up_a (id int);'),
      sqlDigest('ALTER TABLE up_a ADD COLUMN x int;\n--> statement-breakpoint\nALTER TABLE up_a ADD COLUMN y int;'),
    ]);
    expect(formatStale(plan.stale)).toEqual([
      `0002_up_a → 0005_up_a  sha256=${sqlDigest('CREATE TABLE up_a (id int);')}`,
      `0003_up_b → 0006_up_b  sha256=${plan.stale[1]!.digest}`,
    ]);
    expect(formatStale([])).toEqual([]);
  });

  it('读不到 SQL 或没传读取函数：不做内容识别（行为同按名字比对）', () => {
    expect(planRenumber(main, branch).stale).toEqual([]);
    expect(planRenumber(main, branch, { main: mainSql, branch: () => undefined }).stale).toEqual([]);
    expect(planRenumber(main, branch).renames).toHaveLength(3);
  });

  it('清理后的结果再算一遍是稳定的：不再改号', () => {
    const first = planRenumber(main, branch, { main: mainSql, branch: branchSql });
    const second = planRenumber(first.journal, first.journal, { main: mainSql, branch: branchSql });
    expect(second.changed).toBe(false);
    expect(second.stale).toEqual([]);
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
