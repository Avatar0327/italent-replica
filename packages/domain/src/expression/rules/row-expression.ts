/**
 * 行号组合表达式的解析器（R3-T05 设计 §3.3 第 1 条；DEC-261）。
 * 词法只认 `and` / `or`（大小写不敏感，容忍无空格）、英文括号、正整数；文法
 *   expr := term (or term)* ；term := factor (and factor)* ；factor := int | '(' expr ')'
 * 错误只带码和字符偏移，不带文案（文案由前端按码渲染，DEC-045）。
 */
import { RULE_LIMITS } from './diagnostics.js';

export type RowExpressionNode =
  | { readonly kind: 'row'; readonly rowNo: number }
  | { readonly kind: 'and' | 'or'; readonly operands: readonly RowExpressionNode[] };

export interface RowReference {
  readonly rowNo: number;
  /** 行号在表达式源文本里的字符偏移。 */
  readonly offset: number;
}

export interface RowExpressionError {
  readonly code: 'RULE_EXPRESSION_SYNTAX' | 'RULE_TOO_LARGE';
  readonly offset: number;
}

export type RowExpressionParseResult =
  | { readonly ok: true; readonly root: RowExpressionNode; readonly refs: readonly RowReference[] }
  | { readonly ok: false; readonly error: RowExpressionError };

/** 行号位数上限：远超行数上限 50，只为避免超出安全整数。 */
const MAX_ROW_NO_DIGITS = 9;

type Token =
  | { readonly kind: 'int'; readonly rowNo: number; readonly offset: number }
  | { readonly kind: 'and' | 'or' | '(' | ')' | 'end'; readonly offset: number };

class ParseFailure extends Error {
  constructor(readonly error: RowExpressionError) {
    super(error.code);
  }
}

const isDigit = (ch: string) => ch >= '0' && ch <= '9';
const isAsciiLetter = (ch: string) => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');

/** 按需切词：错误按从左到右的先后报告，深层嵌套不必先扫完全文。 */
class Lexer {
  private offset = 0;

  constructor(private readonly source: string) {}

  next(): Token {
    while (this.offset < this.source.length && /\s/.test(this.source[this.offset]!)) this.offset++;
    const start = this.offset;
    if (start >= this.source.length) return { kind: 'end', offset: this.source.length };
    const ch = this.source[start]!;
    if (ch === '(' || ch === ')') {
      this.offset++;
      return { kind: ch, offset: start };
    }
    if (isDigit(ch)) return this.integer(start);
    if (isAsciiLetter(ch)) return this.keyword(start);
    throw new ParseFailure({ code: 'RULE_EXPRESSION_SYNTAX', offset: start });
  }

  private integer(start: number): Token {
    let end = start;
    while (end < this.source.length && isDigit(this.source[end]!)) end++;
    const digits = this.source.slice(start, end);
    if (digits[0] === '0' || digits.length > MAX_ROW_NO_DIGITS) {
      throw new ParseFailure({ code: 'RULE_EXPRESSION_SYNTAX', offset: start });
    }
    this.offset = end;
    return { kind: 'int', rowNo: Number(digits), offset: start };
  }

  private keyword(start: number): Token {
    let end = start;
    while (end < this.source.length && isAsciiLetter(this.source[end]!)) end++;
    const word = this.source.slice(start, end).toLowerCase();
    if (word !== 'and' && word !== 'or') throw new ParseFailure({ code: 'RULE_EXPRESSION_SYNTAX', offset: start });
    this.offset = end;
    return { kind: word, offset: start };
  }
}

class Parser {
  readonly refs: RowReference[] = [];
  private readonly lexer: Lexer;
  private current: Token;
  private depth = 0;

  constructor(source: string) {
    this.lexer = new Lexer(source);
    this.current = this.lexer.next();
  }

  parse(): RowExpressionNode {
    const root = this.parseChain('or');
    if (this.current.kind !== 'end') this.fail(this.current.offset);
    return root;
  }

  private advance(): Token {
    const token = this.current;
    if (token.kind !== 'end') this.current = this.lexer.next();
    return token;
  }

  private fail(offset: number): never {
    throw new ParseFailure({ code: 'RULE_EXPRESSION_SYNTAX', offset });
  }

  /** or 链由 and 链组成；同类运算展平（括号只影响结合，不产生节点）。 */
  private parseChain(op: 'and' | 'or'): RowExpressionNode {
    const operands: RowExpressionNode[] = [];
    do {
      const operand = op === 'or' ? this.parseChain('and') : this.parseFactor();
      if (operand.kind === op) operands.push(...operand.operands);
      else operands.push(operand);
    } while (this.current.kind === op && this.advance());
    return operands.length === 1 ? operands[0]! : { kind: op, operands };
  }

  private parseFactor(): RowExpressionNode {
    const token = this.advance();
    if (token.kind === 'int') {
      this.refs.push({ rowNo: token.rowNo, offset: token.offset });
      return { kind: 'row', rowNo: token.rowNo };
    }
    if (token.kind !== '(') this.fail(token.offset);
    if (++this.depth > RULE_LIMITS.maxParenDepth)
      throw new ParseFailure({ code: 'RULE_TOO_LARGE', offset: token.offset });
    const inner = this.parseChain('or');
    if (this.current.kind !== ')') this.fail(this.current.offset);
    this.advance();
    this.depth--;
    return inner;
  }
}

export function parseRowExpression(source: string): RowExpressionParseResult {
  try {
    const parser = new Parser(source);
    const root = parser.parse();
    return { ok: true, root, refs: parser.refs };
  } catch (error) {
    if (error instanceof ParseFailure) return { ok: false, error: error.error };
    throw error;
  }
}
