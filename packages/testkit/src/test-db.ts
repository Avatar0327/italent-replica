import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { createPgDb, createPgliteDb, type DbHandle, migrationsFolder } from '@italent/db';
import postgres from 'postgres';

/**
 * 测试库模式：设置了 TEST_DATABASE_URL 就用真 PG，否则用进程内 PGlite（离线）。
 * PGlite 是单连接，并发、锁、RLS 角色相关测试必须在真 PG 上跑（技术栈评估 §8 R-1）。
 */
export function testDbMode(): 'pg' | 'pglite' {
  return process.env.TEST_DATABASE_URL ? 'pg' : 'pglite';
}

export interface TestDbOptions {
  /**
   * 升级测试用：只执行到第一个标签以此结尾的迁移之前（如 `_enterprise_settings`），
   * 调用方按旧结构造数据后再调 `handle.migrate()` 补完其余迁移。按标签后缀匹配，迁移重排编号后不用改测试。
   */
  readonly migrateBefore?: string;
}

/** 创建一个全新的空库并跑完全部迁移（或按 migrateBefore 只跑前一部分）。每个测试文件调用一次，互不共享数据。 */
export async function createTestDb(options: TestDbOptions = {}): Promise<DbHandle> {
  const url = process.env.TEST_DATABASE_URL;
  const handle = url ? await createFreshPgDatabase(url) : createPgliteDb(new PGlite({ extensions: { btree_gist } }));
  if (options.migrateBefore === undefined) {
    await handle.migrate();
    return handle;
  }
  const folder = migrationsBefore(options.migrateBefore);
  try {
    await handle.migrate(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  return handle;
}

/** 复制出只含目标迁移之前那些迁移的临时目录（SQL 文件 + 截断的 journal）。 */
function migrationsBefore(tagSuffix: string): string {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const cut = journal.entries.findIndex((e) => e.tag.endsWith(tagSuffix));
  if (cut < 0) throw new Error(`没有标签以 ${tagSuffix} 结尾的迁移`);
  const entries = journal.entries.slice(0, cut);
  const folder = mkdtempSync(join(tmpdir(), 'italent-migrations-'));
  mkdirSync(join(folder, 'meta'));
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const { tag } of entries) copyFileSync(join(migrationsFolder, `${tag}.sql`), join(folder, `${tag}.sql`));
  return folder;
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
