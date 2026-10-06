import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { rowsOf } from './context.js';

/** DEC-190：历史冲突标记永久保留；撤销其他申请不能使本申请自动获胜。 */
export async function isQuarantined(tx: Tx, tenantId: string, id: string) {
  return (
    rowsOf(
      await tx.execute(sql`SELECT id FROM contract_job_attempts
    WHERE tenant_id=${tenantId} AND object_id=${id}::uuid AND kind='quarantine' LIMIT 1`),
    ).length > 0
  );
}
export async function assertNotQuarantined(tx: Tx, tenantId: string, id: string) {
  if (await isQuarantined(tx, tenantId, id))
    throw new AppError('CONFLICT', '存量在途合同冲突：请先撤销冲突申请，再按当前规则重新提交', {
      reason: 'CONTRACT_IN_FLIGHT_QUARANTINED',
      requestId: id,
    });
}
