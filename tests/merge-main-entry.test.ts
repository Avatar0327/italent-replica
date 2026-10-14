/**
 * F-109：pnpm merge:main 入口（scripts/merge-main.mjs）的自动化回归。
 * 在临时 git 仓库里造“叠放分支”（本分支带着上游合并前的旧名迁移，main 上是改号后的迁移），真实运行脚本，
 * 覆盖：正常清理旧名迁移、CRLF / 行尾空格漂移（已提交的格式差异使摘要不同）时的重复快照身份拒绝、预演同样报告。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(import.meta.dirname, '..');
const MIGRATIONS = 'packages/db/migrations';
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Mig {
  tag: string;
  sql: string;
  /** 快照里的表；快照 id 默认 `id-<名字后缀>`，同名后缀的迁移快照 id 相同（模拟上游迁移改号后 id 不变） */
  tables: string[];
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const snapshotId = (tag: string) => `id-${tag.replace(/^\d+_/, '')}`;

function write(root: string, migs: Mig[]) {
  rmSync(path.join(root, MIGRATIONS), { recursive: true, force: true });
  mkdirSync(path.join(root, MIGRATIONS, 'meta'), { recursive: true });
  const entries = migs.map((m, idx) => ({ idx, version: '7', when: 100 + idx * 10, tag: m.tag, breakpoints: true }));
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(
    path.join(root, MIGRATIONS, 'meta/_journal.json'),
    json({ version: '7', dialect: 'postgresql', entries }),
  );
  migs.forEach((m, idx) => {
    writeFileSync(path.join(root, MIGRATIONS, `${m.tag}.sql`), m.sql);
    const tables = Object.fromEntries(m.tables.map((t) => [t, { columns: { id: { type: 'int' } } }]));
    const prevId = idx === 0 ? 'root' : snapshotId(migs[idx - 1]!.tag);
    writeFileSync(
      path.join(root, MIGRATIONS, `meta/${String(idx).padStart(4, '0')}_snapshot.json`),
      json({ id: snapshotId(m.tag), prevId, version: '7', tables }),
    );
  });
}

function sh(root: string, ...args: string[]) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

/** 造仓库：main 与本分支从同一个提交分叉，origin/main 指向 main。结束时停在本分支。 */
function buildRepo(opts: { base: Mig[]; main: Mig[]; branch: Mig[] }) {
  const root = mkdtempSync(path.join(tmpdir(), 'merge-main-entry-'));
  roots.push(root);
  mkdirSync(path.join(root, 'scripts'));
  for (const file of ['merge-main.mjs', 'merge-main-lib.mjs'])
    copyFileSync(path.join(REPO, 'scripts', file), path.join(root, 'scripts', file));
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 'test@example.com');
  sh(root, 'config', 'user.name', 'test');
  sh(root, 'config', 'core.autocrlf', 'false');
  write(root, opts.base);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'base');
  sh(root, 'checkout', '-q', '-b', 'branch');
  write(root, [...opts.base, ...opts.branch]);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'branch');
  sh(root, 'checkout', '-q', 'main');
  write(root, [...opts.base, ...opts.main]);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'main');
  sh(root, 'update-ref', 'refs/remotes/origin/main', 'main');
  sh(root, 'checkout', '-q', 'branch');
  return root;
}

function run(root: string, ...flags: string[]) {
  const result = spawnSync(process.execPath, ['scripts/merge-main.mjs', '--no-fetch', ...flags], {
    cwd: root,
    encoding: 'utf8',
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const readJson = (root: string, file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const migrationFiles = (root: string) => readdirSync(path.join(root, MIGRATIONS)).filter((f) => f.endsWith('.sql'));

/** 所有快照：id 唯一、没有 id = prevId 自环、prevId 链接得上 */
function expectSnapshotChain(root: string) {
  const journal = readJson(root, `${MIGRATIONS}/meta/_journal.json`);
  const snaps = journal.entries.map((e: { idx: number }) =>
    readJson(root, `${MIGRATIONS}/meta/${String(e.idx).padStart(4, '0')}_snapshot.json`),
  );
  const ids = snaps.map((s: { id: string }) => s.id);
  expect(new Set(ids).size, `快照 id 重复：${ids.join(',')}`).toBe(ids.length);
  snaps.forEach((s: { id: string; prevId: string }, i: number) => {
    expect(s.prevId, `${s.id} 自环`).not.toBe(s.id);
    if (i > 0) expect(s.prevId).toBe(snaps[i - 1].id);
  });
}

const init: Mig = { tag: '0000_init', sql: 'CREATE TABLE init (id int);\n', tables: ['init'] };
const a: Mig = { tag: '0001_a', sql: 'CREATE TABLE a (id int);\n', tables: ['init', 'a'] };
const UP_SQL = 'CREATE TABLE x (id int);\n';

/** 叠放场景：本分支 0002_up_x（上游旧名，内容可漂移）+ 自己的 0003_mine；main 上上游迁移已改号为 0003_up_x（最新一条） */
function stacked(branchUpSql: string) {
  return buildRepo({
    base: [init, a],
    main: [
      { tag: '0002_m', sql: 'CREATE TABLE m (id int);\n', tables: ['init', 'a', 'm'] },
      { tag: '0003_up_x', sql: UP_SQL, tables: ['init', 'a', 'm', 'x'] },
    ],
    branch: [
      { tag: '0002_up_x', sql: branchUpSql, tables: ['init', 'a', 'x'] },
      { tag: '0003_mine', sql: 'CREATE TABLE mine (id int);\n', tables: ['init', 'a', 'x', 'mine'] },
    ],
  });
}

describe('merge-main.mjs 入口：叠放分支的旧名迁移', () => {
  it('内容逐字节相同：预演与正式运行都列出“旧名 → main 名 sha256”，清理旧名迁移，只给本分支新增的改号', () => {
    const root = stacked(UP_SQL);
    const check = run(root, '--check');
    expect(check.status).toBe(0);
    expect(check.out).toContain(`0002_up_x → 0003_up_x  sha256=${sha(UP_SQL)}`);
    const head = sh(root, 'rev-parse', 'HEAD');

    const real = run(root, '--no-regen');
    expect(real.status, real.out).toBe(0);
    expect(real.out).toContain(`0002_up_x → 0003_up_x  sha256=${sha(UP_SQL)}`);
    expect(sh(root, 'rev-parse', 'HEAD')).not.toBe(head);
    expect(readJson(root, `${MIGRATIONS}/meta/_journal.json`).entries.map((e: { tag: string }) => e.tag)).toEqual([
      '0000_init',
      '0001_a',
      '0002_m',
      '0003_up_x',
      '0004_mine',
    ]);
    expect(migrationFiles(root).sort()).toEqual([
      '0000_init.sql',
      '0001_a.sql',
      '0002_m.sql',
      '0003_up_x.sql',
      '0004_mine.sql',
    ]);
    expectSnapshotChain(root);
  }, 60_000);

  it.each([
    ['CRLF 漂移', 'CREATE TABLE x (id int);\r\n'],
    ['行尾空格漂移', 'CREATE TABLE x (id int); \n'],
  ])(
    '已提交的%s使摘要不同：快照身份重叠，预演报告并非 0 退出，正式运行停下且不写入重复迁移',
    (_name, drifted) => {
      const root = stacked(drifted);
      const reportParts = [
        '0002_up_x',
        '0003_up_x',
        `sha256=${sha(drifted)}`,
        `sha256=${sha(UP_SQL)}`,
        '快照 id',
        'id-up_x',
        '自环',
      ];

      const check = run(root, '--check');
      expect(check.status).not.toBe(0);
      for (const part of reportParts) expect(check.out, part).toContain(part);

      const head = sh(root, 'rev-parse', 'HEAD');
      const real = run(root, '--no-regen');
      expect(real.status).not.toBe(0);
      for (const part of reportParts) expect(real.out, part).toContain(part);
      expect(sh(root, 'rev-parse', 'HEAD')).toBe(head);
      // 没有改号落盘：不出现 0004 / 0005 开头的迁移
      expect(migrationFiles(root).filter((f) => /^000[4-9]/.test(f))).toEqual([]);
      expect(existsSync(path.join(root, MIGRATIONS, '0004_up_x.sql'))).toBe(false);
    },
    60_000,
  );

  it('本分支新增迁移的快照 id 与 main 不重复：不误报', () => {
    const root = buildRepo({
      base: [init, a],
      main: [{ tag: '0002_m', sql: 'CREATE TABLE m (id int);\n', tables: ['init', 'a', 'm'] }],
      branch: [{ tag: '0002_mine', sql: 'CREATE TABLE mine (id int);\n', tables: ['init', 'a', 'mine'] }],
    });
    expect(run(root, '--check').status).toBe(0);
    const real = run(root, '--no-regen');
    expect(real.status, real.out).toBe(0);
    expectSnapshotChain(root);
  }, 60_000);
});
