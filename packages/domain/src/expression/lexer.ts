/**
 * 词法分析（REQ-EXP-001）：兼容原站公式文本——中文函数名与字段名、全角比较符 / 括号 / 逗号、
 * 以数字开头的对象名（360结果）、带连字符的字段名（问卷-他评总分，DEC-228）、百分比字面量（82%）、
 * 乘除号 × ÷（本租户规则原文写法）、名字里带“/”的面板函数名（`26` §8.6）。
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
  /** 存储模式的字段句柄 `@{tr-field:<uuid>}`（F-082 契约 §1.2）；value 是小写字段 ID。 */
  | 'handle'
  /** 输入模式的不可见字段占位符 `〔不可见字段〕`，只能出现在 `盘点对象.` 之后（由解析器校验）。 */
  | 'placeholder'
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

export type SyntaxIssueCode =
  'SYNTAX_ERROR' | 'CHINESE_QUOTE' | 'UNKNOWN_FUNCTION' | 'ARGUMENT_COUNT' | 'ARGUMENT_TYPE' | 'UNKNOWN_FIELD';

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

/** 渲染时代替看不到的字段名；输入模式的词法器把它识别为专用词（契约 §1.2）。 */
export const HIDDEN_FIELD_PLACEHOLDER = '〔不可见字段〕';
/** 占位符只能跟在这个对象名后面（与 talent-review 的 FORMULA_OBJECT 同值，由单测核对）。 */
export const HIDDEN_FIELD_OWNER = '盘点对象';

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HANDLE_AT = new RegExp(`@\\{tr-field:(${UUID_SOURCE})\\}`, 'y');
const HANDLE_WHOLE = new RegExp(`^@\\{tr-field:(${UUID_SOURCE})\\}$`);

/** 字段句柄：一个完整的盘点字段引用；UUID 按 DEC-194 小写。非 UUID 直接抛错，避免拼出可注入的句柄。 */
export function fieldHandle(fieldId: string): string {
  const id = fieldId.toLowerCase();
  if (!new RegExp(`^${UUID_SOURCE}$`).test(id)) throw new TypeError('字段句柄：字段 ID 必须是 UUID');
  return `@{tr-field:${id}}`;
}

/** 句柄原文 → 字段 ID；只认完整、小写的句柄。 */
export function parseFieldHandle(text: string): string | undefined {
  return HANDLE_WHOLE.exec(text)?.[1];
}

export interface TokenizeOptions {
  /** 存储模式：识别句柄 `@{tr-field:<uuid>}`，不识别占位符。输入模式（缺省）下 `@` 是非法字符。 */
  readonly handles?: boolean;
  /**
   * 输入模式识别占位符 `〔不可见字段〕`（F-082 新路径才开；缺省不识别，B5 路径逐字不变）。存储模式从不识别。
   */
  readonly placeholders?: boolean;
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
  ['×', '*'],
  ['÷', '/'],
  ['!', 'not'],
];

/**
 * 名字里带“/”的面板函数名（`26` §8.6）：后面（可隔空白）紧跟左括号时整体作为函数名，否则“/”仍是除号。
 */
const SLASH_FUNCTION_NAMES = ['获取当前人员测评测验下的最近一次测评得分/维度得分'] as const;

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

  constructor(
    private readonly source: string,
    private readonly handles: boolean,
    private readonly placeholders: boolean,
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
    this.tokens.push(percent ? { kind, text, value, percent, ...start } : { kind, text, value, ...start });
  }

  /** 对象成员位置：前一个词是“.”（中间可以有空白）。 */
  private atMember(): boolean {
    return this.tokens.at(-1)?.kind === 'dot';
  }

  private error(code: SyntaxIssueCode, message: string, length = 1): never {
    throw new SyntaxIssueError({ code, message, length, ...this.position() });
  }

  private scanToken(ch: string): void {
    if (this.handles && ch === '@') return this.scanHandle();
    if (this.placeholders && !this.handles && this.source.startsWith(HIDDEN_FIELD_PLACEHOLDER, this.offset)) {
      return this.scanPlaceholder();
    }
    if (CHINESE_QUOTES.has(ch)) this.error('CHINESE_QUOTE', '字符串须用英文双引号，不能用中文引号');
    if (ch === '"') return this.scanString();
    if (ch === "'") this.error('SYNTAX_ERROR', '字符串须用英文双引号');
    if (isDigit(ch)) return this.atMember() ? this.scanIdentifier() : this.scanNumberOrIdentifier();
    if (isIdentStart(ch)) return this.scanIdentifier();
    // TODO(需取证 #105)：运算符工具栏里的“//”是整除还是注释原站未说明，取证前不猜，按语法错误提示
    if (this.source.startsWith('//', this.offset)) {
      this.error('SYNTAX_ERROR', '“//” 的含义（整除或注释）待取证，暂不支持', 2);
    }
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

  private scanHandle(): void {
    HANDLE_AT.lastIndex = this.offset;
    const match = HANDLE_AT.exec(this.source);
    if (!match) this.error('SYNTAX_ERROR', '字段句柄格式不正确');
    const start = this.position();
    this.advance(match[0].length);
    this.push('handle', match[0], match[1]!, start);
  }

  private scanPlaceholder(): void {
    const start = this.position();
    this.advance(HIDDEN_FIELD_PLACEHOLDER.length);
    this.push('placeholder', HIDDEN_FIELD_PLACEHOLDER, HIDDEN_FIELD_PLACEHOLDER, start);
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

  /**
   * 名字。对象成员位置（“.”之后）的连字符一律属于字段名（DEC-228）：原站字段如 360结果.问卷-他评总分；
   * 字段相减须在减号两侧加空格（盘点对象.得分 - 盘点对象.基准）。不在成员位置的名字（Def 变量、函数名、
   * 不带对象前缀的短字段名）里“-”是减号，a-b、总分-上级分、10-3 都是减法。
   */
  private scanIdentifier(): void {
    const start = this.position();
    const member = this.atMember();
    const slashName = member ? undefined : this.slashFunctionName();
    if (slashName) {
      this.advance(slashName.length);
      return this.push('identifier', slashName, slashName, start);
    }
    let end = this.offset;
    while (end < this.source.length) {
      const ch = this.source[end]!;
      if (isIdentPart(ch)) end++;
      else if (member && ch === '-' && isIdentPart(this.source[end + 1] ?? '')) end++;
      else break;
    }
    const text = this.source.slice(this.offset, end);
    this.advance(text.length);
    const keyword = KEYWORDS[text] ?? KEYWORDS[text.toLowerCase()];
    if (keyword) this.push('keyword', text, keyword, start);
    else this.push('identifier', text, text, start);
  }

  private slashFunctionName(): string | undefined {
    return SLASH_FUNCTION_NAMES.find((name) => {
      if (!this.source.startsWith(name, this.offset)) return false;
      const rest = this.source.slice(this.offset + name.length);
      return /^\s*[(（]/.test(rest);
    });
  }
}

/** 把公式文本切成 token；遇到中文引号或无法识别的字符抛 SyntaxIssueError。 */
export function tokenize(source: string, options: TokenizeOptions = {}): Token[] {
  return new Scanner(source, options.handles === true, options.placeholders === true).run();
}
