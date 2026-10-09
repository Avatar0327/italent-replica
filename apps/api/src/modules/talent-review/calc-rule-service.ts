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
  asc,
  eq,
  inArray,
  sql,
  talentReviewCalcRuleItems as I,
  talentReviewCalcRules as K,
  talentReviewFields as F,
  type Tx,
} from '@italent/db';
import {
  analyzeCalcItems,
  type CalcAnalysis,
  type CalcHints,
  formulaPath,
  formulaReferences,
  type FormulaField,
  targetNotAllowed,
} from '@italent/domain';
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

/** 公式 / 目标字段解析所需的字段目录访问：对象范围 + 查看人对 name / kind / enabled / systemWritten 四列的查看权。 */
export interface CatalogAccess {
  readonly scope: ModuleScope;
  /** 四列都可见才可引用；缺任一列时每个字段都与“不存在”不可区分（不暴露名称、类型、停用与系统写入属性）。 */
  readonly columns: boolean;
}
export interface CalcWriteContext extends WriteContext {
  /** 请求不带计算项目时为空。 */
  readonly fieldAccess?: CatalogAccess;
}
/** 写响应：规则聚合 + 保存提示（提交了 items 或启用时出现；不进审计）。 */
export type CalcWriteView = CalcRuleView & { hints?: CalcHints };

const reject = (reason: string, message: string, extra: object = {}) =>
  new AppError('VALIDATION_FAILED', message, { reason, ...extra });

/** 当前操作人可引用的盘点字段：字段目录对象范围内可见，且四个相关列都有查看权。 */
async function loadVisibleCatalog(
  tx: Tx,
  tenantId: string,
  access: CatalogAccess | undefined,
): Promise<FormulaField[]> {
  if (!access) throw new Error('计算项目缺少字段目录访问');
  if (!access.columns) return [];
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
    .where(eq(F.tenantId, tenantId));
  const visible = (createdBy: string | null) => {
    try {
      requireConfigVisible(access.scope, 'field', createdBy);
      return true;
    } catch {
      return false;
    }
  };
  return rows
    .filter((r) => visible(r.createdBy))
    .map(({ createdBy: _createdBy, ...r }) => ({ ...r, kind: r.kind as FormulaField['kind'] }));
}

const failure = (analysis: Extract<CalcAnalysis, { ok: false }>) => {
  const { reason, item, message, issues, fields } = analysis;
  return reject(reason, message, { item, ...(issues ? { issues } : {}), ...(fields ? { fields } : {}) });
};

/**
 * 一次完整分析（读当前已提交的数据）：目标字段不重复且可引用（不存在、不可见、没有列权限同一个 404）→ 类型允许 →
 * 新目标已启用 → 公式分析（字段绑定一次，见领域层 analyzeCalcItems）。
 */
async function analyzeOnce(
  tx: Tx,
  ctx: CalcWriteContext,
  items: readonly CalcItemBody[],
  held: ReadonlyMap<string, string>,
) {
  const targets = items.map((item) => item.targetFieldId);
  if (new Set(targets).size !== targets.length) {
    throw reject('CALC_ITEM_TARGET_DUPLICATE', '同一规则里一个目标字段只能有一个计算项目');
  }
  const catalog = await loadVisibleCatalog(tx, ctx.tenantId, ctx.fieldAccess);
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
  const analysis = analyzeCalcItems(items, catalog, held);
  if (!analysis.ok) throw failure(analysis);
  return analysis;
}

/** 被引用字段行的共享锁，按字段 id 排序（与字段变更入口的行锁同序）。 */
async function lockFields(tx: Tx, tenantId: string, ids: readonly string[]) {
  if (ids.length === 0) return;
  await tx
    .select({ id: F.id })
    .from(F)
    .where(and(eq(F.tenantId, tenantId), inArray(F.id, [...ids])))
    .orderBy(asc(F.id))
    .for('share');
}

/**
 * 保存前分析整组计算项目，并让引用校验与写入之间不被字段变更插队：分析出目标字段与公式引用的全部字段 id，按排序先取
 * 共享行锁（字段改名 / 停用 / 删除的入口持行排他锁，会排在后面或先完成），锁内重新分析——字段已被删 / 改名 / 停用时得到受控的
 * 404 / 400，不会落到外键错误（500）。锁内分析引出新的引用字段时补锁并再分析，最多几轮。
 */
async function prepareItems(
  tx: Tx,
  ctx: CalcWriteContext,
  items: readonly CalcItemBody[],
  held: ReadonlyMap<string, string>,
) {
  let locked: string[] = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const analysis = await analyzeOnce(tx, ctx, items, held);
    if (analysis.fieldIds.every((id) => locked.includes(id))) return analysis;
    locked = [...new Set([...locked, ...analysis.fieldIds])].sort();
    await lockFields(tx, ctx.tenantId, locked);
  }
  throw new AppError('CONFLICT', '引用的字段正在变化，请刷新后重试', { reason: 'CALC_FIELD_CHANGED' });
}

/** 已存项目的保存提示（启用时给出，DEC-274：不阻断）；字段已不可引用时不给提示。 */
async function storedHints(tx: Tx, ctx: CalcWriteContext, view: CalcRuleView): Promise<CalcHints | undefined> {
  if (!ctx.fieldAccess) return undefined;
  const catalog = await loadVisibleCatalog(tx, ctx.tenantId, ctx.fieldAccess);
  const byId = new Set(catalog.map((field) => field.id));
  const items = view.items.map(({ targetFieldId, priority, formula, description }) => ({
    targetFieldId,
    priority,
    formula,
    description,
  }));
  if (items.some((item) => !byId.has(item.targetFieldId))) return undefined;
  const held = new Map(items.map((item) => [item.targetFieldId, item.formula]));
  const analysis = analyzeCalcItems(items, catalog, held);
  return analysis.ok ? analysis.hints : undefined;
}

/**
 * 命令重放的授权复核（与业务校验分开）：目标字段与公式引用的字段在**当前**字段目录范围和列权限下仍可引用——
 * 幂等重放不再执行命令，撤销后原命令重放同样按新命令的结果拒绝（目标 404，公式里的字段为未知字段 400）。
 */
export async function requireItemsReferenceable(
  tx: Tx,
  tenantId: string,
  items: readonly CalcItemBody[],
  access: CatalogAccess,
): Promise<void> {
  const catalog = await loadVisibleCatalog(tx, tenantId, access);
  const ids = new Set(catalog.map((field) => field.id));
  if (items.some((item) => !ids.has(item.targetFieldId))) throw new AppError('NOT_FOUND', notFoundMessage('field'));
  const held = new Map(items.map((item) => [item.targetFieldId, item.formula]));
  const analysis = analyzeCalcItems(items, catalog, held);
  if (!analysis.ok && analysis.issues?.some((issue) => issue.code === 'UNKNOWN_FIELD')) throw failure(analysis);
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
  const analysis = await prepareItems(tx, ctx, items, new Map());
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
  const held = new Map(before.items.map((item) => [item.targetFieldId, item.formula]));
  const analysis = items ? await prepareItems(tx, ctx, items, held) : undefined;
  await uniqueOr(CALC_RULE.duplicate, CALC_RULE.label, () =>
    tx
      .update(K)
      .set({ ...columns, revision: ctx.expectedRevision + 1, updatedBy: ctx.userId, updatedAt: ctx.now })
      .where(and(eq(K.tenantId, ctx.tenantId), eq(K.id, id))),
  );
  if (items && analysis) await syncItems(tx, ctx, id, items, analysis.usesRanking);
  const after = (await loadCalcRuleView(tx, ctx.tenantId, id))!;
  await auditConfig(tx, ctx, 'calcRule', 'update', id, before, after);
  if (analysis) return { ...after, hints: analysis.hints };
  // 只提交启用也要给出不阻断的提示（循环依赖仍允许启用，DEC-274）
  const hints = patch.enabled === true ? await storedHints(tx, ctx, after) : undefined;
  return hints ? { ...after, hints } : after;
}

export const deleteCalcRule = (tx: Tx, ctx: CalcWriteContext, id: string): Promise<CalcRuleView> =>
  deleteConfig(tx, CALC_RULE, ctx, id);

// ---- 字段删除守卫：被计算项目作目标、或被公式引用的字段不能删 ------------------------------------------------------

registerConfigReferenceGuard('field', async (tx, tenantId, fieldId) => {
  const [target] = await tx
    .select({ id: I.id })
    .from(I)
    .where(and(eq(I.tenantId, tenantId), eq(I.targetFieldId, fieldId)))
    .limit(1);
  if (target) return 'CALC_RULE';
  const [field] = await tx
    .select({ name: F.name })
    .from(F)
    .where(and(eq(F.tenantId, tenantId), eq(F.id, fieldId)));
  if (!field) return null;
  const path = formulaPath(field.name);
  const candidates = await tx
    .select({ formula: I.formula })
    .from(I)
    .where(and(eq(I.tenantId, tenantId), sql`strpos(${I.formula}, ${path}) > 0`));
  return candidates.some((row) => formulaReferences(row.formula).includes(path)) ? 'CALC_RULE' : null;
});
