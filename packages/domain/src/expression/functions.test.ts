/**
 * 逐函数单元测试：每个函数至少各有一例中文名与英文名（`26` §8.1）。取数函数的用例见 tests/acceptance/AC-EXP-07-11。
 */
import { describe, expect, it } from 'vitest';
import { evaluateFormula } from './engine.js';
import { createDefaultRegistry } from './registry.js';
import { createInMemoryPorts, inMemorySubject } from './ports.js';
import type { EvaluationContext, PlainValue } from './index.js';

const context = (fields: Record<string, PlainValue> = {}): EvaluationContext => ({
  subject: inMemorySubject('s', fields),
  calendar: { today: '2026-10-06', timeZone: 'Asia/Shanghai' },
});
const run = (formula: string, fields?: Record<string, PlainValue>) => {
  const result = evaluateFormula(formula, context(fields));
  return result.ok ? result.value : result.failure;
};
const num = (value: number) => ({ kind: 'number', value });
const text = (value: string) => ({ kind: 'text', value });
const bool = (value: boolean) => ({ kind: 'boolean', value });

describe('函数注册表', () => {
  it('中英文名解析到同一函数，英文名不区分大小写', () => {
    const registry = createDefaultRegistry();
    expect(registry.resolve('转换为数字')?.name).toBe('ToNumber');
    expect(registry.resolve('tonumber')?.name).toBe('ToNumber');
    expect(registry.resolve('Latest360Cent')?.name).toBe('Lastest360Cent');
    expect(registry.resolve('不存在')).toBeUndefined();
  });

  it('列出全部函数及其别名与参数，供编辑器展示', () => {
    const names = createDefaultRegistry()
      .list()
      .map((spec) => spec.name)
      .sort();
    expect(names).toEqual(
      expect.arrayContaining([
        'Abs',
        'Average',
        'Concat',
        'Contains',
        'CountJudgesWithResult',
        'CountModulesWithResult',
        'DateAdd',
        'DateDiff',
        'DateFormat',
        'Day',
        'IsEmpty',
        'JudgeAverage',
        'Lastest360Cent',
        'LastestAssessmentCent',
        'Length',
        'Max',
        'Min',
        'ModuleJudgeAverage',
        'ModuleResult',
        'Month',
        'PerformanceCent',
        'PerformanceGrade',
        'PerformanceLastCent',
        'PerformanceLastGrade',
        'Ranking',
        'Round',
        'Sum',
        'ToDate',
        'ToNumber',
        'ToText',
        'Today',
        'Year',
      ]),
    );
  });

  it('使用方可以扩展自定义函数', () => {
    const registry = createDefaultRegistry();
    registry.register({
      name: 'Double',
      aliases: ['翻倍'],
      params: [{ name: '数值', required: true }],
      implement: ({ args, numberArg }) => ({ kind: 'number', value: numberArg(args, 0) * 2 }),
    });
    const result = evaluateFormula('翻倍(21)', { ...context(), registry });
    expect(result).toEqual({ ok: true, value: num(42) });
  });
});

describe('类型转换', () => {
  it('ToNumber / 转换为数字：数字文本、百分比、是否、单选、空', () => {
    expect(run('ToNumber("12.5")')).toEqual(num(12.5));
    expect(run('转换为数字("82%")')).toEqual(num(0.82));
    expect(run('ToNumber(真)')).toEqual(num(1));
    expect(run('ToNumber(盘点对象.x)', { '盘点对象.x': { optionValue: '3', label: '高' } })).toEqual(num(3));
    expect(run('ToNumber(盘点对象.x)', { '盘点对象.x': null })).toEqual(num(0));
    expect(run('ToNumber("abc")')).toMatchObject({ code: 'TYPE_CONVERSION' });
  });
  it('ToText / 转换为文本（别名 ToString）', () => {
    expect(run('ToText(12)')).toEqual(text('12'));
    expect(run('转换为文本(真)')).toEqual(text('真'));
    expect(run('ToString(盘点对象.x)', { '盘点对象.x': null })).toEqual(text(''));
  });
  it('ToDate / 转换为日期', () => {
    expect(run('Year(ToDate("2020/03/04"))')).toEqual(num(2020));
    expect(run('Month(转换为日期("2020-03"))')).toEqual(num(3));
    expect(run('ToDate("2020年")')).toMatchObject({ code: 'TYPE_CONVERSION' });
  });
  it('IsEmpty / 是否为空', () => {
    expect(run('IsEmpty("")')).toEqual(bool(true));
    expect(run('是否为空(0)')).toEqual(bool(false));
  });
});

describe('数值与聚合', () => {
  it('Average / 平均值、Sum / 求和、Max / 最大值、Min / 最小值', () => {
    expect(run('Average(1, 2, 6)')).toEqual(num(3));
    expect(run('平均值(4, 6)')).toEqual(num(5));
    expect(run('Sum(1, 2, 3)')).toEqual(num(6));
    expect(run('求和(1.5, 2.5)')).toEqual(num(4));
    expect(run('Max(1, 9, 3)')).toEqual(num(9));
    expect(run('最大值(-1, -9)')).toEqual(num(-1));
    expect(run('Min(1, 9, 3)')).toEqual(num(1));
    expect(run('最小值(2, 0.5)')).toEqual(num(0.5));
  });
  it('Round / 四舍五入（可指定小数位）、Abs / 绝对值', () => {
    expect(run('Round(2.5)')).toEqual(num(3));
    expect(run('四舍五入(2.345, 2)')).toEqual(num(2.35));
    expect(run('Abs(-3)')).toEqual(num(3));
    expect(run('绝对值(3)')).toEqual(num(3));
  });
  it('聚合遇到空值按语义配置失败（待 Q-M0-95）', () => {
    expect(run('Sum(1, 盘点对象.x)', { '盘点对象.x': null })).toMatchObject({ code: 'EMPTY_IN_AGGREGATE' });
    expect(run('Average(1, "a")')).toMatchObject({ code: 'TEXT_IN_ARITHMETIC' });
  });
});

describe('文本', () => {
  it('Length / 长度、Contains / 包含、Concat / 连接', () => {
    expect(run('Length("北森")')).toEqual(num(2));
    expect(run('长度("")')).toEqual(num(0));
    expect(run('Contains("人才盘点", "盘点")')).toEqual(bool(true));
    expect(run('包含("人才盘点", "评定")')).toEqual(bool(false));
    expect(run('Concat("A", 1, "B")')).toEqual(text('A1B'));
    expect(run('连接("等级", 2)')).toEqual(text('等级2'));
  });
});

describe('日期（🟡 待 Q-M0-83：业务日按租户时区）', () => {
  it('Today / 今天 来自上下文', () => {
    expect(run('DateFormat(Today(), "yyyy-MM-dd")')).toEqual(text('2026-10-06'));
    expect(run('DateFormat(今天(), "yyyyMMdd")')).toEqual(text('20261006'));
  });
  it('Year / 年、Month / 月、Day / 日', () => {
    expect(run('Year("2020/01/02")')).toEqual(num(2020));
    expect(run('年(today())')).toEqual(num(2026));
    expect(run('Month("2020/01/02")')).toEqual(num(1));
    expect(run('月("2020/11")')).toEqual(num(11));
    expect(run('Day("2020/01/02")')).toEqual(num(2));
    expect(run('日(today())')).toEqual(num(6));
  });
  it('DateDiff / 日期差（单位 d / m / y）与 DateAdd / 日期加', () => {
    expect(run('DateDiff("d", "2020/01/01", "2020/01/31")')).toEqual(num(30));
    expect(run('日期差("m", "2020/01/15", "2020/03/01")')).toEqual(num(1));
    expect(run('DateDiff("y", "2000/10/07", today())')).toEqual(num(25));
    expect(run('DateFormat(DateAdd("d", 1, "2020/01/31"), "yyyy-MM-dd")')).toEqual(text('2020-02-01'));
    expect(run('DateFormat(日期加("m", 1, "2020/01/31"), "yyyy-MM-dd")')).toEqual(text('2020-02-29'));
    expect(run('DateFormat(DateAdd("y", -1, "2020/02/29"), "yyyy-MM-dd")')).toEqual(text('2019-02-28'));
  });
  it('DateFormat / 日期格式化：.NET 格式符与引号内字面量', () => {
    expect(run('DateFormat("2020/01/02 09:05:07", "yy/M/d h:m:s t")')).toEqual(text('20/1/2 9:5:7 A'));
    expect(run('日期格式化("2020/01/02", "yyyy\'年\'MM\'月\'")')).toEqual(text('2020年01月'));
    expect(run('DateFormat("13:04", "HH:mm")')).toEqual(text('13:04'));
    expect(run('DateFormat(盘点对象.x, "yyyy")', { '盘点对象.x': null })).toMatchObject({ code: 'TYPE_CONVERSION' });
  });
});

describe('运算符语义', () => {
  it('比较：文本与数字宽松相等、单选按值、日期按时间顺序、是否', () => {
    expect(run('"2026" = 2026')).toEqual(bool(true));
    expect(run('"2026" ≠ 2027')).toEqual(bool(true));
    expect(run('"b" > "a"')).toEqual(bool(true));
    expect(run('"2020/01/02" > "2020/01/01 23:00:00"')).toEqual(bool(true));
    expect(run('真 = 真 且 非 假')).toEqual(bool(true));
    expect(run('1 <> 1 或 2 >= 2')).toEqual(bool(true));
  });
  it('四则：数字、单选值；是否不参与四则', () => {
    expect(run('(1 + 2) * 3 - 4 / 2')).toEqual(num(7));
    expect(run('7 % 3')).toMatchObject({ code: 'SYNTAX_ERROR' });
    expect(run('真 + 1')).toMatchObject({ code: 'TYPE_CONVERSION' });
  });
  it('条件为空按“否”处理，条件不是是否型则失败', () => {
    expect(run('如果 盘点对象.x 那么 1 否则 0', { '盘点对象.x': null })).toEqual(num(0));
    expect(run('如果 1 那么 1 否则 0')).toMatchObject({ code: 'TYPE_CONVERSION' });
  });
  it('失败带上出错位置', () => {
    expect(run('1 +\n盘点对象.x', { '盘点对象.x': 'abc' })).toMatchObject({ code: 'TEXT_IN_ARITHMETIC', line: 2 });
  });
});

describe('绩效取数：英文名与中文名各自实际求值（astra 首审 P3-2）', () => {
  const record = (year: number, score: number, grade: string, modifiedAt: string) => ({
    fields: { 年度: year, 周期名称: '年度', 得分: score, 等级: grade },
    modifiedAt: new Date(modifiedAt),
  });
  const ports = createInMemoryPorts({
    performance: { s: [record(2026, 92, 'A', '2026-07-01T00:00:00Z'), record(2024, 75, 'C', '2025-01-01T00:00:00Z')] },
  });
  const runWithPorts = (formula: string) => {
    const result = evaluateFormula(formula, { ...context(), ports });
    return result.ok ? result.value : result.failure;
  };

  it('PerformanceCent / PerformanceGrade 与中文名', () => {
    expect(runWithPorts('PerformanceCent(考核结果.年度=2026, 考核结果.周期名称="年度")')).toEqual(num(92));
    expect(runWithPorts('PerformanceGrade(考核结果.年度=2026, 考核结果.周期名称="年度")')).toEqual(text('A'));
    expect(runWithPorts('获取指定年度指定周期的绩效得分(考核结果.年度=2024, 考核结果.周期名称="年度")')).toEqual(
      num(75),
    );
    expect(runWithPorts('获取指定年度指定周期的绩效等级(考核结果.年度=2024, 考核结果.周期名称="年度")')).toEqual(
      text('C'),
    );
  });

  it('PerformanceLastCent / PerformanceLastGrade 与中文名（参考年 = 今天所在年 2026）', () => {
    expect(runWithPorts('PerformanceLastCent(1)')).toEqual(num(92));
    expect(runWithPorts('PerformanceLastGrade(2)')).toEqual(text('C'));
    expect(runWithPorts('获取最近第N年度的绩效得分(2)')).toEqual(num(75));
    expect(runWithPorts('获取最近第N年度的绩效等级(1)')).toEqual(text('A'));
  });
});
