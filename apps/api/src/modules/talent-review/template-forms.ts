/** 步骤 × 角色 × 用途选用表单，保存时冻结字段三档（设计 §2.3、DEC-306①）。 */
import { and, asc, eq, inArray, talentReviewForms as F, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { FORM, type FormFieldView } from './form-service.js';
import type { StepFormInput } from './template-extra-input.js';
import type { StepView } from './template-view.js';
import { checkTemplateReferences, type TemplateWriteContext } from './template-structure.js';

export interface StepFormView {
  nodeKey: string;
  roleId: string | null;
  purpose: string;
  formId: string;
  formSnapshot: FormFieldView[];
}
const fail = (reason: string) => {
  throw new AppError('VALIDATION_FAILED', '步骤表单选用不合法', { reason });
};
const seatValid = (row: StepFormView | StepFormInput, steps: readonly StepView[]) => {
  const step = steps.find((s) => s.nodeKey === row.nodeKey);
  return (
    step &&
    (step.kind === 'countersign'
      ? step.roles.some((r) => r.roleId === row.roleId)
      : row.roleId === null || row.roleId === undefined)
  );
};

export async function planStepForms(
  tx: Tx,
  ctx: TemplateWriteContext,
  steps: readonly StepView[],
  submitted: readonly StepFormInput[] | undefined,
  previous: readonly StepFormView[],
): Promise<StepFormView[]> {
  // 换流程时只沿用仍存在的席位；旧版本完整保留。
  if (submitted === undefined) return previous.filter((row) => seatValid(row, steps));
  const seats = new Set<string>();
  for (const row of submitted) {
    if (!seatValid(row, steps)) fail('STEP_FORM_SEAT_INVALID');
    const key = JSON.stringify([row.nodeKey, row.roleId ?? null, row.purpose]);
    if (seats.has(key)) fail('STEP_FORM_DUPLICATE');
    seats.add(key);
    if (row.purpose === 'calibrate_edit' && steps.find((s) => s.nodeKey === row.nodeKey)!.stepType !== 'calibrate') {
      fail('STEP_FORM_PURPOSE_INVALID');
    }
  }
  const retained = (row: StepFormInput) =>
    previous.find(
      (old) =>
        old.nodeKey === row.nodeKey &&
        old.roleId === (row.roleId ?? null) &&
        old.purpose === row.purpose &&
        old.formId === row.formId,
    );
  const fresh = new Set(submitted.filter((row) => !retained(row)).map((row) => row.formId));
  const ids = [...new Set(submitted.map((row) => row.formId))].sort();
  // 与 B3 修改表单的头部行锁互斥，保证头部与字段快照来自同一次提交。
  if (ids.length)
    await tx
      .select({ id: F.id })
      .from(F)
      .where(and(eq(F.tenantId, ctx.tenantId), inArray(F.id, ids)))
      .orderBy(asc(F.id))
      .for('share');
  await checkTemplateReferences(tx, ctx, 'form', ids, new Set(ids.filter((id) => !fresh.has(id))));
  const forms = new Map(
    await Promise.all(ids.map(async (id) => [id, (await FORM.load!(tx, ctx.tenantId, id))!] as const)),
  );
  return submitted.map((row) => {
    const form = forms.get(row.formId)!;
    const kinds = {
      info: 'info',
      calibrate_edit: 'calibrate_edit',
      successor_edit: 'succession_edit',
      target_edit: 'succession_edit',
    } as const;
    const kind = kinds[row.purpose];
    if (form.kind !== kind) fail('STEP_FORM_KIND_MISMATCH');
    return { ...row, roleId: row.roleId ?? null, formSnapshot: retained(row)?.formSnapshot ?? form.fields };
  });
}
