/**
 * 冻结的旧成员词法（#327 第 3 轮，DEC-485；DEC-228）：存量 legacy 名称文本的“历史解释”只走这里。
 *
 * 来源：5aa1d1ad（#89-4 之前）`packages/domain/src/expression/lexer.ts` 的第 84～156 行（关键字、运算符、标点与字符判定）
 * 和第 158～321 行（`class Scanner`）原样移植，只去掉与 legacy 文本无关的两个开关——存储模式的字段句柄
 * `@{tr-field:…}`（原第 214 行 / `scanHandle`）和输入模式的占位符（原第 215～217 行 / `scanPlaceholder`）：legacy 名称文本
 * 两个都没有。其余逐字不变，包括对象成员位置（“.”之后）的连字符一律并入字段名（原第 287～312 行，DEC-228），以及
 * “//” 报语法错误（原第 223～226 行）：旧词法读不出来的文本就是读不出来，由使用方进入 unresolved。
 *
 * **不要修改本文件，也不要让它依赖会变的词法实现**：新词法（lexer.ts）随表达式引擎演进，历史解释不能跟着变。
 * 与旧实现的一致性由 tests/acceptance/AC-EXP-21-legacy-member-lexer.test.ts 在同一批生成文本上逐一核对
 * （对照夹具是 5aa1d1ad 词法 / 语法分析的逐字副本）。
 *
 * 使用方：
 * - parser.ts 的 `legacyMembers` 选项：存量改绑的历史比较、删除 / 改名守卫的引用判定、legacy 渲染都经它解析；
 * - parser.ts 的 mergedMember：新保存的写法里，旧词法能读成一个名字的文本串就是“已存在字段优先”的候选。
 */
import type { SourcePosition } from './failures.js';
import { SyntaxIssueError, type Keyword, type SyntaxIssueCode, type Token, type TokenKind } from './lexer.js';

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

  /** 对象成员位置：前一个词是“.”（中间可以有空白）。 */
  private atMember(): boolean {
    return this.tokens.at(-1)?.kind === 'dot';
  }

  private error(code: SyntaxIssueCode, message: string, length = 1): never {
    throw new SyntaxIssueError({ code, message, length, ...this.position() });
  }

  private scanToken(ch: string): void {
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

/**
 * 从 `start`（对象成员位置的第一个字符）起，旧词法读到的连续成员文本：名字（“-”后面紧跟名字字符的并入名字），
 * 名字后面紧跟“.”和名字时继续读下一段。中间没有空白；读不到名字时为空串。规则与 Scanner.scanIdentifier 的成员分支相同。
 */
export function legacyMemberRun(source: string, start: number): string {
  let end = start;
  for (;;) {
    const nameStart = end;
    while (end < source.length) {
      const ch = source[end]!;
      if (isIdentPart(ch)) end++;
      else if (ch === '-' && isIdentPart(source[end + 1] ?? '')) end++;
      else break;
    }
    if (end === nameStart) break;
    if (source[end] === '.' && isIdentPart(source[end + 1] ?? '')) end++;
    else break;
  }
  return source.slice(start, end);
}

/** 旧词法：把公式文本切成 token；遇到中文引号或无法识别的字符抛 SyntaxIssueError（5aa1d1ad 的 tokenize 默认选项）。 */
export function legacyTokenize(source: string): Token[] {
  return new Scanner(source).run();
}
