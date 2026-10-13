/**
 * DEC-430①：生成物合并后重算、迁移编号合并时分配；DEC-439④：授权版本合并时定号。
 * 1. pnpm merge:main 的纯函数（scripts/merge-main-lib.mjs）：生成物白名单、迁移改号、快照三方合并、“只改计数”冲突识别；
 * 2. 生成物开关（generated-gate.ts）：PR 上只警告、GENERATED_STRICT=1 判红；
 * 3. 端点计数比较（endpoint-counts.ts）；
 * 4. 授权版本定号（planGrantVersion 等，DEC-439④）；
 * 5. 授权项编码增删声明与动态基线、--check 定号预告（F-097）。
 */
import { readFileSync } from 'node:fs';
import { STANDARD_GRANT_DIGEST, STANDARD_GRANT_VERSION } from '@italent/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeGrantChanges,
  checkGrantChanges,
  checkSnapshotIdentity,
  classifyConflict,
  describeGrantPlan,
  EMPTY_GRANT_CHANGES,
  GRANT_CHANGES_PATH,
  GRANT_HISTORY_PATH,
  type GrantHistoryEntry,
  GRANTS_PATH,
  type Journal,
  type JournalEntry,
  formatStale,
  isGeneratedPath,
  maskNumbers,
  merge3,
  parseGrantChanges,
  parseGrantHistory,
  pickGrantChanges,
  planGrantVersion,
  planRenumber,
  readGrantConstants,
  rebaseSnapshots,
  resolveGrantConflict,
  type Snapshot,
  sqlDigest,
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

describe('SQL 摘要（sqlDigest：原始内容的 sha256）与空迁移判定', () => {
  const sql = 'CREATE TABLE a (id int);\n--> statement-breakpoint\nCREATE INDEX i ON a (id);';

  it('摘要是原始内容的 64 位十六进制 sha256；逐字节相同则相同，换行风格 / 尾部空白 / 文件尾换行任何差异都不同', () => {
    expect(sqlDigest(sql)).toMatch(/^[0-9a-f]{64}$/);
    expect(sqlDigest(`${sql}`)).toBe(sqlDigest(sql));
    expect(sqlDigest(sql.replaceAll('\n', '\r\n'))).not.toBe(sqlDigest(sql));
    expect(sqlDigest(`${sql}  `)).not.toBe(sqlDigest(sql));
    expect(sqlDigest(`${sql}\n`)).not.toBe(sqlDigest(sql));
    expect(sqlDigest(sql.replace('int', 'bigint'))).not.toBe(sqlDigest(sql));
  });

  it('引号 / dollar quote 内部只差行尾空白或换行的两条不同迁移，摘要不同', () => {
    const pairs = [
      ["INSERT INTO t VALUES ('a  \nb');", "INSERT INTO t VALUES ('a\nb');"],
      ["INSERT INTO t VALUES ('a\r\nb');", "INSERT INTO t VALUES ('a\nb');"],
      ['SELECT "col  \nname" FROM t;', 'SELECT "col\nname" FROM t;'],
      ['DO $$ BEGIN\n  PERFORM 1;  \nEND $$;', 'DO $$ BEGIN\n  PERFORM 1;\nEND $$;'],
      ['SELECT $q$x\r\ny$q$;', 'SELECT $q$x\ny$q$;'],
    ] as const;
    for (const [a, b] of pairs) expect(sqlDigest(a), a).not.toBe(sqlDigest(b));
  });

  it('读不到：没有摘要', () => {
    expect(sqlDigest(undefined)).toBeUndefined();
  });

  it('空 / 只有空白、分号、行注释、块注释（含嵌套）、分隔符的 SQL 没有摘要', () => {
    const blanks = [
      '',
      ' \r\n\n',
      ';;',
      '-- 占位',
      '--> statement-breakpoint\n;\n',
      '/* 说明\n多行 */',
      '/* 外 /* 内 */ 外 */',
      '/* a /* b /* c */ d */ e */ -- 尾\n;',
      '-- /* 行注释里的块起始不开启块注释\n',
      '/* 块注释里的 -- 不是行注释 */ -- 真行注释',
      '/* 没有结尾的块注释',
    ];
    for (const text of blanks) expect(sqlDigest(text), JSON.stringify(text)).toBeUndefined();
  });

  it('有实际语句的 SQL 有摘要：被行注释“包住”的块注释起止不算注释、嵌套块注释结束后的内容、引号与 dollar quote', () => {
    const contents = [
      '-- /*\nCREATE TABLE a (id int);\n-- */',
      '-- /*\nCREATE TABLE a (id int);\n-- */\n',
      '/* 外 /* 内 */ SELECT 1; */ SELECT 2;',
      '/* 外 /* 内 */ 外 */ SELECT 1;',
      '/* x */ ALTER TABLE a ADD y int;--> statement-breakpoint\n',
      "SELECT '/* 不是注释 */';",
      "SELECT '-- 不是注释';",
      'SELECT "a--b";',
      'SELECT $$ /* x $$;',
      '/',
      'a',
    ];
    for (const text of contents) expect(sqlDigest(text), JSON.stringify(text)).toMatch(/^[0-9a-f]{64}$/);
    expect(sqlDigest('-- 说明一\nSELECT 1;')).not.toBe(sqlDigest('-- 说明二\nSELECT 1;'));
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
  // 本分支的旧名文件：改号只改文件名，内容逐字节相同
  const branchSql = files({
    '0002_up_a': 'CREATE TABLE up_a (id int);\n',
    '0003_up_b': 'ALTER TABLE up_a ADD COLUMN x int;\n--> statement-breakpoint\nALTER TABLE up_a ADD COLUMN y int;\n',
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
    const kept = files({ '0002_x': 'CREATE TABLE up_a (id int);\n', '0005_up_a': 'CREATE TABLE up_a (id int);\n' });
    const again = planRenumber(main, merged, { main: mainSql, branch: kept });
    expect(again.stale).toEqual([]);
    expect(again.renames.map((r) => r.from.tag)).toEqual(['0002_x']);
  });

  it('保护①多对一：多个旧名对应 main 上同一条：不清理，报错停下并列出涉及的名字', () => {
    const dup = journal(...base, entry(2, 'up_a', 300), entry(3, 'up_a_copy', 350));
    const both = files({
      '0002_up_a': 'CREATE TABLE up_a (id int);\n',
      '0003_up_a_copy': 'CREATE TABLE up_a (id int);\n',
    });
    const run = () => planRenumber(main, dup, { main: mainSql, branch: both });
    expect(run).toThrow(/不是一一对应/);
    expect(run).toThrow(/0002_up_a/);
    expect(run).toThrow(/0003_up_a_copy/);
    expect(run).toThrow(/0005_up_a/);
  });

  it('保护①一对多：一个旧名对应 main 上多条相同内容的迁移：不清理，报错停下并列出涉及的名字', () => {
    const twin = journal(...main.entries, entry(7, 'up_a_twin', 900));
    const twinSql = (tag: string) => (tag === '0007_up_a_twin' ? 'CREATE TABLE up_a (id int);\n' : mainSql(tag));
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
      '/* 外 /* 内 */ 外 */\n',
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

  it('保护③：清理的每一对记下 sha256，格式化成“旧名 → main 名 sha256=摘要”', () => {
    const plan = planRenumber(main, branch, { main: mainSql, branch: branchSql });
    expect(plan.stale.map((s) => s.digest)).toEqual([sqlDigest(mainSql('0005_up_a')), sqlDigest(mainSql('0006_up_b'))]);
    expect(formatStale(plan.stale)).toEqual([
      `0002_up_a → 0005_up_a  sha256=${sqlDigest(mainSql('0005_up_a'))}`,
      `0003_up_b → 0006_up_b  sha256=${plan.stale[1]!.digest}`,
    ]);
    expect(formatStale([])).toEqual([]);
  });

  it('保护②（回归）：-- /* … -- */ 包住的 CREATE TABLE 是实际语句，不当空迁移；嵌套块注释不被提前截断', () => {
    const wrapped = '-- /*\nCREATE TABLE up_a (id int);\n-- */\n';
    const only = journal(...base, entry(2, 'up_a', 300));
    // 两边内容逐字节相同且有实际语句：识别为已合并（而不是被当空迁移留下来再改号一次）
    const same = planRenumber(main, only, {
      main: (tag) => (tag === '0005_up_a' ? wrapped : mainSql(tag)),
      branch: () => wrapped,
    });
    expect(same.stale.map((s) => s.from.tag)).toEqual(['0002_up_a']);
    // 内容不同则不会互相认领
    const differ = planRenumber(main, only, {
      main: (tag) => (tag === '0005_up_a' ? wrapped : mainSql(tag)),
      branch: () => '-- /*\nCREATE TABLE other (id int);\n-- */\n',
    });
    expect(differ.stale).toEqual([]);
    // 嵌套块注释后面还有语句：有内容，相同则识别为已合并
    const nested = '/* 外 /* 内 */ 外 */ CREATE TABLE up_a (id int);\n';
    const again = planRenumber(main, only, {
      main: (tag) => (tag === '0005_up_a' ? nested : mainSql(tag)),
      branch: () => nested,
    });
    expect(again.stale).toHaveLength(1);
  });

  it('保护①（回归）：引号内行尾空白 / 换行不同的两条不同迁移不被判同，各自按新增改号', () => {
    const only = journal(...base, entry(2, 'up_a', 300));
    const quoted = (body: string) => `INSERT INTO t VALUES ('${body}');\n`;
    const plan = planRenumber(main, only, {
      main: (tag) => (tag === '0005_up_a' ? quoted('a  \nb') : mainSql(tag)),
      branch: () => quoted('a\nb'),
    });
    expect(plan.stale).toEqual([]);
    expect(plan.renames.map((r) => r.from.tag)).toEqual(['0002_up_a']);
  });

  it('保护③（交错 U1→N1→U2→N2）：每条新增迁移记下它在本分支 journal 里的前一条（baseIdx）', () => {
    const woven = journal(
      ...base,
      entry(2, 'up_a', 300),
      entry(3, 'n1', 310),
      entry(4, 'up_b', 320),
      entry(5, 'n2', 330),
    );
    const wovenSql = files({
      '0002_up_a': mainSql('0005_up_a')!,
      '0003_n1': 'CREATE TABLE n1 (id int);\n',
      '0004_up_b': mainSql('0006_up_b')!,
      '0005_n2': 'CREATE TABLE n2 (id int);\n',
    });
    const plan = planRenumber(main, woven, { main: mainSql, branch: wovenSql });
    expect(plan.stale.map((s) => s.from.tag)).toEqual(['0002_up_a', '0004_up_b']);
    expect(plan.renames.map((r) => [r.from.tag, r.to.tag, r.baseIdx])).toEqual([
      ['0003_n1', '0007_n1', 2],
      ['0005_n2', '0008_n2', 4],
    ]);
    expect(plan.forkIdx).toBe(2);
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

describe('保留迁移的快照身份检查（checkSnapshotIdentity）', () => {
  const main = [
    { tag: '0002_m', id: 'id-m' },
    { tag: '0003_up_x', id: 'id-x' },
  ];
  const digests: Record<string, string | undefined> = { 'main:0003_up_x': 'aaa', 'branch:0002_up_x': 'bbb' };
  const digestOf = (side: 'main' | 'branch', tag: string) => digests[`${side}:${tag}`];

  it('保留项的快照 id 都是新的：没有问题', () => {
    expect(
      checkSnapshotIdentity({ main, kept: [{ tag: '0002_mine', id: 'id-mine' }], mainLastId: 'id-x', digestOf }),
    ).toEqual([]);
  });

  it('保留项的快照 id 与 main 的某条重复：列出文件对与两边摘要；重复的是 main 最新一条时提示自环', () => {
    const problems = checkSnapshotIdentity({
      main,
      kept: [{ tag: '0002_up_x', id: 'id-x' }],
      mainLastId: 'id-x',
      digestOf,
    });
    expect(problems).toHaveLength(1);
    for (const part of ['0002_up_x.sql', 'sha256=bbb', '0003_up_x.sql', 'sha256=aaa', 'id-x', '自环'])
      expect(problems[0], part).toContain(part);
    const notLast = checkSnapshotIdentity({
      main,
      kept: [{ tag: '0002_dup', id: 'id-m' }],
      mainLastId: 'id-x',
      digestOf,
    });
    expect(notLast[0]).toContain('0002_m.sql');
    expect(notLast[0]).not.toContain('自环');
  });

  it('保留项之间快照 id 重复、读不到摘要：也报告（摘要显示为“无”）', () => {
    const problems = checkSnapshotIdentity({
      main,
      kept: [
        { tag: '0004_p', id: 'id-p' },
        { tag: '0005_q', id: 'id-p' },
      ],
      mainLastId: 'id-x',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('0004_p.sql');
    expect(problems[0]).toContain('0005_q.sql');
  });

  it('没有快照 id（读不到）的条目跳过', () => {
    expect(checkSnapshotIdentity({ main, kept: [{ tag: '0009_z', id: undefined }], mainLastId: 'id-x' })).toEqual([]);
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

  it('交错 U1→N1→U2→N2：每条新增迁移只叠自己相对前一条的增量，已合并的上游变化不重算成本分支改动', () => {
    // 上游 U1 加 job；N1 加 succ；上游 U2 给 job 加列 x（int）；N2 加 n2。main 在合入 U2 之后又把 job.x 改成 text。
    const col = (type: string) => ({ type });
    const t = (cols: Record<string, { type: string }>) => ({ columns: cols });
    const u1 = snap('u1', 'f', { org: t({ id: col('uuid') }), job: t({ id: col('uuid') }) });
    const n1 = snap('n1', 'u1', { ...(u1['tables'] as object), succ: t({ id: col('uuid') }) });
    const u2 = snap('u2', 'n1', {
      ...(n1['tables'] as object),
      job: t({ id: col('uuid'), x: col('int') }),
    });
    const n2 = snap('n2', 'u2', { ...(u2['tables'] as object), n2: t({ id: col('uuid') }) });
    const mainLast = snap('m', 'u2m', {
      org: t({ id: col('uuid') }),
      job: t({ id: col('uuid'), x: col('text') }),
    });
    const { snapshots, conflicts } = rebaseSnapshots(u1, [n1, n2], mainLast, [u1, u2]);
    expect(conflicts).toEqual([]);
    expect(snapshots.map((s) => [s.id, s.prevId])).toEqual([
      ['n1', 'm'],
      ['n2', 'n1'],
    ]);
    expect(snapshots[1]!['tables']).toEqual({
      org: t({ id: col('uuid') }),
      job: t({ id: col('uuid'), x: col('text') }),
      succ: t({ id: col('uuid') }),
      n2: t({ id: col('uuid') }),
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

describe('授权项编码增删声明与动态基线（F-097）', () => {
  const declare = (add: string[] = [], remove: string[] = [], reason = 'B6b：模板复制按钮') =>
    JSON.stringify({ reason, add, remove });
  const base = ['p/app:A', 'p/O/op:view', 'p/O/field:f:view', 'q/app:A'];

  it('声明文件：本 PR 改写过才生效；与基线相同（从 main 继承的上一个 PR 的声明）视为没有声明', () => {
    const old = declare(['p/O/button:copy@list']);
    expect(activeGrantChanges(old, old)).toEqual(EMPTY_GRANT_CHANGES);
    expect(activeGrantChanges(old, undefined)).toEqual(EMPTY_GRANT_CHANGES);
    expect(activeGrantChanges(undefined, old).add).toEqual(['p/O/button:copy@list']);
    expect(activeGrantChanges(old, declare(['p/X*'])).add).toEqual(['p/X*']);
  });

  it('声明文件格式：reason 必填，add / remove 是非空字符串数组；不允许裸 * 或没有 / 的前缀', () => {
    expect(parseGrantChanges(declare(['p/O*'], ['q/app:A']))).toEqual({
      reason: 'B6b：模板复制按钮',
      add: ['p/O*'],
      remove: ['q/app:A'],
    });
    expect(() => parseGrantChanges('{"add":[],"remove":[]}')).toThrow(/reason/);
    expect(() => parseGrantChanges(declare([''] as string[]))).toThrow(/非空字符串/);
    expect(() => parseGrantChanges(declare(['*']))).toThrow(/前缀/);
    expect(() => parseGrantChanges(declare(['standard*']))).toThrow(/前缀/);
    expect(() => parseGrantChanges('{"reason":"","add":"x","remove":[]}')).toThrow(/add/);
  });

  it('实际增删与声明一致（含前缀条目）：通过', () => {
    const head = [...base.filter((c) => c !== 'q/app:A'), 'p/O/button:copy@list', 'p/T/op:view', 'p/T/field:x:view'];
    const result = checkGrantChanges({
      baseCodes: base,
      headCodes: head,
      declared: { reason: 'r', add: ['p/O/button:copy@list', 'p/T/*'], remove: ['q/app:A'] },
    });
    expect(result).toEqual({
      added: ['p/O/button:copy@list', 'p/T/field:x:view', 'p/T/op:view'],
      removed: ['q/app:A'],
      problems: [],
    });
  });

  it('多出未声明的增删、声明的没发生：逐条列出', () => {
    const head = [...base.filter((c) => c !== 'p/O/field:f:view'), 'p/O/button:copy@list', 'p/O/button:x@list'];
    const { problems } = checkGrantChanges({
      baseCodes: base,
      headCodes: head,
      declared: { reason: 'r', add: ['p/O/button:copy@list', 'p/Gone/op:view'], remove: ['q/app:A'] },
    });
    expect(problems).toEqual([
      '未声明的新增编码：p/O/button:x@list',
      '未声明的删除编码：p/O/field:f:view',
      '声明新增但当前编码里没有：p/Gone/op:view',
      '声明删除但当前编码里仍有：q/app:A（如 q/app:A）',
    ]);
  });

  it('没有声明（或继承的旧声明）时，编码集合不许变', () => {
    expect(checkGrantChanges({ baseCodes: base, headCodes: base, declared: EMPTY_GRANT_CHANGES }).problems).toEqual([]);
    expect(
      checkGrantChanges({ baseCodes: base, headCodes: [...base, 'p/O/op:delete'], declared: EMPTY_GRANT_CHANGES })
        .problems,
    ).toEqual(['未声明的新增编码：p/O/op:delete']);
  });

  it('别的 PR 先在 main 上加了同一编码：基线已有，本 PR 的声明不算失败（当前编码里有即可）', () => {
    const head = [...base, 'p/O/button:copy@list'];
    expect(
      checkGrantChanges({
        baseCodes: head,
        headCodes: head,
        declared: { reason: 'r', add: ['p/O/button:copy@list'], remove: [] },
      }).problems,
    ).toEqual([]);
  });

  it('合并时声明文件取哪边：本分支改过整份取本分支，否则取 main；不逐行拼接', () => {
    const fork = declare(['a/x'], [], 'A');
    const mine = declare(['b/y'], [], 'B');
    const theirs = declare(['c/z'], [], 'C');
    expect(pickGrantChanges({ branch: mine, fork, main: theirs })).toBe(mine);
    expect(pickGrantChanges({ branch: fork, fork, main: theirs })).toBe(theirs);
    expect(pickGrantChanges({ branch: mine, fork: undefined, main: undefined })).toBe(mine);
    expect(pickGrantChanges({ branch: undefined, fork: undefined, main: theirs })).toBe(theirs);
  });

  it('仓库里的声明文件可解析', () => {
    expect(() => parseGrantChanges(readFileSync(GRANT_CHANGES_PATH, 'utf8'))).not.toThrow();
  });

  const D = (n: number) => String(n).repeat(16).slice(0, 16);
  const main = { version: 18, digest: D(2) };

  it('--check 预告按合并结果：两个 PR 加了同一编码时合并结果与 main 相同，预告取 main 的 18（不再说 19）', () => {
    const text = describeGrantPlan({ main, mergedDigest: D(2), branchDigest: D(3), forkDigest: D(1) });
    expect(text).toContain('取 main 的 version 18');
    expect(text).toContain('main 上已有');
    expect(text).not.toContain('19');
    expect(describeGrantPlan({ main, mergedDigest: D(2), branchDigest: D(1), forkDigest: D(1) })).not.toContain(
      'main 上已有',
    );
  });

  it('--check 预告按合并结果：与 main 不同则 main + 1 并给出合并结果指纹', () => {
    const text = describeGrantPlan({ main, mergedDigest: D(4), branchDigest: D(3), forkDigest: D(1) });
    expect(text).toContain('main + 1 = 19');
    expect(text).toContain(D(4));
  });

  it('--check 合并结果算不出（有业务冲突）：本分支改了编码时给条件式提示，没改时预计取 main', () => {
    const changed = describeGrantPlan({ main, mergedDigest: undefined, branchDigest: D(3), forkDigest: D(1) });
    expect(changed).toMatch(/若编码与 main 相同.*取 main 的 version 18，否则定为 main \+ 1 = 19/);
    const same = describeGrantPlan({ main, mergedDigest: undefined, branchDigest: D(1), forkDigest: D(1) });
    expect(same).toContain('预计取 main 的 version 18');
  });
});
