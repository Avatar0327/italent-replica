/**
 * 升级测试夹具（F-480，迁移 0199，DEC-797）：当前接口写任职周期时会带上 employment_cycles.trainee_start_date
 * （实习转正另存的实习开始日），而这一列在迁移 0199 才建。在更早的结构上用当前接口造入职等在途数据时，临时补出这一列，
 * 前置步骤跑完即撤掉，再由测试执行升级迁移按正式结构重建——同 pre-exit-routes-schema、pre-blacklist-schema 先例。
 * 生产总是先迁移再服务，生产代码不判断列是否存在（DEC-402）。已有这一列（已升级）的库不动。
 * 只补列：校验约束 employment_cycles_trainee_start 与扩充后的 entry_type 取值留给升级迁移，
 * 前置步骤只写 hire / rehire 这类 trainee_start_date 为空的周期，不会碰到它们。
 */
import { type Db, sql } from '@italent/db';

const rowsOf = <T>(value: unknown) => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];

const hasTraineeStartDate = async (db: Db) => {
  const result = await db.execute(sql`SELECT 1 AS found FROM information_schema.columns
    WHERE table_schema='public' AND table_name='employment_cycles' AND column_name='trainee_start_date'`);
  return rowsOf(result).length > 0;
};

/** 补出缺的临时列并返回撤掉它的函数；已存在时返回空操作。必须在升级迁移之前调用返回的函数。 */
export async function addPreInternCycleColumn(db: Db): Promise<() => Promise<void>> {
  const add = !(await hasTraineeStartDate(db));
  if (add) await db.execute(sql`ALTER TABLE employment_cycles ADD COLUMN trainee_start_date date`);
  return async () => {
    if (add) await db.execute(sql`ALTER TABLE employment_cycles DROP COLUMN trainee_start_date`);
  };
}

export async function withPreInternCycleSchema<T>(db: Db, run: () => Promise<T>): Promise<T> {
  const restore = await addPreInternCycleColumn(db);
  try {
    return await run();
  } finally {
    await restore();
  }
}
