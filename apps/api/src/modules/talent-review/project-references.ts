/** 项目引用（设计 §2.4）：显式选择复核目录范围；共享组织必须属于本租户；新引用须启用，已有停用引用可保留。 */
import {
  and,
  asc,
  eq,
  inArray,
  orgObjects,
  talentCriteria,
  talentReviewCategories as C,
  talentReviewCalcRules as R,
  talentReviewFields as F,
  talentReviewMatrices as M,
  talentReviewRatioRuleGroups as G,
  talentReviewProjects as P,
  talentReviewProjectExcludedCategories as E,
  talentReviewProjectCalibrationFields as CF,
  talentReviewProjectMatrices as PM,
  type Tx,
} from '@italent/db';
import { AppError } from '../../errors.js';
import { notFoundMessage, requireConfigVisible, type ModuleScope } from './access.js';
import {
  configReferrer,
  registerConfigReferenceGuard,
  registerConfigUpdateConstraint,
  type WriteContext,
} from './config-kit.js';
import { isTalentCriterionReferenceable, registerTalentCriterionReferenceGuard } from '../talent/port.js';
import { registerRatioGroupReferenceGuard } from './matrix-service.js';
import type { ProjectPatch } from './project-input.js';
import type { ProjectView } from './project-store.js';

export const PROJECT_REFERENCE_TABLES = { category: C, calcRule: R, matrix: M, field: F };
export type ProjectReference = keyof typeof PROJECT_REFERENCE_TABLES;
export interface ProjectWriteContext extends WriteContext {
  readonly referenceScopes: Partial<Record<ProjectReference, ModuleScope>>;
}
const ids = (xs: readonly (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort();
export const projectReferences = (input: ProjectPatch) => ({
  category: ids([input.categoryId, ...(input.excludedCategoryIds ?? [])]),
  calcRule: ids([input.calcRuleId]),
  matrix: ids((input.matrices ?? []).map((x) => x.matrixId)),
  field: ids((input.calibrationFields ?? []).map((x) => x.fieldId)),
});
export const referenceKinds = (input: ProjectPatch) =>
  (Object.keys(PROJECT_REFERENCE_TABLES) as ProjectReference[]).filter((key) => projectReferences(input)[key].length);

export async function checkProjectReferences(
  tx: Tx,
  ctx: ProjectWriteContext,
  input: ProjectPatch,
  before?: ProjectView,
  replay = false,
) {
  const criterionId = input.criterionId === undefined ? before?.criterionId : input.criterionId;
  if (criterionId) {
    // 与标准修改 / 删除的 FOR UPDATE 冲突；同事务内读当前启用状态后才能写项目。
    await tx
      .select({ id: talentCriteria.id })
      .from(talentCriteria)
      .where(and(eq(talentCriteria.tenantId, ctx.tenantId), eq(talentCriteria.id, criterionId)))
      .for('share');
    if (!replay && !(await isTalentCriterionReferenceable(tx, ctx.tenantId, criterionId))) {
      throw new AppError('VALIDATION_FAILED', '人才标准不存在或已停用，不能引用', {
        reason: 'CRITERION_NOT_REFERENCEABLE',
      });
    }
  }
  const refs = projectReferences(input);
  const held = projectReferences(before ?? {});
  for (const key of referenceKinds(input)) {
    const table = PROJECT_REFERENCE_TABLES[key];
    const rows = await tx
      .select({ id: table.id, enabled: table.enabled, createdBy: table.createdBy })
      .from(table)
      .where(and(eq(table.tenantId, ctx.tenantId), inArray(table.id, refs[key])))
      .orderBy(asc(table.id))
      .for('share');
    for (const id of refs[key]) {
      const found = rows.find((row) => row.id === id);
      if (!found) throw new AppError('NOT_FOUND', notFoundMessage(key));
      requireConfigVisible(ctx.referenceScopes[key]!, key, found.createdBy);
      if (!replay && !found.enabled && !held[key].includes(id)) {
        throw new AppError('VALIDATION_FAILED', '不能新增停用配置引用', { reason: 'PROJECT_REFERENCE_DISABLED' });
      }
    }
  }
  const orgIds = ids([input.ownerOrgId, ...(input.sharedOrgIds ?? [])]);
  if (orgIds.length) {
    const rows = await tx
      .select({ id: orgObjects.id })
      .from(orgObjects)
      .where(and(eq(orgObjects.tenantId, ctx.tenantId), inArray(orgObjects.id, orgIds)))
      .for('key share');
    if (rows.length !== orgIds.length) throw new AppError('NOT_FOUND', notFoundMessage('project'));
  }
  if (!replay && refs.field.length) {
    const fields = await tx
      .select({ group: F.group })
      .from(F)
      .where(and(eq(F.tenantId, ctx.tenantId), inArray(F.id, refs.field)));
    if (fields.some((x) => x.group !== 'calibration')) {
      throw new AppError('VALIDATION_FAILED', '校准原因只能选择校准分组字段', {
        reason: 'PROJECT_CALIBRATION_FIELD_INVALID',
      });
    }
  }
}

/** TR-R7：缺省配置是系统带入全部启用九宫格，非人工提交的目录引用；锁住九宫格，避免规则组被并发删除。 */
export async function defaultProjectMatrices(tx: Tx, tenantId: string) {
  const rows = await tx
    .select({ id: M.id })
    .from(M)
    .where(and(eq(M.tenantId, tenantId), eq(M.enabled, true)))
    .orderBy(asc(M.sortNo), asc(M.id))
    .for('share');
  return resolveProjectMatrices(
    tx,
    tenantId,
    rows.map((row) => ({ matrixId: row.id })),
  );
}
export async function resolveProjectMatrices(
  tx: Tx,
  tenantId: string,
  matrices: NonNullable<ProjectPatch['matrices']>,
) {
  const result = [];
  for (const [index, matrix] of matrices.entries()) {
    const groups = await tx
      .select({ id: G.id, isDefault: G.isDefault })
      .from(G)
      .where(and(eq(G.tenantId, tenantId), eq(G.matrixId, matrix.matrixId)))
      .orderBy(asc(G.id))
      .for('share');
    const ratioGroupId =
      matrix.ratioGroupId === undefined ? (groups.find((g) => g.isDefault)?.id ?? null) : matrix.ratioGroupId;
    if (ratioGroupId && !groups.some((g) => g.id === ratioGroupId)) {
      throw new AppError('VALIDATION_FAILED', '比例规则组不属于所选九宫格', { reason: 'PROJECT_MATRIX_GROUP_INVALID' });
    }
    result.push({ matrixId: matrix.matrixId, ratioGroupId, sortNo: matrix.sortNo ?? index });
  }
  return result;
}

// 设计 §2.4 TR-R38：引用写持字段共享锁，改组持排他锁；等待提交后在同一事务复核，避免留下无法原样保存的配置。
registerConfigUpdateConstraint('field', async (tx, tenantId, id, patch) => {
  if (patch.group === undefined || patch.group === 'calibration') return;
  const [reference] = await tx
    .select({ id: CF.projectId })
    .from(CF)
    .where(and(eq(CF.tenantId, tenantId), eq(CF.fieldId, id)))
    .limit(1);
  if (reference) {
    throw new AppError('CONFLICT', '字段已被项目选为校准原因，不能改离校准分组', {
      reason: 'FIELD_GROUP_BREAKS_PROJECT',
    });
  }
});

// 被引用配置的删除与保存引用在同一行锁上串行，避免悬空引用或外键错误落成 503。
registerConfigReferenceGuard('category', async (tx, tenantId, id) => {
  const [head] = await tx
    .select({ id: P.id })
    .from(P)
    .where(and(eq(P.tenantId, tenantId), eq(P.categoryId, id)))
    .limit(1);
  const [excluded] = await tx
    .select({ id: E.projectId })
    .from(E)
    .where(and(eq(E.tenantId, tenantId), eq(E.categoryId, id)))
    .limit(1);
  return head || excluded ? 'PROJECT' : null;
});
for (const [kind, table, column] of [
  ['calcRule', P, P.calcRuleId],
  ['field', CF, CF.fieldId],
  ['matrix', PM, PM.matrixId],
] as const)
  registerConfigReferenceGuard(kind, async (tx, tenantId, id) => {
    const [row] = await tx
      .select({ tenantId: table.tenantId })
      .from(table)
      .where(and(eq(table.tenantId, tenantId), eq(column, id)))
      .limit(1);
    return row ? 'PROJECT' : null;
  });
registerRatioGroupReferenceGuard(async (tx, tenantId, groupId) => {
  const [row] = await tx
    .select({ id: PM.projectId })
    .from(PM)
    .where(and(eq(PM.tenantId, tenantId), eq(PM.ratioGroupId, groupId)))
    .limit(1);
  return row ? 'PROJECT' : null;
});

// 人才模块端口仅作桥接；项目拒删仍登记在 B7a 的统一配置引用入口，锁序为项目 → 来源标准。
registerConfigReferenceGuard('criterion', async (tx, tenantId, id) => {
  const [row] = await tx
    .select({ id: P.id })
    .from(P)
    .where(and(eq(P.tenantId, tenantId), eq(P.criterionId, id)))
    .limit(1);
  return row ? 'TALENT_REVIEW_PROJECT' : null;
});
registerTalentCriterionReferenceGuard((tx, tenantId, id) => configReferrer(tx, tenantId, 'criterion', id));
// §5.1 / §7：项目保存须引用启用标准，禁止属性修改使已有项目配置失效；先持来源排他锁再询问引用。
registerConfigUpdateConstraint('criterion', async (tx, tenantId, id, patch) => {
  if (patch.enabled !== false) return;
  if (await configReferrer(tx, tenantId, 'criterion', id)) {
    throw new AppError('CONFLICT', '人才标准被盘点项目引用，停用会使项目配置失效', {
      reason: 'CRITERION_DISABLE_BREAKS_PROJECT',
    });
  }
});
