import { type DbHandle, sql } from '@italent/db';

/**
 * 升级类测试（createTestDb 的 migrateBefore）的升级前兼容垫片：升级前夹具用**当前代码**（API、台账）写数据，
 * 而当前代码已经依赖更新迁移才加的列或表，旧结构就会报 column / relation does not exist。真实升级先跑完全部迁移再启动新代码
 * （docs/06_部署 §迁移），不存在这个窗口，所以这是测试夹具的问题，不改迁移、不改业务代码。
 *
 * 做法（单一入口，各升级测试文件不各写一份）：
 * - 升级前阶段：对登记表里“库里还没有”的列临时 ADD COLUMN（可空，类型与正式迁移一致）；
 * - 第一次 `handle.migrate()` 之前先把自己加的列 DROP 掉，再由正式迁移用不带 IF NOT EXISTS 的 ADD COLUMN 加回；
 * - 库里已有的列（migrateBefore 切在它的迁移之后）不动，也不会被删。
 * - 缺失的登记表临时建最小列结构，保留租户隔离及 SELECT / INSERT 权限；首次 migrate 前 DROP，再由正式迁移建回。
 * - 仅撤除本句柄添加的对象；临时表中的夹具数据不进入正式迁移，已有正式表及其数据不动。
 * 新依赖集中登记在这里；测试核对登记对应真实迁移，升级后结构与完整迁移一致。
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
  // F-140：升级前垫片列为空，计划日函数取回退值（记录 / 载荷生效日）；正式迁移 0130 回填并加触发器。
  {
    table: 'employment_payload_versions',
    column: 'planned_effective_date',
    type: 'date',
    migration: 'employment_planned_effective_date',
  },
  // F-255：当前离职夹具查询兼职最新快照，旧库也需临时具备该查询读取的机构列。
  { table: 'employment_payload_versions', column: 'institution_id', type: 'uuid', migration: 'gray_firestar' },
  // F-261 叠在 F-140b 上：当前任职写入与离职读取已依赖人工计划、替代来源两列。
  { table: 'employment_payload_versions', column: 'manual_plan', type: 'boolean', migration: 'ancient_nitro' },
  { table: 'exit_requests', column: 'supersedes_business_id', type: 'uuid', migration: 'ancient_nitro' },
];

export interface PreUpgradeTableShim {
  readonly table: string;
  readonly migration: string;
  /** 最小结构只声明列名和正式类型，不提前模拟后续迁移的业务约束。 */
  readonly columns: readonly { readonly name: string; readonly type: string }[];
}

export const PRE_UPGRADE_TABLE_SHIMS: readonly PreUpgradeTableShim[] = [
  {
    table: 'employment_probation_versions',
    migration: 'be3_probation',
    columns: [
      { name: 'id', type: 'uuid' },
      { name: 'tenant_id', type: 'uuid' },
      { name: 'employee_id', type: 'uuid' },
      { name: 'business_id', type: 'uuid' },
      { name: 'version_no', type: 'integer' },
      { name: 'previous_version_id', type: 'uuid' },
      { name: 'has_probation', type: 'boolean' },
      { name: 'start_date', type: 'date' },
      { name: 'months', type: 'smallint' },
      { name: 'expected_end_date', type: 'date' },
      { name: 'source', type: 'text' },
      { name: 'command_id', type: 'text' },
      { name: 'created_at', type: 'timestamp with time zone' },
    ],
  },
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

/** 补上缺的垫片对象，并让第一次 migrate 先撤掉它们；不改变已有正式对象。 */
export async function withPreUpgradeShims(handle: DbHandle): Promise<DbHandle> {
  const present = await existingColumns(handle);
  const tables = new Set([...present].map((key) => key.split('.')[0]));
  const added = PRE_UPGRADE_SHIMS.filter((s) => tables.has(s.table) && !present.has(`${s.table}.${s.column}`));
  const addedTables = PRE_UPGRADE_TABLE_SHIMS.filter((s) => !tables.has(s.table));
  if (!added.length && !addedTables.length) return handle;
  await handle.db.transaction(async (tx) => {
    for (const s of addedTables) {
      const columns = s.columns.map((column) => sql`${ident(column.name)} ${sql.raw(column.type)}`);
      await tx.execute(sql`CREATE TABLE ${ident(s.table)} (${sql.join(columns, sql`, `)})`);
      await tx.execute(sql`SELECT enable_tenant_isolation(${s.table}::regclass)`);
      await tx.execute(sql`GRANT SELECT, INSERT ON ${ident(s.table)} TO app_user`);
    }
    for (const s of added) {
      await tx.execute(sql`ALTER TABLE ${ident(s.table)} ADD COLUMN ${ident(s.column)} ${sql.raw(s.type)}`);
    }
  });
  let pending = true;
  return {
    ...handle,
    async migrate(folder) {
      if (pending) {
        await handle.db.transaction(async (tx) => {
          for (const s of added) {
            await tx.execute(sql`ALTER TABLE ${ident(s.table)} DROP COLUMN ${ident(s.column)}`);
          }
          for (const s of [...addedTables].reverse()) {
            await tx.execute(sql`DROP TABLE ${ident(s.table)}`);
          }
        });
        pending = false;
      }
      return handle.migrate(folder);
    },
  };
}
