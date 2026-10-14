/** B6a-2 子表的版本读写；只追加新版本，快照字段使用明确的关系列。 */
import {
  and,
  asc,
  eq,
  inArray,
  type Tx,
  talentReviewTemplateStepForms as S,
  talentReviewTemplateFormFields as SnapshotField,
  talentReviewTemplateResultRules as R,
  talentReviewTemplateResultRefs as RF,
  talentReviewTemplateResultModuleRefs as RM,
} from '@italent/db';
import type { StepFormView } from './template-forms.js';
import type { ResultRuleView } from './template-results.js';
import { registerConfigReferenceGuard } from './config-kit.js';

export async function writeTemplateExtras(
  tx: Tx,
  tenantId: string,
  versionId: string,
  stepIds: ReadonlyMap<string, string>,
  stepForms: readonly StepFormView[],
  resultRules: readonly ResultRuleView[],
) {
  for (const [sortNo, row] of stepForms.entries()) {
    const [saved] = await tx
      .insert(S)
      .values({
        tenantId,
        stepId: stepIds.get(row.nodeKey)!,
        roleId: row.roleId,
        purpose: row.purpose,
        formId: row.formId,
        sortNo,
      })
      .returning({ id: S.id });
    if (row.formSnapshot.length)
      await tx.insert(SnapshotField).values(
        row.formSnapshot.map((field, index) => ({
          ...field,
          tenantId,
          stepFormId: saved!.id,
          sortNo: index,
        })),
      );
  }
  for (const [sortNo, row] of resultRules.entries()) {
    const [saved] = await tx
      .insert(R)
      .values({
        tenantId,
        versionId,
        targetFieldId: row.targetFieldId,
        formula: row.formula,
        priority: row.priority,
        sortNo,
      })
      .returning({ id: R.id });
    if (row.refModuleIds.length)
      await tx.insert(RM).values(row.refModuleIds.map((moduleId) => ({ tenantId, ruleId: saved!.id, moduleId })));
    if (row.refFieldIds.length)
      await tx.insert(RF).values(
        row.refFieldIds.map((fieldId) => ({
          tenantId,
          ruleId: saved!.id,
          fieldId,
        })),
      );
  }
}

export async function loadTemplateExtras(
  tx: Tx,
  tenantId: string,
  versionId: string,
  steps: readonly { id: string; nodeKey: string }[],
) {
  const forms = steps.length
    ? await tx
        .select()
        .from(S)
        .where(
          and(
            eq(S.tenantId, tenantId),
            inArray(
              S.stepId,
              steps.map((s) => s.id),
            ),
          ),
        )
        .orderBy(asc(S.sortNo))
    : [];
  const fields = forms.length
    ? await tx
        .select()
        .from(SnapshotField)
        .where(
          and(
            eq(SnapshotField.tenantId, tenantId),
            inArray(
              SnapshotField.stepFormId,
              forms.map((f) => f.id),
            ),
          ),
        )
        .orderBy(asc(SnapshotField.sortNo))
    : [];
  return {
    stepForms: forms.map((row): StepFormView => ({
      nodeKey: steps.find((s) => s.id === row.stepId)!.nodeKey,
      roleId: row.roleId,
      purpose: row.purpose,
      formId: row.formId,
      formSnapshot: fields
        .filter((f) => f.stepFormId === row.id)
        .map(({ fieldId, access, required }) => ({ fieldId, access, required })),
    })),
    resultRules: await loadResultRules(tx, tenantId, versionId),
  };
}

async function loadResultRules(tx: Tx, tenantId: string, versionId: string): Promise<ResultRuleView[]> {
  const rules = await tx
    .select()
    .from(R)
    .where(and(eq(R.tenantId, tenantId), eq(R.versionId, versionId)))
    .orderBy(asc(R.sortNo));
  const refs = rules.length
    ? await tx
        .select()
        .from(RF)
        .where(
          and(
            eq(RF.tenantId, tenantId),
            inArray(
              RF.ruleId,
              rules.map((r) => r.id),
            ),
          ),
        )
    : [];
  const moduleRefs = rules.length
    ? await tx
        .select()
        .from(RM)
        .where(
          and(
            eq(RM.tenantId, tenantId),
            inArray(
              RM.ruleId,
              rules.map((r) => r.id),
            ),
          ),
        )
    : [];
  return rules.map((row): ResultRuleView => ({
    targetFieldId: row.targetFieldId,
    formula: row.formula,
    priority: row.priority,
    formulaBinding: 'bound',
    refModuleIds: moduleRefs.filter((r) => r.ruleId === row.id).map((r) => r.moduleId),
    refFieldIds: refs.filter((r) => r.ruleId === row.id).map((r) => r.fieldId),
  }));
}

// DEC-387：目标与公式引用都拒删；表单字段即使从源表单移除，历史快照仍持有引用。
registerConfigReferenceGuard('field', async (tx, tenantId, id) => {
  for (const [table, field] of [
    [R, R.targetFieldId],
    [RF, RF.fieldId],
    [SnapshotField, SnapshotField.fieldId],
  ] as const) {
    const rows = await tx
      .select({ tenantId: table.tenantId })
      .from(table)
      .where(and(eq(table.tenantId, tenantId), eq(field, id)))
      .limit(1);
    if (rows.length) return 'TEMPLATE_RESULT_OR_FORM';
  }
  return null;
});

// 任一历史版本的选用都保留引用；不能只查模板当前版本，外键 restrict 继续兜底。
registerConfigReferenceGuard('form', async (tx, tenantId, id) => {
  const rows = await tx
    .select({ id: S.id })
    .from(S)
    .where(and(eq(S.tenantId, tenantId), eq(S.formId, id)))
    .limit(1);
  return rows.length ? 'TEMPLATE_STEP_FORM' : null;
});
