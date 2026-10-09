/**
 * 盘点计算规则的保存分析（纯函数；R3-T04 设计 §2.2 calc_rules / _items、§4.5(d)、§7 计算规则行；TR-R27～R30）：
 * - 公式按字段名引用盘点字段（`盘点对象.<名>`，26 §8），字段目录 = 调用方给出的可见字段 + 项目 / 方案三个固定字段；
 * - 保存校验 validateFormula，依赖排序 orderComputationItems（先优先级、再按引用依赖；循环与依赖矛盾只提示、不拦截，DEC-274）；
 * - uses_ranking 由公式用到的函数派生（排名函数在待办触发时不计算，DEC-260）；
 * - 目标字段类型允许性（§4.5(d) 表）与公式引用多选字段（DEC-314②，取证前禁用）。
 */
import {
  createDefaultRegistry,
  orderComputationItems,
  validateFormula,
  type ExpressionFieldKind,
} from '../expression/index.js';
import type { TalentReviewFieldKind } from './fields.js';

export const CALC_RULE_WINDOWS = ['before_project_end', 'before_project_start'] as const;
export type CalcRuleWindow = (typeof CALC_RULE_WINDOWS)[number];

/** 公式里盘点字段的写法前缀。 */
export const FORMULA_OBJECT = '盘点对象';
/** 项目 / 方案字段（设计 §5 RankingPort 行）：排名范围条件与分组可用，不是盘点字段目录里的字段。 */
export const FORMULA_CONTEXT_FIELDS: Readonly<Record<string, ExpressionFieldKind>> = {
  '盘点活动.项目名称': 'text',
  '盘点活动.盘点年度': 'text',
  '盘点对象.盘点方案': 'text',
};
export const formulaPath = (fieldName: string) => `${FORMULA_OBJECT}.${fieldName}`;

export interface FormulaField {
  readonly id: string;
  readonly name: string;
  readonly kind: TalentReviewFieldKind;
  readonly systemWritten: boolean;
}
export interface CalcItemInput {
  readonly targetFieldId: string;
  readonly priority: number;
  readonly formula: string;
  readonly description?: string | null | undefined;
}

/** 目标字段只能是标量字段：多选和系统写入字段不能作目标（设计 §4.5(d)，保存时 400 TARGET_FIELD_NOT_ALLOWED）。 */
export function targetNotAllowed(field: Pick<FormulaField, 'kind' | 'systemWritten'>): string | null {
  if (field.kind === 'multi_option') return '多选字段不能作为计算项目的目标';
  if (field.systemWritten) return '系统写入的字段不能作为计算项目的目标';
  return null;
}

export interface CalcIssue {
  readonly code: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}
export interface CalcHints {
  /** 计算顺序（目标字段 id）：先优先级、再按依赖。 */
  readonly order: string[];
  readonly warnings: string[];
  /** 循环依赖的代表环（字段路径），保存不拦截，计算时整次失败（DEC-274）。 */
  readonly cycles: string[][];
  /** 成环或依赖成环、无法计算的项目（目标字段 id）。 */
  readonly blocked: string[];
}
export type CalcAnalysis =
  | { readonly ok: true; readonly usesRanking: boolean[]; readonly hints: CalcHints }
  | {
      readonly ok: false;
      readonly reason: 'FORMULA_INVALID' | 'MULTI_OPTION_IN_FORMULA';
      readonly item: number;
      readonly message: string;
      readonly issues?: CalcIssue[];
      readonly fields?: string[];
    };

const staticKind = (kind: TalentReviewFieldKind): ExpressionFieldKind => (kind === 'option' ? 'text' : kind);

/**
 * 分析一条规则的全部计算项目。`catalog` 是调用方可见的盘点字段（含全部目标字段）；重名字段的写法有歧义，不进入公式字段目录。
 * 返回第一个不合法的项目（下标 = items 下标）；通过时给出每项的 uses_ranking 与保存提示。
 */
export function analyzeCalcItems(items: readonly CalcItemInput[], catalog: readonly FormulaField[]): CalcAnalysis {
  const counts = new Map<string, number>();
  for (const field of catalog) counts.set(field.name, (counts.get(field.name) ?? 0) + 1);
  const byPath = new Map(
    catalog.filter((field) => counts.get(field.name) === 1).map((field) => [formulaPath(field.name), field]),
  );
  const byId = new Map(catalog.map((field) => [field.id, field]));
  const isKnownField = (path: string) => byPath.has(path) || path in FORMULA_CONTEXT_FIELDS;
  const fieldKind = (path: string): ExpressionFieldKind | undefined => {
    const field = byPath.get(path);
    return field ? staticKind(field.kind) : FORMULA_CONTEXT_FIELDS[path];
  };
  const compItems = items.map((item) => ({
    field: formulaPath(byId.get(item.targetFieldId)!.name),
    priority: item.priority,
    formula: item.formula,
    ...(item.description ? { description: item.description } : {}),
  }));
  const registry = createDefaultRegistry();
  // 先按名称找出多选字段的引用并给出专用错误码（引擎遇到带多选类型的字段会报参数类型错误，信息不够明确）；
  // 其他语法 / 函数 / 字段错误留给下面的依赖排序统一报告
  const usesRanking: boolean[] = [];
  for (const [index, item] of compItems.entries()) {
    const checked = validateFormula(item.formula, { isKnownField, registry });
    const multi = checked.ok ? checked.fields.filter((path) => byPath.get(path)?.kind === 'multi_option') : [];
    if (multi.length > 0) {
      return {
        ok: false,
        reason: 'MULTI_OPTION_IN_FORMULA',
        item: index,
        message: '公式不能引用多选字段',
        fields: multi,
      };
    }
    usesRanking.push(
      checked.ok && checked.functions.some((name) => registry.resolve(name)?.skipInTodoTrigger === true),
    );
  }
  const ordering = orderComputationItems(compItems, { isKnownField, fieldKind, registry });
  if (!ordering.ok) {
    const { failure } = ordering;
    const index = 'field' in failure ? compItems.findIndex((item) => item.field === failure.field) : -1;
    const { code, message } = failure;
    const issue = 'line' in failure ? { code, message, line: failure.line, column: failure.column } : { code, message };
    return { ok: false, reason: 'FORMULA_INVALID', item: Math.max(index, 0), message, issues: [issue] };
  }
  const idOfPath = new Map(compItems.map((item, index) => [item.field, items[index]!.targetFieldId]));
  const ids = (paths: readonly string[]) => paths.map((path) => idOfPath.get(path)!);
  return {
    ok: true,
    usesRanking,
    hints: {
      order: ids(ordering.order.map((item) => item.field)),
      warnings: [...ordering.warnings],
      cycles: ordering.cycles.map((cycle) => [...cycle]),
      blocked: ids(ordering.blocked),
    },
  };
}
