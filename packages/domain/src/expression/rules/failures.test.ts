/**
 * R3-T05 B1：求值失败 → “第 n 行条件出错”（设计 §3.4）。定位只看 rowSpans，文案按错误码固定映射，
 * 引擎 message 可能带字段值，任何出口都不得使用。
 */
import { describe, expect, it } from 'vitest';
import { evaluateFormula } from '../engine.js';
import type { ComputationFailure, FailureCode } from '../failures.js';
import type { FieldLookup } from '../ports.js';
import type { PlainValue } from '../values.js';
import { compileRuleSet, type RuleFieldCatalog } from './compile.js';
import { describeRuleFailure, locateRuleRow } from './failures.js';
import type { RuleConditionRow, RuleFieldRef } from './types.js';

const SPANS = [
  { rowNo: 1, start: 3, end: 10 },
  { rowNo: 2, start: 15, end: 22 },
  { rowNo: 1, start: 27, end: 34 },
] as const;

describe('locateRuleRow：offset 落在哪个区间就是哪一行', () => {
  it('区间左闭右开；同一行多处引用都能定位；组合层与越界返回 undefined', () => {
    expect(locateRuleRow(SPANS, 3)).toBe(1);
    expect(locateRuleRow(SPANS, 9)).toBe(1);
    expect(locateRuleRow(SPANS, 10)).toBeUndefined();
    expect(locateRuleRow(SPANS, 15)).toBe(2);
    expect(locateRuleRow(SPANS, 30)).toBe(1);
    expect(locateRuleRow(SPANS, 0)).toBeUndefined();
    expect(locateRuleRow(SPANS, 99)).toBeUndefined();
    expect(locateRuleRow(SPANS, undefined)).toBeUndefined();
    expect(locateRuleRow(SPANS, -1)).toBeUndefined();
  });
});

describe('describeRuleFailure：固定文案映射（§3.4 表）', () => {
  const at = (code: FailureCode, offset = 16): ComputationFailure => ({ code, message: '引擎文案：含 机密值', offset });

  it.each([
    ['TYPE_CONVERSION', '第 2 行条件出错：比较或转换时类型不符'],
    ['ARGUMENT_TYPE', '第 2 行条件出错：比较或转换时类型不符'],
    ['EMPTY_IN_COMPARISON', '第 2 行条件出错：空值参与运算'],
    ['EMPTY_IN_ARITHMETIC', '第 2 行条件出错：空值参与运算'],
    ['DIVISION_BY_ZERO', '第 2 行条件出错：除以 0'],
    ['FIELD_FORBIDDEN', '第 2 行条件出错：计算主体无权读取字段'],
    ['DATA_UNAVAILABLE', '第 2 行条件出错：数据源不可用'],
    ['UNKNOWN_FIELD', '第 2 行条件出错：规则需要重新编译'],
    ['UNKNOWN_FUNCTION', '第 2 行条件出错：规则需要重新编译'],
    ['SYNTAX_ERROR', '第 2 行条件出错：规则需要重新编译'],
  ] as const)('%s → %s', (code, text) => {
    expect(describeRuleFailure(at(code), SPANS)).toEqual({ code, rowNo: 2, text });
  });

  it('其他错误码或定位不到行 → “条件表达式出错”', () => {
    expect(describeRuleFailure(at('INTERNAL_ERROR'), SPANS)).toEqual({
      code: 'INTERNAL_ERROR',
      text: '条件表达式出错',
    });
    expect(describeRuleFailure(at('DATA_FORBIDDEN'), SPANS)).toEqual({
      code: 'DATA_FORBIDDEN',
      text: '条件表达式出错',
    });
    expect(describeRuleFailure(at('TYPE_CONVERSION', 12), SPANS)).toEqual({
      code: 'TYPE_CONVERSION',
      text: '条件表达式出错',
    });
    expect(describeRuleFailure({ code: 'FIELD_FORBIDDEN', message: 'x' }, SPANS)).toEqual({
      code: 'FIELD_FORBIDDEN',
      text: '条件表达式出错',
    });
  });

  it('结果只含 code / rowNo / text，不透出引擎 message', () => {
    const report = describeRuleFailure(at('TYPE_CONVERSION'), SPANS);
    expect(Object.keys(report).sort()).toEqual(['code', 'rowNo', 'text']);
    expect(JSON.stringify(report)).not.toContain('机密');
  });
});

describe('与引擎联调：真实求值失败定位到行，且文案不含字段值', () => {
  const SCORE: RuleFieldRef = { object: 'review_object', code: 'score', path: '盘点对象.得分', kind: 'number' };
  const catalog: RuleFieldCatalog = { resolve: () => SCORE };
  const rows: RuleConditionRow[] = [
    { rowNo: 1, kind: 'aggregate', operator: 'not_empty' },
    { rowNo: 2, kind: 'field', field: SCORE, operator: 'gt', values: [5] },
  ];
  const result = compileRuleSet({ rows, expression: '1 and 2' }, catalog);
  if (!result.ok) throw new Error('应当编译成功');
  const { formula, rowSpans } = result.compiled;

  const evaluate = (fields: Record<string, PlainValue>, forbidden: readonly string[] = []) =>
    evaluateFormula(formula, {
      subject: {
        id: 's',
        resolveField(path): FieldLookup {
          if (forbidden.includes(path)) return { status: 'forbidden' };
          return Object.hasOwn(fields, path) ? { status: 'found', value: fields[path] } : { status: 'unknown' };
        },
      },
      calendar: { today: '2026-10-09', timeZone: 'Asia/Shanghai' },
      fieldKind: (path) => (path === SCORE.path || path.startsWith('行') ? 'number' : undefined),
    });

  it('无权字段 → 第 2 行：计算主体无权读取字段', () => {
    const outcome = evaluate({ '行1.值': 1 }, [SCORE.path]);
    if (outcome.ok) throw new Error('应当失败');
    expect(describeRuleFailure(outcome.failure, rowSpans)).toEqual({
      code: 'FIELD_FORBIDDEN',
      rowNo: 2,
      text: '第 2 行条件出错：计算主体无权读取字段',
    });
  });

  it('文本值参与大小比较 → 类型不符；引擎文案带的字段值不出现在结果里', () => {
    const outcome = evaluate({ '行1.值': 1, [SCORE.path]: '机密文本' });
    if (outcome.ok) throw new Error('应当失败');
    expect(outcome.failure.message).toContain('机密文本'); // 前提：引擎原文案确实带值
    const report = describeRuleFailure(outcome.failure, rowSpans);
    expect(report).toEqual({ code: 'TYPE_CONVERSION', rowNo: 2, text: '第 2 行条件出错：比较或转换时类型不符' });
    expect(JSON.stringify(report)).not.toContain('机密文本');
  });
});
