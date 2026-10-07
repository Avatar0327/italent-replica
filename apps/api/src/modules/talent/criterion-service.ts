/**
 * 人才标准分类与人才标准的写入（docs/02_业务建模/23 §2.2；DEC-281）。
 * - 都挂所属管理单元（建后不可改）；标准的分类须可见；
 * - 引用指标（TC-R2 只存引用）：新引用的指标须在查看人的指标范围内、与所属指标库都已启用（TC-R4），只有能力指标
 *   可设权重与目标（TC-R3）；新增能力引用缺省权重 1，已有引用没传的值保持（DEC-281②）；
 * - 分类下还有标准时不能删除分类（DEC-281⑦ 维持，原站未实测 🟡）；被其他模块引用的标准不能删除。
 */
import {
  and,
  eq,
  sql,
  talentCriteria,
  talentCriterionCategories,
  talentCriterionDimensions,
  type Tx,
} from '@italent/db';
import {
  criterionDimensionValues,
  criterionDimensionViolation,
  type CriterionDimensionValue,
  type ExistingReference,
  type ReferencedDimension,
  type TalentDimensionType,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { requireVisible } from './access.js';
import type {
  CategoryCreate,
  CategoryPatch,
  CriterionCreate,
  CriterionDimensionInput,
  CriterionPatch,
} from './input.js';
import { loadCategory, loadCriterion, type CriterionView } from './read-model.js';
import { criterionReferrer } from './references.js';
import {
  audit,
  bumped,
  created,
  lockOwned,
  owned,
  referenced,
  rejectInUse,
  requireOwnerOrg,
  rowsOf,
  type WriteContext,
} from './write-support.js';

const N = talentCriterionCategories;
const C = talentCriteria;

// ---- 人才标准分类 ----

export async function createCategory(tx: Tx, ctx: WriteContext, input: CategoryCreate) {
  await requireOwnerOrg(tx, ctx, 'criterionCategory', input.ownerOrgId);
  const { ownerOrgId, ...fields } = input;
  const [row] = await tx
    .insert(N)
    .values({ tenantId: ctx.tenantId, ...fields, ...owned(ctx, ownerOrgId), ...created(ctx) })
    .returning({ id: N.id });
  const after = (await loadCategory(tx, ctx.tenantId, row!.id))!;
  await audit(tx, ctx, 'criterionCategory', 'create', after.id, { before: null, after, orgId: after.ownerOrgId });
  return after;
}

export async function updateCategory(tx: Tx, ctx: WriteContext, id: string, patch: CategoryPatch) {
  await lockOwned(tx, ctx, 'criterionCategory', id);
  const before = (await loadCategory(tx, ctx.tenantId, id))!;
  await tx
    .update(N)
    .set({ ...patch, ...bumped(ctx) })
    .where(and(eq(N.tenantId, ctx.tenantId), eq(N.id, id)));
  const after = (await loadCategory(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'criterionCategory', 'update', id, { before, after, orgId: after.ownerOrgId });
  return after;
}

/** DEC-281⑦：分类下还有人才标准时不能删除（外键 RESTRICT 兜底）。 */
export async function deleteCategory(tx: Tx, ctx: WriteContext, id: string) {
  await lockOwned(tx, ctx, 'criterionCategory', id);
  await rejectInUse(tx, ctx, {
    table: 'talent_criteria',
    column: 'category_id',
    id,
    reason: 'CATEGORY_HAS_CRITERIA',
    message: '分类下还有人才标准，不能删除',
  });
  const before = (await loadCategory(tx, ctx.tenantId, id))!;
  await tx.delete(N).where(and(eq(N.tenantId, ctx.tenantId), eq(N.id, id)));
  await audit(tx, ctx, 'criterionCategory', 'delete', id, { before, after: null, orgId: before.ownerOrgId });
  return before;
}

// ---- 人才标准 ----

export async function createCriterion(tx: Tx, ctx: WriteContext, input: CriterionCreate) {
  await requireOwnerOrg(tx, ctx, 'criterion', input.ownerOrgId);
  await referenced(tx, ctx, 'criterionCategory', input.categoryId);
  const { dimensions = [], ownerOrgId, ...fields } = input;
  const values = await checkReferences(tx, ctx, dimensions, new Map());
  const [row] = await tx
    .insert(C)
    .values({ tenantId: ctx.tenantId, ...fields, ...owned(ctx, ownerOrgId), ...created(ctx) })
    .returning({ id: C.id });
  await replaceReferences(tx, ctx.tenantId, row!.id, dimensions, values);
  const after = (await loadCriterion(tx, ctx.tenantId, row!.id))!;
  await audit(tx, ctx, 'criterion', 'create', after.id, {
    before: null,
    after: auditCriterion(after),
    orgId: after.ownerOrgId,
  });
  return after;
}

export async function updateCriterion(tx: Tx, ctx: WriteContext, id: string, patch: CriterionPatch) {
  await lockOwned(tx, ctx, 'criterion', id);
  const before = (await loadCriterion(tx, ctx.tenantId, id))!;
  const { dimensions, ...fields } = patch;
  if (fields.categoryId !== undefined && fields.categoryId !== before.categoryId) {
    await referenced(tx, ctx, 'criterionCategory', fields.categoryId);
  }
  const existing = new Map<string, ExistingReference>(
    before.dimensions.map(({ dimensionId, weight, target }) => [dimensionId, { weight, target }]),
  );
  const values = dimensions && (await checkReferences(tx, ctx, dimensions, existing));
  await tx
    .update(C)
    .set({ ...fields, ...bumped(ctx) })
    .where(and(eq(C.tenantId, ctx.tenantId), eq(C.id, id)));
  if (dimensions && values) await replaceReferences(tx, ctx.tenantId, id, dimensions, values);
  const after = (await loadCriterion(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'criterion', 'update', id, {
    before: auditCriterion(before),
    after: auditCriterion(after),
    orgId: after.ownerOrgId,
  });
  return after;
}

export async function deleteCriterion(tx: Tx, ctx: WriteContext, id: string) {
  await lockOwned(tx, ctx, 'criterion', id);
  const referrer = await criterionReferrer(tx, ctx.tenantId, id);
  if (referrer) {
    throw new AppError('CONFLICT', '人才标准已被引用，不能删除', { reason: 'CRITERION_REFERENCED', referrer });
  }
  const before = (await loadCriterion(tx, ctx.tenantId, id))!;
  await tx.delete(C).where(and(eq(C.tenantId, ctx.tenantId), eq(C.id, id)));
  await audit(tx, ctx, 'criterion', 'delete', id, {
    before: auditCriterion(before),
    after: null,
    orgId: before.ownerOrgId,
  });
  return before;
}

interface DimensionStateRow {
  readonly id: string;
  readonly enabled: boolean;
  readonly owner_org_id: string;
  readonly owner_id: string;
  readonly type: TalentDimensionType;
  readonly library_enabled: boolean;
}

/**
 * 引用的指标：先对指标与所属指标库加共享锁再读状态（与停用 / 删除串行，TC-R4 / R5），再按领域规则判定并算出
 * 每行保存的权重与目标。新增引用的指标须在查看人的指标范围内；已有引用不重新判定范围与启用状态（DEC-281⑧）。
 */
async function checkReferences(
  tx: Tx,
  ctx: WriteContext,
  items: readonly CriterionDimensionInput[],
  existing: ReadonlyMap<string, ExistingReference>,
): Promise<CriterionDimensionValue[]> {
  const ids = [...new Set(items.map((item) => item.dimensionId))];
  if (!ids.length) return [];
  const result = await tx.execute(sql`SELECT d.id, d.enabled, d.owner_org_id, d.owner_id, l.type,
      l.enabled AS library_enabled
    FROM talent_dimensions d JOIN talent_dimension_libraries l ON l.tenant_id = d.tenant_id AND l.id = d.library_id
    WHERE d.tenant_id = ${ctx.tenantId} AND d.id = ANY(${`{${ids.join(',')}}`}::uuid[])
    ORDER BY d.id FOR SHARE`);
  const rows = rowsOf<DimensionStateRow>(result);
  const found = new Map(rows.map((row) => [row.id, row]));
  const fresh = ids.filter((id) => !existing.has(id));
  if (fresh.length && ctx.references.dimension === null) throw new AppError('FORBIDDEN', '无权查看指标');
  for (const id of fresh) {
    const row = found.get(id);
    if (!row) throw new AppError('NOT_FOUND', '指标不存在');
    requireVisible(ctx.references.dimension!, 'dimension', { orgId: row.owner_org_id, ownerId: row.owner_id });
  }
  const referenced = new Map<string, ReferencedDimension>(
    rows.map((row) => [
      row.id,
      { id: row.id, type: row.type, enabled: row.enabled, libraryEnabled: row.library_enabled },
    ]),
  );
  const violation = criterionDimensionViolation(items, referenced, new Set(existing.keys()));
  if (violation) throw new AppError('VALIDATION_FAILED', VIOLATION_MESSAGES[violation.reason], violation);
  return criterionDimensionValues(items, referenced, existing);
}

const VIOLATION_MESSAGES = {
  DUPLICATE_DIMENSION: '同一人才标准里不能重复引用同一指标',
  DIMENSION_NOT_ENABLED: '只能引用已启用的指标与指标库',
  WEIGHT_TARGET_ABILITY_ONLY: '只有能力指标可以设置权重和目标',
} as const;

async function replaceReferences(
  tx: Tx,
  tenantId: string,
  criterionId: string,
  items: readonly CriterionDimensionInput[],
  values: readonly CriterionDimensionValue[],
) {
  const R = talentCriterionDimensions;
  await tx.delete(R).where(and(eq(R.tenantId, tenantId), eq(R.criterionId, criterionId)));
  if (!values.length) return;
  const decimal = (value: number | null) => (value === null ? null : value.toFixed(1));
  await tx.insert(R).values(
    values.map((value, index) => ({
      tenantId,
      criterionId,
      dimensionId: value.dimensionId,
      weight: decimal(value.weight),
      target: decimal(value.target),
      displayOrder: items[index]!.displayOrder ?? index + 1,
    })),
  );
}

/** 审计只记引用本身（指标 ID、类型、权重、目标、顺序），不把指标内容当作标准的字段（TC-R2）。 */
function auditCriterion(view: CriterionView) {
  return { ...view, dimensions: view.dimensions.map(({ dimension: _content, ...reference }) => reference) };
}
