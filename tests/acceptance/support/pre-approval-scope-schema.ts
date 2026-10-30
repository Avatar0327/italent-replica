/**
 * 升级测试夹具（BE-14a3 / BE-10a2）：审批实例范围会引用 Offer、批量审批单子表和组织调整表。
 * PostgreSQL 解析时即要求这些表存在，即使实例不属于对应业务类型。在早于这些表的结构上用当前接口造数时，
 * 临时建同名空表（只含范围谓词读到的列），前置步骤跑完即撤掉，再由测试执行升级迁移按正式结构重建——同 pre-blacklist-schema、
 * pre-part-time-schema 先例。生产总是先迁移再服务，生产代码不判断表是否存在（DEC-402）。已有这些表的库不动。
 */
import { type Db, sql } from '@italent/db';

const present = async (db: Db, table: string) => {
  const result = await db.execute(sql`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present`);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { present: boolean }[];
  return Boolean(rows[0]?.present);
};

/** 补出缺的临时表并返回撤掉它们的函数；表都已存在时返回空操作。必须在升级迁移之前调用返回的函数。 */
export async function addPreApprovalScopeTables(db: Db): Promise<() => Promise<void>> {
  const added: string[] = [];
  if (!(await present(db, 'offers'))) {
    await db.execute(sql`CREATE TABLE offers (id uuid NOT NULL, tenant_id uuid NOT NULL, department_id uuid,
      created_by uuid NOT NULL)`);
    added.push('offers');
  }
  if (!(await present(db, 'offer_batch_approval_items'))) {
    await db.execute(sql`CREATE TABLE offer_batch_approval_items (tenant_id uuid NOT NULL, batch_id uuid NOT NULL,
      offer_id uuid NOT NULL)`);
    added.push('offer_batch_approval_items');
  }
  if (!(await present(db, 'org_adjustments'))) {
    await db.execute(sql`CREATE TABLE org_adjustments (id uuid NOT NULL, tenant_id uuid NOT NULL,
      approval_subject_org_id uuid)`);
    added.push('org_adjustments');
  }
  if (!added.length) return async () => {};
  await db.execute(sql.raw(`GRANT SELECT ON ${added.join(', ')} TO app_user`));
  return async () => {
    await db.execute(sql.raw(`DROP TABLE ${added.join(', ')}`));
  };
}

export async function withPreApprovalScopeSchema<T>(db: Db, run: () => Promise<T>): Promise<T> {
  const restore = await addPreApprovalScopeTables(db);
  try {
    return await run();
  } finally {
    await restore();
  }
}
