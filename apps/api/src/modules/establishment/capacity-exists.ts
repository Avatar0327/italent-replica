import { sql, type Tx } from '@italent/db';
import { rowsOf } from './store.js';

/**
 * F-296：这些组织自 `from` 起是否还有编制对象——周期未在 `from` 前结束的都算（覆盖 `from` 的当期，以及之后的各期）。
 * 只读单一入口（DEC-431①），供直接停用组织的临时关口使用；11e 的 endCapacity 合入后随关口一并拆除。
 * 调用方须已完成数据范围授权（范围外的下级不能经此判断泄露存在性）。
 */
export async function hasCapacityFrom(tx: Tx, tenantId: string, orgIds: readonly string[], from: string) {
  if (!orgIds.length) return false;
  const result = await tx.execute(sql`
    SELECT 1 AS found FROM establishment_objects
    WHERE tenant_id = ${tenantId} AND org_id = ANY(${`{${orgIds.join(',')}}`}::uuid[])
      AND period_end >= ${from}::date LIMIT 1
  `);
  return rowsOf<{ found: number }>(result).length > 0;
}
