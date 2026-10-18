/**
 * 升级测试夹具（R2 BE-7 PT-2）：任职写入口提交前的结果复核（permission/employment-replay.ts）与审计查看规则会查兼职
 * 期限链与兼职申请表，它们在迁移 part_time 才建。在更早的结构上用当前接口造数时，临时建同名空表（只含这些查询读到的列），
 * 前置步骤跑完即撤掉，再由测试执行升级迁移按正式结构重建——同 pre-audit-schema 的审计列、BE-8a 黑名单表先例。
 * 生产总是先迁移再服务，生产代码不判断表是否存在（DEC-402）。已有这些表（已升级）的库不动。
 */
import { type Db, sql } from '@italent/db';

/**
 * 补出临时表并返回撤掉它们的函数；表已存在时返回空操作。必须在升级迁移之前调用返回的函数。
 * F-218③：建表在一个事务里，任一步失败整体回滚（不留半套临时表）；撤掉函数幂等，异常路径与正常路径共用同一个 restore。
 */
export async function addPrePartTimeTables(db: Db): Promise<() => Promise<void>> {
  const result = await db.execute(sql`SELECT to_regclass('public.part_time_requests') IS NOT NULL AS present`);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { present: boolean }[];
  if (rows[0]?.present) return async () => {};
  await db.transaction(async (tx) => {
    await tx.execute(sql`CREATE TABLE employment_part_time_terms (tenant_id uuid NOT NULL, record_id uuid NOT NULL,
      term_no int NOT NULL, end_date date, source text NOT NULL, source_id uuid)`);
    await tx.execute(sql`CREATE TABLE part_time_requests (id uuid NOT NULL, tenant_id uuid NOT NULL,
      employee_id uuid NOT NULL, record_id uuid, initiator_user_id uuid NOT NULL)`);
    await tx.execute(sql`CREATE TABLE part_time_request_versions (tenant_id uuid NOT NULL, request_id uuid NOT NULL,
      version_no int NOT NULL, department_id uuid)`);
    await tx.execute(
      sql`GRANT SELECT ON employment_part_time_terms, part_time_requests, part_time_request_versions TO app_user`,
    );
  });
  return async () => {
    await db.execute(
      sql`DROP TABLE IF EXISTS employment_part_time_terms, part_time_requests, part_time_request_versions`,
    );
  };
}

export async function withPrePartTimeSchema<T>(db: Db, run: () => Promise<T>): Promise<T> {
  const restore = await addPrePartTimeTables(db);
  try {
    return await run();
  } finally {
    await restore();
  }
}
