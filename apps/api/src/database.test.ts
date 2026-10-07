import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { databaseFromEnv, localPgliteDir, resetLocalDatabase } from './database.js';

// 模拟仓库根：demoRoot = <repo>/.demo；相对路径按 <repo> 解析（与进程当前目录无关）
const repo = mkdtempSync(join(tmpdir(), 'italent-local-db-'));
const demoRoot = join(repo, '.demo');
const options = { demoRoot };
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('F-025 后端本地数据库选择', () => {
  it('开发环境未设 DATABASE_URL：PGlite 落盘到本地目录并自动迁移，重启后数据仍在', async () => {
    const env = { NODE_ENV: 'development', LOCAL_PGLITE_DIR: '.demo/dev.pglite' };
    const dir = join(demoRoot, 'dev.pglite');
    expect(localPgliteDir(env, options)).toBe(dir);
    const first = await databaseFromEnv(env, options);
    expect(first?.driver).toBe('pglite');
    const migrated = await first!.db.execute('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
    const count = (migrated as unknown as { rows: { n: number }[] }).rows[0]!.n;
    expect(count).toBeGreaterThan(0);
    await first!.db.execute('CREATE TABLE public.f025_probe (id int)');
    await first!.close();
    expect(existsSync(join(dir, 'PG_VERSION'))).toBe(true);

    // 第二次启动：迁移幂等，之前写入的数据仍在磁盘上
    const second = await databaseFromEnv(env, options);
    const again = await second!.db.execute('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
    expect((again as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(count);
    await second!.db.execute('SELECT * FROM public.f025_probe');
    await second!.close();

    // 重置与启动解析到同一目录（P2-1）
    expect(resetLocalDatabase(env, options)).toBe(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('缺省目录是演示根下的 pglite；相对 / 绝对路径解析一致', () => {
    const env = { NODE_ENV: 'development' };
    expect(localPgliteDir(env, options)).toBe(join(demoRoot, 'pglite'));
    const absolute = join(demoRoot, 'abs');
    expect(localPgliteDir({ ...env, LOCAL_PGLITE_DIR: absolute }, options)).toBe(absolute);
    expect(localPgliteDir({ ...env, LOCAL_PGLITE_DIR: '.demo/abs' }, options)).toBe(absolute);
  });

  it.each(['apps', '.demo', '.demo/../apps', '/tmp', '../outside'])(
    'LOCAL_PGLITE_DIR=%s 不在演示根之下：启动与重置都拒绝',
    async (target) => {
      const env = { NODE_ENV: 'development', LOCAL_PGLITE_DIR: target };
      // 先断言纯解析即拒绝：实现有缺陷时在这里失败，不会走到下面真正打开 / 删除目录的调用
      expect(() => localPgliteDir(env, options)).toThrow(/LOCAL_PGLITE_DIR/);
      await expect(databaseFromEnv(env, options)).rejects.toThrow(/LOCAL_PGLITE_DIR/);
      expect(() => resetLocalDatabase(env, options)).toThrow(/LOCAL_PGLITE_DIR/);
    },
  );

  it('演示根下但没有 PGlite 标记的目录拒绝重置，内容保留；不存在的目录重置为空操作', () => {
    const dir = join(demoRoot, 'plain');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'keep.txt'), 'x');
    const env = { NODE_ENV: 'development', LOCAL_PGLITE_DIR: dir };
    expect(() => resetLocalDatabase(env, options)).toThrow(/PGlite/);
    expect(existsSync(join(dir, 'keep.txt'))).toBe(true);
    expect(() => resetLocalDatabase({ ...env, LOCAL_PGLITE_DIR: '.demo/missing' }, options)).not.toThrow();
  });

  it.each([
    ['production', { NODE_ENV: 'production' }],
    ['未设置 NODE_ENV', {}],
    ['test', { NODE_ENV: 'test' }],
    ['大小写不符', { NODE_ENV: 'Development' }],
  ])('%s 且未设 DATABASE_URL：不回退到 PGlite，也不创建本地目录', async (_label, base) => {
    const name = `never-${Math.random().toString(36).slice(2)}.pglite`;
    expect(await databaseFromEnv({ ...base, LOCAL_PGLITE_DIR: `.demo/${name}` }, options)).toBeUndefined();
    expect(existsSync(join(demoRoot, name))).toBe(false);
  });

  it('非开发环境拒绝重置', () => {
    expect(() => resetLocalDatabase({ NODE_ENV: 'production' }, options)).toThrow(/development/);
  });

  it('设了 DATABASE_URL 时一律连真 PostgreSQL（开发环境也不用 PGlite）', async () => {
    const url = 'postgres://demo:demo@127.0.0.1:1/none';
    for (const NODE_ENV of ['development', 'production']) {
      const handle = await databaseFromEnv({ NODE_ENV, DATABASE_URL: url, LOCAL_PGLITE_DIR: '.demo/unused' }, options);
      expect(handle?.driver).toBe('pg');
      await handle!.close();
    }
    expect(existsSync(join(demoRoot, 'unused'))).toBe(false);
  });

  // #92 第 2 轮审查 P2：演示根 `.demo` 本身是符号链接时，realpath 会把仓库外目录当成允许范围
  it('演示根目录本身是符号链接（指向仓库外）：启动与重置都拒绝，仓库外的库保留', async () => {
    const fakeRepo = mkdtempSync(join(tmpdir(), 'italent-linked-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'italent-outside-'));
    mkdirSync(join(outside, 'pglite'));
    writeFileSync(join(outside, 'pglite', 'PG_VERSION'), '16\n');
    const linkedRoot = join(fakeRepo, '.demo');
    symlinkSync(outside, linkedRoot);
    try {
      const env = { NODE_ENV: 'development' };
      expect(() => resetLocalDatabase(env, { demoRoot: linkedRoot })).toThrow(/符号链接/);
      expect(existsSync(join(outside, 'pglite', 'PG_VERSION'))).toBe(true);
      await expect(databaseFromEnv(env, { demoRoot: linkedRoot })).rejects.toThrow(/符号链接/);
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
