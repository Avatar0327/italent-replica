/** C2-1b / 设计 §4.4：按评定固定任职周期检查，不能用员工当前周期替代（重聘隔离）。 */
import { isUuid, sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { recordEventToday } from '../employment/record-events.js';
import { rowsOf, type EvaluationContext } from './access.js';

/**
 * 评定写命令统一准入：调用方先按员工 → 评定行锁定，再调用本守卫，然后执行业务写入。
 * 员工锁与任职登记 / 删除 / 消费串行；不得先锁评定再取员工锁。系统离职终止本身不走这个拒写守卫。
 */
export async function assertCycleActive(tx: Tx, ctx: EvaluationContext, cycleId: string): Promise<void> {
  if (!isUuid(cycleId)) throw new AppError('VALIDATION_FAILED', '任职周期标识必须是 UUID');
  const [left] = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT r.id
    FROM employment_timeline t JOIN employment_records r
      ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    WHERE t.tenant_id=${ctx.tenantId}::uuid AND r.staff_id=${cycleId.toLowerCase()}::uuid
      AND r.kind IN ('leave','retirement') AND t.start_date<=${recordEventToday(ctx)}::date LIMIT 1`),
  );
  if (left) throw new AppError('CONFLICT', '该任职周期已离职，不能继续修改评定', { reason: 'EMPLOYEE_LEFT' });
}
