import type { Tx } from '@italent/db';
import { requireEmploymentScope } from './context.js';
import { emptyPresetFields, type EmploymentBusinessInput, type EmploymentContext } from './types.js';
import { normalizeEmploymentInput } from './fields.js';
import { prepareInheritance, resolveEffectiveInheritance } from './inheritance.js';
import { readEmploymentEmployee } from './record-store.js';
import { validateEmploymentReferences } from './references.js';
import { editedValues } from './record-edit.js';
import { loadEmploymentRecord } from './read-model.js';
import { isForwardEditSupported } from './forward-rules.js';
import { AppError } from '../../errors.js';
import type { EmploymentBusinessPatch } from './types.js';
import { tenantLocalDate } from '@italent/domain';
import { selectEmploymentCycle, NEW_CYCLE_KINDS } from './write-service.js';
import { assertNotBeforeCurrentCycle } from './cycles.js';
import { forwardUpdateEmployment } from './forward-update.js';

/** 只读预览依赖事务快照；不加行锁，不创建命令、payload、审计或 outbox。 */
export async function previewEmploymentForwardUpdate(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  input: EmploymentBusinessInput,
) {
  const normalized = normalizeEmploymentInput(ctx, input);
  const employee = await readEmploymentEmployee(tx, ctx, employeeId);
  requireEmploymentScope(ctx, employeeId);
  if (normalized.fields.departmentId !== undefined)
    requireEmploymentScope(ctx, employeeId, normalized.fields.departmentId);
  await assertNotBeforeCurrentCycle(tx, ctx, employeeId, normalized);
  if (NEW_CYCLE_KINDS.includes(normalized.kind))
    return { employeeRevision: employee.revision, changes: [], skipped: [], wholeRecordSkips: [] };
  const selected = await selectEmploymentCycle(tx, ctx, employeeId, normalized);
  const prepared = await prepareInheritance(tx, ctx, { ...normalized, employeeId, staffId: selected.cycle.id });
  const resolved = await resolveEffectiveInheritance(tx, ctx, prepared, {
    staffId: selected.cycle.id,
    predecessor: selected.predecessor,
  });
  const after = { ...resolved, fields: { ...resolved.fields, jobNumber: employee.code } };
  requireEmploymentScope(ctx, employeeId, after.fields.departmentId);
  await validateEmploymentReferences(tx, ctx, after.fields, normalized.effectiveDate);
  const plan = await forwardUpdateEmployment(
    tx,
    ctx,
    {
      employeeId,
      staffId: selected.cycle.id,
      effectiveDate: normalized.effectiveDate,
      evaluationDate: normalized.mode === 'application' ? normalized.effectiveDate : undefined,
      before:
        selected.predecessor?.staffId === selected.cycle.id
          ? selected.predecessor
          : { fields: emptyPresetFields(), customFields: {} },
      after,
    },
    true,
  );
  return {
    employeeRevision: employee.revision,
    ...plan,
    ...(normalized.mode === 'application' ? { notice: '结果以生效时为准' } : {}),
  };
}

export async function previewEmploymentEditForwardUpdate(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  input: EmploymentBusinessPatch,
) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const record = await loadEmploymentRecord(tx, ctx.tenantId, id, today, ctx.scope);
  if (!record) throw new AppError('CONFLICT', '只能预览有效任职记录的编辑');
  const after = await editedValues(tx, ctx, record, input);
  await validateEmploymentReferences(tx, ctx, after.fields, record.effectiveDate);
  if (!isForwardEditSupported({ ...record, entry: 'import', today }))
    return { changes: [], skipped: [], wholeRecordSkips: [] };
  return forwardUpdateEmployment(
    tx,
    ctx,
    {
      employeeId: record.employeeId,
      businessId: record.id,
      staffId: record.staffId,
      effectiveDate: record.effectiveDate,
      before: record,
      after,
    },
    true,
  );
}
