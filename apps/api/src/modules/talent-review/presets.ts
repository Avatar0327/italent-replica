/**
 * 开通租户时的盘点预置（设计 §2.7）：预置盘点字段（编码固定、名称可改、不可删）。与开通的其他预置同一事务写入，
 * 写数据变更日志（系统写入）；可重复执行：已有编码的字段不重复安装。后续子 PR 在这里追加九宫格、表单、映射的预置。
 */
import {
  and,
  eq,
  talentReviewFieldMappings as M,
  talentReviewFieldOptions as O,
  talentReviewFields as F,
  type Tx,
} from '@italent/db';
import { TALENT_REVIEW_PRESET_FIELDS } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { registerSeed, type SeedInstallResult, type SeedWriteContext } from '../../seeds/registry.js';
import { codeOf, TALENT_REVIEW_AUDIT_ACTIONS } from './access.js';
import { loadFieldView } from './field-service.js';
import { MAPPING } from './mapping-service.js';

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

const MAPPING_CODES = ['carry_last:tags'];
const MAPPING_TAGS = 'tags';
registerSeed({
  module: 'talent-review',
  key: 'preset-field-mappings',
  version: 1,
  codes: MAPPING_CODES,
  // 租户已有同一对“标签 → 标签”映射就算已有——不论 preset：租户可能手工建过，补装既不重复插入（撞唯一约束）也不覆盖其记录
  existing: async (tx, tenantId) => {
    const rows = await tx
      .select({ id: M.id })
      .from(M)
      .innerJoin(F, and(eq(F.tenantId, M.tenantId), eq(F.id, M.sourceFieldId)))
      .where(
        and(
          eq(M.tenantId, tenantId),
          eq(M.scene, 'carry_last'),
          eq(M.targetFieldId, M.sourceFieldId),
          eq(F.code, MAPPING_TAGS),
        ),
      );
    return new Set(rows.length > 0 ? MAPPING_CODES : []);
  },
  // TR-R9：预置一条“标签 → 标签”映射（来源 = 目标 = 预置字段 tags，同一字段）。依赖的字段缺失 / 已被租户停用时不装，
  // 以 skipped 返回受控原因（与手工新建映射的“停用字段不可新引用”同一口径）
  install: async (tx, write) => {
    const [tags] = await tx
      .select({ id: F.id, enabled: F.enabled })
      .from(F)
      .where(and(eq(F.tenantId, write.tenantId), eq(F.code, MAPPING_TAGS)));
    if (!tags) return { skipped: [{ code: MAPPING_CODES[0]!, reason: 'MAPPING_FIELD_MISSING' }] };
    if (!tags.enabled) return { skipped: [{ code: MAPPING_CODES[0]!, reason: 'MAPPING_FIELD_DISABLED' }] };
    const [row] = await tx
      .insert(M)
      .values({
        tenantId: write.tenantId,
        scene: 'carry_last',
        sourceFieldId: tags.id,
        targetFieldId: tags.id,
        preset: true,
        createdBy: write.actorUserId,
        updatedBy: write.actorUserId,
        createdAt: write.now,
        updatedAt: write.now,
      })
      .returning({ id: M.id });
    await recordAudit(tx, {
      tenantId: write.tenantId,
      actorUserId: write.actorUserId,
      action: `${TALENT_REVIEW_AUDIT_ACTIONS.mapping}.create`,
      objectType: codeOf('mapping'),
      objectId: row!.id,
      before: null,
      after: (await MAPPING.load!(tx, write.tenantId, row!.id))!,
      commandId: write.commandId,
      occurredAt: write.now,
    });
  },
});
