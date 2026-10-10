/**
 * F-082（F082-1）：analyzeBoundItems——以句柄为键的计算项目分析（契约 §1.5、§4）。
 * 类型检查、多选判定、停用判定、依赖排序、uses_ranking 都基于规范文本里的字段 ID；诊断文案用显示名称。
 */
import { describe, expect, it } from 'vitest';
import { fieldHandle, orderComputationItems } from '../expression/index.js';
import { analyzeBoundItems, type BoundCalcItem } from './bound-analysis.js';
import type { FormulaField } from './calc-rule.js';

const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const [SCORE, LEVEL, TOTAL, MULTI, OFF] = [1, 2, 3, 4, 5].map(id) as [string, string, string, string, string];
const h = (fieldId: string) => fieldHandle(fieldId);

const field = (fieldId: string, name: string, extra: Partial<FormulaField> = {}): FormulaField => ({
  id: fieldId,
  name,
  kind: 'number',
  systemWritten: false,
  enabled: true,
  ...extra,
});
const CATALOG: FormulaField[] = [
  field(SCORE, '得分'),
  field(LEVEL, '等级', { kind: 'text' }),
  field(TOTAL, '总分'),
  field(MULTI, '标签', { kind: 'multi_option' }),
  field(OFF, '停用项', { enabled: false }),
];
const item = (targetFieldId: string, stored: string, priority = 0): BoundCalcItem => ({
  targetFieldId,
  priority,
  stored,
});

const expectOk = (result: ReturnType<typeof analyzeBoundItems>) => {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result;
};

describe('analyzeBoundItems：基本分析', () => {
  it('按依赖排序，hints 里是目标字段 ID；fieldIds 含目标与全部引用', () => {
    const result = expectOk(analyzeBoundItems([item(TOTAL, `${h(SCORE)} + 1`, 5), item(SCORE, '80', 0)], CATALOG));
    expect(result.hints.order).toEqual([SCORE, TOTAL]);
    expect(result.hints.blocked).toEqual([]);
    expect(new Set(result.fieldIds)).toEqual(new Set([TOTAL, SCORE]));
    expect(result.usesRanking).toEqual([false, false]);
  });

  it('优先级与依赖矛盾的提示用显示名称，不出现句柄或 ID', () => {
    const result = expectOk(analyzeBoundItems([item(TOTAL, `${h(SCORE)} + 1`, 0), item(SCORE, '80', 5)], CATALOG));
    expect(result.hints.warnings).toHaveLength(1);
    expect(result.hints.warnings[0]).toContain('盘点对象.总分');
    expect(result.hints.warnings[0]).toContain('盘点对象.得分');
    expect(result.hints.warnings[0]).not.toContain('@{');
    expect(result.hints.warnings[0]).not.toContain(SCORE);
    // 结构化诊断里的字段仍是字段键（句柄）
    expect(result.diagnostics[0]!.fields).toEqual(expect.arrayContaining([h(TOTAL), h(SCORE)]));
  });

  it('循环依赖：保存不拦截；cycles 与 blocked 都是目标字段 ID；提示用显示名称', () => {
    const result = expectOk(analyzeBoundItems([item(SCORE, `${h(TOTAL)} + 1`), item(TOTAL, `${h(SCORE)} + 1`)], CATALOG));
    expect(result.hints.blocked.sort()).toEqual([SCORE, TOTAL].sort());
    expect(result.hints.cycles).toHaveLength(1);
    expect(result.hints.cycles[0]!.every((entry) => entry === SCORE || entry === TOTAL)).toBe(true);
    expect(result.hints.warnings.join('')).toContain('盘点对象.得分');
    expect(result.hints.warnings.join('')).not.toContain('@{');
  });

  it('目标字段与其他字段重名可以保存（B5 的 CALC_FIELD_NAME_AMBIGUOUS 作废）', () => {
    const twin = field(id(6), '总分');
    const result = analyzeBoundItems([item(TOTAL, `${h(SCORE)} + 1`)], [...CATALOG, twin]);
    expect(result.ok).toBe(true);
  });

  it('自引用是循环依赖', () => {
    const result = expectOk(analyzeBoundItems([item(SCORE, `${h(SCORE)} + 1`)], CATALOG));
    expect(result.hints.blocked).toEqual([SCORE]);
  });

  it('uses_ranking 由公式用到的函数派生', () => {
    const ranking = `Ranking("百分位", ${h(SCORE)}, 盘点活动.项目名称="项目甲", 盘点对象.盘点方案)`;
    const result = expectOk(analyzeBoundItems([item(SCORE, '80'), item(TOTAL, ranking, 2)], CATALOG));
    expect(result.usesRanking).toEqual([false, true]);
  });
});

describe('analyzeBoundItems：校验', () => {
  it('引用多选字段 → MULTI_OPTION_IN_FORMULA，指出项目与字段 ID', () => {
    const result = analyzeBoundItems([item(SCORE, '1'), item(TOTAL, `Len(${h(MULTI)})`)], CATALOG);
    expect(result).toMatchObject({ ok: false, reason: 'MULTI_OPTION_IN_FORMULA', item: 1, fields: [MULTI] });
  });

  it('新引用已停用字段 → CALC_FORMULA_FIELD_DISABLED；已有引用（按 ID）保留不受影响', () => {
    const stored = `${h(OFF)} + 1`;
    const added = analyzeBoundItems([item(TOTAL, stored)], CATALOG);
    expect(added).toMatchObject({ ok: false, reason: 'CALC_FORMULA_FIELD_DISABLED', item: 0, fields: [OFF] });
    const kept = analyzeBoundItems([item(TOTAL, stored)], CATALOG, new Map([[TOTAL, new Set([OFF])]]));
    expect(kept.ok).toBe(true);
  });

  it('语法 / 类型错误 → FORMULA_INVALID 带行列；消息不含 ID', () => {
    const result = analyzeBoundItems([item(TOTAL, `${h(SCORE)} +`)], CATALOG);
    expect(result).toMatchObject({ ok: false, reason: 'FORMULA_INVALID', item: 0 });
  });

  it('句柄指向目录里没有的字段 → UNKNOWN_FIELD（防御：外键 restrict 下不应出现）', () => {
    const result = analyzeBoundItems([item(TOTAL, `${h(id(9))} + 1`)], CATALOG);
    expect(result).toMatchObject({ ok: false, reason: 'FORMULA_INVALID', item: 0 });
    if (!result.ok) expect(result.issues?.[0]?.code).toBe('UNKNOWN_FIELD');
  });
});

describe('orderComputationItems 的 display 回调', () => {
  it('诊断文案用显示名称生成，结构化 fields 仍是字段键', () => {
    const a = h(SCORE);
    const b = h(TOTAL);
    const result = orderComputationItems(
      [
        { field: b, priority: 0, formula: `${a} + 1` },
        { field: a, priority: 5, formula: '80' },
      ],
      { storage: true, isKnownField: (path) => path === a || path === b, display: (key) => (key === a ? '得分' : '总分') },
    );
    if (!result.ok) throw new Error(JSON.stringify(result.failure));
    expect(result.warnings[0]).toBe('总分（优先级 0）引用了 得分（优先级 5），按依赖先算 得分');
    expect(result.diagnostics[0]!.fields).toEqual([b, a]);
  });

  it('不传 display 时保持原文案', () => {
    const result = orderComputationItems([
      { field: 'a.x', priority: 0, formula: 'a.y + 1' },
      { field: 'a.y', priority: 5, formula: '80' },
    ]);
    if (!result.ok) throw new Error('应成功');
    expect(result.warnings[0]).toContain('a.x（优先级 0）引用了 a.y（优先级 5），按依赖先算 a.y');
  });
});
