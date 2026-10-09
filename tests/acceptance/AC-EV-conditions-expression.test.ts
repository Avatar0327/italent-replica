/**
 * AC-EV-conditions 参评条件纯函数（R3-T02 设计 §3.2 / §10 表达式行、EV-R10 / EV-R11；拆分方案 B2）：
 * 明细 9 种运算符的取值形状；组合表达式用 R3-T00 的 validateFormula 校验，只能引用存在的条件序号（条件1…条件n）。
 * 本 PR 不按人员求值（求值在 C2）。
 */
import {
  ACTIVITY_CONDITION_OPERATORS,
  activityConditionField,
  evaluateFormula,
  inMemorySubject,
  validateActivityConditionDetails,
  validateActivityConditionExpression,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';

const detail = (seq: number, operator: string, value1?: string | number | null, value2?: string | number | null) => ({
  seq,
  operator,
  value1,
  value2,
});

describe('AC-EV-conditions 明细运算符（9 种 🟢）', () => {
  it('运算符全集：等于、不等于、大于、小于、大于等于、小于等于、为空、不为空、范围', () => {
    expect([...ACTIVITY_CONDITION_OPERATORS].sort()).toEqual(
      ['between', 'eq', 'ge', 'gt', 'is_empty', 'le', 'lt', 'ne', 'not_empty'].sort(),
    );
  });

  it('合法形状：比较类要 value1；为空 / 不为空不带值；范围要 value1 与 value2', () => {
    const details = [
      detail(1, 'ge', 99),
      detail(2, 'eq', '教师'),
      detail(3, 'is_empty'),
      detail(4, 'not_empty', null, null),
      detail(5, 'between', 1, 5),
      detail(6, 'le', '2026-09-15'),
    ];
    expect(validateActivityConditionDetails(details)).toEqual({ ok: true });
  });

  it.each(['eq', 'ne', 'gt', 'lt', 'ge', 'le'])(
    '%s 缺 value1 → VALUE_REQUIRED；多给 value2 → VALUE_NOT_ALLOWED',
    (op) => {
      expect(validateActivityConditionDetails([detail(1, op)])).toEqual({
        ok: false,
        issues: [{ seq: 1, code: 'VALUE_REQUIRED' }],
      });
      expect(validateActivityConditionDetails([detail(1, op, '', null)])).toEqual({
        ok: false,
        issues: [{ seq: 1, code: 'VALUE_REQUIRED' }],
      });
      expect(validateActivityConditionDetails([detail(1, op, 1, 2)])).toEqual({
        ok: false,
        issues: [{ seq: 1, code: 'VALUE_NOT_ALLOWED' }],
      });
    },
  );

  it.each(['is_empty', 'not_empty'])('%s 不接受任何值', (op) => {
    expect(validateActivityConditionDetails([detail(1, op, 1)])).toEqual({
      ok: false,
      issues: [{ seq: 1, code: 'VALUE_NOT_ALLOWED' }],
    });
    expect(validateActivityConditionDetails([detail(1, op, null, 2)])).toEqual({
      ok: false,
      issues: [{ seq: 1, code: 'VALUE_NOT_ALLOWED' }],
    });
  });

  it('范围缺一端 → VALUE_REQUIRED；数字上下界颠倒 → RANGE_INVERTED；相等允许', () => {
    expect(validateActivityConditionDetails([detail(1, 'between', 1)])).toEqual({
      ok: false,
      issues: [{ seq: 1, code: 'VALUE_REQUIRED' }],
    });
    expect(validateActivityConditionDetails([detail(1, 'between', 5, 1)])).toEqual({
      ok: false,
      issues: [{ seq: 1, code: 'RANGE_INVERTED' }],
    });
    expect(validateActivityConditionDetails([detail(1, 'between', 3, 3)])).toEqual({ ok: true });
  });

  it('未知运算符 → OPERATOR_INVALID；序号须为正整数且不重复', () => {
    expect(validateActivityConditionDetails([detail(1, 'like', 'x')])).toEqual({
      ok: false,
      issues: [{ seq: 1, code: 'OPERATOR_INVALID' }],
    });
    expect(validateActivityConditionDetails([detail(0, 'is_empty'), detail(1.5, 'is_empty')])).toEqual({
      ok: false,
      issues: [
        { seq: 0, code: 'SEQ_INVALID' },
        { seq: 1.5, code: 'SEQ_INVALID' },
      ],
    });
    expect(validateActivityConditionDetails([detail(2, 'is_empty'), detail(2, 'not_empty')])).toEqual({
      ok: false,
      issues: [{ seq: 2, code: 'SEQ_DUPLICATE' }],
    });
  });

  it('没有明细也合法（不设条件则不校验，EV-R10）', () => {
    expect(validateActivityConditionDetails([])).toEqual({ ok: true });
  });
});

describe('AC-EV-conditions 组合表达式：只引用存在的序号（validateFormula）', () => {
  const seqs = [1, 2, 3];

  it('字段名 = 条件 + 序号', () => {
    expect(activityConditionField(2)).toBe('条件2');
  });

  it('合法表达式返回去重后的引用序号', () => {
    expect(validateActivityConditionExpression('条件1 and (条件2 or 条件3)', seqs)).toEqual({
      ok: true,
      referencedSeqs: [1, 2, 3],
    });
    expect(validateActivityConditionExpression('条件1 and 条件1', seqs)).toEqual({ ok: true, referencedSeqs: [1] });
    expect(validateActivityConditionExpression('条件3 且 not 条件2', seqs)).toMatchObject({
      ok: true,
      referencedSeqs: [3, 2],
    });
  });

  it('引用不存在的序号 → CONDITION_SEQ_UNKNOWN，带行列', () => {
    const result = validateActivityConditionExpression('条件1 and 条件9', seqs);
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'CONDITION_SEQ_UNKNOWN', line: 1, column: 8 }] });
  });

  it('引用条件以外的字段 → CONDITION_SEQ_UNKNOWN（不借表达式读别的数据）', () => {
    expect(validateActivityConditionExpression('员工.年龄 > 30', seqs)).toMatchObject({
      ok: false,
      errors: [{ code: 'CONDITION_SEQ_UNKNOWN' }],
    });
  });

  it('语法错误 → EXPRESSION_SYNTAX', () => {
    expect(validateActivityConditionExpression('条件1 and (条件2', seqs)).toMatchObject({
      ok: false,
      errors: [{ code: 'EXPRESSION_SYNTAX' }],
    });
    expect(validateActivityConditionExpression('条件1 and', seqs)).toMatchObject({ ok: false });
  });

  it('空白表达式 → EXPRESSION_EMPTY（是否允许不设表达式由调用方决定）', () => {
    expect(validateActivityConditionExpression('   ', seqs)).toEqual({
      ok: false,
      errors: [{ code: 'EXPRESSION_EMPTY' }],
    });
  });

  it('没有任何明细时，任何序号引用都不存在', () => {
    expect(validateActivityConditionExpression('条件1', [])).toMatchObject({
      ok: false,
      errors: [{ code: 'CONDITION_SEQ_UNKNOWN' }],
    });
  });

  it('校验过的表达式能交给 evaluateFormula 以条件序号为布尔字段求值（C2 用法的衔接）', () => {
    const subject = inMemorySubject('e1', { 条件1: true, 条件2: false, 条件3: true });
    const calendar = { today: '2026-10-09', timeZone: 'Asia/Shanghai' };
    const result = evaluateFormula('条件1 and (条件2 or 条件3)', { subject, calendar });
    expect(result).toEqual({ ok: true, value: { kind: 'boolean', value: true } });
  });
});
