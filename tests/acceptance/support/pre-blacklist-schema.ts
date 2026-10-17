/**
 * 升级测试夹具（R2 BE-8a）：新周期入职（hire / rehire / retire_rehire）保存时会查黑名单表，而它在迁移 be8a_blacklist
 * 才建。在更早的结构上用当前接口造入职数据时，临时建一张同名空表（只含拦截查询读到的列），前置步骤跑完即撤掉，再由
 * 测试执行升级迁移按正式结构重建——同 AC-APV-F048-upgrade 的冻结表、pre-audit-schema 的审计列先例。生产总是先迁移
 * 再服务，生产代码不判断表是否存在（DEC-402）。已有该表（已升级）的库不动。
 */
import { type Db, sql } from '@italent/db';

/** 补出临时表并返回撤掉它的函数；表已存在时返回空操作。必须在升级迁移之前调用返回的函数。 */
export async function addPreBlacklistTable(db: Db): Promise<() => Promise<void>> {
  const result = await db.execute(sql`SELECT to_regclass('public.employment_blacklist') IS NOT NULL AS present`);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { present: boolean }[];
  if (rows[0]?.present) return async () => {};
  await db.execute(sql`CREATE TABLE employment_blacklist (id uuid NOT NULL, tenant_id uuid NOT NULL, employee_id uuid,
    name text NOT NULL, id_number text, mobile_phone text, email text, reason text NOT NULL, status text NOT NULL,
    blacklist_date date NOT NULL, expiry_date date)`);
  await db.execute(sql`GRANT SELECT ON employment_blacklist TO app_user`);
  return async () => {
    await db.execute(sql`DROP TABLE employment_blacklist`);
  };
}

export async function withPreBlacklistSchema<T>(db: Db, run: () => Promise<T>): Promise<T> {
  const restore = await addPreBlacklistTable(db);
  try {
    return await run();
  } finally {
    await restore();
  }
}
