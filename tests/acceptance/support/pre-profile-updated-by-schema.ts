/**
 * 升级测试夹具（F-474-5，迁移 0212）：当前接口开通租户安装标准身份时会写 permission_profiles.updated_by（最近修改人），
 * 而这一列在迁移 0212 才建。在更早的结构上用当前接口造租户等在途数据时，临时补出这一列，
 * 前置步骤跑完即撤掉，再由测试执行升级迁移按正式结构重建——同 pre-intern-cycle-schema 先例。
 * 生产总是先迁移再服务，生产代码不判断列是否存在（DEC-402）。已有这一列（已升级）的库不动。
 * 只补列：外键 permission_profiles_updated_by_users_id_fk 留给升级迁移。
 */
import { type Db, sql } from '@italent/db';

const rowsOf = <T>(value: unknown) => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];

const hasUpdatedBy = async (db: Db) => {
  const result = await db.execute(sql`SELECT 1 AS found FROM information_schema.columns
    WHERE table_schema='public' AND table_name='permission_profiles' AND column_name='updated_by'`);
  return rowsOf(result).length > 0;
};

export async function withPreProfileUpdatedBySchema<T>(db: Db, run: () => Promise<T>): Promise<T> {
  const add = !(await hasUpdatedBy(db));
  if (add) await db.execute(sql`ALTER TABLE permission_profiles ADD COLUMN updated_by uuid`);
  try {
    return await run();
  } finally {
    if (add) await db.execute(sql`ALTER TABLE permission_profiles DROP COLUMN updated_by`);
  }
}
