/**
 * 计算项目排序的结构化诊断（PR #184 第 3 轮）：diagnostics 与 warnings 一一对应（同序、message 相同），
 * 类别与提到的字段路径来自结构，不依赖文案；字段名里含“循环”等关键词不影响类别。
 */
import { describe, expect, it } from 'vitest';
import { orderComputationItems } from './engine.js';

const known = (path: string) => path.startsWith('盘点对象.');
const ordered = (items: { field: string; priority: number; formula: string }[]) => {
  const result = orderComputationItems(items, { isKnownField: known, fieldKind: () => 'number' });
  if (!result.ok) throw new Error(result.failure.message);
  expect(result.diagnostics.map((item) => item.message)).toEqual(result.warnings);
  return result.diagnostics;
};

describe('orderComputationItems 结构化诊断', () => {
  it('循环依赖组、依赖成环项目：类别 cycle / blockedByCycle，fields 是环上与组内的全部项目', () => {
    const diagnostics = ordered([
      { field: '盘点对象.循环甲', priority: 1, formula: '盘点对象.循环乙 + 1' },
      { field: '盘点对象.循环乙', priority: 1, formula: '盘点对象.循环甲 + 1' },
      { field: '盘点对象.下游', priority: 1, formula: '盘点对象.循环甲 + 1' },
    ]);
    expect(diagnostics.map((item) => item.kind)).toEqual(['cycle', 'blockedByCycle']);
    expect(diagnostics[0]!.fields).toEqual(expect.arrayContaining(['盘点对象.循环甲', '盘点对象.循环乙']));
    expect(diagnostics[1]!.fields).toEqual(['盘点对象.下游']);
  });

  it('优先级与依赖矛盾：类别 priorityConflict，fields 是本项目与被引用的项目；字段名含“循环”也不是循环类', () => {
    const diagnostics = ordered([
      { field: '盘点对象.循环得分', priority: 1, formula: '盘点对象.成环系数 + 1' },
      { field: '盘点对象.成环系数', priority: 5, formula: '1' },
    ]);
    expect(diagnostics).toEqual([
      expect.objectContaining({ kind: 'priorityConflict', fields: ['盘点对象.循环得分', '盘点对象.成环系数'] }),
    ]);
  });

  it('类型不确定：类别 typeUncertain，fields 含项目字段与公式的全部引用', () => {
    const result = orderComputationItems(
      [{ field: '盘点对象.结果', priority: 1, formula: 'Year(IF(真,Today(),1)) + 盘点对象.来源' }],
      { isKnownField: known, fieldKind: () => 'number' },
    );
    if (!result.ok) throw new Error(result.failure.message);
    expect(result.diagnostics.map((item) => item.message)).toEqual(result.warnings);
    const uncertain = result.diagnostics.filter((item) => item.kind === 'typeUncertain');
    expect(uncertain.length).toBeGreaterThan(0);
    for (const item of uncertain) expect(item.fields).toEqual(['盘点对象.结果', '盘点对象.来源']);
  });

  it('循环组超过 20 组：截断汇总的类别 cyclesTruncated，fields 是全部成环项目', () => {
    const items = Array.from({ length: 21 }, (_, i) => [
      { field: `盘点对象.甲${i}`, priority: 1, formula: `盘点对象.乙${i} + 1` },
      { field: `盘点对象.乙${i}`, priority: 1, formula: `盘点对象.甲${i} + 1` },
    ]).flat();
    const diagnostics = ordered(items);
    const truncated = diagnostics.filter((item) => item.kind === 'cyclesTruncated');
    expect(truncated).toHaveLength(1);
    expect(truncated[0]!.fields).toHaveLength(42);
    expect(diagnostics.filter((item) => item.kind === 'cycle')).toHaveLength(20);
  });
});
