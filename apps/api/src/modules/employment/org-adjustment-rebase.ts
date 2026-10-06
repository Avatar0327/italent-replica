/** DEC-186 / 195：调动移出旧区间时，派生的组织调整按新前驱重建继承字段，历史载荷不可改写。 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { auditEmployment, requireLinkedEmploymentRecord } from './context.js';
import { applyForwardChanges, type ForwardFieldChange } from './forward-rules.js';
import { personnelHooks } from './personnel-hooks.js';
import { loadEmploymentRecord } from './read-model.js';
import { camelRow, insertEmploymentRow, rowsOf, snapshotFields, type EmploymentPayloadRow } from './record-store.js';
import { validateNewEmploymentReferences } from './references.js';
import { recordWindow } from './reporting-cycle.js';
import type { EmploymentContext, EmploymentRecord } from './types.js';

export async function rebaseDerivedOrgAdjustments(
  tx: Tx,
  ctx: EmploymentContext,
  source: EmploymentRecord,
  actualDate: string,
) {
  // 沿创建来源和字段传播来源找派生链；另一笔独立业务不是组织调整，不能顺便改写。
  const targets = rowsOf<{ id: string }>(
    await tx.execute(sql`
    WITH RECURSIVE derived AS (
      SELECT r.id FROM employment_records r WHERE r.tenant_id=${ctx.tenantId}
        AND r.employee_id=${source.employeeId}::uuid AND r.kind='org_adjustment'
        AND (r.inheritance_source_id=${source.id}::uuid OR EXISTS (
          SELECT 1 FROM employment_payload_versions p WHERE p.tenant_id=r.tenant_id AND p.business_id=r.id
            AND p.trigger_business_id=${source.id}::uuid))
      UNION
      SELECT r.id FROM employment_records r JOIN derived d ON r.inheritance_source_id=d.id
        WHERE r.tenant_id=${ctx.tenantId} AND r.employee_id=${source.employeeId}::uuid AND r.kind='org_adjustment'
    ) SELECT t.record_id AS id FROM derived d JOIN employment_timeline t
      ON t.tenant_id=${ctx.tenantId} AND t.record_id=d.id
    WHERE t.start_date<${actualDate}::date ORDER BY t.start_date,t.sort_order LIMIT 1001`),
  );
  if (targets.length > 1000) throw new AppError('PAYLOAD_TOO_LARGE', '派生组织调整超过单次处理上限');
  for (const target of targets) {
    const record = await loadEmploymentRecord(tx, ctx.tenantId, target.id, actualDate);
    if (!record?.previousRecordId || record.staffId !== source.staffId) continue;
    const previous = await loadEmploymentRecord(tx, ctx.tenantId, record.previousRecordId, record.effectiveDate);
    if (previous?.staffId === record.staffId) await rebaseRecord(tx, ctx, record, previous, source.id);
  }
}

async function rebaseRecord(
  tx: Tx,
  ctx: EmploymentContext,
  record: EmploymentRecord,
  previous: EmploymentRecord,
  triggerBusinessId: string,
) {
  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
    SELECT p.*,EXISTS (SELECT 1 FROM employment_outbox o
        WHERE o.tenant_id=p.tenant_id AND o.payload_version_id=p.id
          AND o.event_type='employment.org-adjustment.rebased') AS is_rebase
      FROM employment_payload_versions p WHERE p.tenant_id=${ctx.tenantId} AND p.business_id=${record.id}::uuid
      ORDER BY p.version_no LIMIT 1001`),
  );
  if (rows.length > 1000) throw new AppError('PAYLOAD_TOO_LARGE', '组织调整载荷历史超过处理上限');
  const history = rows.map((row) => {
    const { isRebase, ...raw } = camelRow(row);
    return {
      rebase: Boolean(isRebase),
      payload: { ...raw, fields: snapshotFields(raw) } as unknown as EmploymentPayloadRow,
    };
  });
  const latest = history.at(-1)!.payload;
  const changes = inheritedChanges(record, history, previous, triggerBusinessId);
  if (!changes.length) return;
  const values = applyForwardChanges(record, changes);
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

function inheritedChanges(
  record: EmploymentRecord,
  history: { payload: EmploymentPayloadRow; rebase: boolean }[],
  previous: EmploymentRecord,
  triggerBusinessId: string,
): ForwardFieldChange[] {
  const changes: ForwardFieldChange[] = [];
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const restore = (
    field: string,
    current: ForwardFieldChange['before'],
    inherited: ForwardFieldChange['after'],
    read: (payload: EmploymentPayloadRow) => ForwardFieldChange['after'],
  ) => {
    let value = inherited;
    // 用新前驱重放独立更正；忽略移走的源业务传播及以前的派生重建，避免多个迟到源互相留下提前值。
    for (let index = 1; index < history.length; index++) {
      const item = history[index]!;
      if (
        !item.rebase &&
        item.payload.triggerBusinessId !== triggerBusinessId &&
        !equal(read(history[index - 1]!.payload), read(item.payload))
      )
        value = read(item.payload);
    }
    if (!equal(current, value)) changes.push({ field, before: current, after: value });
  };
  for (const field of Object.keys(record.fields) as (keyof typeof record.fields)[])
    restore(field, record.fields[field], previous.fields[field], (payload) => payload.fields[field]);
  for (const id of Object.keys(record.customFields))
    restore(
      `custom:${id}`,
      record.customFields[id] ?? null,
      previous.customFields[id] ?? null,
      (payload) => payload.customFields[id] ?? null,
    );
  return changes;
}
