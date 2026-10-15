/**
 * F-133 第 5 轮（DEC-501）：scripts/merge-main-isolated.mjs 的单元用例（临时 git 仓库）。
 * 入口级反例（assume-unchanged、filter、hook……）见 tests/merge-main-conflicts.test.ts；这里锁住三件事：
 *   ① 从树写出是逐字节的——仓库开着 autocrlf / text 属性、有 CRLF 内容、可执行位、仓库内符号链接时，什么都不改就收集不出改动；
 *   ② 收集只认内容：允许的目录里新增 / 修改 / 删除都进新树，别处的改动与被忽略的新文件都列为问题；
 *   ③ 前置拒绝的各项条件（含索引里 .gitattributes 设的 filter）。
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createIsolation, symlinkEscapes } from '../scripts/merge-main-isolated.mjs';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function sh(root: string, ...args: string[]) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

function put(root: string, files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
}

/** 一个提交过的仓库：普通文件、CRLF 文件、可执行文件、仓库内符号链接、生成物目录。 */
function repo(extra: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), `merge-main-isolated-${randomUUID()}-`));
  roots.push(root);
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 'test@example.com');
  sh(root, 'config', 'user.name', 'test');
  put(root, {
    'src/a.ts': 'export const A = 1;\n',
    'src/crlf.txt': 'line1\r\nline2\r\n',
    'gen/out.json': '{"v":1}\n',
    'gen/stale.json': '{}\n',
    'bin/run.sh': '#!/bin/sh\necho hi\n',
    ...extra,
  });
  chmodSync(path.join(root, 'bin/run.sh'), 0o755);
  symlinkSync('../src/a.ts', path.join(root, 'gen/link.ts'));
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'base');
  return root;
}

const inGen = (file: string) => file.startsWith('gen/');

describe('symlinkEscapes：符号链接目标按文本判断是否走出仓库', () => {
  it.each([
    ['a/b.ts', '../c.ts', false],
    ['a/b.ts', 'c/d.ts', false],
    ['a/b.ts', '../../c.ts', true],
    ['b.ts', '../c.ts', true],
    ['a/b.ts', '/etc/passwd', true],
    ['a/b.ts', 'C:\\x', true],
    ['a/b/c.ts', '../../x/../y.ts', false],
  ])('%s → %s：走出仓库 = %s', (file, target, escapes) => {
    expect(symlinkEscapes(file, target)).toBe(escapes);
  });
});

describe('materializeTree + collectTree：逐字节写出，按内容收集', () => {
  it('仓库开着 autocrlf 与 text=auto：写出的字节与对象一致，什么都不改就收集不出改动，树原样返回', async () => {
    const root = repo();
    sh(root, 'config', 'core.autocrlf', 'true');
    writeFileSync(path.join(root, '.git/info/attributes'), '* text=auto\n');
    const iso = createIsolation(root);
    const tree = sh(root, 'rev-parse', 'HEAD^{tree}');
    const tmp = await iso.materializeTree(tree);
    try {
      expect(readFileSync(path.join(tmp.dir, 'src/crlf.txt'), 'utf8')).toBe('line1\r\nline2\r\n');
      const result = iso.collectTree(tmp, tree, inGen);
      expect(result).toEqual({ tree, changed: [], problems: [] });
    } finally {
      tmp.cleanup();
    }
  });

  it('允许的目录里新增、修改、删除都写进新树；仓库索引不动', async () => {
    const root = repo();
    const iso = createIsolation(root);
    const tree = sh(root, 'rev-parse', 'HEAD^{tree}');
    const index = sh(root, 'write-tree');
    const tmp = await iso.materializeTree(tree);
    try {
      put(tmp.dir, { 'gen/out.json': '{"v":2}\n', 'gen/new.json': '{"n":1}\n' });
      unlinkSync(path.join(tmp.dir, 'gen/stale.json'));
      const result = iso.collectTree(tmp, tree, inGen);
      expect(result.problems).toEqual([]);
      expect(result.changed).toEqual(['gen/new.json', 'gen/out.json', 'gen/stale.json']);
      expect(sh(root, 'show', `${result.tree}:gen/out.json`)).toBe('{"v":2}');
      expect(sh(root, 'show', `${result.tree}:gen/new.json`)).toBe('{"n":1}');
      expect(sh(root, 'ls-tree', '--name-only', result.tree, 'gen/')).not.toContain('stale.json');
      expect(sh(root, 'show', `${result.tree}:src/crlf.txt`)).toBe('line1\r\nline2');
      expect(sh(root, 'write-tree')).toBe(index);
    } finally {
      tmp.cleanup();
    }
  });

  it('允许目录以外的改动（内容、可执行位、删除）与被忽略的新文件都列为问题，树原样返回', async () => {
    const root = repo({ '.gitignore': 'node_modules\n*.cache\n' });
    const iso = createIsolation(root);
    const tree = sh(root, 'rev-parse', 'HEAD^{tree}');
    const tmp = await iso.materializeTree(tree);
    try {
      put(tmp.dir, { 'src/a.ts': 'export const A = 2;\n', 'gen/x.cache': 'c\n', 'node_modules/dep/index.js': '' });
      chmodSync(path.join(tmp.dir, 'bin/run.sh'), 0o644);
      unlinkSync(path.join(tmp.dir, 'gen/link.ts'));
      symlinkSync('../bin/run.sh', path.join(tmp.dir, 'gen/link.ts'));
      const result = iso.collectTree(tmp, tree, (file) => file.startsWith('gen/') && file !== 'gen/link.ts');
      expect(result.tree).toBe(tree);
      expect(result.problems.join('\n')).toContain('gen/x.cache');
      const outside = result.problems.find((p) => p.includes('生成物以外的文件')) ?? '';
      for (const file of ['src/a.ts', 'bin/run.sh', 'gen/link.ts']) expect(outside).toContain(file);
      expect(result.problems.join('\n')).not.toContain('node_modules');
    } finally {
      tmp.cleanup();
    }
  });
});

describe('unprovableProblems：前置拒绝的条件', () => {
  it('干净仓库（含仓库内符号链接）没有问题', () => {
    expect(createIsolation(repo()).unprovableProblems()).toEqual([]);
  });

  it('索引里的 .gitattributes 设了 filter → 列出文件', () => {
    const root = repo({ '.gitattributes': 'src/*.ts filter=x\n' });
    const problems = createIsolation(root).unprovableProblems();
    expect(problems.join('\n')).toContain('filter');
    expect(problems.join('\n')).toContain('src/a.ts');
  });

  it('指向仓库外的符号链接 → 列出文件', () => {
    const root = repo();
    symlinkSync('/etc/hostname', path.join(root, 'src/out.ts'));
    sh(root, 'add', 'src/out.ts');
    expect(createIsolation(root).unprovableProblems().join('\n')).toContain('src/out.ts');
  });

  it('写出时遇到指向仓库外的符号链接同样抛错（兜底）', async () => {
    const root = repo();
    symlinkSync('../../outside.ts', path.join(root, 'src/out.ts'));
    sh(root, 'add', 'src/out.ts');
    const tree = sh(root, 'write-tree');
    await expect(createIsolation(root).materializeTree(tree)).rejects.toThrow('src/out.ts');
  });
});
