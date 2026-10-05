import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema/index.js';

/** 迁移目录（包内 `migrations/`，源码与 dist 运行时都从包根解析）。 */
export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/** 与驱动无关的数据库句柄：业务代码只依赖这个类型，便于 PGlite / 真 PG 互换。 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  readonly db: Db;
  readonly driver: 'pg' | 'pglite';
  /** 执行迁移；folder 默认包内迁移目录（升级测试可传只含前一部分迁移的目录）。 */
  migrate(folder?: string): Promise<void>;
  close(): Promise<void>;
}

/** 连接真 PostgreSQL（生产与 `test:pg`）。 */
export function createPgDb(url: string, options: { max?: number } = {}): DbHandle {
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => undefined });
  const db = drizzlePg(client, { schema });
  return {
    db: db as unknown as Db,
    driver: 'pg',
    migrate: (folder = migrationsFolder) => migratePg(db, { migrationsFolder: folder }),
    close: () => client.end(),
  };
}

/** 包装一个已创建的 PGlite 实例（调用方负责加载 btree_gist 等扩展）。 */
export function createPgliteDb(client: PGlite): DbHandle {
  const db = drizzlePglite(client, { schema });
  return {
    db: db as unknown as Db,
    driver: 'pglite',
    migrate: (folder = migrationsFolder) => migratePglite(db, { migrationsFolder: folder }),
    close: () => client.close(),
  };
}
