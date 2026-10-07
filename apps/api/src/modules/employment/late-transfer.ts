/** DEC-186：追加载荷版本并重建日期投影，保留底表、业务 ID 与原计划日审计。 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { validateTransferReposition } from './write-service.js';
import { personnelHooks } from './personnel-hooks.js';
import { rebaseDerivedOrgAdjustments } from './org-adjustment-rebase.js';
import { rederiveRepositionedStatus } from './employee-status.js';
import { auditEmployment } from './context.js';
import { loadEmploymentRecord } from './read-model.js';
import { insertEmploymentRow, rowsOf, type LockedEmploymentBusiness } from './record-store.js';
import { insertEmploymentTimeline } from './timeline.js';
import type { EmploymentContext } from './types.js';

export async function postponeLateTransfer(tx: Tx, ctx: EmploymentContext, business: LockedEmploymentBusiness) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const previous = business.payload;
  if (previous.kind !== 'transfer' || previous.effectiveDate >= today) return;
  const record = await loadEmploymentRecord(tx, ctx.tenantId, business.id, today);
  const next = {
    ...previous,
    id: randomUUID(),
    versionNo: previous.versionNo + 1,
    previousVersionId: previous.id,
    effectiveDate: today,
    commandId: ctx.commandId,
    triggerBusinessId: business.id,
    ...(record
      ? { fields: record.fields, customFields: record.customFields, isRecordSnapshot: true, deferredFieldCodes: [] }
      : {}),
  };
  const { fields, ...metadata } = next;
  await insertEmploymentRow(tx, 'employment_payload_versions', {
    ...metadata,
    ...fields,
    createdAt: ctx.now.toISOString(),
  });
  business.payload = next;
  await auditEmployment(
    tx,
    ctx,
    'employment.transfer.rescheduled',
    'employment-business',
    business.id,
    { effectiveDate: previous.effectiveDate },
    { originalEffectiveDate: previous.effectiveDate, effectiveDate: today },
  );
  if (record) {
    const [point] = rowsOf<{ startDate: string; sortOrder: number }>(
      await tx.execute(sql`
      SELECT start_date::text AS "startDate",sort_order AS "sortOrder" FROM employment_timeline
      WHERE tenant_id=${ctx.tenantId} AND record_id=${business.id}::uuid`),
    );
    const [before] = rowsOf<{ id: string }>(
      await tx.execute(sql`
      SELECT record_id AS id FROM employment_timeline WHERE tenant_id=${ctx.tenantId}
        AND employee_id=${business.employeeId}::uuid
        AND (start_date,sort_order)<(${point!.startDate}::date,${point!.sortOrder})
      ORDER BY start_date DESC,sort_order DESC LIMIT 1`),
    );
    const [after] = rowsOf<{ date: string }>(
      await tx.execute(sql`
      SELECT start_date::text AS date FROM employment_timeline WHERE tenant_id=${ctx.tenantId}
        AND employee_id=${business.employeeId}::uuid
        AND (start_date,sort_order)>(${point!.startDate}::date,${point!.sortOrder})
      ORDER BY start_date,sort_order LIMIT 1`),
    );
    await tx.execute(
      sql`DELETE FROM employment_timeline WHERE tenant_id=${ctx.tenantId} AND record_id=${business.id}::uuid`,
    );
    if (before)
      await tx.execute(sql`UPDATE employment_timeline
      SET valid_during=daterange(start_date,${after?.date ?? null}::date,'[)')
      WHERE tenant_id=${ctx.tenantId} AND record_id=${before.id}::uuid`);
    await rebaseDerivedOrgAdjustments(tx, ctx, record, today);
    await validateTransferReposition(tx, ctx, business, record);
    await insertEmploymentTimeline(tx, ctx, business.employeeId, business.id, record.staffId, today);
    // F-022：移到当天后按新位置的前一条重新确定人员状态（跨过转正时取正式，不沿用原日期下的试用）
    await rederiveRepositionedStatus(tx, ctx, business);
  }
  if (record) await personnelHooks.sync(tx, ctx, business.employeeId, business.id, 'transfer', today);
}
