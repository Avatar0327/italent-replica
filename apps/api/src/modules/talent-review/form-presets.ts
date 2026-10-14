/**
 * 开通租户时的盘点内容表单预置（设计 §2.7；DEC-361）：员工自评 / 上级评价 / 管理员查看 / 批量盘点可编辑四个表单，
 * 字段集合按预置字段分组与成对角色生成（domain presetFormFields，覆盖全部预置字段，未列出的为 hidden）。
 * 登记在预置字段之后（seeds/index.ts 先收录 presets.ts），所以安装时字段已存在。
 * 可重复执行：已有编码的表单不重复安装、不覆盖租户的定制；名称被租户自建的表单占用时不装并给出原因；写字段级审计（系统写入，DEC-216）。
 */
import {
  eq,
  talentReviewFields as F,
  talentReviewFormFields as FF,
  talentReviewForms as FM,
  type Tx,
} from '@italent/db';
import { presetFormFields, TALENT_REVIEW_PRESET_FORMS } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { registerSeed, type SeedInstallResult, type SeedSkip, type SeedWriteContext } from '../../seeds/registry.js';
import { codeOf, TALENT_REVIEW_AUDIT_ACTIONS } from './access.js';
import { FORM } from './form-service.js';

async function installForms(tx: Tx, write: SeedWriteContext, missing: readonly string[]): Promise<SeedInstallResult> {
  const fields = await tx.select({ id: F.id, code: F.code }).from(F).where(eq(F.tenantId, write.tenantId));
  const idOf = new Map(fields.map((field) => [field.code, field.id]));
  const taken = new Set(
    (await tx.select({ name: FM.name }).from(FM).where(eq(FM.tenantId, write.tenantId))).map((row) => row.name),
  );
  const skipped: SeedSkip[] = [];
  for (const [index, preset] of TALENT_REVIEW_PRESET_FORMS.entries()) {
    if (!missing.includes(preset.code)) continue;
    // 名称租户唯一：被租户自建的表单占用时不覆盖、不撞约束
    if (taken.has(preset.name)) {
      skipped.push({ code: preset.code, reason: 'FORM_NAME_TAKEN' });
      continue;
    }
    const [created] = await tx
      .insert(FM)
      .values({
        tenantId: write.tenantId,
        code: preset.code,
        name: preset.name,
        kind: preset.kind,
        preset: true,
        sortNo: (index + 1) * 10,
        createdBy: write.actorUserId,
        updatedBy: write.actorUserId,
        createdAt: write.now,
        updatedAt: write.now,
      })
      .returning({ id: FM.id });
    const rows = presetFormFields(preset.code).flatMap(({ code, access }, order) => {
      const fieldId = idOf.get(code);
      return fieldId ? [{ tenantId: write.tenantId, formId: created!.id, fieldId, access, sortNo: order + 1 }] : [];
    });
    if (rows.length > 0) await tx.insert(FF).values(rows);
    await recordAudit(tx, {
      tenantId: write.tenantId,
      actorUserId: write.actorUserId,
      action: `${TALENT_REVIEW_AUDIT_ACTIONS.form}.create`,
      objectType: codeOf('form'),
      objectId: created!.id,
      before: null,
      after: await FORM.load!(tx, write.tenantId, created!.id),
      commandId: write.commandId,
      occurredAt: write.now,
    });
  }
  return { skipped };
}

registerSeed({
  module: 'talent-review',
  key: 'preset-forms',
  version: 1,
  codes: TALENT_REVIEW_PRESET_FORMS.map((form) => form.code),
  existing: async (tx, tenantId) =>
    new Set((await tx.select({ code: FM.code }).from(FM).where(eq(FM.tenantId, tenantId))).map((row) => row.code)),
  install: installForms,
});
