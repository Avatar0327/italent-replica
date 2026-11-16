import { type Db, schema, sql } from '@italent/db';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';

const rowsOf = <T>(value: unknown) => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
const publicTable = (name: string) => sql`${sql.identifier('public')}.${sql.identifier(name)}`;

/** serial 是带隐式 DEFAULT 的建列语法；临时列只需要对应存储类型，不能创建序列。 */
function storageType(type: string): string {
  return { serial: 'integer', smallserial: 'smallint', bigserial: 'bigint' }[type] ?? type;
}

/**
 * F-524 / DEC-912：仅供隔离升级测试。先运行其他建表 / 改约束夹具，再在此回调里用当前接口造数。
 * 只补 public 已有表的缺列，不模拟约束、默认值或新类型；未知类型退化为 text。
 * 回调结束（含抛错）撤回自己补的列；必须退出回调后才能调用 handle.migrate()。
 */
export async function withCurrentWriteColumns<T>(db: Db, run: () => Promise<T>): Promise<T> {
  const tables = rowsOf<{ table_name: string }>(
    await db.execute(sql`SELECT table_name
    FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`),
  );
  const existing = new Map(tables.map(({ table_name }) => [table_name, new Set<string>()]));
  const columns = rowsOf<{ table_name: string; column_name: string }>(
    await db.execute(sql`
    SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'`),
  );
  for (const column of columns) existing.get(column.table_name)?.add(column.column_name);
  const added: { table: string; columns: string[] }[] = [];
  const types = new Map<string, string>();
  try {
    for (const table of Object.values(schema)) {
      if (!is(table, PgTable)) continue;
      const config = getTableConfig(table);
      if (config.schema && config.schema !== 'public') continue;
      const present = existing.get(config.name);
      if (!present) continue;
      const missing = config.columns.filter((column) => !present.has(column.name));
      if (!missing.length) continue;
      const definitions = [];
      for (const column of missing) {
        const declared = storageType(column.getSQLType());
        let type = types.get(declared);
        if (!type) {
          const [row] = rowsOf<{ present: boolean }>(
            await db.execute(sql`SELECT to_regtype(${declared}) IS NOT NULL AS present`),
          );
          type = row?.present ? declared : 'text';
          types.set(declared, type);
        }
        definitions.push(sql`ADD COLUMN ${sql.identifier(column.name)} ${sql.raw(type)}`);
      }
      // 一张表一次原子 DDL；只登记已经成功添加的列，准备阶段失败也走 finally 清理。
      await db.execute(sql`ALTER TABLE ${publicTable(config.name)} ${sql.join(definitions, sql`, `)}`);
      added.push({ table: config.name, columns: missing.map((column) => column.name) });
      for (const column of missing) present.add(column.name);
    }
    return await run();
  } finally {
    await restoreColumns(db, added);
  }
}

async function restoreColumns(db: Db, added: { table: string; columns: string[] }[]): Promise<void> {
  const failures: unknown[] = [];
  for (const item of added.reverse()) {
    try {
      const drops = item.columns.map((name) => sql`DROP COLUMN ${sql.identifier(name)}`);
      await db.execute(sql`ALTER TABLE ${publicTable(item.table)} ${sql.join(drops, sql`, `)}`);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'F-524 临时列清理失败');
}
