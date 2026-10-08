/**
 * 人才标准分类与人才标准的写入（docs/02_业务建模/23 §2.2；DEC-281）。
 * - 所属人 / 所属管理单元由系统按创建人填写（DEC-294③，建后不可改）；标准的分类须可见；
 * - 引用指标（TC-R2 只存引用）：新引用的指标须在查看人的指标范围内、与所属指标库都已启用（TC-R4），只有能力指标
 *   可设权重与目标（TC-R3）；新增能力引用缺省权重 1，已有引用没传的值保持（DEC-281②）；
 * - 引用行（关联记录）带自己的“指标类别”文本：新增时复制所选指标的库内分类名称——操作人当前看不到指标的
 *   categoryName 就留空（DEC-309），之后可单独修改或经「设置指标类别」批量填写，与库内分类各自独立（DEC-294⑤）；
 * - 新增的关联记录由系统填写所属人 = 添加人、所属管理单元 = 添加人的授权管理单元，不继承标准（DEC-294 补充二）；
 * - 分类下还有标准时不能删除分类（DEC-281⑦ 维持，原站未实测 🟡）；被其他模块引用的标准不能删除。
 */
import {
  and,
  eq,
  inArray,
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
import type {
  CategoryCreate,
  CategoryPatch,
  CriterionCreate,
  CriterionDimensionInput,
  CriterionPatch,
  DimensionCategoryBatch,
} from './input.js';
import { fieldVisible, requireVisible } from './access.js';
import { ownerUnit, relationUnit } from './owner-units.js';
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
  rowsOf,
  type WriteContext,
} from './write-support.js';

const N = talentCriterionCategories;
const C = talentCriteria;

// ---- 人才标准分类 ----

export async function createCategory(tx: Tx, ctx: WriteContext, input: CategoryCreate) {
  const { ownerOrgId: requested, ...fields } = input;
  const ownerOrgId = await ownerUnit(tx, ctx, 'criterionCategory', requested);
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
  const { dimensions = [], ownerOrgId: requested, ...fields } = input;
  const ownerOrgId = await ownerUnit(tx, ctx, 'criterion', requested);
  await referenced(tx, ctx, 'criterionCategory', input.categoryId);
  const checked = await checkReferences(tx, ctx, dimensions, new Map());
  const [row] = await tx
    .insert(C)
    .values({ tenantId: ctx.tenantId, ...fields, ...owned(ctx, ownerOrgId), ...created(ctx) })
    .returning({ id: C.id });
  // 关联记录与标准由同一添加人在同一请求里加入：用同一个所选（或自动填写）的授权管理单元
  await replaceReferences(tx, ctx, row!.id, dimensions, checked, new Map(), ownerOrgId);
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
  const { dimensions, relationOwnerOrgId, ...fields } = patch;
  if (fields.categoryId !== undefined && fields.categoryId !== before.categoryId) {
    await referenced(tx, ctx, 'criterionCategory', fields.categoryId);
  }
  const existing = new Map<string, ExistingReference>(
    before.dimensions.map(({ dimensionId, weight, target }) => [dimensionId, { weight, target }]),
  );
  const checked = dimensions && (await checkReferences(tx, ctx, dimensions, existing));
  const kept = new Map(before.dimensions.map((row) => [row.dimensionId, row]));
  // 新加的关联记录跟添加人（DEC-294 补充二）：没有授权管理单元拒绝，多个时须选一个；传了选择就校验
  const adds = dimensions?.some((item) => !kept.has(item.dimensionId)) ?? false;
  const unit =
    adds || relationOwnerOrgId !== undefined ? await relationUnit(tx, ctx, relationOwnerOrgId) : before.ownerOrgId;
  await tx
    .update(C)
    .set({ ...fields, ...bumped(ctx) })
    .where(and(eq(C.tenantId, ctx.tenantId), eq(C.id, id)));
  if (dimensions && checked) {
    await replaceReferences(tx, ctx, id, dimensions, checked, kept, unit);
  }
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
  readonly category_name: string | null;
}

interface CheckedReferences {
  readonly values: CriterionDimensionValue[];
  /** 选入时复制的库内分类名称（DEC-294⑤）；操作人当前看不到指标的 categoryName 时为空（DEC-309）。 */
  readonly categoryNames: ReadonlyMap<string, string | null>;
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
): Promise<CheckedReferences> {
  const ids = [...new Set(items.map((item) => item.dimensionId))];
  if (!ids.length) return { values: [], categoryNames: new Map() };
  const result = await tx.execute(sql`SELECT d.id, d.enabled, d.owner_org_id, d.owner_id, l.type,
      l.enabled AS library_enabled, c.name AS category_name
    FROM talent_dimensions d JOIN talent_dimension_libraries l ON l.tenant_id = d.tenant_id AND l.id = d.library_id
    LEFT JOIN talent_dimension_categories c ON c.tenant_id = d.tenant_id AND c.id = d.category_id
    WHERE d.tenant_id = ${ctx.tenantId} AND d.id = ANY(${`{${ids.join(',')}}`}::uuid[])
    ORDER BY d.id FOR SHARE OF d, l`);
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
  // 没解析到指标的可见字段就按看不到处理（fail-closed）
  const copyable = 'dimension' in ctx.referenceFields && fieldVisible(ctx.referenceFields.dimension, 'categoryName');
  return {
    values: criterionDimensionValues(items, referenced, existing),
    categoryNames: new Map(rows.map((row) => [row.id, copyable ? row.category_name : null])),
  };
}

const VIOLATION_MESSAGES = {
  DUPLICATE_DIMENSION: '同一人才标准里不能重复引用同一指标',
  DIMENSION_NOT_ENABLED: '只能引用已启用的指标与指标库',
  WEIGHT_TARGET_ABILITY_ONLY: '只有能力指标可以设置权重和目标',
} as const;

/**
 * 整组替换引用行。已有行保留自己的所属人 / 所属管理单元与指标类别（未提交时）；新增行由系统填写所属人
 * （操作人）与所属管理单元，指标类别未提交时复制库内分类名称（DEC-294③⑤）。
 */
async function replaceReferences(
  tx: Tx,
  ctx: WriteContext,
  criterionId: string,
  items: readonly CriterionDimensionInput[],
  checked: CheckedReferences,
  kept: ReadonlyMap<
    string,
    { readonly ownerId: string; readonly ownerOrgId: string; dimensionCategory: string | null }
  >,
  ownerOrgId: string,
) {
  const R = talentCriterionDimensions;
  await tx.delete(R).where(and(eq(R.tenantId, ctx.tenantId), eq(R.criterionId, criterionId)));
  if (!checked.values.length) return;
  const decimal = (value: number | null) => (value === null ? null : value.toFixed(1));
  await tx.insert(R).values(
    checked.values.map((value, index) => {
      const item = items[index]!;
      const previous = kept.get(value.dimensionId);
      const fallback = previous ? previous.dimensionCategory : (checked.categoryNames.get(value.dimensionId) ?? null);
      return {
        tenantId: ctx.tenantId,
        criterionId,
        dimensionId: value.dimensionId,
        weight: decimal(value.weight),
        target: decimal(value.target),
        displayOrder: item.displayOrder ?? index + 1,
        dimensionCategory: item.dimensionCategory === undefined ? fallback : item.dimensionCategory,
        ownerId: previous?.ownerId ?? ctx.userId,
        ownerOrgId: previous?.ownerOrgId ?? ownerOrgId,
      };
    }),
  );
}

/**
 * 「设置指标类别」（DEC-294⑤）：给标准里勾选的指标统一填写类别（null 清空）。按人才标准的编辑处理：行锁 → 范围 →
 * revision，revision + 1，审计记一次标准修改（字段 dimensions）。勾选的指标须都是本标准已引用的。
 */
export async function setDimensionCategory(tx: Tx, ctx: WriteContext, id: string, input: DimensionCategoryBatch) {
  await lockOwned(tx, ctx, 'criterion', id);
  const before = (await loadCriterion(tx, ctx.tenantId, id))!;
  const referencedIds = new Set(before.dimensions.map((row) => row.dimensionId));
  const missing = input.dimensionIds.filter((dimensionId) => !referencedIds.has(dimensionId));
  if (missing.length) {
    throw new AppError('VALIDATION_FAILED', '只能给本标准已引用的指标设置类别', {
      reason: 'DIMENSION_NOT_REFERENCED',
      dimensionIds: missing,
    });
  }
  const R = talentCriterionDimensions;
  await tx
    .update(R)
    .set({ dimensionCategory: input.dimensionCategory })
    .where(and(eq(R.tenantId, ctx.tenantId), eq(R.criterionId, id), inArray(R.dimensionId, input.dimensionIds)));
  await tx
    .update(C)
    .set(bumped(ctx))
    .where(and(eq(C.tenantId, ctx.tenantId), eq(C.id, id)));
  const after = (await loadCriterion(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'criterion', 'update', id, {
    before: auditCriterion(before),
    after: auditCriterion(after),
    orgId: after.ownerOrgId,
  });
  return after;
}

/** 审计只记引用本身（指标 ID、类型、权重、目标、顺序、指标类别、所属），不把指标内容当作标准的字段（TC-R2）。 */
function auditCriterion(view: CriterionView) {
  return { ...view, dimensions: view.dimensions.map(({ dimension: _content, ...reference }) => reference) };
}
