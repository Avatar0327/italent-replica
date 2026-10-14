/**
 * AC-EXP 第三轮回归（astra 第二轮审查 P2-1～P2-3，PR #90）：连字符与减号（第四轮起按 DEC-228）、
 * 短字段名绑定在排序前一次性固定、单选先解包再决定是否按日期比较。
 */
import {
  evaluateBatch,
  evaluateFormula,
  inMemorySubject,
  orderComputationItems,
  validateFormula,
  type ComputationItem,
  type EvaluationResult,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { CALENDAR, contextFor } from './AC-EXP-support.js';

const valueOf = (result: EvaluationResult) => (result.ok ? result.value : result.failure);
const num = (value: number) => ({ kind: 'number', value });
const bool = (value: boolean) => ({ kind: 'boolean', value });
const item = (field: string, priority: number, formula: string): ComputationItem => ({ field, priority, formula });

describe('P2-1 连字符与减号（#89-4 取代 DEC-228：已存在字段优先，否则按减法；R3e 实测原站按减法）', () => {
  it('完整字段按字段读取：对象自身字段、原站 360 字段', () => {
    expect(valueOf(evaluateFormula('盘点对象.得分-上级分 + 1', contextFor({ '盘点对象.得分-上级分': 4 })))).toEqual(
      num(5),
    );
    const validated = validateFormula('Lastest360Cent(360结果.问卷-他评总分)');
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.fields).toContain('360结果.问卷-他评总分');
  });

  it('不加空格且合并后的完整名不是已存在字段：右侧是字段、变量、函数调用都按减法', () => {
    const fields = { '盘点对象.得分': 5, '盘点对象.基准': 2, 基准: 1 };
    const run = (formula: string) => valueOf(evaluateFormula(formula, contextFor(fields)));
    expect(run('盘点对象.得分-盘点对象.基准')).toEqual(num(3));
    expect(run('盘点对象.得分-基准')).toEqual(num(4));
    expect(run('Def(上级分, 3); 盘点对象.得分-上级分')).toEqual(num(2));
    expect(run('盘点对象.得分-转换为数字("2")')).toEqual(num(3));
  });

  it('加空格后的减法保持运算优先级', () => {
    const fields = { '盘点对象.得分': 5, 基准: 2 };
    expect(valueOf(evaluateFormula('盘点对象.得分 - 基准*2', contextFor(fields)))).toEqual(num(1));
    expect(valueOf(evaluateFormula('盘点对象.得分 - 基准 - 1', contextFor(fields)))).toEqual(num(2));
  });

  it('不加空格且右侧不存在：按减法后报右侧的未知字段，不再提示加空格', () => {
    const result = valueOf(evaluateFormula('盘点对象.得分-不存在', contextFor({ '盘点对象.得分': 5 })));
    expect(result).toMatchObject({ code: 'UNKNOWN_FIELD', message: expect.stringContaining('不存在') });
    expect(JSON.stringify(result)).not.toContain('减号两侧');
  });

  it('批量求值：不加空格、加空格都按减法并依赖先算项目（旧口径 DEC-228 不加空格不绑定）', () => {
    const subjects = [inMemorySubject('e1', { '盘点对象.得分': 5 })];
    for (const formula of ['盘点对象.得分-基准', '盘点对象.得分 - 基准']) {
      const items = [item('盘点对象.基准', 1, '2'), item('盘点对象.差值', 2, formula)];
      const ordered = orderComputationItems(items);
      expect(ordered.ok && ordered.entries[1]?.dependsOn).toEqual(['盘点对象.基准']);
      const batch = evaluateBatch(items, subjects, { calendar: CALENDAR });
      expect(batch.ok && batch.results.e1?.['盘点对象.差值']).toEqual({ ok: true, value: num(3) });
    }
  });
});

describe('P2-2 短字段名绑定在排序前一次性固定，不随计算顺序变化', () => {
  const subjects = () => [inMemorySubject('e1', { a: 9 })];

  it.each([2, 4])('歧义短名 a（优先级 %i）始终读对象自身字段', (priority) => {
    const items = [item('盘点对象.a', 1, '1'), item('盘点对象.b', priority, 'a'), item('任职记录.a', 3, '2')];
    const ordered = orderComputationItems(items);
    expect(ordered.ok).toBe(true);
    if (ordered.ok) expect(ordered.entries.find((entry) => entry.item.field === '盘点对象.b')?.dependsOn).toEqual([]);
    const batch = evaluateBatch(items, subjects(), { calendar: CALENDAR });
    expect(batch.ok).toBe(true);
    if (batch.ok) expect(batch.results.e1?.['盘点对象.b']).toEqual({ ok: true, value: num(9) });
  });

  it('唯一短名在目标项目优先级靠后时仍绑定到该项目并先算它', () => {
    const items = [item('盘点对象.b', 1, 'a + 1'), item('盘点对象.a', 5, '100')];
    const batch = evaluateBatch(items, subjects(), { calendar: CALENDAR });
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.order).toEqual(['盘点对象.a', '盘点对象.b']);
    expect(batch.results.e1?.['盘点对象.b']).toEqual({ ok: true, value: num(101) });
  });
});

describe('P2-3 单选先解包成选项值，再决定是否按日期比较（`26` §8.3）', () => {
  const dateOption = { '盘点对象.选项': { optionValue: '2020/01/01', label: '选项甲' } };
  const textOption = { '盘点对象.选项': { optionValue: 'A', label: '甲' } };

  it('日期形状的选项值与文本两种写法都相等', () => {
    expect(valueOf(evaluateFormula('盘点对象.选项 = "2020/01/01"', contextFor(dateOption)))).toEqual(bool(true));
    expect(valueOf(evaluateFormula('"2020/01/01" = 盘点对象.选项', contextFor(dateOption)))).toEqual(bool(true));
    expect(valueOf(evaluateFormula('盘点对象.选项 = "2020/1/1"', contextFor(dateOption)))).toEqual(bool(true));
    expect(valueOf(evaluateFormula('盘点对象.选项 < "2020/02/01"', contextFor(dateOption)))).toEqual(bool(true));
  });

  it('普通文本选项值按文本比较；显示文本不参与', () => {
    expect(valueOf(evaluateFormula('盘点对象.选项 = "A"', contextFor(textOption)))).toEqual(bool(true));
    expect(valueOf(evaluateFormula('"A" = 盘点对象.选项', contextFor(textOption)))).toEqual(bool(true));
    expect(valueOf(evaluateFormula('盘点对象.选项 = "甲"', contextFor(textOption)))).toEqual(bool(false));
    expect(valueOf(evaluateFormula('盘点对象.选项 = "2020/01/01"', contextFor(textOption)))).toEqual(bool(false));
  });
});
