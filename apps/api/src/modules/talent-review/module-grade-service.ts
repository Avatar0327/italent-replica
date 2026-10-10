/**
 * 模块等级的读写（设计 §2.2 module_grades / _items、§4.2、TR-R15 / R20）。等级项两种口径二选一——得分区间（含下界不含上界，
 * 最后一段含上界）或按指标数目的门槛；口径不混用、区间不重叠、名称与值不重复由领域函数 gradeItemsProblem 判定
 * （算分匹配 matchModuleGradeByScore / ByCount 用同一份约定）。修改等级项整组替换（模板版本保存时整份快照，无外部引用）。
 */
import {
  and,
  asc,
  eq,
  inArray,
  talentReviewModuleGradeItems as I,
  talentReviewModuleGrades as G,
  type Tx,
} from '@italent/db';
import { gradeItemsProblem } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { ModuleGradeCreate, ModuleGradePatch } from './config-input.js';
import {
  auditConfig,
  type ConfigSpec,
  type ConfigTable,
  createConfig,
  lockConfigRow,
  requireSeeAllToRename,
  uniqueOr,
  type WriteContext,
} from './config-kit.js';

const row = {
  id: G.id,
  name: G.name,
  enabled: G.enabled,
  revision: G.revision,
  createdBy: G.createdBy,
  createdAt: G.createdAt,
  updatedBy: G.updatedBy,
  updatedAt: G.updatedAt,
};
export interface GradeItemView {
  readonly name: string;
  readonly value: string;
  readonly sortNo: number;
  readonly minScore: number | null;
  readonly maxScore: number | null;
  readonly minCount: number | null;
}
export type ModuleGradeView = Omit<typeof G.$inferSelect, 'tenantId'> & {
  /** 派生：等级项的口径（得分区间 / 按指标数目），请求不可写。 */
  mode: 'score' | 'count';
  items: GradeItemView[];
};

export async function withItems(tx: Tx, tenantId: string, rows: Omit<ModuleGradeView, 'items' | 'mode'>[]) {
  if (rows.length === 0) return [];
  const items = await tx
    .select({
      gradeId: I.gradeId,
      name: I.name,
      value: I.value,
      sortNo: I.sortNo,
      minScore: I.minScore,
      maxScore: I.maxScore,
      minCount: I.minCount,
    })
    .from(I)
    .where(
      and(
        eq(I.tenantId, tenantId),
        inArray(
          I.gradeId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(asc(I.sortNo), asc(I.name));
  return rows.map((r) => {
    const own = items.filter((i) => i.gradeId === r.id).map(({ gradeId: _gradeId, ...rest }) => rest);
    return { ...r, mode: own[0]?.minCount != null ? ('count' as const) : ('score' as const), items: own };
  });
}

export const MODULE_GRADE: ConfigSpec<ModuleGradeView> = {
  object: 'moduleGrade',
  label: '模块等级',
  table: G as unknown as ConfigTable,
  view: row,
  orderBy: [['name', G.name]],
  duplicate: 'MODULE_GRADE_DUPLICATE',
  inUse: 'MODULE_GRADE_IN_USE',
  load: async (tx, tenantId, id) => {
    const rows = await tx
      .select(row)
      .from(G)
      .where(and(eq(G.tenantId, tenantId), eq(G.id, id)));
    return (await withItems(tx, tenantId, rows))[0];
  },
};

type ItemInput = ModuleGradeCreate['items'][number];
function checkItems(items: readonly ItemInput[]) {
  const problem = gradeItemsProblem(items);
  if (problem) throw new AppError('VALIDATION_FAILED', '模块等级的等级项不合法', { reason: problem });
}
const itemRows = (tenantId: string, gradeId: string, items: readonly ItemInput[]) =>
  items.map((item, index) => ({
    tenantId,
    gradeId,
    name: item.name,
    value: item.value,
    sortNo: index + 1,
    // 口径已在 gradeItemsProblem 校验为二选一，这里原样落库，不再悄悄丢弃任何一种
    minScore: item.minScore ?? null,
    maxScore: item.maxScore ?? null,
    minCount: item.minCount ?? null,
  }));

export function createModuleGrade(tx: Tx, ctx: WriteContext, input: ModuleGradeCreate): Promise<ModuleGradeView> {
  const { items, ...columns } = input;
  checkItems(items);
  return createConfig(tx, MODULE_GRADE, ctx, columns, async (id) => {
    await tx.insert(I).values(itemRows(ctx.tenantId, id, items));
  });
}

export async function updateModuleGrade(
  tx: Tx,
  ctx: WriteContext,
  id: string,
  patch: ModuleGradePatch,
): Promise<ModuleGradeView> {
  await lockConfigRow(tx, MODULE_GRADE, ctx, id);
  const before = (await MODULE_GRADE.load!(tx, ctx.tenantId, id))!;
  requireSeeAllToRename(ctx, before, patch.name);
  const { items, ...columns } = patch;
  if (items !== undefined) checkItems(items);
  await uniqueOr(MODULE_GRADE.duplicate, MODULE_GRADE.label, () =>
    tx
      .update(G)
      .set({ ...columns, revision: ctx.expectedRevision + 1, updatedBy: ctx.userId, updatedAt: ctx.now })
      .where(and(eq(G.tenantId, ctx.tenantId), eq(G.id, id))),
  );
  if (items !== undefined) {
    await tx.delete(I).where(and(eq(I.tenantId, ctx.tenantId), eq(I.gradeId, id)));
    await tx.insert(I).values(itemRows(ctx.tenantId, id, items));
  }
  const after = (await MODULE_GRADE.load!(tx, ctx.tenantId, id))!;
  await auditConfig(tx, ctx, 'moduleGrade', 'update', id, before, after);
  return after;
}
