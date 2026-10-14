import { type DbHandle, sql } from '@italent/db';

/**
 * 升级类测试（createTestDb 的 migrateBefore）的升级前兼容垫片：升级前夹具用**当前代码**（API、台账）写数据，
 * 而当前代码已经依赖更新迁移才加的列，旧结构的库上就会报 column does not exist。真实升级先跑完全部迁移再启动新代码
 * （docs/06_部署 §迁移），不存在这个窗口，所以这是测试夹具的问题，不改迁移、不改业务代码。
 *
 * 做法（单一入口，各升级测试文件不各写一份）：
 * - 升级前阶段：对登记表里“库里还没有”的列临时 ADD COLUMN（可空，类型与正式迁移一致）；
 * - 第一次 `handle.migrate()` 之前先把自己加的列 DROP 掉，再由正式迁移用不带 IF NOT EXISTS 的 ADD COLUMN 加回；
 * - 库里已有的列（migrateBefore 切在它的迁移之后）不动，也不会被删。
 * 新迁移给“当前代码在升级前夹具里会读写的表”加列时，在这里追加一行；`test-db.test.ts` 核对每一行都对应一条真实迁移。
 */
export interface PreUpgradeShim {
  readonly table: string;
  readonly column: string;
  /** 与正式迁移一致的列类型（升级前垫片只补可空列）。 */
  readonly type: string;
  /** 加这一列的迁移标签（不含编号前缀以外的部分）；只用于测试核对与说明。 */
  readonly migration: string;
}

export const PRE_UPGRADE_SHIMS: readonly PreUpgradeShim[] = [
  { table: 'command_ledger', column: 'actor_user_id', type: 'uuid', migration: 'command_ledger_actor' },
  { table: 'command_ledger', column: 'command_type', type: 'text', migration: 'command_ledger_actor' },
  { table: 'audit_command_failures', column: 'http_status', type: 'integer', migration: 'command_failure_http_status' },
];

const ident = (name: string) => sql.raw(`"${name.replaceAll('"', '""')}"`);

async function existingColumns(handle: DbHandle): Promise<Set<string>> {
  const result = await handle.db.execute(sql`
    SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'
  `);
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as {
    table_name: string;
    column_name: string;
  }[];
  return new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
}

/** 补上缺的垫片列，并让第一次 migrate 先撤掉它们；没有缺的列时原样返回句柄。 */
export async function withPreUpgradeShims(handle: DbHandle): Promise<DbHandle> {
  const present = await existingColumns(handle);
  const tables = new Set([...present].map((key) => key.split('.')[0]));
  const added = PRE_UPGRADE_SHIMS.filter((s) => tables.has(s.table) && !present.has(`${s.table}.${s.column}`));
  for (const s of added) {
    await handle.db.execute(sql`ALTER TABLE ${ident(s.table)} ADD COLUMN ${ident(s.column)} ${sql.raw(s.type)}`);
  }
  if (!added.length) return handle;
  let pending = true;
  return {
    ...handle,
    async migrate(folder) {
      if (pending) {
        pending = false;
        for (const s of added) {
          await handle.db.execute(sql`ALTER TABLE ${ident(s.table)} DROP COLUMN ${ident(s.column)}`);
        }
      }
      return handle.migrate(folder);
    },
  };
}
