/**
 * 开通租户时的九宫格预置（设计 §2.7；DEC-361）：业绩-能力、绩效-潜力两个九宫格（3 × 3 分段，选项值 1 / 2 / 3），
 * 位置字段占用对应的预置位置字段。登记在预置字段之后（seeds/index.ts 先收录 presets.ts），所以安装时字段已存在。
 * 可重复执行：已有编码的九宫格不重复安装、不覆盖租户的定制；写字段级审计（系统写入，DEC-216）。
 */
import {
  eq,
  inArray,
  talentReviewFields as F,
  talentReviewMatrices as M,
  talentReviewMatrixAxisLevels as L,
  talentReviewMatrixCells as C,
  talentReviewMatrixPositionFields as P,
  type Tx,
} from '@italent/db';
import { presetAxisLevels, presetCells, TALENT_REVIEW_PRESET_MATRICES, type PresetMatrix } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { registerSeed, type SeedInstallResult, type SeedSkip, type SeedWriteContext } from '../../seeds/registry.js';
import { codeOf, TALENT_REVIEW_AUDIT_ACTIONS } from './access.js';
import { lockPositionFields, type MatrixShape, presetShapeProblem } from './matrix-service.js';
import { loadMatrixView } from './matrix-view.js';

const fieldCodes = (matrix: PresetMatrix) => [
  matrix.xFieldCode,
  matrix.yFieldCode,
  matrix.positionFieldCodes.before,
  matrix.positionFieldCodes.after,
];

const shapeOf = (preset: PresetMatrix, idOf: (code: string) => string | undefined): MatrixShape | null => {
  const ids = fieldCodes(preset).map(idOf);
  if (ids.some((id) => id === undefined)) return null;
  const [x, y, before, after] = ids as string[];
  return {
    xFieldId: x!,
    yFieldId: y!,
    zFieldId: null,
    positionFields: [
      { role: 'before', fieldId: before! },
      { role: 'after', fieldId: after! },
    ],
    axisLevels: presetAxisLevels().map((level) => ({ ...level, optionValues: [...level.optionValues] })),
    cells: presetCells(preset),
  };
};

/**
 * 预置九宫格依赖的预置字段可能已被存量租户定制（停用、改分组）或位置字段被自建九宫格占用：按普通创建同一套校验判定，
 * 不可用就不装并在结果里给出原因，不覆盖定制、不撞约束（可恢复后再补装）。
 */
async function installMatrices(
  tx: Tx,
  write: SeedWriteContext,
  missing: readonly string[],
): Promise<SeedInstallResult> {
  const presets = TALENT_REVIEW_PRESET_MATRICES.filter((matrix) => missing.includes(matrix.code));
  const fields = await tx
    .select({ id: F.id, code: F.code })
    .from(F)
    .where(inArray(F.code, [...new Set(presets.flatMap(fieldCodes))]));
  const idOf = (code: string) => fields.find((f) => f.code === code)?.id;
  const skipped: SeedSkip[] = [];
  for (const [index, preset] of TALENT_REVIEW_PRESET_MATRICES.entries()) {
    if (!missing.includes(preset.code)) continue;
    const shape = shapeOf(preset, idOf);
    // 位置字段占用锁在核验之前取，核验与插入之间不会被并发的占用插队
    if (shape) {
      await lockPositionFields(
        tx,
        write.tenantId,
        shape.positionFields.map((p) => p.fieldId),
      );
    }
    const problem = shape ? await presetShapeProblem(tx, write.tenantId, shape) : 'MATRIX_FIELD_MISSING';
    if (!shape || problem) {
      skipped.push({ code: preset.code, reason: problem ?? 'MATRIX_FIELD_MISSING' });
      continue;
    }
    const [created] = await tx
      .insert(M)
      .values({
        tenantId: write.tenantId,
        code: preset.code,
        name: preset.name,
        xFieldId: shape.xFieldId,
        yFieldId: shape.yFieldId,
        preset: true,
        sortNo: (index + 1) * 10,
        createdBy: write.actorUserId,
        updatedBy: write.actorUserId,
        createdAt: write.now,
        updatedAt: write.now,
      })
      .returning({ id: M.id });
    const base = { tenantId: write.tenantId, matrixId: created!.id };
    await tx.insert(P).values(shape.positionFields.map((p) => ({ ...base, ...p })));
    await tx.insert(L).values(shape.axisLevels.map((level) => ({ ...base, ...level, lowerBound: null })));
    await tx.insert(C).values(shape.cells.map((cell) => ({ ...base, ...cell })));
    await recordAudit(tx, {
      tenantId: write.tenantId,
      actorUserId: write.actorUserId,
      action: `${TALENT_REVIEW_AUDIT_ACTIONS.matrix}.create`,
      objectType: codeOf('matrix'),
      objectId: created!.id,
      before: null,
      after: await loadMatrixView(tx, write.tenantId, created!.id),
      commandId: write.commandId,
      occurredAt: write.now,
    });
  }
  return { skipped };
}

registerSeed({
  module: 'talent-review',
  key: 'preset-matrices',
  version: 1,
  codes: TALENT_REVIEW_PRESET_MATRICES.map((matrix) => matrix.code),
  existing: async (tx, tenantId) =>
    new Set((await tx.select({ code: M.code }).from(M).where(eq(M.tenantId, tenantId))).map((row) => row.code)),
  install: installMatrices,
});
