/**
 * 计算规则 hints 的统一投影（F-082 契约 §5.2，DEC-376⑥、DEC-374⑥）：GET（详情与列表）、写响应、幂等重放、审计里意外出现的
 * hints 都经过它。纯函数：检测（analyzeBoundItems 的 hints + 结构化诊断）在全部字段上做，这里按查看人投影输出。
 * - 没有 items 查看权：order / blocked / cycles 为空，warnings 只有固定一句，others 给全部个数（不含任何 ID 或名称）；
 * - 有 items 查看权：order / blocked 只列目标字段可见的项目 ID；cycles 只列全部成员可见的环（元素是目标字段 ID）；
 *   warnings 只保留 fields 全部可见的诊断，被裁掉的循环类诊断汇总成不含名称的循环提示，其余汇总成“另有 N 条…”；
 *   others 给被裁掉的个数（都为 0 时省略）。
 * “可见”一律按 ID 判断，不按名称，也不做子串匹配。
 */
import type { OrderingDiagnostic, OrderingDiagnosticKind } from '../expression/index.js';

/** 固定提示文案（与保存响应里 B5 的同名提示一致）。 */
export const HINT_CYCLE_HIDDEN = '存在循环依赖，涉及当前不可见的字段（不显示字段名称）；允许保存，计算时将整次失败';
export const hintOtherHidden = (count: number) => `另有 ${count} 条提示涉及不可见的字段，未显示`;
export const hintItemsHidden = (count: number) => `计算项目对你不可见，${count} 条提示未显示`;

/** 检测的原始结果（全部字段，未投影）。cycles 的元素与 order / blocked 一样是计算项目的目标字段 ID。 */
export interface RawHints {
  readonly order: readonly string[];
  readonly blocked: readonly string[];
  readonly cycles: readonly (readonly string[])[];
  readonly diagnostics: readonly OrderingDiagnostic[];
}

export interface HintViewer {
  /** 查看人对计算规则 items 列的查看权。 */
  readonly itemsViewable: boolean;
  /** 诊断里出现的字段键（句柄 / 项目上下文路径）对查看人是否可见。 */
  readonly shown: (key: string) => boolean;
  /** 计算项目的目标字段（按 ID）对查看人是否可见。 */
  readonly target: (fieldId: string) => boolean;
}

export interface ProjectedHints {
  readonly order: string[];
  readonly blocked: string[];
  readonly cycles: string[][];
  readonly warnings: string[];
  readonly others?: { readonly order: number; readonly blocked: number; readonly warnings: number };
}

const CYCLE_KINDS: ReadonlySet<OrderingDiagnosticKind> = new Set(['cycle', 'cyclesTruncated', 'blockedByCycle']);

export function projectHints(raw: RawHints, viewer: HintViewer): ProjectedHints {
  const total = raw.diagnostics.length;
  if (!viewer.itemsViewable) {
    const hiding = total + raw.order.length + raw.blocked.length + raw.cycles.length > 0;
    return {
      order: [],
      blocked: [],
      cycles: [],
      warnings: hiding ? [hintItemsHidden(total)] : [],
      ...(hiding ? { others: { order: raw.order.length, blocked: raw.blocked.length, warnings: total } } : {}),
    };
  }
  const order = raw.order.filter(viewer.target);
  const blocked = raw.blocked.filter(viewer.target);
  const cycles = raw.cycles.filter((cycle) => cycle.every(viewer.target)).map((cycle) => [...cycle]);
  const kept = raw.diagnostics.filter((entry) => entry.fields.every(viewer.shown));
  const dropped = raw.diagnostics.filter((entry) => !entry.fields.every(viewer.shown));
  const droppedOther = dropped.filter((entry) => !CYCLE_KINDS.has(entry.kind)).length;
  const cycleHidden = dropped.some((entry) => CYCLE_KINDS.has(entry.kind)) || cycles.length < raw.cycles.length;
  const others = {
    order: raw.order.length - order.length,
    blocked: raw.blocked.length - blocked.length,
    warnings: dropped.length,
  };
  return {
    order,
    blocked,
    cycles,
    warnings: [
      ...kept.map((entry) => entry.message),
      ...(cycleHidden ? [HINT_CYCLE_HIDDEN] : []),
      ...(droppedOther > 0 ? [hintOtherHidden(droppedOther)] : []),
    ],
    ...(others.order + others.blocked + others.warnings > 0 ? { others } : {}),
  };
}
