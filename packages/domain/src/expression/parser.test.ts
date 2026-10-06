import { describe, expect, it } from 'vitest';
import { parseFormula } from './parser.js';
import { tokenize } from './lexer.js';

const ok = (source: string) => {
  const result = parseFormula(source);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.program;
};
const fail = (source: string) => {
  const result = parseFormula(source);
  if (result.ok) throw new Error('应当报错');
  return result.errors[0]!;
};

describe('词法：字段引用、数字、字符串、全角符号', () => {
  it('以数字开头的中文对象名与含连字符的字段名是一个标识符', () => {
    const kinds = tokenize('360结果.问卷-他评总分').map((token) => `${token.kind}:${token.text}`);
    expect(kinds).toEqual(['identifier:360结果', 'dot:.', 'identifier:问卷-他评总分', 'eof:']);
  });

  it('连字符后面是数字时仍是减号', () => {
    const kinds = tokenize('考核结果.年度-1').map((token) => token.kind);
    expect(kinds).toEqual(['identifier', 'dot', 'identifier', 'operator', 'number', 'eof']);
  });

  it('全角括号、逗号、分号和比较符都能识别；百分比是数字', () => {
    const texts = tokenize('ToNumber（a，b）； x ≥ 82%').map((token) => token.text);
    expect(texts).toEqual(['ToNumber', '（', 'a', '，', 'b', '）', '；', 'x', '≥', '82%', '']);
  });

  it('位置：行列从 1 起算，换行后列重置', () => {
    const tokens = tokenize('a\n  bb');
    expect(tokens[1]).toMatchObject({ text: 'bb', line: 2, column: 3 });
  });
});

describe('语法：四则优先级、逻辑、if 多段、Def', () => {
  it('四则运算优先级与一元负号', () => {
    const program = ok('-1 + 2 * 3');
    expect(program.body).toMatchObject({
      type: 'binary',
      operator: '+',
      left: { type: 'unary', operator: '-' },
      right: { type: 'binary', operator: '*' },
    });
  });

  it('且 的优先级高于 或；非 可用于比较', () => {
    expect(ok('a 或 b 且 c').body).toMatchObject({ type: 'logical', operator: 'or', right: { operator: 'and' } });
    expect(ok('非 a = 1').body).toMatchObject({ type: 'logical', operator: 'not', operand: { type: 'binary' } });
  });

  it('如果…那么…如果…那么…否则 展开为多段分支', () => {
    const program = ok('如果 a>1 那么 3 如果 a>0 那么 2 否则 1');
    expect(program.body).toMatchObject({ type: 'if', branches: [{}, {}], otherwise: { type: 'number', value: 1 } });
  });

  it('else if 与 否则 如果 等价，允许无 否则', () => {
    expect(ok('if a then 1 else if b then 2').body).toMatchObject({ type: 'if', branches: [{}, {}] });
    expect(ok('如果 a 那么 1 否则 如果 b 那么 2 否则 3').body).toMatchObject({ branches: [{}, {}], otherwise: {} });
  });

  it('Def 语句以分号分隔，主表达式可带结尾分号', () => {
    const program = ok('Def(x, 1); 定义(y, x + 1); x + y;');
    expect(program.definitions.map((definition) => definition.name)).toEqual(['x', 'y']);
    expect(program.body).toMatchObject({ type: 'binary', operator: '+' });
  });

  it('函数调用参数保留原始语法树（供惰性求值）', () => {
    const program = ok('PerformanceCent(考核结果.年度="2026", 考核结果.周期名称="年度")');
    expect(program.body).toMatchObject({
      type: 'call',
      name: 'PerformanceCent',
      args: [{ type: 'binary' }, { type: 'binary' }],
    });
  });
});

describe('语法错误：位置与原因', () => {
  it('中文引号', () => {
    expect(fail('a = “高”')).toMatchObject({ code: 'CHINESE_QUOTE', line: 1, column: 5 });
  });
  it('未闭合字符串', () => {
    expect(fail('a = "高')).toMatchObject({ code: 'SYNTAX_ERROR', column: 5 });
  });
  it('缺少右括号与多余的 token', () => {
    expect(fail('ToNumber(a')).toMatchObject({ code: 'SYNTAX_ERROR', column: 11 });
    expect(fail('1 2')).toMatchObject({ code: 'SYNTAX_ERROR', column: 3 });
  });
  it('缺少 那么', () => {
    expect(fail('如果 a 1 否则 2')).toMatchObject({ code: 'SYNTAX_ERROR', column: 6 });
  });
  it('空公式', () => {
    expect(fail('   ')).toMatchObject({ code: 'SYNTAX_ERROR' });
  });
});
