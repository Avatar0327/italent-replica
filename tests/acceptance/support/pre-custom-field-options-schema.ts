/**
 * 升级测试夹具（F-474-6b-0b，迁移 0215）：当前接口读取自定义字段定义时会带上
 * employment_custom_field_objects.options（单选下拉的选项集），而这一列在迁移 0215 才建。
 * 在更早的结构上用当前接口造入职、调动等在途数据时，临时补出这一列，前置步骤跑完即撤掉，
 * 再由测试执行升级迁移按正式结构重建——同 pre-intern-cycle-schema、pre-profile-updated-by-schema 先例。
 * 生产总是先迁移再服务，生产代码不判断列是否存在（DEC-402）。已有这一列（已升级）的库不动。
 * 只补列：options 数组检查、单选必须有选项、放宽后的 value_type 取值与触发器 / 授权改动留给升级迁移；
 * 前置步骤不建自定义字段定义，用到的只是读取，空数组即可。
 */
import { type Db, sql } from '@italent/db';

const rowsOf = <T>(value: unknown) => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];

const hasOptions = async (db: Db) => {
  const result = await db.execute(sql`SELECT 1 AS found FROM information_schema.columns
    WHERE table_schema='public' AND table_name='employment_custom_field_objects' AND column_name='options'`);
  return rowsOf(result).length > 0;
};

/** 补出缺的临时列并返回撤掉它的函数；已存在时返回空操作。必须在升级迁移之前调用返回的函数。 */
export async function addPreCustomFieldOptionsColumn(db: Db): Promise<() => Promise<void>> {
  const add = !(await hasOptions(db));
  if (add) {
    await db.execute(
      sql`ALTER TABLE employment_custom_field_objects ADD COLUMN options jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
  }
  return async () => {
    if (add) await db.execute(sql`ALTER TABLE employment_custom_field_objects DROP COLUMN options`);
  };
}

export async function withPreCustomFieldOptionsSchema<T>(db: Db, run: () => Promise<T>): Promise<T> {
  const restore = await addPreCustomFieldOptionsColumn(db);
  try {
    return await run();
  } finally {
    await restore();
  }
}
