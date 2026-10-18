/**
 * 删除主职记录的探针（docs/08_设计/R2-T05_兼职设计.md §5.3 / §3.3 S13）：被删记录是任职周期的入职类记录
 * （hire / rehire / retire_rehire）且该周期有兼职记录 → 联动项“该任职周期的 N 条兼职记录”，deleteEmploymentBusiness 按既有
 * assertNoLinkedChanges 整单拒绝（EMPLOYMENT_LINKED_CHANGES_EXIST 同形态，复刻从严，同 DEC-012 / 172）。
 * 删除周期内的其他主职记录不影响兼职（时间轴连续覆盖保证开始日仍有主职记录）。只读。
 */
import { sql } from '@italent/db';
import type { DeletionLinkageProbe } from '../deletion-guards.js';
import { rowsOf } from '../record-store.js';
import { NEW_CYCLE_KINDS } from '../write-service.js';

export const partTimeCycleProbe: DeletionLinkageProbe = async (tx, ctx, record) => {
  if (!NEW_CYCLE_KINDS.includes(record.kind)) return [];
  const [row] = rowsOf<{ count: number }>(
    await tx.execute(sql`SELECT count(*)::int AS count FROM employment_records
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${record.employeeId}::uuid AND staff_id=${record.staffId}::uuid
        AND service_type <> 'primary'`),
  );
  const count = Number(row?.count ?? 0);
  return count ? [{ kind: 'part-time', label: `该任职周期的 ${count} 条兼职记录`, count }] : [];
};
