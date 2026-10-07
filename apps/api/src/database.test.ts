import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { databaseFromEnv, resetLocalDatabase } from './database.js';

const root = mkdtempSync(join(tmpdir(), 'italent-local-db-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('F-025 后端本地数据库选择', () => {
  it('开发环境未设 DATABASE_URL：PGlite 落盘到本地目录并自动迁移，重启后数据仍在', async () => {
    const dir = join(root, 'dev.pglite');
    const env = { NODE_ENV: 'development', LOCAL_PGLITE_DIR: dir };
    const first = await databaseFromEnv(env);
    expect(first?.driver).toBe('pglite');
    const migrated = await first!.db.execute('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
    const count = (migrated as unknown as { rows: { n: number }[] }).rows[0]!.n;
    expect(count).toBeGreaterThan(0);
    await first!.db.execute('CREATE TABLE public.f025_probe (id int)');
    await first!.close();
    expect(existsSync(dir)).toBe(true);

    // 第二次启动：迁移幂等，之前写入的数据仍在磁盘上
    const second = await databaseFromEnv(env);
    const again = await second!.db.execute('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
    expect((again as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(count);
    await second!.db.execute('SELECT * FROM public.f025_probe');
    await second!.close();

    resetLocalDatabase(env);
    expect(existsSync(dir)).toBe(false);
  });

  it.each([
    ['production', { NODE_ENV: 'production' }],
    ['未设置 NODE_ENV', {}],
    ['test', { NODE_ENV: 'test' }],
    ['大小写不符', { NODE_ENV: 'Development' }],
  ])('%s 且未设 DATABASE_URL：不回退到 PGlite，也不创建本地目录', async (_label, base) => {
    const dir = join(root, `never-${Math.random().toString(36).slice(2)}.pglite`);
    expect(await databaseFromEnv({ ...base, LOCAL_PGLITE_DIR: dir })).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  });

  it('非开发环境拒绝重置本地数据库', () => {
    const dir = join(root, 'keep.pglite');
    expect(() => resetLocalDatabase({ NODE_ENV: 'production', LOCAL_PGLITE_DIR: dir })).toThrow(/development/);
  });

  it('设了 DATABASE_URL 时一律连真 PostgreSQL（开发环境也不用 PGlite）', async () => {
    const dir = join(root, 'unused.pglite');
    const url = 'postgres://demo:demo@127.0.0.1:1/none';
    for (const NODE_ENV of ['development', 'production']) {
      const handle = await databaseFromEnv({ NODE_ENV, DATABASE_URL: url, LOCAL_PGLITE_DIR: dir });
      expect(handle?.driver).toBe('pg');
      await handle!.close();
    }
    expect(existsSync(dir)).toBe(false);
  });
});
