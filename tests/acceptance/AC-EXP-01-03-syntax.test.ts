/**
 * AC-EXP-01～03：原站租户公式兼容、缺“否则”的多段 if、保存时语法校验返回行列（`26` §8.1，REQ-EXP-001）。
 */
import { evaluateFormula, validateFormula } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { contextFor } from './AC-EXP-support.js';

const performanceRecord = (year: number, period: string, score: number, modifiedAt: string) => ({
  fields: { 年度: year, 周期名称: period, 得分: score, 等级: score >= 90 ? 'A' : 'B' },
  modifiedAt: new Date(modifiedAt),
});

const ports = {
  performance: {
    'emp-1': [performanceRecord(2026, '年度', 92, '2026-07-01T00:00:00Z')],
    'emp-2': [performanceRecord(2026, '年度', 85, '2026-07-01T00:00:00Z')],
    'emp-3': [performanceRecord(2026, '年度', 60, '2026-07-01T00:00:00Z')],
  },
};

// 本租户 GLD盘点规则HTC 的实际写法：中文函数名、全角 ≤ / ≥、年度带引号与不带引号、“且”
const GLD_RULE = [
  '如果 获取指定年度指定周期的绩效得分(考核结果.年度="2026",考核结果.周期名称="年度") ≥ 90 那么 3',
  '如果 获取指定年度指定周期的绩效得分(考核结果.年度=2026,考核结果.周期名称="年度") > 80',
  '且 获取指定年度指定周期的绩效得分(考核结果.年度=2026,考核结果.周期名称="年度") ≤ 90 那么 2',
  '否则 1',
].join('\n');

describe('AC-EXP-01 原站租户公式（GLD盘点规则HTC 写法）能解析并按预期求值', () => {
  it('中文函数名 + 全角比较符 + 带 / 不带引号的年度 + 且', () => {
    expect(validateFormula(GLD_RULE).ok).toBe(true);
    const run = (subjectId: string) => evaluateFormula(GLD_RULE, contextFor({}, { ports, subjectId }));
    expect(run('emp-1')).toEqual({ ok: true, value: { kind: 'number', value: 3 } });
    expect(run('emp-2')).toEqual({ ok: true, value: { kind: 'number', value: 2 } });
    expect(run('emp-3')).toEqual({ ok: true, value: { kind: 'number', value: 1 } });
  });

  it('英文写法与中文写法等价：if / then / else、and、<=、PerformanceCent', () => {
    const english = [
      'if PerformanceCent(考核结果.年度="2026", 考核结果.周期名称="年度") >= 90 then 3',
      'else if PerformanceCent(考核结果.年度=2026, 考核结果.周期名称="年度") > 80',
      'and PerformanceCent(考核结果.年度=2026, 考核结果.周期名称="年度") <= 90 then 2 else 1',
    ].join(' ');
    expect(evaluateFormula(english, contextFor({}, { ports, subjectId: 'emp-2' }))).toEqual({
      ok: true,
      value: { kind: 'number', value: 2 },
    });
  });

  it('Def(变量, 表达式); 之后的主表达式可以引用变量', () => {
    const formula = 'Def(分, ToNumber(盘点对象.绩效得分));\n如果 分 ≥ 90 那么 "高" 否则 "低"';
    expect(evaluateFormula(formula, contextFor({ '盘点对象.绩效得分': 95 }))).toEqual({
      ok: true,
      value: { kind: 'text', value: '高' },
    });
  });
});

describe('AC-EXP-02 缺“否则”的多段 if', () => {
  const formula = '如果 盘点对象.得分 > 90 那么 3 如果 盘点对象.得分 > 80 那么 2 否则 1';

  it('能保存（校验通过）并按分段顺序求值', () => {
    expect(validateFormula(formula).ok).toBe(true);
    expect(evaluateFormula(formula, contextFor({ '盘点对象.得分': 95 }))).toMatchObject({ value: { value: 3 } });
    expect(evaluateFormula(formula, contextFor({ '盘点对象.得分': 85 }))).toMatchObject({ value: { value: 2 } });
    expect(evaluateFormula(formula, contextFor({ '盘点对象.得分': 70 }))).toMatchObject({ value: { value: 1 } });
  });

  it('没有任何分支命中且没有 否则 时结果为空', () => {
    const noElse = '如果 盘点对象.得分 > 90 那么 3 如果 盘点对象.得分 > 80 那么 2';
    expect(evaluateFormula(noElse, contextFor({ '盘点对象.得分': 70 }))).toEqual({ ok: true, value: { kind: 'empty' } });
  });
});

describe('AC-EXP-03 保存时语法校验返回报错位置（原站不校验，复刻改进）', () => {
  it('中文引号：指出行列并说明须用英文双引号', () => {
    const result = validateFormula('如果 盘点对象.等级 = “高”\n那么 1 否则 0');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ code: 'CHINESE_QUOTE', line: 1, column: 14 });
  });

  it('缺右括号：报错落在第二行', () => {
    const result = validateFormula('Def(x, 1);\nToNumber(盘点对象.得分 + 1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ code: 'SYNTAX_ERROR', line: 2 });
  });

  it('未知函数与参数个数不符在保存时就能发现', () => {
    const unknown = validateFormula('不存在的函数(1)');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errors[0]).toMatchObject({ code: 'UNKNOWN_FUNCTION', line: 1, column: 1 });

    const arity = validateFormula('PerformanceCent(考核结果.年度=2026)');
    expect(arity.ok).toBe(false);
    if (!arity.ok) expect(arity.errors[0]).toMatchObject({ code: 'ARGUMENT_COUNT' });
  });

  it('校验通过时返回引用到的字段与函数，供使用方做依赖分析', () => {
    const result = validateFormula('如果 盘点对象.得分 > 盘点对象.基准 那么 Average(盘点对象.得分, 1) 否则 0');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields).toEqual(['盘点对象.得分', '盘点对象.基准']);
    expect(result.functions).toEqual(['Average']);
  });
});
