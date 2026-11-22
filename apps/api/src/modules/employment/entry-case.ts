import { and, eq, inArray, onboardingEntryCases, sql, type Tx } from '@italent/db';
import { EMPLOYEE_STATUS } from '@italent/domain';
import { auditActor } from '../../system-actor.js';
import { entryLifecyclePort, type EntryLifecycleChange } from './onboarding-entry-port.js';
import { lockEmploymentBusiness, rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

const cases = onboardingEntryCases;

export function entryCaseContext(ctx: EmploymentContext) {
  return { ...ctx, userId: auditActor(ctx.userId) };
}

export async function createPendingEntryCase(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  businessId: string,
  pendingDate: string,
) {
  await entryLifecyclePort().create(tx, entryCaseContext(ctx), { employeeId, businessId, pendingDate });
}

/** DEC-402：没有历史阶段时不补建。调用方已锁员工及当前业务头。 */
export async function applyCurrentEntryCase(tx: Tx, ctx: EmploymentContext, change: EntryLifecycleChange) {
  const [current] = await tx
    .select({ id: cases.id })
    .from(cases)
    .where(
      and(
        eq(cases.tenantId, ctx.tenantId),
        eq(cases.employeeId, change.employeeId),
        eq(cases.currentBusinessId, change.businessId),
        inArray(cases.state, ['pending', 'cancelled']),
      ),
    );
  if (current) await entryLifecyclePort().apply(tx, entryCaseContext(ctx), change);
}

function dueCases(tenantId: string, today: string) {
  return sql`
    SELECT c.employee_id AS "employeeId", c.current_business_id AS "businessId",
      t.start_date::text AS "hiredOn", b.revision
    FROM onboarding_entry_cases c
    JOIN employment_business_objects b ON b.tenant_id = c.tenant_id AND b.id = c.current_business_id
    JOIN employment_timeline t ON t.tenant_id = c.tenant_id AND t.record_id = c.current_business_id
    JOIN LATERAL employment_record_status(c.tenant_id, c.current_business_id) s ON true
    WHERE c.tenant_id = ${tenantId} AND c.state = 'pending' AND c.pending_date <= ${today}::date
      AND t.start_date <= ${today}::date
      AND s.employee_status IN (${EMPLOYEE_STATUS.probation}, ${EMPLOYEE_STATUS.regular})
  `;
}

export function dueEntryCaseEmployees(tenantId: string, today: string, cursor: string | null) {
  return sql`SELECT d."employeeId"::text FROM (${dueCases(tenantId, today)}) d
    WHERE (${cursor}::uuid IS NULL OR d."employeeId" > ${cursor}::uuid)`;
}

/** 已办理但计划日期在未来的阶段，由任职调度按当前事实收口。此处只写阶段和审计。 */
export async function finishDueEntryCases(tx: Tx, ctx: EmploymentContext, employeeId: string, today: string) {
  const due = rowsOf<{ businessId: string; hiredOn: string; revision: number }>(
    await tx.execute(sql`SELECT * FROM (${dueCases(ctx.tenantId, today)}) d
      WHERE d."employeeId" = ${employeeId}::uuid ORDER BY d."businessId"`),
  );
  for (const { businessId, hiredOn, revision } of due) {
    const business = await lockEmploymentBusiness(tx, { ...ctx, expectedRevision: revision }, businessId);
    if (business.state !== 'effective') continue;
    await entryLifecyclePort().apply(tx, entryCaseContext(ctx), {
      kind: 'hire',
      employeeId,
      businessId,
      hiredRecordId: businessId,
      hiredOn,
    });
  }
}
