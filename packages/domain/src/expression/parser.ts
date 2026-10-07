/**
 * 递归下降语法分析（REQ-EXP-001）。文法：
 *   program := (def ';')* expr ';'?
 *   def     := ('Def' | '定义') '(' 标识符 ',' expr ')'
 *   expr    := if | or
 *   if      := 如果 expr 那么 expr (if | 否则 expr)?        —— 多段 if，允许缺“否则”（本租户写法，`26` §8.1）
 *   or      := and (或 and)* ；and := not (且 not)* ；not := 非 not | cmp
 *   cmp     := add (比较符 add)? ；add := mul (('+'|'-') mul)* ；mul := unary (('*'|'/') unary)*
 *   unary   := ('-'|'+') unary | primary
 *   primary := 数字 | 字符串 | 真 | 假 | '(' expr ')' | 调用 | 字段引用 | 标识符
 */
import type { BinaryOperator, CallNode, Definition, ExprNode, IfBranch, Program } from './ast.js';
import type { SourcePosition } from './failures.js';
import { SyntaxIssueError, tokenize, type Keyword, type SyntaxIssue, type Token } from './lexer.js';

export type ParseResult =
  { readonly ok: true; readonly program: Program } | { readonly ok: false; readonly errors: SyntaxIssue[] };

const DEF_NAMES = new Set(['def', '定义']);
const COMPARISONS = new Set(['=', '!=', '<', '>', '<=', '>=']);

/** 公式规模上限（astra 首审 P2-5）：超出直接报语法错误，避免解析 / 求值递归栈溢出。 */
export const MAX_FORMULA_LENGTH = 4000;
export const MAX_FORMULA_TOKENS = 800;
export const MAX_NESTING_DEPTH = 100;

class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parseProgram(): Program {
    const definitions: Definition[] = [];
    while (this.isDefinitionStart()) {
      definitions.push(this.parseDefinition());
      this.expect('semicolon', '缺少分号');
    }
    if (this.peek().kind === 'eof') this.error(definitions.length ? '缺少主表达式' : '公式为空');
    const body = this.parseExpr();
    if (this.peek().kind === 'semicolon') this.index++;
    if (this.peek().kind !== 'eof') this.error(`多余的内容“${this.peek().text}”`);
    return { definitions, body };
  }

  private peek(ahead = 0): Token {
    return this.tokens[Math.min(this.index + ahead, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const token = this.peek();
    if (token.kind !== 'eof') this.index++;
    return token;
  }

  private at(kind: Token['kind'], value?: string): boolean {
    const token = this.peek();
    return token.kind === kind && (value === undefined || token.value === value);
  }

  private atKeyword(keyword: Keyword): boolean {
    return this.at('keyword', keyword);
  }

  private error(message: string, token: Token = this.peek()): never {
    const length = Math.max(token.text.length, 1);
    const position: SourcePosition = { line: token.line, column: token.column, offset: token.offset };
    throw new SyntaxIssueError({ code: 'SYNTAX_ERROR', message, length, ...position });
  }

  private expect(kind: Token['kind'], message: string): Token {
    if (!this.at(kind)) this.error(message);
    return this.next();
  }

  private expectKeyword(keyword: Keyword, message: string): void {
    if (!this.atKeyword(keyword)) this.error(message);
    this.next();
  }

  private pos(token: Token): SourcePosition {
    return { line: token.line, column: token.column, offset: token.offset };
  }

  private isDefinitionStart(): boolean {
    return (
      this.at('identifier') && DEF_NAMES.has(String(this.peek().value).toLowerCase()) && this.peek(1).kind === 'lparen'
    );
  }

  private parseDefinition(): Definition {
    const start = this.next();
    this.expect('lparen', 'Def 后缺少左括号');
    const nameToken = this.expect('identifier', 'Def 的第一个参数须是变量名');
    this.expect('comma', 'Def 的变量名后缺少逗号');
    const value = this.parseExpr();
    this.expect('rparen', 'Def 缺少右括号');
    return { name: String(nameToken.value), value, pos: this.pos(start) };
  }

  /** 括号、函数参数、如果、一元运算每进一层计一次深度。 */
  private nested<T>(parse: () => T): T {
    if (++this.depth > MAX_NESTING_DEPTH) this.error(`公式嵌套过深（超过 ${MAX_NESTING_DEPTH} 层）`);
    try {
      return parse();
    } finally {
      this.depth--;
    }
  }

  private parseExpr(): ExprNode {
    return this.nested(() => (this.atKeyword('if') ? this.parseIf() : this.parseOr()));
  }

  private parseIf(): ExprNode {
    const start = this.next();
    const branches: IfBranch[] = [];
    let otherwise: ExprNode | undefined;
    for (;;) {
      const condition = this.parseOr();
      this.expectKeyword('then', '如果 后面缺少 那么');
      branches.push({ condition, then: this.parseExpr() });
      if (this.atKeyword('if')) {
        this.next();
        continue;
      }
      if (!this.atKeyword('else')) break;
      this.next();
      if (this.atKeyword('if')) {
        this.next();
        continue;
      }
      otherwise = this.parseExpr();
      break;
    }
    return otherwise
      ? { type: 'if', branches, otherwise, pos: this.pos(start) }
      : { type: 'if', branches, pos: this.pos(start) };
  }

  private parseOr(): ExprNode {
    let left = this.parseAnd();
    while (this.atKeyword('or')) {
      const token = this.next();
      left = { type: 'logical', operator: 'or', left, right: this.parseAnd(), pos: this.pos(token) };
    }
    return left;
  }

  private parseAnd(): ExprNode {
    let left = this.parseNot();
    while (this.atKeyword('and')) {
      const token = this.next();
      left = { type: 'logical', operator: 'and', left, right: this.parseNot(), pos: this.pos(token) };
    }
    return left;
  }

  private parseNot(): ExprNode {
    if (!this.atKeyword('not')) return this.parseComparison();
    const token = this.next();
    return { type: 'logical', operator: 'not', operand: this.nested(() => this.parseNot()), pos: this.pos(token) };
  }

  private parseComparison(): ExprNode {
    const left = this.parseAdditive();
    if (!this.at('operator') || !COMPARISONS.has(String(this.peek().value))) return left;
    const token = this.next();
    const operator = token.value as BinaryOperator;
    return { type: 'binary', operator, left, right: this.parseAdditive(), pos: this.pos(token) };
  }

  private parseAdditive(): ExprNode {
    let left = this.parseMultiplicative();
    while (this.at('operator', '+') || this.at('operator', '-')) {
      const token = this.next();
      const operator = token.value as BinaryOperator;
      left = { type: 'binary', operator, left, right: this.parseMultiplicative(), pos: this.pos(token) };
    }
    return left;
  }

  private parseMultiplicative(): ExprNode {
    let left = this.parseUnary();
    while (this.at('operator', '*') || this.at('operator', '/')) {
      const token = this.next();
      const operator = token.value as BinaryOperator;
      left = { type: 'binary', operator, left, right: this.parseUnary(), pos: this.pos(token) };
    }
    return left;
  }

  private parseUnary(): ExprNode {
    if (this.at('operator', '-') || this.at('operator', '+')) {
      const token = this.next();
      const operand = this.nested(() => this.parseUnary());
      return { type: 'unary', operator: token.value as '-' | '+', operand, pos: this.pos(token) };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExprNode {
    const token = this.peek();
    switch (token.kind) {
      case 'number':
        this.next();
        return { type: 'number', value: token.value as number, percent: token.percent === true, pos: this.pos(token) };
      case 'string':
        this.next();
        return { type: 'string', value: String(token.value), pos: this.pos(token) };
      case 'keyword':
        return this.parseKeywordPrimary(token);
      case 'lparen': {
        this.next();
        const inner = this.parseExpr();
        this.expect('rparen', '缺少右括号');
        return inner;
      }
      case 'identifier':
        return this.peek(1).kind === 'lparen' ? this.parseCall() : this.parseReference();
      case 'eof':
        return this.error('公式不完整，缺少表达式');
      default:
        return this.error(`此处不应出现“${token.text}”`);
    }
  }

  private parseKeywordPrimary(token: Token): ExprNode {
    if (token.value === 'true' || token.value === 'false') {
      this.next();
      return { type: 'boolean', value: token.value === 'true', pos: this.pos(token) };
    }
    if (token.value === 'if') return this.parseIf();
    return this.error(`此处不应出现“${token.text}”`);
  }

  private parseCall(): CallNode {
    const nameToken = this.next();
    this.expect('lparen', '函数名后缺少左括号');
    const args: ExprNode[] = [];
    if (!this.at('rparen')) {
      args.push(this.parseExpr());
      while (this.at('comma')) {
        this.next();
        args.push(this.parseExpr());
      }
    }
    this.expect('rparen', '函数调用缺少右括号');
    return { type: 'call', name: String(nameToken.value), args, pos: this.pos(nameToken) };
  }

  private parseReference(): ExprNode {
    const first = this.next();
    const path = [String(first.value)];
    while (this.at('dot')) {
      this.next();
      path.push(String(this.expect('identifier', '“.”后面缺少字段名').value));
    }
    if (path.length === 1) return { type: 'identifier', name: path[0]!, pos: this.pos(first) };
    return { type: 'field', path, text: path.join('.'), pos: this.pos(first) };
  }
}

/** 解析公式文本；语法错误以结构化结果返回（含行 / 列），不抛异常。 */
export function parseFormula(source: string): ParseResult {
  const origin = { line: 1, column: 1, offset: 0, length: 1 } as const;
  if (source.length > MAX_FORMULA_LENGTH) {
    return {
      ok: false,
      errors: [{ code: 'SYNTAX_ERROR', message: `公式过长（超过 ${MAX_FORMULA_LENGTH} 字符）`, ...origin }],
    };
  }
  try {
    const tokens = tokenize(source);
    if (tokens.length > MAX_FORMULA_TOKENS) {
      return {
        ok: false,
        errors: [{ code: 'SYNTAX_ERROR', message: `公式过长（超过 ${MAX_FORMULA_TOKENS} 个词）`, ...origin }],
      };
    }
    return { ok: true, program: new Parser(tokens).parseProgram() };
  } catch (error) {
    if (error instanceof SyntaxIssueError) return { ok: false, errors: [error.issue] };
    // 兜底（astra 首审 P2-5）：解析器不应再抛其他异常；万一出现也只给结构化结果，不透出内容
    return { ok: false, errors: [{ code: 'SYNTAX_ERROR', message: '公式无法解析', ...origin }] };
  }
}
