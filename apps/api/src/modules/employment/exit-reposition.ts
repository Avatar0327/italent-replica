/** F-140 §3.4：已生效离职的人工快照与重定位；不重放离职生效副作用。 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { auditEmployment } from './context.js';
import { assertRestoredPredecessor } from './deletion-guards.js';
import { repositionEffectiveRecord } from './late-transfer.js';
import { loadEmploymentRecord } from './read-model.js';
import { bumpEmploymentBusiness, insertEmploymentRow, rowsOf, type LockedEmploymentBusiness } from './record-store.js';
import { employeeStatusHooks, type EmploymentRecordEvent } from './status-hooks.js';
import { reattachFutureTransfers } from './timeline.js';
import { detachAndRecord } from './exit-activation.js';
import { personnelHooks } from './personnel-hooks.js';
import type { EmploymentContext, EmploymentRecord } from './types.js';
import type { DownstreamItem } from './exit-downstream.js';

export async function repositionExit(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  change: { oldPlan: string; effectiveDate: string; lastWorkDate: string | null },
): Promise<{ next: LockedEmploymentBusiness['payload']; hints: DownstreamItem[]; successor: undefined }> {
  const before = await loadEmploymentRecord(tx, ctx.tenantId, business.id, business.payload.effectiveDate);
  if (!before) throw new AppError('CONFLICT', '离职任职记录不在时间轴上');
  if (change.effectiveDate < before.effectiveDate) {
    const crossed = rowsOf(
      await tx.execute(sql`SELECT record_id FROM employment_timeline
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${business.employeeId}::uuid AND staff_id=${before.staffId}::uuid
        AND record_id<>${business.id}::uuid AND start_date>=${change.effectiveDate}::date
        AND start_date<${before.effectiveDate}::date LIMIT 1`),
    );
    if (crossed.length)
      throw new AppError('CONFLICT', '改早的离职日期不能越过同周期任职记录', {
        reason: 'EXIT_RESCHEDULE_CROSSES_RECORD',
      });
  }
  const previous = business.payload;
  const next = {
    ...previous,
    id: randomUUID(),
    versionNo: previous.versionNo + 1,
    previousVersionId: previous.id,
    effectiveDate: change.effectiveDate,
    lastWorkDate: change.lastWorkDate,
    fields: before.fields,
    customFields: before.customFields,
    isRecordSnapshot: true,
    deferredFieldCodes: [],
    commandId: ctx.commandId,
    triggerBusinessId: business.id,
  };
  const { fields, ...metadata } = next;
  await insertEmploymentRow(
    tx,
    'employment_payload_versions',
    {
      ...metadata,
      ...fields,
      createdAt: ctx.now.toISOString(),
    },
    undefined,
    true,
  );
  business.payload = next;
  await repositionEffectiveRecord(tx, ctx, business, before, async () => {
    await reattachFutureTransfers(tx, ctx, business.employeeId, business.id);
  });
  await detachAndRecord(tx, ctx, business);
  if (change.effectiveDate > before.effectiveDate) await validateRestoredWindow(tx, ctx, before, change.effectiveDate);
  await bumpEmploymentBusiness(tx, ctx, business);
  await auditEmployment(
    tx,
    ctx,
    'employment.leave.replanned',
    'employment-business',
    business.id,
    { plannedEffectiveDate: change.oldPlan },
    { plannedEffectiveDate: change.effectiveDate, versionNo: next.versionNo },
  );
  const event: EmploymentRecordEvent = {
    employeeId: business.employeeId,
    recordId: business.id,
    kind: 'leave',
    effectiveDate: before.effectiveDate,
    lastWorkDate: previous.lastWorkDate,
    employeeStatus: before.employeeStatus,
  };
  const hints = await employeeStatusHooks.recordRescheduled(tx, ctx, {
    before: event,
    after: { ...event, effectiveDate: change.effectiveDate, lastWorkDate: change.lastWorkDate },
  });
  return { next, hints, successor: undefined };
}

/** 最终时间轴定型后校验恢复段，避免按临时开放区间误拒绝。 */
async function validateRestoredWindow(tx: Tx, ctx: EmploymentContext, before: EmploymentRecord, effectiveDate: string) {
  const restored = rowsOf<{ id: string; from: string; to: string }>(
    await tx.execute(sql`
    SELECT record_id::text AS id, greatest(start_date,${before.effectiveDate}::date)::text AS "from",
      least(upper(valid_during),${effectiveDate}::date)::text AS "to"
    FROM employment_timeline WHERE tenant_id=${ctx.tenantId} AND employee_id=${before.employeeId}::uuid
    AND valid_during && daterange(${before.effectiveDate}::date,${effectiveDate}::date,'[)')
    ORDER BY start_date,sort_order`),
  );
  for (const row of restored) {
    await assertRestoredPredecessor(
      tx,
      ctx,
      before,
      {
        previousId: row.id,
        window: { from: row.from, to: row.to },
      },
      { delegateIntervalChecks: true },
    );
    const record = await loadEmploymentRecord(tx, ctx.tenantId, row.id, row.from);
    if (record) await personnelHooks.sync(tx, ctx, before.employeeId, row.id, record.kind, record.effectiveDate);
  }
}
