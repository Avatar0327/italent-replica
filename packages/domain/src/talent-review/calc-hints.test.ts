/**
 * F-082（F082-4）：计算规则 hints 的统一投影（契约 §5.2，DEC-376⑥、DEC-374⑥）。
 * 检测在全部字段上做，输出按查看人投影：没有 items 查看权只给匿名计数；有 items 查看权只列目标可见的项目、环要全部成员可见、
 * 涉及不可见字段的提示汇总成不含名称的提示；可见性一律按 ID 判断（不按名称，不做子串匹配）。
 */
import { describe, expect, it } from 'vitest';
import type { OrderingDiagnostic } from '../expression/index.js';
import { HINT_CYCLE_HIDDEN, hintItemsHidden, hintOtherHidden, projectHints, type RawHints } from './calc-hints.js';

const A = 'a0000000-0000-4000-8000-000000000001';
const B = 'b0000000-0000-4000-8000-000000000002';
const C = 'c0000000-0000-4000-8000-000000000003';
const h = (id: string) => `@{tr-field:${id}}`;
const diag = (kind: OrderingDiagnostic['kind'], fields: string[], message: string): OrderingDiagnostic => ({
  kind,
  fields,
  message,
});

/** A→B→A 循环，C 单独有一条类型不确定的提示。 */
const raw: RawHints = {
  order: [A, B, C],
  blocked: [A, B],
  cycles: [[A, B]],
  diagnostics: [
    diag('cycle', [h(A), h(B)], '循环依赖：甲 → 乙 → 甲'),
    diag('blockedByCycle', [h(A), h(B)], '甲、乙依赖成环，无法计算'),
    diag('typeUncertain', [h(C)], '丙的类型不确定'),
  ],
};
const viewer = (visible: string[], itemsViewable = true) => ({
  itemsViewable,
  shown: (key: string) => visible.some((id) => key === h(id)),
  target: (id: string) => visible.includes(id),
});

describe('没有 items 查看权', () => {
  it('order / blocked / cycles 为空，warnings 只有固定一句，others 是全部个数，不含任何 ID 或名称', () => {
    const out = projectHints(raw, viewer([A, B, C], false));
    expect(out).toEqual({
      order: [],
      blocked: [],
      cycles: [],
      warnings: [hintItemsHidden(3)],
      others: { order: 3, blocked: 2, warnings: 3 },
    });
    expect(JSON.stringify(out)).not.toMatch(/循环依赖：|甲|乙|a0000000/);
  });

  it('没有任何提示 / 项目时不产生固定文案和 others', () => {
    const out = projectHints({ order: [], blocked: [], cycles: [], diagnostics: [] }, viewer([], false));
    expect(out).toEqual({ order: [], blocked: [], cycles: [], warnings: [] });
  });
});

describe('有 items 查看权', () => {
  it('全部可见：原样给出，没有 others', () => {
    const out = projectHints(raw, viewer([A, B, C]));
    expect(out.order).toEqual([A, B, C]);
    expect(out.blocked).toEqual([A, B]);
    expect(out.cycles).toEqual([[A, B]]);
    expect(out.warnings).toEqual(['循环依赖：甲 → 乙 → 甲', '甲、乙依赖成环，无法计算', '丙的类型不确定']);
    expect(out.others).toBeUndefined();
  });

  it('B 不可见：含 B 的环不列出，循环提示汇总为不含名称的固定提示；order / blocked 只留可见目标，others 给被裁掉的个数', () => {
    const out = projectHints(raw, viewer([A, C]));
    expect(out.order).toEqual([A, C]);
    expect(out.blocked).toEqual([A]);
    expect(out.cycles).toEqual([]);
    expect(out.warnings).toEqual(['丙的类型不确定', HINT_CYCLE_HIDDEN]);
    expect(out.others).toEqual({ order: 1, blocked: 1, warnings: 2 });
    expect(JSON.stringify(out)).not.toContain(B);
    expect(JSON.stringify(out)).not.toContain('乙');
  });

  it('非循环类提示涉及不可见字段：汇总为“另有 N 条提示涉及不可见的字段”', () => {
    const out = projectHints(raw, viewer([A, B]));
    expect(out.warnings).toEqual(['循环依赖：甲 → 乙 → 甲', '甲、乙依赖成环，无法计算', hintOtherHidden(1)]);
    expect(out.others).toEqual({ order: 1, blocked: 0, warnings: 1 });
  });

  it('可见性按 ID 判断：项目上下文固定路径按可见处理，不可见字段的句柄不因“名称前缀相同”而可见', () => {
    const ctx = diag('typeUncertain', ['盘点活动.项目名称', h(C)], '提示');
    const out = projectHints(
      { ...raw, diagnostics: [ctx] },
      { ...viewer([A, B]), shown: (k) => k === '盘点活动.项目名称' },
    );
    expect(out.warnings).toEqual([hintOtherHidden(1)]);
  });
});
