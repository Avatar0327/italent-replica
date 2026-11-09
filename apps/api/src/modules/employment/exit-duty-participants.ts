/**
 * 离职 / 退休落地时的“待清空项”（R2-T09b DT-R5）：唯一取数来源（DEC-385③）。
 * 落地清空（exit-duty-clear.ts）与入口预锁（transfer-locks.ts participants）都从这里取，清空阶段只在此结果上执行、复核。
 * 落地清空要改下属当前任职的上级（经 editEmploymentRecord → lockTransferBusiness 再规划一次员工锁）；若这些下属不在入口
 * 一次取齐的预锁集合里，之后再取会逆序，所以预锁按同一函数把“尚未落地的离职 / 退休 × 计划之外仍承担的下属”并入。
 * 与计划是否已提前执行（审批通过时 / 指定日期到日）无关：执行过的只是计划里的职责，计划之外的落地时仍要清空（第 2 轮 P2-1）。
 * 组织角色不涉及员工锁，预锁只取下属；直线、虚线下属同一口径（currentDuties）。
 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { Duty } from '../duty-transfer/duties.js';
import { uncoveredDuties } from '../duty-transfer/uncovered.js';
import { latestLinkage } from '../transfer/linkage/store.js';
import { rowsOf } from './record-store.js';
import { plannedEffectiveDate } from './timeline.js';
import type { EmploymentContext } from './types.js';

export interface ExitClearTarget {
  readonly businessId: string;
  readonly employeeId: string;
  readonly kind: string;
  /** 退休同时返聘（RT-R3，DEC-863①）：不清空，计划之外的职责保留在本人名下。 */
  readonly reEmployed: boolean;
}

/** asOf 当日落地将被清空的职责：当前承担的减去最新转交计划已覆盖的；退休同时返聘的为空。 */
export async function exitDutiesToClear(
  tx: Tx,
  tenantId: string,
  exit: ExitClearTarget,
  asOf: string,
): Promise<Duty[]> {
  if (exit.kind === 'retirement' && exit.reEmployed) return [];
  const plan = (await latestLinkage(tx, tenantId, exit.businessId))?.options.dutyTransfer ?? null;
  return uncoveredDuties(tx, tenantId, exit.employeeId, asOf, plan);
}

/**
 * 给定员工中，名下有尚未落地（含直接生效单落地前一刻）的离职 / 退休的，其落地时将被清空上级的下属。
 * 落地日取计划生效日（§5.0A，与生效路径同一取值）、载荷生效日与今天（迟到落地取实际执行日）的并集，偏多不偏少。
 */
export async function pendingClearSubordinates(
  tx: Tx,
  ctx: EmploymentContext,
  employeeIds: readonly string[],
): Promise<string[]> {
  const exits = rowsOf<ExitClearTarget & { effectiveDate: string; plannedDate: string }>(
    await tx.execute(sql`
      SELECT b.id::text AS "businessId", b.employee_id::text AS "employeeId", p.kind,
        p.effective_date::text AS "effectiveDate",
        ${plannedEffectiveDate(ctx.tenantId, sql`b.id`, sql`p.effective_date`)}::text AS "plannedDate",
        COALESCE(rr.re_employed, false) AS "reEmployed"
      FROM employment_business_objects b
      JOIN LATERAL (SELECT kind, effective_date FROM employment_payload_versions p
        WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY version_no DESC LIMIT 1) p ON true
      JOIN LATERAL (SELECT state FROM employment_state_events s
        WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY event_no DESC LIMIT 1) s ON true
      LEFT JOIN retirement_requests rr ON rr.tenant_id=b.tenant_id AND rr.business_id=b.id
      WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=ANY(${`{${employeeIds.join(',')}}`}::uuid[])
        AND p.kind IN ('leave','retirement') AND s.state NOT IN ('deleted','disapproved','voided','effective')`),
  );
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const found = new Set<string>();
  for (const exit of exits) {
    const late = today > exit.plannedDate ? today : exit.plannedDate;
    for (const day of new Set([exit.plannedDate, exit.effectiveDate, late]))
      for (const duty of await exitDutiesToClear(tx, ctx.tenantId, exit, day))
        if (duty.subordinateId) found.add(duty.subordinateId.toLowerCase());
  }
  return [...found];
}
