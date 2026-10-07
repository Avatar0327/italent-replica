/** DEC-186 / 195：调动移出旧区间后按最终时间轴重算，再同事务追加组织调整快照。 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { auditEmployment, requireLinkedEmploymentRecord } from './context.js';
import { calculatedChanges } from './org-adjustment-recompute.js';
import { calculateAdjustmentTimeline, type AdjustmentCalculation } from './org-adjustment-timeline.js';
import { personnelHooks } from './personnel-hooks.js';
import { insertEmploymentRow } from './record-store.js';
import { validateNewEmploymentReferences } from './references.js';
import { recordWindow } from './reporting-cycle.js';
import type { EmploymentContext, EmploymentRecord } from './types.js';

export async function rebaseDerivedOrgAdjustments(
  tx: Tx,
  ctx: EmploymentContext,
  source: EmploymentRecord,
  actualDate: string,
) {
  // 先完成计算，后条总是读取重算后的前驱；计算输出不再成为后续重建的业务输入。
  const plan = await calculateAdjustmentTimeline(tx, ctx, source, actualDate);
  for (const item of plan) await appendCalculation(tx, ctx, item, source.id);
}

async function appendCalculation(
  tx: Tx,
  ctx: EmploymentContext,
  { record, history, values }: AdjustmentCalculation,
  triggerBusinessId: string,
) {
  const changes = calculatedChanges(record, values);
  if (!changes.length) return;
  const latest = history.at(-1)!.payload;
  await requireLinkedEmploymentRecord(tx, ctx, record.employeeId, record.fields.departmentId, record.id);
  await requireLinkedEmploymentRecord(tx, ctx, record.employeeId, values.fields.departmentId, record.id);
  await validateNewEmploymentReferences(tx, ctx, values.fields, record.effectiveDate, {
    employeeId: record.employeeId,
    window: await recordWindow(tx, ctx.tenantId, record.id),
  });
  const next = {
    ...latest,
    ...values,
    id: randomUUID(),
    versionNo: latest.versionNo + 1,
    previousVersionId: latest.id,
    commandId: ctx.commandId,
    triggerBusinessId,
    isRecordSnapshot: true,
  };
  const { fields, ...metadata } = next;
  await insertEmploymentRow(tx, 'employment_payload_versions', {
    ...metadata,
    ...fields,
    createdAt: ctx.now.toISOString(),
  });
  await tx.execute(sql`UPDATE employment_business_objects SET revision=revision+1
    WHERE tenant_id=${ctx.tenantId} AND id=${record.id}::uuid`);
  await auditEmployment(
    tx,
    ctx,
    'employment.org-adjustment.rebased',
    'employment-record',
    record.id,
    Object.fromEntries(changes.map((change) => [change.field, change.before])),
    { ...Object.fromEntries(changes.map((change) => [change.field, change.after])), triggerBusinessId },
    next.id,
  );
  await personnelHooks.sync(tx, ctx, record.employeeId, record.id, record.kind, record.effectiveDate);
}
