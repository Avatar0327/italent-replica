import type { Tx } from '@italent/db';
import { assertEstablishmentCapacity, type EstablishmentWarning } from '../employment/activation-checks.js';
import type { EmploymentContext } from '../employment/types.js';
import { affectsEstablishmentOccupancy } from '../establishment/employment-check.js';
import type { SequenceTarget } from './sequence-targets.js';

/** DEC-015 / 127：异步批量同步同样按行提示超编，不能因绕过编辑端口而静默漏检。 */
export async function sequenceEstablishmentWarnings(
  tx: Tx,
  ctx: EmploymentContext,
  targets: readonly SequenceTarget[],
) {
  const warnings: EstablishmentWarning[] = [];
  // 全批已追加并持有员工/业务锁，再取组织→编制锁；评估完整批次结果，不在持编制锁后取下一业务锁。
  for (const target of targets) {
    const fields = { ...target.fields, sequenceId: target.source.sequenceId };
    const point = {
      businessId: target.payload.businessId,
      employeeId: target.payload.employeeId,
      effectiveDate: target.payload.effectiveDate,
    };
    if (await affectsEstablishmentOccupancy(tx, ctx, target.fields, fields, point))
      await assertEstablishmentCapacity(
        tx,
        ctx,
        {
          ...point,
          kind: 'transfer',
          fields,
          departmentId: fields.departmentId,
          positionId: fields.positionId,
          reconcileCarried: false,
        },
        warnings,
      );
  }
  return warnings.map(({ businessId, reason }) => ({ recordId: businessId, reason }));
}
