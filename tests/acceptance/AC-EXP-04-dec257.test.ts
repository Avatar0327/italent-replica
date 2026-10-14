/**
 * AC-EXP-04 按 DEC-257 校准（取证 Q-M0-95，`26` §8.5 原站试算）：空值与类型语义照原站。
 * 空值用两种来源各验一遍：取数函数取不到（原站试算即用 1999 年绩效得分）和对象字段为空。
 */
import { evaluateFormula, type EvaluationResult, type InMemoryPortData } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { contextFor } from './AC-EXP-support.js';

const valueOf = (result: EvaluationResult) => (result.ok ? result.value : result.failure);
const num = (value: number) => ({ kind: 'number', value });
const bool = (value: boolean) => ({ kind: 'boolean', value });

/** 原站试算的取数写法：1999 年无绩效数据 → 空。 */
const EMPTY_PERF = 'PerformanceCent(考核结果.年度="1999", 考核结果.周期名称="年度")';
const ports: InMemoryPortData = {
  performance: { 'emp-1': [{ fields: { 年度: 2026, 周期名称: '年度', 得分: 88 }, modifiedAt: new Date(0) }] },
};
const run = (formula: string, fields = {}) => valueOf(evaluateFormula(formula, contextFor(fields, { ports })));
const EMPTY_SOURCES = [
  ['取数函数取不到', EMPTY_PERF, {}],
  ['对象字段为空', '盘点对象.x', { '盘点对象.x': null }],
] as const;

describe.each(EMPTY_SOURCES)('DEC-257 空值（%s）', (_label, empty, fields) => {
  it('空 + 1 = 1：空值参与四则按 0', () => {
    expect(run(`${empty} + 1`, fields)).toEqual(num(1));
    expect(run(`10 - ${empty}`, fields)).toEqual(num(10));
    expect(run(`${empty} * 3`, fields)).toEqual(num(0));
    expect(run(`-${empty}`, fields)).toEqual(num(0));
  });

  it('空值作除数按 0 → 除数为 0 失败', () => {
    expect(run(`1 / ${empty}`, fields)).toMatchObject({ code: 'DIVISION_BY_ZERO' });
  });

  it('ToNumber(空) = 0（不变）', () => {
    expect(run(`ToNumber(${empty})`, fields)).toEqual(num(0));
  });

  it('DEC-270：Round(空)、Abs(空) 等函数数值参数遇空计算失败（取代 DEC-264 的按 0），四则仍按 0', () => {
    expect(run(`Round(${empty})`, fields)).toMatchObject({ code: 'EMPTY_IN_ARITHMETIC' });
    expect(run(`Abs(${empty})`, fields)).toMatchObject({ code: 'EMPTY_IN_ARITHMETIC' });
    expect(run(`Round(${empty} + 0)`, fields)).toEqual(num(0));
  });

  it('Average(空, 4) 计算失败（不变，聚合不跳过空值）', () => {
    expect(run(`Average(${empty}, 4)`, fields)).toMatchObject({ code: 'EMPTY_IN_AGGREGATE' });
    expect(run(`Sum(${empty}, 4)`, fields)).toMatchObject({ code: 'EMPTY_IN_AGGREGATE' });
  });

  it('如果 空 > 3 那么 1 否则 0 → 0：空值参与大于 / 小于比较结果为假、不报错', () => {
    expect(run(`如果 ${empty} > 3 那么 1 否则 0`, fields)).toEqual(num(0));
    expect(run(`${empty} < 3`, fields)).toEqual(bool(false));
    expect(run(`${empty} >= 0`, fields)).toEqual(bool(false));
    expect(run(`${empty} <= 0`, fields)).toEqual(bool(false));
    expect(run(`3 > ${empty}`, fields)).toEqual(bool(false));
  });

  it('空值参与 = / ≠ 口径不变：空 = 空 为真，空与非空不相等', () => {
    expect(run(`${empty} = ${empty}`, fields)).toEqual(bool(true));
    expect(run(`${empty} = 0`, fields)).toEqual(bool(false));
    expect(run(`${empty} ≠ 0`, fields)).toEqual(bool(true));
    expect(run(`${empty} = ""`, fields)).toEqual(bool(false));
  });
});

describe('DEC-257 文本参与四则与比较', () => {
  it('"5" + 1 = 6：数字字符串参与四则按数值（不拼接）', () => {
    expect(run('"5" + 1')).toEqual(num(6));
    expect(run('盘点对象.年度 - 1', { '盘点对象.年度': '2026' })).toEqual(num(2025));
    expect(run('" 2.5 " * 2')).toEqual(num(5));
  });

  it('非数字文本参与四则仍计算失败', () => {
    expect(run('"甲" + 1')).toMatchObject({ code: 'TEXT_IN_ARITHMETIC' });
    expect(run('盘点对象.备注 * 2', { '盘点对象.备注': 'abc' })).toMatchObject({ code: 'TEXT_IN_ARITHMETIC' });
    expect(run('"" + 1')).toMatchObject({ code: 'TEXT_IN_ARITHMETIC' });
  });

  it('如果 "10" > "9" 那么 1 否则 0 → 计算失败“比较【10>9】时出错”', () => {
    expect(run('如果 "10" > "9" 那么 1 否则 0')).toMatchObject({
      code: 'TYPE_CONVERSION',
      message: expect.stringContaining('比较【10>9】时出错'),
    });
    expect(run('"b" < "a"')).toMatchObject({ code: 'TYPE_CONVERSION' });
  });

  it('如果 "5" > 3 那么 1 否则 0 → 计算失败（原站编辑期拦截，复刻先按运行时失败）', () => {
    expect(run('如果 "5" > 3 那么 1 否则 0')).toMatchObject({
      code: 'TYPE_CONVERSION',
      message: expect.stringContaining('比较【5>3】时出错'),
    });
    expect(run('3 <= 盘点对象.年度', { '盘点对象.年度': '2026' })).toMatchObject({ code: 'TYPE_CONVERSION' });
  });

  it('文本与数字 = / ≠ 口径不变（按数值宽松相等）', () => {
    expect(run('"2026" = 2026')).toEqual(bool(true));
    expect(run('"5" ≠ 3')).toEqual(bool(true));
    expect(run('"b" = "b"')).toEqual(bool(true));
  });

  it('日期文本之间、日期文本与日期比较大小保持合法', () => {
    expect(run('"2020/12" > "2020/9"')).toEqual(bool(true));
    expect(run('today() > "2020/01/01 00:00:00"')).toEqual(bool(true));
  });
});
