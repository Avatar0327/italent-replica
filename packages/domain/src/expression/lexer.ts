/**
 * 词法分析（REQ-EXP-001）：兼容原站公式文本——中文函数名与字段名、全角比较符 / 括号 / 逗号、
 * 以数字开头的对象名（360结果）、成员位置带连字符的字段名（问卷-他评总分，按字段解析与减号区分）、百分比字面量（82%）。
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
  percent?: boolean;
  /** 成员位置带连字符、且没有字段解析器可判断是字段还是减法的标识符（求值前按对象字段重新切分）。 */
  ambiguousHyphen?: boolean;
}

export interface TokenizeOptions {
  /**
   * 完整字段路径（如 盘点对象.得分-上级分）是否是已知字段：true 并入字段名，false 拆成减法，
   * undefined 表示此时无法判断（如保存时校验没有对象），先并入并标记 ambiguousHyphen。
   */
  readonly isField?: (path: string) => boolean | undefined;
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

  private pendingAmbiguous = false;

  constructor(
    private readonly source: string,
    private readonly options: TokenizeOptions,
  ) {}

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
    const token: Token = { kind, text, value, ...start };
    if (percent) token.percent = true;
    if (this.pendingAmbiguous) {
      token.ambiguousHyphen = true;
      this.pendingAmbiguous = false;
    }
    this.tokens.push(token);
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

  private scanIdentifier(): void {
    const start = this.position();
    const base = this.scanIdentifierRun(this.offset);
    const text = this.tokens.at(-1)?.kind === 'dot' ? this.resolveHyphenatedMember(base) : base;
    this.advance(text.length);
    const keyword = KEYWORDS[text] ?? KEYWORDS[text.toLowerCase()];
    if (keyword) this.push('keyword', text, keyword, start);
    else this.push('identifier', text, text, start);
  }

  /** 从 from 起连续的标识符字符（字母、数字、下划线、汉字），不含连字符。 */
  private scanIdentifierRun(from: number): string {
    let end = from;
    while (end < this.source.length && isIdentPart(this.source[end]!)) end++;
    return this.source.slice(from, end);
  }

  /**
   * 对象成员位置的连字符（astra 二轮 P2-1）：原站字段名可能含“-”（360结果.问卷-他评总分），普通减法也可能不写空格
   * （盘点对象.得分-盘点对象.基准）。规则：
   * 1. 只有“-”前后都是汉字才可能是字段名的一部分；
   * 2. 连字符串后面紧跟“.”或“(”时一定是减法（右侧是另一个对象字段 / 函数调用）；
   * 3. 其余情况按字段解析：调用方提供 isField 时，整体是已知字段才并入，否则拆成减法；
   *    isField 判断不了（如保存时校验没有对象）时先并入并标记 ambiguousHyphen，求值前会按对象字段重新切分。
   */
  private resolveHyphenatedMember(base: string): string {
    let end = this.offset + base.length;
    while (this.source[end] === '-' && isCjk(this.source[end - 1] ?? '') && isCjk(this.source[end + 1] ?? '')) {
      end += 1 + this.scanIdentifierRun(end + 1).length;
    }
    const joined = this.source.slice(this.offset, end);
    if (joined === base) return base;
    const next = this.source[end] ?? '';
    if (next === '.' || next === '(') return base;
    const known = this.options.isField?.(`${this.memberObjectPath()}.${joined}`);
    if (known === undefined) {
      this.pendingAmbiguous = true;
      return joined;
    }
    return known ? joined : base;
  }

  /** 成员位置前面的对象路径（如 盘点对象、A.B），由已扫出的 标识符 . 标识符 . 序列拼回。 */
  private memberObjectPath(): string {
    const parts: string[] = [];
    for (let i = this.tokens.length - 2; i >= 0; i -= 2) {
      const token = this.tokens[i]!;
      if (token.kind !== 'identifier') break;
      parts.unshift(token.text);
      if (this.tokens[i - 1]?.kind !== 'dot') break;
    }
    return parts.join('.');
  }
}

/** 把公式文本切成 token；遇到中文引号或无法识别的字符抛 SyntaxIssueError。 */
export function tokenize(source: string, options: TokenizeOptions = {}): Token[] {
  return new Scanner(source, options).run();
}
