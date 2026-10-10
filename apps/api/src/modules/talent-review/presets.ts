/**
 * 开通租户时的盘点预置（设计 §2.7）：预置盘点字段（编码固定、名称可改、不可删）。与开通的其他预置同一事务写入，
 * 写数据变更日志（系统写入）；可重复执行：已有编码的字段不重复安装。后续子 PR 在这里追加九宫格、表单、映射的预置。
 */
import { and, eq, talentReviewFieldOptions as O, talentReviewFields as F, type Tx } from '@italent/db';
import { TALENT_REVIEW_PRESET_FIELDS } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { registerSeed, type SeedInstallResult, type SeedWriteContext } from '../../seeds/registry.js';
import { codeOf, TALENT_REVIEW_AUDIT_ACTIONS } from './access.js';
import { loadFieldView } from './field-service.js';

async function installFields(tx: Tx, write: SeedWriteContext, missing: readonly string[]): Promise<SeedInstallResult> {
  const created = new Map<string, string>();
  for (const [index, preset] of TALENT_REVIEW_PRESET_FIELDS.entries()) {
    if (!missing.includes(preset.code)) continue;
    const [row] = await tx
      .insert(F)
      .values({
        tenantId: write.tenantId,
        code: preset.code,
        name: preset.name,
        kind: preset.kind,
        group: preset.group,
        preset: true,
        systemWritten: preset.systemWritten,
        pairRole: preset.pairRole ?? null,
        precision: preset.kind === 'number' ? 2 : null,
        sortNo: (index + 1) * 10,
        createdBy: write.actorUserId,
        updatedBy: write.actorUserId,
        createdAt: write.now,
        updatedAt: write.now,
      })
      .returning({ id: F.id });
    created.set(preset.code, row!.id);
    const options = (preset.options ?? []).map((o, i) => ({
      tenantId: write.tenantId,
      fieldId: row!.id,
      ...o,
      sortNo: i + 1,
    }));
    if (options.length > 0) await tx.insert(O).values(options);
  }
  // 成对字段双向回填（同一次安装里两端都是新建的才回填，已有行不改）
  for (const preset of TALENT_REVIEW_PRESET_FIELDS) {
    const id = created.get(preset.code);
    const partner = preset.pairCode ? created.get(preset.pairCode) : undefined;
    if (id && partner) {
      await tx
        .update(F)
        .set({ pairFieldId: partner })
        .where(and(eq(F.tenantId, write.tenantId), eq(F.id, id)));
    }
  }
  for (const id of created.values()) {
    await recordAudit(tx, {
      tenantId: write.tenantId,
      actorUserId: write.actorUserId,
      action: `${TALENT_REVIEW_AUDIT_ACTIONS.field}.create`,
      objectType: codeOf('field'),
      objectId: id,
      before: null,
      after: await loadFieldView(tx, write.tenantId, id),
      commandId: write.commandId,
      occurredAt: write.now,
    });
  }
  // 字段目录变了；版本由 installMissingSeeds 在全部登记项装完后统一推进（锁序 V 最后，契约 §3.4）
  return created.size > 0 ? { catalogChanged: true } : {};
}

registerSeed({
  module: 'talent-review',
  key: 'preset-fields',
  version: 1,
  codes: TALENT_REVIEW_PRESET_FIELDS.map((preset) => preset.code),
  existing: async (tx, tenantId) =>
    new Set((await tx.select({ code: F.code }).from(F).where(eq(F.tenantId, tenantId))).map((row) => row.code)),
  install: installFields,
});
