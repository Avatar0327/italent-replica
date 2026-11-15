/**
 * 升级测试夹具（F-474-6b，org_versions.custom_fields 列由迁移 0220 建，后合并的任务改号后文件名会变，这里不写死）：
 * 当前接口写组织时，org_versions 的插入会带上 custom_fields 这一列。在更早的结构上用当前接口造组织等在途数据时，
 * 临时补出这一列，前置步骤跑完即撤掉，再由测试执行升级迁移按正式结构重建——同 pre-custom-field-options-schema 先例。
 * 生产总是先迁移再服务，生产代码不判断列是否存在（DEC-402）。补列和撤列只按 information_schema 判断列在不在，
 * 已有这一列（已升级）的库不动。
 * 只补列：必须是对象的 CHECK 约束留给升级迁移；前置步骤不写自定义字段值，补出的列取缺省空对象，等同历史数据。
 */
import { type Db, sql } from '@italent/db';

const rowsOf = <T>(value: unknown) => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];

const hasColumn = async (db: Db) => {
  const result = await db.execute(sql`SELECT 1 AS found FROM information_schema.columns
    WHERE table_schema='public' AND table_name='org_versions' AND column_name='custom_fields'`);
  return rowsOf(result).length > 0;
};

/** 补出缺的临时列并返回撤掉它的函数；已存在时返回空操作。必须在升级迁移之前调用返回的函数。 */
export async function addPreOrgCustomFieldsColumn(db: Db): Promise<() => Promise<void>> {
  const add = !(await hasColumn(db));
  if (add) {
    await db.execute(sql`ALTER TABLE org_versions ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb`);
  }
  return async () => {
    if (add) await db.execute(sql`ALTER TABLE org_versions DROP COLUMN custom_fields`);
  };
}

export async function withPreOrgCustomFieldsSchema<T>(db: Db, run: () => Promise<T>): Promise<T> {
  const restore = await addPreOrgCustomFieldsColumn(db);
  try {
    return await run();
  } finally {
    await restore();
  }
}
