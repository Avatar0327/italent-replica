/**
 * 离职 / 退休落地时将被清空上级的下属（R2-T09b DT-R5）的预锁参与者（P2-2）。
 * 落地清空要改这些下属当前任职的上级（经 editEmploymentRecord → lockTransferBusiness 再规划一次员工锁）；
 * 若它们不在入口一次取齐的预锁集合里，之后再取会逆序（UUID 小于已持锁者）并抛 TRANSFER_LOCK_PLAN_CHANGED，
 * 清空被记为业务拒绝、下属上级仍是离职人。所以把“尚未落地的离职 / 退休 × 计划之外仍承担的下属”并入统一的
 * 预锁计划（transfer-locks.ts participants，在首次员工锁、组织锁之前）。组织角色不涉及员工锁，不在此列。
 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { uncoveredDuties } from '../duty-transfer/uncovered.js';
import { latestLinkage } from '../transfer/linkage/store.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

/**
 * 给定员工中，名下有尚未落地（含直接生效单落地前一刻）、尚未执行转交的离职 / 退休的，其计划之外仍承担的下属。
 * 退休同时返聘的不清空（RT-R3，DEC-863①），不在此列。
 * 按计划生效日与今天（迟到落地取实际执行日）两个日期取并集，偏多不偏少。
 */
export async function pendingClearSubordinates(
  tx: Tx,
  ctx: EmploymentContext,
  employeeIds: readonly string[],
): Promise<string[]> {
  const exits = rowsOf<{ businessId: string; employeeId: string; effectiveDate: string }>(
    await tx.execute(sql`
      SELECT b.id::text AS "businessId", b.employee_id::text AS "employeeId", p.effective_date::text AS "effectiveDate"
      FROM employment_business_objects b
      JOIN LATERAL (SELECT kind, effective_date FROM employment_payload_versions p
        WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY version_no DESC LIMIT 1) p ON true
      JOIN LATERAL (SELECT state FROM employment_state_events s
        WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY event_no DESC LIMIT 1) s ON true
      WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=ANY(${`{${employeeIds.join(',')}}`}::uuid[])
        AND p.kind IN ('leave','retirement') AND s.state NOT IN ('deleted','disapproved','voided','effective')
        AND NOT EXISTS (SELECT 1 FROM transfer_linkage_runs r WHERE r.tenant_id=b.tenant_id AND r.business_id=b.id)
        AND NOT EXISTS (SELECT 1 FROM retirement_requests rr
          WHERE rr.tenant_id=b.tenant_id AND rr.business_id=b.id AND rr.re_employed)`),
  );
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const found = new Set<string>();
  for (const exit of exits) {
    const plan = (await latestLinkage(tx, ctx.tenantId, exit.businessId))?.options.dutyTransfer ?? null;
    for (const day of new Set([exit.effectiveDate, today > exit.effectiveDate ? today : exit.effectiveDate]))
      for (const duty of await uncoveredDuties(tx, ctx.tenantId, exit.employeeId, day, plan))
        if (duty.subordinateId) found.add(duty.subordinateId.toLowerCase());
  }
  return [...found];
}
