/**
 * R3-T05 B1：parseRowExpression（设计 §3.3 第 1 条）。词法只认 and / or / 括号 / 正整数；错误只带码和位置，不带文案。
 */
import { describe, expect, it } from 'vitest';
import { parseRowExpression, type RowExpressionNode } from './row-expression.js';

const parsed = (source: string) => {
  const result = parseRowExpression(source);
  if (!result.ok) throw new Error(`应当解析成功：${JSON.stringify(result.error)}`);
  return result;
};
const failed = (source: string) => {
  const result = parseRowExpression(source);
  if (result.ok) throw new Error('应当报错');
  return result.error;
};
const row = (rowNo: number): RowExpressionNode => ({ kind: 'row', rowNo });

describe('parseRowExpression：文法 expr := term (or term)*; term := factor (and factor)*', () => {
  it('and 比 or 先结合；连续同类运算展平', () => {
    expect(parsed('1 or 2 and 3').root).toEqual({
      kind: 'or',
      operands: [row(1), { kind: 'and', operands: [row(2), row(3)] }],
    });
    expect(parsed('1 and 2 and 3').root).toEqual({ kind: 'and', operands: [row(1), row(2), row(3)] });
    expect(parsed('1 or 2 or 3').root).toEqual({ kind: 'or', operands: [row(1), row(2), row(3)] });
  });

  it('括号改变结合；多余括号不产生节点', () => {
    expect(parsed('(1 or 2) and 3').root).toEqual({
      kind: 'and',
      operands: [{ kind: 'or', operands: [row(1), row(2)] }, row(3)],
    });
    expect(parsed('((1))').root).toEqual(row(1));
    expect(parsed('1 and (2 and 3)').root).toEqual({ kind: 'and', operands: [row(1), row(2), row(3)] });
  });

  it('大小写不敏感，容忍无空格', () => {
    const expected = { kind: 'and', operands: [row(1), row(2)] };
    expect(parsed('1 AND 2').root).toEqual(expected);
    expect(parsed('1And2').root).toEqual(expected);
    expect(parsed('(1)and(2)').root).toEqual(expected);
    expect(parsed('  1\tand\n2 ').root).toEqual(expected);
    expect(parsed('1 OR 2').root).toEqual({ kind: 'or', operands: [row(1), row(2)] });
  });

  it('按出现顺序列出全部行引用（含重复）与偏移', () => {
    const result = parsed('1 and (2 or 1)');
    expect(result.refs).toEqual([
      { rowNo: 1, offset: 0 },
      { rowNo: 2, offset: 7 },
      { rowNo: 1, offset: 12 },
    ]);
  });
});

describe('parseRowExpression：错误（RULE_EXPRESSION_SYNTAX，位置为字符偏移）', () => {
  it.each([
    ['', 0],
    ['   ', 3],
    ['1 and', 5],
    ['and 1', 0],
    ['1 2', 2],
    ['(1', 2],
    ['1)', 1],
    ['()', 1],
    ['1 and and 2', 6],
    ['0', 0],
    ['01', 0],
    ['1 xor 2', 2],
    ['1 andor 2', 2],
    ['（1）', 0],
    ['1 且 2', 2],
    ['1 && 2', 2],
    ['-1', 0],
    ['1.5', 1],
    ['a', 0],
    ['1234567890', 0],
  ])('%j → 语法错误 @%i', (source, offset) => {
    expect(failed(source)).toEqual({ code: 'RULE_EXPRESSION_SYNTAX', offset });
  });
});

describe('parseRowExpression：括号嵌套 ≤ 20', () => {
  const nested = (depth: number) => `${'('.repeat(depth)}1${')'.repeat(depth)}`;

  it('20 层通过，21 层 RULE_TOO_LARGE（定位在第 21 个左括号）', () => {
    expect(parsed(nested(20)).root).toEqual(row(1));
    expect(failed(nested(21))).toEqual({ code: 'RULE_TOO_LARGE', offset: 20 });
  });

  it('极深嵌套不会栈溢出，直接拒绝', () => {
    expect(failed('('.repeat(100_000))).toEqual({ code: 'RULE_TOO_LARGE', offset: 20 });
  });
});
