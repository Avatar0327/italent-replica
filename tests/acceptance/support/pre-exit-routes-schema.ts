/**
 * 升级测试夹具（F-478 S1，迁移 0197）：当前接口发布流程要读出口路由表，发起 / 办理要写节点激活台账和任务的
 * decision_exit 列，而这些在迁移 0197 才建。在更早的结构上用当前接口造在途数据时，临时建同名空表（只含读写到的列）
 * 并补列，前置步骤跑完即撤掉，再由测试执行升级迁移按正式结构重建——同 pre-blacklist-schema、pre-approval-scope-schema
 * 先例。生产总是先迁移再服务，生产代码不判断表是否存在（DEC-402）。已有这些对象（已升级）的库不动。
 */
import { type Db, sql } from '@italent/db';

const rowsOf = <T>(value: unknown) => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];

const present = async (db: Db, table: string) => {
  const result = await db.execute(sql`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present`);
  return Boolean(rowsOf<{ present: boolean }>(result)[0]?.present);
};

const hasColumn = async (db: Db, table: string, column: string) => {
  const result = await db.execute(sql`SELECT 1 AS found FROM information_schema.columns
    WHERE table_schema='public' AND table_name=${table} AND column_name=${column}`);
  return rowsOf(result).length > 0;
};

/** 补出缺的临时表 / 列并返回撤掉它们的函数；都已存在时返回空操作。必须在升级迁移之前调用返回的函数。 */
export async function addPreExitRoutesObjects(db: Db): Promise<() => Promise<void>> {
  const tables: string[] = [];
  if (!(await present(db, 'approval_node_exit_routes'))) {
    await db.execute(sql`CREATE TABLE approval_node_exit_routes (tenant_id uuid NOT NULL, version_id uuid NOT NULL,
      node_key text NOT NULL, exit text NOT NULL, branch_no smallint NOT NULL, kind text NOT NULL,
      priority smallint, expression text, target_node_key text NOT NULL)`);
    tables.push('approval_node_exit_routes');
  }
  if (!(await present(db, 'approval_node_exit_route_conditions'))) {
    await db.execute(sql`CREATE TABLE approval_node_exit_route_conditions (tenant_id uuid NOT NULL,
      version_id uuid NOT NULL, node_key text NOT NULL, exit text NOT NULL, branch_no smallint NOT NULL,
      item_no smallint NOT NULL, field_path text NOT NULL, operator text NOT NULL, value_text text,
      value_list text[])`);
    tables.push('approval_node_exit_route_conditions');
  }
  if (!(await present(db, 'approval_node_activations'))) {
    await db.execute(sql`CREATE TABLE approval_node_activations (tenant_id uuid NOT NULL, activation_id uuid NOT NULL,
      instance_id uuid NOT NULL, round integer NOT NULL, node_key text NOT NULL, entry_kind text NOT NULL,
      from_activation_id uuid, from_node_key text, from_exit text, from_branch_no smallint,
      created_seq integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
    tables.push('approval_node_activations');
  }
  if (tables.length) await db.execute(sql.raw(`GRANT SELECT, INSERT ON ${tables.join(', ')} TO app_user`));
  const addColumn = !(await hasColumn(db, 'approval_tasks', 'decision_exit'));
  if (addColumn) await db.execute(sql`ALTER TABLE approval_tasks ADD COLUMN decision_exit text`);
  return async () => {
    if (addColumn) await db.execute(sql`ALTER TABLE approval_tasks DROP COLUMN decision_exit`);
    if (tables.length) await db.execute(sql.raw(`DROP TABLE ${tables.join(', ')}`));
  };
}

export async function withPreExitRoutesSchema<T>(db: Db, run: () => Promise<T>): Promise<T> {
  const restore = await addPreExitRoutesObjects(db);
  try {
    return await run();
  } finally {
    await restore();
  }
}
