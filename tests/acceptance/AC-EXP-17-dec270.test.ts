/**
 * AC-EXP-17 DEC-270（取证 Q-M0-105，`26` §8.8，原站盘点实际计算）：函数参数与聚合的空值 / 文本口径。
 * ① 函数数值参数遇空计算失败（四则仍按 0）；② 日期函数的日期参数在保存检查时做类型拦截，空日期按 0001-01-01；
 * ③ Sum 遇文本按字符串拼接；④ 取数过滤 / 排名范围里的“年度 > "2025"”检查通过、计算不报错、结果为空。
 */
import {
  DEFAULT_SEMANTICS,
  evaluateBatch,
  evaluateFormula,
  inMemorySubject,
  validateFormula,
  type EvaluationContext,
  type EvaluationResult,
  type InMemoryPortData,
  type PlainValue,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { CALENDAR, contextFor } from './AC-EXP-support.js';

const valueOf = (result: EvaluationResult) => (result.ok ? result.value : result.failure);
const num = (value: number) => ({ kind: 'number', value });
const text = (value: string) => ({ kind: 'text', value });
/** 数值取数函数（绩效得分、排名）取不到：空值带来源类型（PR #108 第 3 轮）。 */
const EMPTY = { kind: 'empty', of: 'number' };

/** 原站试算的空值来源：1999 年无绩效数据。 */
const EMPTY_PERF = '获取指定年度指定周期的绩效得分(考核结果.年度=1999, 考核结果.周期名称="年度")';
const PORTS: InMemoryPortData = {
  performance: { 'emp-1': [{ fields: { 年度: 2026, 周期名称: '年度', 得分: 88 }, modifiedAt: new Date(0) }] },
};
const run = (formula: string, fields: Record<string, PlainValue> = {}, extra: Partial<EvaluationContext> = {}) =>
  valueOf(evaluateFormula(formula, { ...contextFor(fields, { ports: PORTS }), ...extra }));

describe('DEC-270 ① 函数数值参数遇空计算失败，四则仍按 0', () => {
  it('Round(空)、Abs(空) 计算失败（原站“无法转换为double类型”）', () => {
    expect(run(`Round(${EMPTY_PERF})`)).toMatchObject({ code: 'EMPTY_IN_ARITHMETIC' });
    expect(run(`Abs(${EMPTY_PERF})`)).toMatchObject({ code: 'EMPTY_IN_ARITHMETIC' });
    expect(run('Round(盘点对象.x, 1)', { '盘点对象.x': null })).toMatchObject({ code: 'EMPTY_IN_ARITHMETIC' });
  });

  it('四则遇空仍按 0：空 + 1 = 1（DEC-257 不变）', () => {
    expect(run(`${EMPTY_PERF} + 1`)).toEqual(num(1));
    expect(run(`Round(${EMPTY_PERF} + 0.4)`)).toEqual(num(0));
  });

  it('新补函数同口径：RoundUP / INT / Mod / AddDays 的数量 / 小数位参数遇空失败', () => {
    for (const formula of [
      `RoundUP(${EMPTY_PERF})`,
      `INT(${EMPTY_PERF})`,
      `Mod(7, ${EMPTY_PERF})`,
      `Round(2.5, ${EMPTY_PERF})`,
      `AddDays("2026/10/07", ${EMPTY_PERF})`,
    ]) {
      expect(run(formula), formula).toMatchObject({ code: 'EMPTY_IN_ARITHMETIC' });
    }
  });

  it('semantics 配置 emptyInFunctionArgument 可切回按 0（四则配置互不影响）', () => {
    const semantics = { ...DEFAULT_SEMANTICS, emptyInFunctionArgument: 'zero' } as const;
    expect(run(`Round(${EMPTY_PERF})`, {}, { semantics })).toEqual(num(0));
    expect(DEFAULT_SEMANTICS.emptyInFunctionArgument).toBe('fail');
    expect(DEFAULT_SEMANTICS.emptyInArithmetic).toBe('zero');
  });
});

describe('DEC-270 ② 日期函数参数：保存检查拦截非日期；空日期按 0001-01-01', () => {
  it('AddDays(取数函数结果, 1) 保存检查即拦截（原站“第1个参数应为日期或日期时间字段或常量”）', () => {
    const result = validateFormula(`AddDays(${EMPTY_PERF}, 1)`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({
      code: 'ARGUMENT_TYPE',
      line: 1,
      column: 1,
      message: expect.stringContaining('第1个参数应为日期或日期时间字段或常量'),
    });
  });

  it.each(['AddDays(1, 1)', 'Year("abc")', 'Days(Today(), 3)', 'DateFormat(1 + 1, "yyyy")', 'WeekDay(真)'])(
    '静态可知不是日期：%s → ARGUMENT_TYPE，单公式求值同一失败码',
    (formula) => {
      const validated = validateFormula(formula);
      expect(validated.ok ? [] : validated.errors.map((issue) => issue.code)).toEqual(['ARGUMENT_TYPE']);
      expect(run(formula)).toMatchObject({ code: 'ARGUMENT_TYPE' });
    },
  );

  it.each([
    'AddDays(员工信息.出生日期, 1)',
    'AddDays(Today(), 1)',
    'AddDays("2026/10/07", 1)',
    'Year(ToDate(员工信息.入职日期文本))',
    'Def(d, Today()); Year(d)',
    'Year(IF(真, Today(), "2020/01/01"))',
  ])('日期字段、日期常量、返回日期的函数、变量与 IF 不拦截：%s', (formula) => {
    expect(validateFormula(formula).ok).toBe(true);
  });

  it('批量计算保存排序同样拦截（三条入口同一解释）', () => {
    const batch = evaluateBatch(
      [{ field: '盘点对象.a', priority: 1, formula: `AddDays(${EMPTY_PERF}, 1)` }],
      [inMemorySubject('emp-1', {})],
      { calendar: CALENDAR },
    );
    expect(batch).toMatchObject({ ok: false, failure: { code: 'ARGUMENT_TYPE' } });
  });

  it('Year(AddDays(员工信息.出生日期(空), 1)) = 1，不报错', () => {
    expect(run('Year(AddDays(员工信息.出生日期, 1))', { '员工信息.出生日期': null })).toEqual(num(1));
    expect(run('DateFormat(员工信息.出生日期, "yyyy-MM-dd")', { '员工信息.出生日期': null })).toEqual(
      text('0001-01-01'),
    );
    expect(run('Days(员工信息.出生日期, "0001/01/11")', { '员工信息.出生日期': null })).toEqual(num(10));
  });

  it('semantics 配置 emptyDateArgument = fail 时空日期计算失败', () => {
    const semantics = { ...DEFAULT_SEMANTICS, emptyDateArgument: 'fail' } as const;
    expect(run('Year(员工信息.出生日期)', { '员工信息.出生日期': null }, { semantics })).toMatchObject({
      code: 'TYPE_CONVERSION',
    });
  });
});

describe('DEC-270 ③ Sum 遇文本按字符串拼接（原站怪异行为照搬）', () => {
  it('Sum(1, "5") = "15"（与四则 "5" + 1 = 6 不同）', () => {
    expect(run('Sum(1, "5")')).toEqual(text('15'));
    expect(run('求和(1, 2, "5")')).toEqual(text('35'));
    expect(run('"5" + 1')).toEqual(num(6));
  });

  it('全是数值时照常求和；遇空仍计算失败（DEC-257）', () => {
    expect(run('Sum(1, 2, 3)')).toEqual(num(6));
    expect(run(`Sum(1, ${EMPTY_PERF})`)).toMatchObject({ code: 'EMPTY_IN_AGGREGATE' });
  });

  it('Average 遇数字文本仍按数值（原站按 double 转换，未见拼接；🟡 #105）', () => {
    expect(run('Average(1, "5")')).toEqual(num(3));
  });

  it('semantics 配置 textInSum = coerce 时按数值相加', () => {
    const semantics = { ...DEFAULT_SEMANTICS, textInSum: 'coerce' } as const;
    expect(run('Sum(1, "5")', {}, { semantics })).toEqual(num(6));
  });
});

describe('DEC-270 ④ 取数过滤 / 排名范围里的 年度 > "2025"：检查通过、计算不报错、结果为空', () => {
  const PERF_TEXT_YEAR = '获取指定年度指定周期的绩效得分(考核结果.年度>"2025", 考核结果.周期名称="年度")';
  const RANK_TEXT_YEAR =
    '获取某个结果在指定人员范围内的排名("百分位", 盘点对象.价值观本人评分, 盘点活动.盘点年度>"2025", 盘点对象.盘点方案)';

  it('保存检查通过', () => {
    expect(validateFormula(PERF_TEXT_YEAR).ok).toBe(true);
    expect(validateFormula(RANK_TEXT_YEAR).ok).toBe(true);
  });

  it('绩效取数：有 / 无考核结果都不报错，结果为空（数值比较是否生效 🟡）', () => {
    expect(run(PERF_TEXT_YEAR)).toEqual(EMPTY);
    expect(valueOf(evaluateFormula(PERF_TEXT_YEAR, contextFor({}, { ports: { performance: {} } })))).toEqual(EMPTY);
  });

  it('排名：范围条件里的文本年度比较不报错，结果为空', () => {
    const fields = { '盘点对象.价值观本人评分': 4, '盘点活动.盘点年度': 2026, '盘点对象.盘点方案': '方案一' };
    const ports: InMemoryPortData = { ranking: [{ id: 'emp-1', fields }] };
    expect(valueOf(evaluateFormula(RANK_TEXT_YEAR, contextFor(fields, { ports })))).toEqual(EMPTY);
  });
});
