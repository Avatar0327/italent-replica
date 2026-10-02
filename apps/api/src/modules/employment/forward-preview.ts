import type { Tx } from '@italent/db';
import { emptyPresetFields, type EmploymentBusinessInput, type EmploymentContext } from './types.js';
import { normalizeEmploymentInput } from './fields.js';
import { prepareInheritance, resolveEffectiveInheritance } from './inheritance.js';
import { lockEmploymentEmployee } from './record-store.js';
import { validateEmploymentReferences } from './references.js';
import { selectEmploymentCycle, NEW_CYCLE_KINDS } from './write-service.js';
import { forwardUpdateEmployment } from './forward-update.js';

/** 只读预览取得员工锁以保证多条查询一致；不创建命令、payload、审计或 outbox。 */
export async function previewEmploymentForwardUpdate(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  input: EmploymentBusinessInput,
) {
  const normalized = normalizeEmploymentInput(ctx, input);
  const employee = await lockEmploymentEmployee(tx, ctx, employeeId);
  if (NEW_CYCLE_KINDS.includes(normalized.kind))
    return { employeeRevision: employee.revision, changes: [], skipped: [] };
  const selected = await selectEmploymentCycle(tx, ctx, employeeId, normalized);
  const prepared = await prepareInheritance(tx, ctx, { ...normalized, employeeId, staffId: selected.cycle.id });
  const resolved = await resolveEffectiveInheritance(tx, ctx, prepared, {
    staffId: selected.cycle.id,
    predecessor: selected.predecessor,
  });
  const after = { ...resolved, fields: { ...resolved.fields, jobNumber: employee.code } };
  await validateEmploymentReferences(tx, ctx, after.fields, normalized.effectiveDate);
  const plan = await forwardUpdateEmployment(
    tx,
    ctx,
    {
      employeeId,
      staffId: selected.cycle.id,
      effectiveDate: normalized.effectiveDate,
      before:
        selected.predecessor?.staffId === selected.cycle.id
          ? selected.predecessor
          : { fields: emptyPresetFields(), customFields: {} },
      after,
    },
    true,
  );
  return { employeeRevision: employee.revision, ...plan };
}
