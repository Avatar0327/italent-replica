import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { createPgDb, createPgliteDb, type DbHandle } from '@italent/db';
import postgres from 'postgres';

/**
 * 测试库模式：设置了 TEST_DATABASE_URL 就用真 PG，否则用进程内 PGlite（离线）。
 * PGlite 是单连接，并发、锁、RLS 角色相关测试必须在真 PG 上跑（技术栈评估 §8 R-1）。
 */
export function testDbMode(): 'pg' | 'pglite' {
  return process.env.TEST_DATABASE_URL ? 'pg' : 'pglite';
}

/** 创建一个全新的空库并跑完全部迁移。每个测试文件调用一次，互不共享数据。 */
export async function createTestDb(): Promise<DbHandle> {
  const url = process.env.TEST_DATABASE_URL;
  const handle = url ? await createFreshPgDatabase(url) : createPgliteDb(new PGlite({ extensions: { btree_gist } }));
  await handle.migrate();
  return handle;
}

/**
 * 真 PG：用 TEST_DATABASE_URL 的角色（需 CREATEDB）新建一个随机命名的库，关闭时删除。
 * 用独立库而非独立 schema，是为了让迁移里的扩展、schema 限定名与生产完全一致。
 */
async function createFreshPgDatabase(adminUrl: string): Promise<DbHandle> {
  const dbName = `italent_t_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const handle = createPgDb(url.toString(), { max: 5 });
  return {
    ...handle,
    async close() {
      await handle.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    },
  };
}
