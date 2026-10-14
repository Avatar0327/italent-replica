/** 盘点计算规则聚合的视图装配（设计 §2.2）：规则行 + 计算项目（按序号）。列表与详情共用 withItems。 */
import {
  and,
  asc,
  eq,
  inArray,
  talentReviewCalcItemRefs as R,
  talentReviewCalcRuleItems as I,
  talentReviewCalcRules as K,
  talentReviewFields as F,
  type Tx,
} from '@italent/db';
import type { FormulaBindingState } from '@italent/domain';
import type { ConfigSpec, ConfigTable } from './config-kit.js';

const row = {
  id: K.id,
  name: K.name,
  enabled: K.enabled,
  assessmentLatestWindow: K.assessmentLatestWindow,
  description: K.description,
  sortNo: K.sortNo,
  revision: K.revision,
  createdBy: K.createdBy,
  createdAt: K.createdAt,
  updatedBy: K.updatedBy,
  updatedAt: K.updatedAt,
};
export type CalcRuleRow = Omit<typeof K.$inferSelect, 'tenantId'>;
export interface CalcItemView {
  readonly targetFieldId: string;
  readonly priority: number;
  readonly formula: string;
  readonly description: string | null;
  readonly sortNo: number;
  readonly usesRanking: boolean;
  /**
   * 开关打开（F-082）后的存储形态，只在命令台账 / 审计用的原始视图里出现（presentCalcRules 渲染后不对外）：
   * formula 是规范文本（bound）还是名称文本（legacy / unresolved）；bound 项目另带写入时刻的字段名与引用 ID（契约 §5.3）。
   */
  readonly formulaBinding?: FormulaBindingState;
  readonly fieldNames?: Record<string, string>;
  readonly refFieldIds?: string[];
  /** unresolved 的原因码（改绑失败，契约 §6.3）：同样只在原始视图里出现。 */
  readonly bindingIssue?: string;
  /** 渲染后对外的逐处绑定（presentCalcRules 产出，契约 §1.4）。 */
  readonly formulaBindings?: (string | null)[];
}
export type CalcRuleView = CalcRuleRow & { items: CalcItemView[] };

const selectRows = (tx: Tx, tenantId: string, ids: string[]) =>
  tx
    .select(row)
    .from(K)
    .where(and(eq(K.tenantId, tenantId), inArray(K.id, ids))) as unknown as Promise<CalcRuleRow[]>;

/** bound = 开关打开：原始视图带存储形态与（bound 项目的）引用；关闭时与 B5 完全一致。 */
function calcRuleSpec(bound: boolean): ConfigSpec<CalcRuleView> {
  return {
    object: 'calcRule',
    label: '计算规则',
    table: K as unknown as ConfigTable,
    view: row,
    // 列表只按查看人看得到的排序键排（config-kit visibleOrder），以 id 收尾
    orderBy: [
      ['sortNo', K.sortNo],
      ['name', K.name],
    ],
    duplicate: 'CALC_RULE_DUPLICATE',
    inUse: 'CALC_RULE_IN_USE',
    load: async (tx, tenantId, id) => (await withItems(tx, tenantId, await selectRows(tx, tenantId, [id]), bound))[0],
  };
}
export const CALC_RULE: ConfigSpec<CalcRuleView> = calcRuleSpec(false);
export const CALC_RULE_BOUND: ConfigSpec<CalcRuleView> = calcRuleSpec(true);
export const calcRuleSpecOf = (bound: boolean) => (bound ? CALC_RULE_BOUND : CALC_RULE);

/**
 * 项目的引用与写入时刻的字段名：审计快照的 fieldNames / refFieldIds（契约 §5.3）。bound 项目是 bound 引用；
 * legacy / unresolved 项目是候选引用（改绑失败或改名固化，契约 §6.2）——候选变化也要进审计，否则改绑重试新增候选时
 * 前后快照相同、changes 为空（F082-5 第 1 轮 P2-2）。读取时同样按查看人的字段目录权限裁剪。
 */
async function itemRefs(tx: Tx, tenantId: string, itemIds: readonly string[]) {
  const found = new Map<string, { id: string; name: string }[]>();
  if (itemIds.length === 0) return found;
  const rows = await tx
    .select({ itemId: R.itemId, fieldId: R.fieldId, name: F.name })
    .from(R)
    .innerJoin(F, and(eq(F.tenantId, R.tenantId), eq(F.id, R.fieldId)))
    .where(and(eq(R.tenantId, tenantId), inArray(R.itemId, [...itemIds])))
    .orderBy(asc(R.fieldId));
  for (const entry of rows) {
    found.set(entry.itemId, [...(found.get(entry.itemId) ?? []), { id: entry.fieldId, name: entry.name }]);
  }
  return found;
}

export async function withItems(tx: Tx, tenantId: string, rows: CalcRuleRow[], bound = false): Promise<CalcRuleView[]> {
  if (rows.length === 0) return [];
  const items = await tx
    .select()
    .from(I)
    .where(
      and(
        eq(I.tenantId, tenantId),
        inArray(
          I.ruleId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(asc(I.sortNo), asc(I.id));
  const refs = bound
    ? await itemRefs(
        tx,
        tenantId,
        items.map((item) => item.id),
      )
    : new Map();
  return rows.map((r) => ({
    ...r,
    items: items
      .filter((item) => item.ruleId === r.id)
      .map(
        ({ id, targetFieldId, priority, formula, description, sortNo, usesRanking, formulaBinding, bindingIssue }) => ({
          targetFieldId,
          priority,
          formula,
          description,
          sortNo,
          usesRanking,
          ...(bound ? boundExtras(formulaBinding as FormulaBindingState, refs.get(id), bindingIssue) : {}),
        }),
      ),
  }));
}

function boundExtras(
  binding: FormulaBindingState,
  refs: { id: string; name: string }[] | undefined,
  issue: string | null,
) {
  const list = refs ?? [];
  const references = {
    fieldNames: Object.fromEntries(list.map((entry) => [entry.id, entry.name])),
    refFieldIds: list.map((entry) => entry.id),
  };
  if (binding === 'bound') return { formulaBinding: binding, ...references };
  // legacy / unresolved：候选引用有变化才出现在快照里，没有候选的保持原来的形状
  return {
    formulaBinding: binding,
    ...(issue ? { bindingIssue: issue } : {}),
    ...(list.length > 0 ? references : {}),
  };
}

export const loadCalcRuleView = (tx: Tx, tenantId: string, id: string, bound = false) =>
  calcRuleSpecOf(bound).load!(tx, tenantId, id);
