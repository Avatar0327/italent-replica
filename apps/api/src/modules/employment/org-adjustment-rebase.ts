/** DEC-186 / 195：调动移出旧区间时，派生的组织调整按新前驱重建继承字段，历史载荷不可改写。 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { auditEmployment, requireLinkedEmploymentRecord } from './context.js';
import { applyForwardChanges, type ForwardFieldChange } from './forward-rules.js';
import { personnelHooks } from './personnel-hooks.js';
import { loadEmploymentRecord } from './read-model.js';
import { insertEmploymentRow, rowsOf } from './record-store.js';
import { orgAdjustmentHistory, type AdjustmentHistory } from './org-adjustment-history.js';
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
  const history = await orgAdjustmentHistory(tx, ctx, record);
  const latest = history.at(-1)!.payload;
  const changes = inheritedChanges(record, history, previous);
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
  history: readonly AdjustmentHistory[],
  previous: EmploymentRecord,
): ForwardFieldChange[] {
  const initial = history[0]!.payload;
  const explicit = new Set(initial.explicitFieldCodes);
  // F-006 首个载荷已含本业务主动设置的经理；F-007 纯复制的显式字段为空，只重建其继承值。
  let values = applyForwardChanges(
    previous,
    valueChanges(previous, initial).filter((change) =>
      explicit.has(change.field.startsWith('custom:') ? change.field : `preset:${change.field}`),
    ),
  );
  // 按版本顺序重放有效来源和人工更正；已改期/移出时间线的来源、此前重建均不能恢复提前值。
  for (let index = 1; index < history.length; index++) {
    const item = history[index]!;
    if (!item.replay) continue;
    const source = item.sequenceSource;
    // F-021 的同事务事件区分自动同步和人工更正，无须增加载荷列或修改同步写入口。
    if (source && values.fields[source.sourceKind === 'posts' ? 'postId' : 'positionId'] !== source.sourceId) continue;
    values = applyForwardChanges(values, valueChanges(history[index - 1]!.payload, item.payload));
  }
  return valueChanges(record, values);
}

function valueChanges(
  before: Pick<EmploymentRecord, 'fields' | 'customFields'>,
  after: Pick<EmploymentRecord, 'fields' | 'customFields'>,
): ForwardFieldChange[] {
  const changes: ForwardFieldChange[] = [];
  const add = (field: string, oldValue: ForwardFieldChange['before'], newValue: ForwardFieldChange['after']) => {
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue))
      changes.push({ field, before: oldValue, after: newValue });
  };
  for (const field of Object.keys(before.fields) as (keyof typeof before.fields)[])
    add(field, before.fields[field], after.fields[field]);
  for (const id of new Set([...Object.keys(before.customFields), ...Object.keys(after.customFields)]))
    add(`custom:${id}`, before.customFields[id] ?? null, after.customFields[id] ?? null);
  return changes;
}
