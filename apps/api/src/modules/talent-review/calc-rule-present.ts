/**
 * 计算规则的响应渲染（F-082 契约 §1.4，开关打开时）：GET / 写响应 / 幂等重放 / 删除回执共用。
 * 命令台账和审计里是原始视图（规范文本 + 存储形态）；对外一律在响应时按**当前**名称和**当前**查看人渲染：
 * - bound 项目：句柄 → `盘点对象.<当前名称>`，看不到的字段 → 占位符，并给出逐处绑定 formulaBindings；
 * - legacy / unresolved 与 B5 时代的旧台账结果（没有存储形态）：按 legacy 规则，绑定全为 null（不能作为绑定证明）；
 * - 规则另带 fieldCatalogVersion（字段“名称 → ID”映射的当前版本）。
 * 渲染后不对外暴露存储形态、写入时刻的字段名与引用 ID（那些只属于审计）。
 * 统一投影 projectCalcRule（契约 §5.1）：公式 / 绑定 / 版本 / hints 在这里一次产出，四个出口（GET 详情、列表、写响应、重放）共用。
 */
import type { Tx } from '@italent/db';
import { FORMULA_REPAIR_NOTICE, type ProjectedHints, renderFormula } from '@italent/domain';
import { type CatalogAccess, loadFullCatalog, visibleOf } from './calc-rule-catalog.js';
import { projectRuleHints } from './calc-rule-hints.js';
import type { CalcItemView, CalcRuleView } from './calc-rule-view.js';
import { readFieldCatalogVersion } from './field-catalog.js';

export type PresentedCalcRule<T extends CalcRuleView = CalcRuleView> = T & {
  fieldCatalogVersion: number;
  hints?: ProjectedHints;
};

/** 查看人：字段目录访问（决定哪些引用显示名称）+ 对计算规则 items 列的查看权（决定 hints 投影）。 */
export interface PresentViewer {
  readonly access: CatalogAccess | undefined;
  readonly itemsViewable: boolean;
}

export async function presentCalcRules<T extends CalcRuleView>(
  tx: Tx,
  tenantId: string,
  views: readonly T[],
  viewer: PresentViewer,
  withHints = false,
): Promise<PresentedCalcRule<T>[]> {
  if (views.length === 0) return [];
  const full = await loadFullCatalog(tx, tenantId);
  const visibleFields = visibleOf(full, viewer.access);
  const allFieldsVisible = visibleFields.length === full.length;
  const fieldCatalogVersion = await readFieldCatalogVersion(tx, tenantId);
  const renderItem = (item: CalcItemView): CalcItemView => {
    const { formulaBinding, fieldNames: _names, refFieldIds: _refs, ...visible } = item;
    const rendered = renderFormula(item.formula, {
      binding: formulaBinding ?? 'legacy',
      visibleFields,
      allFieldsVisible,
    });
    // bound 的规范文本损坏（不该发生）：不原样输出，给固定提示
    if (!rendered.ok) return { ...visible, formula: FORMULA_REPAIR_NOTICE, formulaBindings: [] };
    return { ...visible, formula: rendered.text, formulaBindings: [...rendered.bindings] };
  };
  return views.map((view) => ({
    ...view,
    items: view.items.map(renderItem),
    fieldCatalogVersion,
    // hints 在原始视图（规范文本）上检测，经 projectHints 按查看人投影（GET / 写响应 / 重放同一套）
    ...(withHints
      ? { hints: projectRuleHints(view.items, full, { visibleFields, itemsViewable: viewer.itemsViewable }) }
      : {}),
  }));
}
