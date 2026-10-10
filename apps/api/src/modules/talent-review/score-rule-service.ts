/**
 * 评价规则的读写（设计 §2.2 score_rules / _levels、TR-R20）。在 config-kit.ts 的通用骨架之上加规则自己的跨行规则：
 * - 数值类：最小分 < 最大分，不带等级和显示方式；等级类：至少一个等级、等级名称不重复、下拉或平铺（缺省下拉），不带分值范围；
 * - 类型建后不可改；修改等级整组替换（模板版本保存时整份快照，等级无外部引用）；修改按“合并后的值”重新校验。
 */
import { and, asc, eq, inArray, talentReviewScoreLevels as L, talentReviewScoreRules as R, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import type { ScoreRuleCreate, ScoreRulePatch } from './config-input.js';
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
  id: R.id,
  name: R.name,
  kind: R.kind,
  minScore: R.minScore,
  maxScore: R.maxScore,
  display: R.display,
  allowUnable: R.allowUnable,
  enabled: R.enabled,
  revision: R.revision,
  createdBy: R.createdBy,
  createdAt: R.createdAt,
  updatedBy: R.updatedBy,
  updatedAt: R.updatedAt,
};
export interface ScoreLevelView {
  readonly name: string;
  readonly value: number;
  readonly sortNo: number;
}
export type ScoreRuleView = Omit<typeof R.$inferSelect, 'tenantId'> & { levels: ScoreLevelView[] };

export async function withLevels(tx: Tx, tenantId: string, rows: Omit<ScoreRuleView, 'levels'>[]) {
  if (rows.length === 0) return [];
  const levels = await tx
    .select({ ruleId: L.ruleId, name: L.name, value: L.value, sortNo: L.sortNo })
    .from(L)
    .where(
      and(
        eq(L.tenantId, tenantId),
        inArray(
          L.ruleId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(asc(L.sortNo), asc(L.name));
  return rows.map((r) => ({
    ...r,
    levels: levels.filter((l) => l.ruleId === r.id).map(({ ruleId: _ruleId, ...rest }) => rest),
  }));
}

export const SCORE_RULE: ConfigSpec<ScoreRuleView> = {
  object: 'scoreRule',
  label: '评价规则',
  table: R as unknown as ConfigTable,
  view: row,
  orderBy: [['name', R.name]],
  duplicate: 'SCORE_RULE_DUPLICATE',
  inUse: 'SCORE_RULE_IN_USE',
  load: async (tx, tenantId, id) => {
    const rows = await tx
      .select(row)
      .from(R)
      .where(and(eq(R.tenantId, tenantId), eq(R.id, id)));
    return (await withLevels(tx, tenantId, rows))[0];
  },
};

const invalid = (reason: string, message: string) => new AppError('VALIDATION_FAILED', message, { reason });

interface Shape {
  readonly kind: string;
  readonly minScore?: number | null;
  readonly maxScore?: number | null;
  readonly display?: string | null;
  readonly levels?: readonly { name: string }[];
}

/** 合并后的形状校验：创建时 = 请求体，修改时 = 当前值覆盖上请求体里给出的键。 */
function checkShape(shape: Shape) {
  const levels = shape.levels ?? [];
  if (shape.kind === 'numeric') {
    if (levels.length > 0) throw invalid('SCORE_LEVELS_NOT_ALLOWED', '数值类评价规则不能配置等级');
    if (shape.display != null) throw invalid('SCORE_FIELD_NOT_APPLICABLE', '数值类评价规则没有显示方式');
    const { minScore: min, maxScore: max } = shape;
    if (min == null || max == null || !(max > min)) throw invalid('SCORE_RANGE_INVALID', '最大分必须大于最小分');
    return;
  }
  if (shape.minScore != null || shape.maxScore != null) {
    throw invalid('SCORE_FIELD_NOT_APPLICABLE', '等级类评价规则没有分值范围');
  }
  if (levels.length === 0) throw invalid('SCORE_LEVELS_REQUIRED', '等级类评价规则至少需要一个等级');
  if (new Set(levels.map((l) => l.name)).size !== levels.length) throw invalid('SCORE_LEVEL_DUPLICATE', '等级名称重复');
}

const levelRows = (tenantId: string, ruleId: string, levels: readonly { name: string; value: number }[]) =>
  levels.map((l, index) => ({ tenantId, ruleId, name: l.name, value: l.value, sortNo: index + 1 }));

export function createScoreRule(tx: Tx, ctx: WriteContext, input: ScoreRuleCreate): Promise<ScoreRuleView> {
  const { levels = [], display, ...columns } = input;
  checkShape({ ...input, display });
  return createConfig(
    tx,
    SCORE_RULE,
    ctx,
    { ...columns, display: input.kind === 'grade' ? (display ?? 'dropdown') : null },
    async (id) => {
      if (levels.length > 0) await tx.insert(L).values(levelRows(ctx.tenantId, id, levels));
    },
  );
}

export async function updateScoreRule(
  tx: Tx,
  ctx: WriteContext,
  id: string,
  patch: ScoreRulePatch,
): Promise<ScoreRuleView> {
  await lockConfigRow(tx, SCORE_RULE, ctx, id);
  const before = (await SCORE_RULE.load!(tx, ctx.tenantId, id))!;
  requireSeeAllToRename(ctx, before, patch.name);
  const merged = { ...before, ...patch, levels: patch.levels ?? before.levels };
  if (patch.levels !== undefined && before.kind === 'numeric') {
    throw invalid('SCORE_LEVELS_NOT_ALLOWED', '数值类评价规则不能配置等级');
  }
  checkShape(merged);
  const { levels, ...columns } = patch;
  await uniqueOr(SCORE_RULE.duplicate, SCORE_RULE.label, () =>
    tx
      .update(R)
      .set({ ...columns, revision: ctx.expectedRevision + 1, updatedBy: ctx.userId, updatedAt: ctx.now })
      .where(and(eq(R.tenantId, ctx.tenantId), eq(R.id, id))),
  );
  if (levels !== undefined) {
    await tx.delete(L).where(and(eq(L.tenantId, ctx.tenantId), eq(L.ruleId, id)));
    await tx.insert(L).values(levelRows(ctx.tenantId, id, levels));
  }
  const after = (await SCORE_RULE.load!(tx, ctx.tenantId, id))!;
  await auditConfig(tx, ctx, 'scoreRule', 'update', id, before, after);
  return after;
}
