/**
 * 计算规则 hints 的检测与统一投影（F-082 契约 §5.2，DEC-376⑥、DEC-374⑥）：GET（详情与列表）、写响应、幂等重放共用。
 * 检测在全部字段上做（不按查看人裁剪，看不到字段的人也要得到循环提示，DEC-274）；输出经领域层 projectHints 按查看人投影：
 * 没有 items 查看权只给匿名计数；有 items 查看权只列目标可见的项目、环要全部成员可见、涉及不可见字段的提示汇总成不含名称的提示。
 * 可见性一律按字段 ID 判断。按规则里项目的存储形态检测：
 * - 全是 bound：按 ID 分析；**已有引用集合（引用表）传入**，合法保留的停用引用不当作新增引用（契约 §3.3）；
 * - 全是 legacy：按名称检测（这些项目还是名称文本），环的成员映射成目标字段 ID（重名无法映射的按不可见处理）；
 * - unresolved 或与 bound 混合：不能做完整检测，明确提示“无法完整校验”，order 仍列出全部目标；
 * - 没有计算项目：空 hints。
 */
import {
  analyzeBoundItems,
  analyzeCalcItems,
  FORMULA_CONTEXT_FIELDS,
  type FormulaField,
  formulaPath,
  type OrderingDiagnostic,
  parseFieldHandle,
  projectHints,
  type ProjectedHints,
  type RawHints,
} from '@italent/domain';
import type { CalcItemView } from './calc-rule-view.js';

const UNVERIFIABLE = '部分公式当前无法完整校验（引用的字段可能已改名或删除），请检查后重新保存';
const NOT_REBOUND = '部分计算项目尚未改绑为按字段 ID 绑定（旧公式或改绑失败），无法完整校验，请重新保存这些公式';

/** 不针对任何字段的提示（fields 为空，对任何查看人都算“可见”）。 */
const note = (message: string): OrderingDiagnostic => ({ kind: 'typeUncertain', fields: [], message });

function detectBound(items: readonly CalcItemView[], full: readonly FormulaField[]): RawHints {
  const order = items.map((item) => item.targetFieldId);
  const held = new Map(items.map((item) => [item.targetFieldId, new Set(item.refFieldIds ?? [])]));
  const analysis = analyzeBoundItems(
    items.map((item) => ({
      targetFieldId: item.targetFieldId,
      priority: item.priority,
      stored: item.formula,
      description: item.description,
    })),
    full,
    held,
  );
  if (!analysis.ok) return { order, blocked: [], cycles: [], diagnostics: [note(UNVERIFIABLE)] };
  const { hints, diagnostics } = analysis;
  return { order: hints.order, blocked: hints.blocked, cycles: hints.cycles, diagnostics };
}

/** legacy（名称文本）：B5 的按名称检测；环的成员是字段路径，映射成目标字段 ID（名称重名无法唯一映射 → 空串，按不可见处理）。 */
function detectLegacy(items: readonly CalcItemView[], full: readonly FormulaField[]): RawHints {
  const order = items.map((item) => item.targetFieldId);
  const ids = new Set(full.map((field) => field.id));
  if (items.some((item) => !ids.has(item.targetFieldId))) {
    return { order, blocked: [], cycles: [], diagnostics: [note(UNVERIFIABLE)] };
  }
  const held = new Map(items.map((item) => [item.targetFieldId, item.formula]));
  const analysis = analyzeCalcItems(items, full, held);
  if (!analysis.ok) return { order, blocked: [], cycles: [], diagnostics: [note(UNVERIFIABLE)] };
  const counts = new Map<string, number>();
  for (const field of full) counts.set(field.name, (counts.get(field.name) ?? 0) + 1);
  const idOfPath = new Map(
    full.filter((field) => counts.get(field.name) === 1).map((field) => [formulaPath(field.name), field.id]),
  );
  const { hints, diagnostics } = analysis;
  return {
    order: hints.order,
    blocked: hints.blocked,
    cycles: hints.cycles.map((cycle) => cycle.map((path) => idOfPath.get(path) ?? '')),
    diagnostics,
  };
}

export function detectHints(items: readonly CalcItemView[], full: readonly FormulaField[]): RawHints {
  if (items.length === 0) return { order: [], blocked: [], cycles: [], diagnostics: [] };
  const states = new Set(items.map((item) => item.formulaBinding ?? 'legacy'));
  if (states.size === 1 && states.has('bound')) return detectBound(items, full);
  if (states.size === 1 && states.has('legacy')) return detectLegacy(items, full);
  const order = items.map((item) => item.targetFieldId);
  return { order, blocked: [], cycles: [], diagnostics: [note(NOT_REBOUND)] };
}

export interface HintsViewer {
  /** 查看人可引用（可见）的字段：字段目录范围内且四列可见。 */
  readonly visibleFields: readonly FormulaField[];
  readonly itemsViewable: boolean;
}

/** 检测 + 按查看人投影。 */
export function projectRuleHints(
  items: readonly CalcItemView[],
  full: readonly FormulaField[],
  viewer: HintsViewer,
): ProjectedHints {
  const raw = detectHints(items, full);
  const visibleIds = new Set(viewer.visibleFields.map((field) => field.id));
  const visiblePaths = new Set(viewer.visibleFields.map((field) => formulaPath(field.name)));
  const bound = items.length > 0 && items.every((item) => item.formulaBinding === 'bound');
  const shown = (key: string): boolean => {
    if (key in FORMULA_CONTEXT_FIELDS) return true;
    const id = parseFieldHandle(key);
    return id === undefined ? !bound && visiblePaths.has(key) : visibleIds.has(id);
  };
  return projectHints(raw, { itemsViewable: viewer.itemsViewable, shown, target: (id) => visibleIds.has(id) });
}
