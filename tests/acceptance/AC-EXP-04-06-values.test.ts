/**
 * AC-EXP-04～06：空值与计算失败（`26` §8.2 / §8.4）、单选按选项值（§8.3）、百分比 / DateFormat / today()（§8.3，DEC-056）。
 * 空值与类型转换的精确行为按 DEC-257（Q-M0-95 原站试算，§8.5）集中在 semantics.ts；七例实测见 AC-EXP-04-dec257。
 */
import { evaluateFormula, type EvaluationResult } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { contextFor } from './AC-EXP-support.js';

const failureOf = (result: EvaluationResult) => (result.ok ? undefined : result.failure);

describe('AC-EXP-04 空值参与比较为假、参与平均失败；ToNumber 兜底后通过（DEC-257）', () => {
  it('取不到的数据是空值，不自动当 0', () => {
    expect(evaluateFormula('盘点对象.绩效得分', contextFor({ '盘点对象.绩效得分': null }))).toEqual({
      ok: true,
      value: { kind: 'empty' },
    });
  });

  it('空值参与大小比较：结果为假、不报错（DEC-257，原站实测与手册不符）', () => {
    const result = evaluateFormula(
      '如果 盘点对象.绩效得分 > 80 那么 1 否则 0',
      contextFor({ '盘点对象.绩效得分': null }),
    );
    expect(result).toEqual({ ok: true, value: { kind: 'number', value: 0 } });
  });

  it('空值参与平均：失败原因码 EMPTY_IN_AGGREGATE', () => {
    const result = evaluateFormula(
      'Average(盘点对象.a, 盘点对象.b)',
      contextFor({ '盘点对象.a': 80, '盘点对象.b': null }),
    );
    expect(failureOf(result)?.code).toBe('EMPTY_IN_AGGREGATE');
  });

  it('ToNumber(空) = 0（DEC-257 实测），之后比较与平均都能算', () => {
    const fields = { '盘点对象.绩效得分': null, '盘点对象.b': 80 };
    expect(evaluateFormula('如果 ToNumber(盘点对象.绩效得分) > 80 那么 1 否则 0', contextFor(fields))).toMatchObject({
      value: { value: 0 },
    });
    expect(evaluateFormula('Average(ToNumber(盘点对象.绩效得分), 盘点对象.b)', contextFor(fields))).toMatchObject({
      value: { value: 40 },
    });
  });

  it('非数字字符串参与四则运算 → 计算失败 TEXT_IN_ARITHMETIC（数字字符串按数值，DEC-257）', () => {
    expect(failureOf(evaluateFormula('盘点对象.备注 + 1', contextFor({ '盘点对象.备注': '甲' })))?.code).toBe(
      'TEXT_IN_ARITHMETIC',
    );
    // DEC-265：ToNumber 对非数字文本给 0（原站 ToNumber("abc") = 0，`26` §8.7），不再报转换出错
    expect(evaluateFormula('ToNumber(盘点对象.备注)', contextFor({ '盘点对象.备注': '甲' }))).toEqual({
      ok: true,
      value: { kind: 'number', value: 0 },
    });
  });

  it('是否为空() 可以显式判空，空值 = 空值 为真', () => {
    const fields = { '盘点对象.绩效得分': null };
    expect(evaluateFormula('是否为空(盘点对象.绩效得分)', contextFor(fields))).toMatchObject({
      value: { value: true },
    });
    expect(evaluateFormula('IsEmpty(1)', contextFor({}))).toMatchObject({ value: { value: false } });
  });

  it('除以零、未定义变量都是结构化失败而不是异常', () => {
    expect(failureOf(evaluateFormula('1 / 0', contextFor({})))?.code).toBe('DIVISION_BY_ZERO');
    expect(failureOf(evaluateFormula('x + 1', contextFor({})))?.code).toBe('UNKNOWN_FIELD');
  });
});

describe('AC-EXP-05 单选列表按选项值比较和赋值', () => {
  const fields = { '盘点对象.潜力': { optionValue: 3, label: '高' } };

  it('与选项值比较为真，与显示文本比较为假', () => {
    expect(evaluateFormula('盘点对象.潜力 = 3', contextFor(fields))).toMatchObject({ value: { value: true } });
    expect(evaluateFormula('盘点对象.潜力 = "高"', contextFor(fields))).toMatchObject({ value: { value: false } });
  });

  it('参与四则时取选项值', () => {
    expect(evaluateFormula('盘点对象.潜力 * 10', contextFor(fields))).toMatchObject({ value: { value: 30 } });
  });
});

describe('AC-EXP-06 百分比按小数、DateFormat 支持 .NET 格式符、today() 按租户时区上下文', () => {
  it('82% → 0.82；ToNumber("82%") 亦然', () => {
    expect(evaluateFormula('82%', contextFor({}))).toMatchObject({ value: { value: 0.82 } });
    expect(evaluateFormula('ToNumber("82%")', contextFor({}))).toMatchObject({ value: { value: 0.82 } });
  });

  it('DateFormat(日期, "yyyy-MM-dd HH:mm:ss tt")', () => {
    const formula = 'DateFormat("2020/01/02 13:04:05", "yyyy-MM-dd HH:mm:ss tt")';
    expect(evaluateFormula(formula, contextFor({}))).toMatchObject({ value: { value: '2020-01-02 13:04:05 PM' } });
    expect(evaluateFormula('日期格式化("2020/01", "yyyy年M月")', contextFor({}))).toMatchObject({
      value: { value: '2020年1月' },
    });
  });

  it('today() 来自上下文（不读系统时钟），日期字面量与字段日期可比较', () => {
    expect(evaluateFormula('DateFormat(today(), "yyyy/MM/dd")', contextFor({}))).toMatchObject({
      value: { value: '2026/10/06' },
    });
    expect(
      evaluateFormula('盘点对象.入职日期 < "2020/01/01"', contextFor({ '盘点对象.入职日期': '2019/12/31' })),
    ).toMatchObject({
      value: { value: true },
    });
    expect(evaluateFormula('today() > "2020/01/01 00:00:00"', contextFor({}))).toMatchObject({
      value: { value: true },
    });
  });

  it('Date 瞬时按租户时区转为业务日期（DEC-056）', () => {
    const fields = { '盘点对象.入职日期': new Date('2020-01-01T20:00:00Z') };
    expect(evaluateFormula('DateFormat(盘点对象.入职日期, "yyyy-MM-dd")', contextFor(fields))).toMatchObject({
      value: { value: '2020-01-02' },
    });
  });
});
