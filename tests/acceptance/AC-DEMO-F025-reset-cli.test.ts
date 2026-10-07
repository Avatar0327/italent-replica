/**
 * F-025 重置（#92 第二轮 P2-1）：以真实子进程走 `pnpm demo:reset` 用的 CLI 路径。
 * 相对路径一律按仓库根解析（与启动 / 种子同一函数），只允许删除 `.demo/` 之下、带 PGlite 数据库标记的目录；
 * 非法目标拒绝并报错，不误删任何东西。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { localPgliteDir } from '../../apps/api/src/database.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const apiDir = join(repoRoot, 'apps/api');
const demoRoot = join(repoRoot, '.demo');
const tag = `f025-reset-${process.pid}-${Date.now()}`;
const created: string[] = [];
afterAll(() => created.forEach((path) => rmSync(path, { recursive: true, force: true })));

/** 在 `.demo/` 下造一个“PGlite 数据目录”（带 PG_VERSION 标记），返回相对仓库根的路径。 */
function fakeDatabase(name: string, marker = true): string {
  const dir = join(demoRoot, `${tag}-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, marker ? 'PG_VERSION' : 'keep.txt'), '16\n');
  created.push(dir);
  return `.demo/${tag}-${name}`;
}

function reset(localDir: string, env: Record<string, string> = {}) {
  const { DATABASE_URL: _url, ...base } = process.env;
  // cwd 故意是 apps/api（与 pnpm demo 起后端 / 种子相同），验证相对路径不按进程目录解析
  return spawnSync(process.execPath, ['--conditions=@italent/source', '--import', 'tsx', 'src/demo/cli.ts', 'reset'], {
    cwd: apiDir,
    env: { ...base, NODE_ENV: 'development', LOCAL_PGLITE_DIR: localDir, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('F-025 演示数据重置（真实 CLI）', () => {
  it('相对路径按仓库根解析：删除 .demo/ 下的目标库，同级目录不受影响', () => {
    const target = fakeDatabase('relative');
    const sibling = fakeDatabase('sibling');
    const result = reset(target);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(repoRoot, target))).toBe(false);
    expect(existsSync(join(repoRoot, sibling, 'PG_VERSION'))).toBe(true);
    expect(existsSync(join(apiDir, target))).toBe(false);
  }, 60_000);

  it('绝对路径同样可以重置', () => {
    const target = join(repoRoot, fakeDatabase('absolute'));
    const result = reset(target);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(target)).toBe(false);
  }, 60_000);

  it.each([
    ['仓库内其他目录', 'apps'],
    ['演示根目录本身', '.demo'],
    ['借 .. 跳出演示根', `.demo/../apps`],
    ['仓库外的绝对路径', '/tmp'],
  ])(
    '非法目标（%s）被拒绝，不删除任何东西',
    (_label, target) => {
      // 先断言纯解析即拒绝：实现有缺陷时在这里失败，不会真的对非法目标起子进程
      expect(() => localPgliteDir({ NODE_ENV: 'development', LOCAL_PGLITE_DIR: target })).toThrow(/LOCAL_PGLITE_DIR/);
      const result = reset(target);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/LOCAL_PGLITE_DIR/);
      expect(existsSync(join(repoRoot, 'apps/api/package.json'))).toBe(true);
      expect(existsSync('/tmp')).toBe(true);
    },
    60_000,
  );

  it('.demo/ 下但没有 PGlite 数据库标记的目录被拒绝，内容保留', () => {
    const target = fakeDatabase('no-marker', false);
    const result = reset(target);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/PGlite/);
    expect(existsSync(join(repoRoot, target, 'keep.txt'))).toBe(true);
  }, 60_000);

  it('.demo/ 下指向外部目录的符号链接被拒绝，链接目标保留', () => {
    // 链接目标在 .demo 之外（仓库根下的临时目录），且带数据库标记
    const external = join(repoRoot, `.${tag}-external`);
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, 'PG_VERSION'), '16\n');
    created.push(external);
    const link = join(demoRoot, `${tag}-link`);
    symlinkSync(external, link);
    created.push(link);
    const result = reset(`.demo/${tag}-link`);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(external, 'PG_VERSION'))).toBe(true);
  }, 60_000);

  it('非开发环境或设了 DATABASE_URL 时拒绝重置', () => {
    const target = fakeDatabase('guarded');
    expect(reset(target, { NODE_ENV: 'production' }).status).not.toBe(0);
    expect(reset(target, { DATABASE_URL: 'postgres://demo:demo@127.0.0.1:1/none' }).status).not.toBe(0);
    expect(existsSync(join(repoRoot, target, 'PG_VERSION'))).toBe(true);
  }, 60_000);
});
