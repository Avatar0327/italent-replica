/**
 * 准备度引用守卫（设计 §1.1 准备度行；同 #106 做法）：T04 删除准备度时在同一事务内询问各引用方，被继任记录引用
 * （含已结束的记录）即拒绝删除，409 READINESS_IN_USE；已删除的记录不占用（触发器已在软删除时释放引用，0080）。
 * 停用不受影响：已有引用保留，只是不能再新选用（selectReadiness）。
 */
import { sql } from '@italent/db';
import { registerReadinessReferenceGuard } from '../talent-review/readiness-port.js';
import { rowsOf } from './read-sql.js';

export const SUCCESSION_RECORD_REFERRER = 'SUCCESSION_RECORD';

registerReadinessReferenceGuard(async (tx, tenantId, readinessId) => {
  const rows = rowsOf<{ found: number }>(
    await tx.execute(sql`SELECT 1 AS found FROM succession_records
      WHERE tenant_id = ${tenantId}::uuid AND readiness_id = ${readinessId}::uuid AND deleted_at IS NULL LIMIT 1`),
  );
  return rows.length ? SUCCESSION_RECORD_REFERRER : null;
});
