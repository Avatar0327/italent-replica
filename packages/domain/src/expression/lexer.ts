/**
 * 词法分析（REQ-EXP-001）：兼容原站公式文本——中文函数名与字段名、全角比较符 / 括号 / 逗号、
 * 以数字开头的对象名（360结果）、带连字符的字段名（问卷-他评总分）、百分比字面量（82%）。
 * 中文引号与无法识别的字符在这里报错并给出行列（复刻改进，`26` §8.1）。
 */
import type { SourcePosition } from './failures.js';

export type TokenKind =
  | 'number'
  | 'string'
  | 'identifier'
  | 'keyword'
  | 'operator'
  | 'dot'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'semicolon'
  | 'eof';

export type Keyword = 'if' | 'then' | 'else' | 'and' | 'or' | 'not' | 'true' | 'false';

export interface Token extends SourcePosition {
  readonly kind: TokenKind;
  /** 原文（eof 为空串）。 */
  readonly text: string;
  /** 归一化后的值：数字 / 字符串内容 / 关键字 / 运算符（全角已转半角）。 */
  readonly value: string | number;
  /** 数字后带 %。 */
  readonly percent?: boolean;
}

export type SyntaxIssueCode = 'SYNTAX_ERROR' | 'CHINESE_QUOTE' | 'UNKNOWN_FUNCTION' | 'ARGUMENT_COUNT';

export interface SyntaxIssue extends SourcePosition {
  readonly code: SyntaxIssueCode;
  readonly message: string;
  readonly length: number;
}

export class SyntaxIssueError extends Error {
  constructor(readonly issue: SyntaxIssue) {
    super(issue.message);
    this.name = 'SyntaxIssueError';
  }
}

const KEYWORDS: Readonly<Record<string, Keyword>> = {
  如果: 'if',
  if: 'if',
  那么: 'then',
  then: 'then',
  否则: 'else',
  else: 'else',
  且: 'and',
  并且: 'and',
  and: 'and',
  或: 'or',
  或者: 'or',
  or: 'or',
  非: 'not',
  not: 'not',
  真: 'true',
  true: 'true',
  假: 'false',
  false: 'false',
};

/** 多字符运算符优先匹配；全角写法归一化为半角。 */
const OPERATORS: readonly (readonly [string, string])[] = [
  ['<=', '<='],
  ['>=', '>='],
  ['==', '='],
  ['!=', '!='],
  ['<>', '!='],
  ['&&', 'and'],
  ['||', 'or'],
  ['≤', '<='],
  ['≥', '>='],
  ['≠', '!='],
  ['＜', '<'],
  ['＞', '>'],
  ['＝', '='],
  ['<', '<'],
  ['>', '>'],
  ['=', '='],
  ['+', '+'],
  ['-', '-'],
  ['*', '*'],
  ['/', '/'],
  ['!', 'not'],
];

const PUNCTUATION: Readonly<Record<string, TokenKind>> = {
  '(': 'lparen',
  '（': 'lparen',
  ')': 'rparen',
  '）': 'rparen',
  ',': 'comma',
  '，': 'comma',
  ';': 'semicolon',
  '；': 'semicolon',
  '.': 'dot',
};

const CHINESE_QUOTES = new Set(['“', '”', '‘', '’']);

const isDigit = (ch: string) => ch >= '0' && ch <= '9';
const isLetter = (ch: string) => /[A-Za-z_]/.test(ch);
const isCjk = (ch: string) => /[㐀-䶿一-鿿豈-﫿]/.test(ch);
const isIdentStart = (ch: string) => isLetter(ch) || isCjk(ch);
const isIdentPart = (ch: string) => isIdentStart(ch) || isDigit(ch);
const isSpace = (ch: string) => /\s/.test(ch);

class Scanner {
  private offset = 0;
  private line = 1;
  private column = 1;
  readonly tokens: Token[] = [];

  constructor(private readonly source: string) {}

  run(): Token[] {
    while (this.offset < this.source.length) {
      const ch = this.peek();
      if (isSpace(ch)) this.advance(1);
      else this.scanToken(ch);
    }
    this.tokens.push({ kind: 'eof', text: '', value: '', ...this.position() });
    return this.tokens;
  }

  private peek(ahead = 0): string {
    return this.source[this.offset + ahead] ?? '';
  }

  private position(): SourcePosition {
    return { line: this.line, column: this.column, offset: this.offset };
  }

  private advance(count: number): void {
    for (let i = 0; i < count; i++) {
      if (this.source[this.offset] === '\n') {
        this.line++;
        this.column = 1;
      } else {
        this.column++;
      }
      this.offset++;
    }
  }

  private push(kind: TokenKind, text: string, value: string | number, start: SourcePosition, percent?: boolean): void {
    this.tokens.push(percent ? { kind, text, value, percent, ...start } : { kind, text, value, ...start });
  }

  private error(code: SyntaxIssueCode, message: string, length = 1): never {
    throw new SyntaxIssueError({ code, message, length, ...this.position() });
  }

  private scanToken(ch: string): void {
    if (CHINESE_QUOTES.has(ch)) this.error('CHINESE_QUOTE', '字符串须用英文双引号，不能用中文引号');
    if (ch === '"') return this.scanString();
    if (ch === "'") this.error('SYNTAX_ERROR', '字符串须用英文双引号');
    if (isDigit(ch)) return this.scanNumberOrIdentifier();
    if (isIdentStart(ch)) return this.scanIdentifier();
    const punctuation = PUNCTUATION[ch];
    if (punctuation) {
      const start = this.position();
      this.advance(1);
      return this.push(punctuation, ch, punctuation === 'dot' ? '.' : ch, start);
    }
    for (const [raw, normalized] of OPERATORS) {
      if (this.source.startsWith(raw, this.offset)) return this.scanOperator(raw, normalized);
    }
    this.error('SYNTAX_ERROR', `无法识别的字符“${ch}”`);
  }

  private scanOperator(raw: string, normalized: string): void {
    const start = this.position();
    this.advance(raw.length);
    if (normalized === 'and' || normalized === 'or' || normalized === 'not')
      this.push('keyword', raw, normalized, start);
    else this.push('operator', raw, normalized, start);
  }

  private scanString(): void {
    const start = this.position();
    let end = this.offset + 1;
    while (end < this.source.length && this.source[end] !== '"' && this.source[end] !== '\n') end++;
    if (this.source[end] !== '"') this.error('SYNTAX_ERROR', '字符串缺少结束的英文双引号');
    const text = this.source.slice(this.offset, end + 1);
    this.advance(text.length);
    this.push('string', text, text.slice(1, -1), start);
  }

  private scanNumberOrIdentifier(): void {
    let end = this.offset;
    while (isDigit(this.peek(end - this.offset))) end++;
    if (isIdentStart(this.source[end] ?? '')) return this.scanIdentifier();
    if (this.source[end] === '.' && isDigit(this.source[end + 1] ?? '')) {
      end++;
      while (isDigit(this.source[end] ?? '')) end++;
    }
    const start = this.position();
    const percent = this.source[end] === '%';
    const text = this.source.slice(this.offset, end + (percent ? 1 : 0));
    this.advance(text.length);
    this.push('number', text, Number(percent ? text.slice(0, -1) : text), start, percent || undefined);
  }

  /** 标识符内的连字符：前后都是字母 / 汉字时算名字的一部分（问卷-他评总分），否则是减号（年度-1）。 */
  private scanIdentifier(): void {
    const start = this.position();
    let end = this.offset;
    while (end < this.source.length) {
      const ch = this.source[end]!;
      if (isIdentPart(ch)) end++;
      else if (ch === '-' && isIdentStart(this.source[end - 1] ?? '') && isIdentStart(this.source[end + 1] ?? ''))
        end++;
      else break;
    }
    const text = this.source.slice(this.offset, end);
    this.advance(text.length);
    const keyword = KEYWORDS[text] ?? KEYWORDS[text.toLowerCase()];
    if (keyword) this.push('keyword', text, keyword, start);
    else this.push('identifier', text, text, start);
  }
}

/** 把公式文本切成 token；遇到中文引号或无法识别的字符抛 SyntaxIssueError。 */
export function tokenize(source: string): Token[] {
  return new Scanner(source).run();
}
