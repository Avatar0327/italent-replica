/**
 * 升级测试夹具（F-474-8c-2c，transfer_linkage_versions 的三个调整列由社保迁移建，后合并的任务改号后文件名会变，这里不写死）：
 * 当前接口读取调动联动时，会带上 transfer_linkage_versions 的 adjusted_insurance_region_code / plan_id / company_id。
 * 在更早的结构上用当前接口造审批、调动等在途数据时，临时补出这三列，前置步骤跑完即撤掉，
 * 再由测试执行升级迁移按正式结构重建——同 pre-org-custom-fields-schema、pre-custom-field-options-schema 先例。
 * 生产总是先迁移再服务，生产代码不判断列是否存在（DEC-402）。补列和撤列只按 information_schema 判断列在不在，
 * 已有这些列（已升级）的库不动；表还不存在时也无需补。
 * 只补列：行政区划 / 方案 / 公司的外键留给升级迁移；前置步骤不写社保调整值，补出的列可空，等同历史数据。
 */
import { type Db, sql } from '@italent/db';

const rowsOf = <T>(value: unknown) => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];

/** 列名与类型同社保迁移里的定义（可空、不带外键）。 */
const COLUMNS = [
  ['adjusted_insurance_region_code', 'text'],
  ['adjusted_insurance_plan_id', 'uuid'],
  ['adjusted_insurance_company_id', 'uuid'],
] as const;

const existing = async (db: Db): Promise<ReadonlySet<string>> => {
  const result = await db.execute(sql`SELECT column_name AS name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='transfer_linkage_versions'`);
  return new Set(rowsOf<{ name: string }>(result).map((row) => row.name));
};

/** 补出缺的临时列并返回撤掉它们的函数；列都在（已升级）或表不存在时返回空操作。必须在升级迁移之前调用返回的函数。 */
export async function addPreTransferLinkageInsuranceColumns(db: Db): Promise<() => Promise<void>> {
  const present = await existing(db);
  // 表不存在时 present 为空：这时没有可补的表，什么都不做
  const added = present.size === 0 ? [] : COLUMNS.filter(([name]) => !present.has(name));
  for (const [name, type] of added) {
    await db.execute(sql.raw(`ALTER TABLE transfer_linkage_versions ADD COLUMN ${name} ${type}`));
  }
  return async () => {
    for (const [name] of added) {
      await db.execute(sql.raw(`ALTER TABLE transfer_linkage_versions DROP COLUMN ${name}`));
    }
  };
}

export async function withPreTransferLinkageInsuranceSchema<T>(db: Db, run: () => Promise<T>): Promise<T> {
  const restore = await addPreTransferLinkageInsuranceColumns(db);
  try {
    return await run();
  } finally {
    await restore();
  }
}
