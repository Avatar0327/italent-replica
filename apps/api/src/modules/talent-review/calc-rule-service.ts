/**
 * 盘点计算规则的读写（设计 §2.2 calc_rules / _items、§4.5(d)、§7 计算规则行）。在 config-kit.ts 的通用骨架之上：
 * - 计算项目按目标字段对应（规则内唯一，保存后只读）：提交 items 即整组替换（相同目标更新、缺的删、新的增）；
 * - 保存分析在领域层 analyzeCalcItems：validateFormula / orderComputationItems / uses_ranking / 多选字段；
 * - 公式与目标字段引用盘点字段目录：只在当前操作人**可见**的字段里解析——看不到的字段名与不存在的字段名同样是未知字段，
 *   看不到的目标字段与不存在同一个 404（不暴露隐藏字段的存在、类型）；
 * - 规则 revision 随任何保存递增（run 冻结时核对“规则已改”）；名称租户唯一，只有看全部的人可改名（不暴露隐藏规则）。
 */
import {
  and,
  eq,
  talentReviewCalcRuleItems as I,
  talentReviewCalcRules as K,
  talentReviewFields as F,
  type Tx,
} from '@italent/db';
import { analyzeCalcItems, type CalcHints, type FormulaField, targetNotAllowed } from '@italent/domain';
import { AppError } from '../../errors.js';
import { notFoundMessage, requireConfigCreatable, requireConfigVisible, type ModuleScope } from './access.js';
import type { CalcItemBody, CalcRuleCreate, CalcRulePatch } from './calc-rule-input.js';
import { CALC_RULE, type CalcRuleView, loadCalcRuleView } from './calc-rule-view.js';
import {
  auditConfig,
  createConfig,
  deleteConfig,
  lockConfigRow,
  registerConfigReferenceGuard,
  requireSeeAllToRename,
  uniqueOr,
  type WriteContext,
} from './config-kit.js';

export interface CalcWriteContext extends WriteContext {
  /** 公式 / 目标字段解析所需的字段目录范围；请求不带 items 时为空。 */
  readonly fieldScope?: ModuleScope;
}
/** 写响应：规则聚合 + 保存提示（只在提交了 items 的写入里出现；不进审计）。 */
export type CalcWriteView = CalcRuleView & { hints?: CalcHints };

const reject = (reason: string, message: string, extra: object = {}) =>
  new AppError('VALIDATION_FAILED', message, { reason, ...extra });

interface CatalogField extends FormulaField {
  readonly enabled: boolean;
}

/** 当前操作人在字段目录范围内可见的盘点字段。 */
async function loadVisibleCatalog(tx: Tx, ctx: CalcWriteContext): Promise<CatalogField[]> {
  if (!ctx.fieldScope) throw new Error('计算项目缺少字段目录范围');
  const rows = await tx
    .select({
      id: F.id,
      name: F.name,
      kind: F.kind,
      enabled: F.enabled,
      systemWritten: F.systemWritten,
      createdBy: F.createdBy,
    })
    .from(F)
    .where(eq(F.tenantId, ctx.tenantId));
  const scope = ctx.fieldScope;
  const visible = (createdBy: string | null) => {
    try {
      requireConfigVisible(scope, 'field', createdBy);
      return true;
    } catch {
      return false;
    }
  };
  return rows
    .filter((r) => visible(r.createdBy))
    .map(({ createdBy: _createdBy, ...r }) => ({ ...r, kind: r.kind as FormulaField['kind'] }));
}

/**
 * 保存前分析整组计算项目：目标字段不重复且可见（不存在与不可见同一个 404）→ 类型允许 → 新目标已启用 → 公式分析。
 * 返回每项的 uses_ranking 与保存提示。
 */
async function prepareItems(tx: Tx, ctx: CalcWriteContext, items: readonly CalcItemBody[], held: ReadonlySet<string>) {
  const targets = items.map((item) => item.targetFieldId);
  if (new Set(targets).size !== targets.length) {
    throw reject('CALC_ITEM_TARGET_DUPLICATE', '同一规则里一个目标字段只能有一个计算项目');
  }
  const catalog = await loadVisibleCatalog(tx, ctx);
  const byId = new Map(catalog.map((field) => [field.id, field]));
  for (const [index, item] of items.entries()) {
    const field = byId.get(item.targetFieldId);
    if (!field) throw new AppError('NOT_FOUND', notFoundMessage('field'));
    const notAllowed = targetNotAllowed(field);
    if (notAllowed) throw reject('TARGET_FIELD_NOT_ALLOWED', notAllowed, { item: index });
    if (!held.has(field.id) && !field.enabled) {
      throw reject('CALC_TARGET_DISABLED', '该字段已停用，不能新选作目标', { item: index });
    }
  }
  const names = items.map((item) => byId.get(item.targetFieldId)!.name);
  if (new Set(names).size !== names.length) {
    throw reject('CALC_ITEM_TARGET_DUPLICATE', '目标字段重名，公式无法区分，请先修改字段名称');
  }
  const analysis = analyzeCalcItems(items, catalog);
  if (!analysis.ok) {
    const { reason, item, message, issues, fields } = analysis;
    throw reject(reason, message, { item, ...(issues ? { issues } : {}), ...(fields ? { fields } : {}) });
  }
  return analysis;
}

const itemRow = (ctx: CalcWriteContext, ruleId: string, item: CalcItemBody, index: number, usesRanking: boolean) => ({
  tenantId: ctx.tenantId,
  ruleId,
  targetFieldId: item.targetFieldId,
  priority: item.priority,
  description: item.description ?? null,
  formula: item.formula,
  sortNo: index + 1,
  usesRanking,
});

export async function createCalcRule(tx: Tx, ctx: CalcWriteContext, input: CalcRuleCreate): Promise<CalcWriteView> {
  const { items, ...columns } = input;
  // 新建范围先于一切读取：范围为空的人对任何字段引用都得到同一个结果
  requireConfigCreatable(ctx.scope, 'calcRule');
  const analysis = await prepareItems(tx, ctx, items, new Set());
  const created = await createConfig(tx, CALC_RULE, ctx, columns, async (id) => {
    if (items.length === 0) return;
    await tx.insert(I).values(items.map((item, index) => itemRow(ctx, id, item, index, analysis.usesRanking[index]!)));
  });
  return { ...created, hints: analysis.hints };
}

/** 按目标字段对应整组替换：相同目标更新、缺的删除、新的新增。 */
async function syncItems(
  tx: Tx,
  ctx: CalcWriteContext,
  ruleId: string,
  items: readonly CalcItemBody[],
  usesRanking: readonly boolean[],
) {
  const scope = and(eq(I.tenantId, ctx.tenantId), eq(I.ruleId, ruleId));
  const existing = new Set((await tx.select({ id: I.targetFieldId }).from(I).where(scope)).map((r) => r.id));
  const keep = new Set(items.map((item) => item.targetFieldId));
  for (const targetFieldId of existing) {
    if (!keep.has(targetFieldId)) await tx.delete(I).where(and(scope, eq(I.targetFieldId, targetFieldId)));
  }
  for (const [index, item] of items.entries()) {
    const values = itemRow(ctx, ruleId, item, index, usesRanking[index]!);
    if (!existing.has(item.targetFieldId)) {
      await tx.insert(I).values(values);
      continue;
    }
    const { tenantId: _tenant, ruleId: _rule, targetFieldId, ...columns } = values;
    await tx
      .update(I)
      .set(columns)
      .where(and(scope, eq(I.targetFieldId, targetFieldId)));
  }
}

export async function updateCalcRule(
  tx: Tx,
  ctx: CalcWriteContext,
  id: string,
  patch: CalcRulePatch,
): Promise<CalcWriteView> {
  await lockConfigRow(tx, CALC_RULE, ctx, id);
  const before = (await loadCalcRuleView(tx, ctx.tenantId, id))!;
  requireSeeAllToRename(ctx, before, patch.name);
  const { items, ...columns } = patch;
  const analysis = items
    ? await prepareItems(tx, ctx, items, new Set(before.items.map((item) => item.targetFieldId)))
    : undefined;
  await uniqueOr(CALC_RULE.duplicate, CALC_RULE.label, () =>
    tx
      .update(K)
      .set({ ...columns, revision: ctx.expectedRevision + 1, updatedBy: ctx.userId, updatedAt: ctx.now })
      .where(and(eq(K.tenantId, ctx.tenantId), eq(K.id, id))),
  );
  if (items && analysis) await syncItems(tx, ctx, id, items, analysis.usesRanking);
  const after = (await loadCalcRuleView(tx, ctx.tenantId, id))!;
  await auditConfig(tx, ctx, 'calcRule', 'update', id, before, after);
  return analysis ? { ...after, hints: analysis.hints } : after;
}

export const deleteCalcRule = (tx: Tx, ctx: CalcWriteContext, id: string): Promise<CalcRuleView> =>
  deleteConfig(tx, CALC_RULE, ctx, id);

// ---- 字段删除守卫：被计算项目作目标的字段不能删 ----------------------------------------------------------------------

registerConfigReferenceGuard('field', async (tx, tenantId, fieldId) => {
  const [item] = await tx
    .select({ id: I.id })
    .from(I)
    .where(and(eq(I.tenantId, tenantId), eq(I.targetFieldId, fieldId)))
    .limit(1);
  return item ? 'CALC_RULE' : null;
});
