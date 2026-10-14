/**
 * AC-EXP-21（#327 第 3 轮，DEC-485 接手）：存量 legacy 名称文本的历史解释只走冻结的旧成员词法。
 * 第 1、2 轮用“新词法 + fieldExists 开关”去模拟旧词法，总有旧词法能吃进、新词法却切开的写法漏掉（小数 `a-1.5`、
 * 多段 `a-b.c-d`）。这里把 5aa1d1ad（#89-4 之前）的词法 / 语法分析逐字副本放在 support/legacy-expression-5aa1d1ad/，
 * 与领域包里冻结的 legacy-member-lexer 放在同一批生成的成员文本上跑，要求结果逐一相同；再覆盖三条使用方：
 * 改绑的历史比较、删除 / 改名守卫的引用判定、legacy 渲染。
 */
import {
  bindFormula,
  formulaReferences,
  legacyMemberRun,
  legacyTextReferences,
  legacyTokenize,
  nameTextReferences,
  parseFormula,
  rebindLegacyFormula,
  renderFormula,
  textMentionsField,
  validateFormula,
  type ParseResult,
  type Token,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';
import {
  SyntaxIssueError as OldSyntaxIssueError,
  tokenize as oldTokenize,
} from './support/legacy-expression-5aa1d1ad/lexer.js';
import {
  parseFormula as oldParseFormula,
  type ParseResult as OldParseResult,
} from './support/legacy-expression-5aa1d1ad/parser.js';

/** 固定种子的伪随机数：生成的批量文本每次相同，失败可复现。 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 成员名的片段：小数（1 + . + 5）、数字开头（1a、9）、下划线、中文、与关键字同形（真、and）。 */
const PIECES = ['a', 'b', '1', '5', '1a', '9', 'x_y', '_z', '甲', '乙丙', '真', 'and'] as const;
/** 片段之间的连接：连字符、点号、两侧带空格、双连字符、紧邻的 `.-` / `-.`。 */
const JOINS = ['-', '.', ' - ', ' . ', '--', '.-', '-.'] as const;

function enumerate(pieces: readonly string[], maxPieces: number): string[] {
  const out: string[] = [];
  const extend = (prefix: string, left: number) => {
    for (const piece of pieces) {
      out.push(prefix + piece);
      if (left > 1) for (const join of JOINS) extend(prefix + piece + join, left - 1);
    }
  };
  extend('', maxPieces);
  return out;
}

/** 审查反例与同类写法：小数、多段连字符、深路径（连字符 + 点号 + 连字符）、数字开头、下划线、中文、与关键字同形。 */
const CURATED = [
  'a-1.5',
  'a-1.5.6',
  'a-1.5-2',
  'a-b.c-d',
  'a-b-c.d-e-f',
  '1-2.3-4',
  'x_y-z_w.甲-乙',
  '甲-乙丙.丁-戊',
  'a-真.b',
  'a-and',
  '1a-2b',
  'a-1.5%',
] as const;

const FIRST_ROUND = enumerate(PIECES.slice(0, 9), 3);
const random = seeded(327);
const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
const RANDOM_MEMBERS = Array.from({ length: 4000 }, () => {
  let text: string = pick(PIECES);
  for (let count = 1 + Math.floor(random() * 5); count > 0; count--) text += pick(JOINS) + pick(PIECES);
  return text;
}).concat(CURATED);

/** 成员文本放进的上下文：单独引用、带 Def、与另一个字段相减、括号、百分比、裸变量位置。 */
const CONTEXTS: readonly ((member: string) => string)[] = [
  (m) => `盘点对象.${m}`,
  (m) => `Def(b,3); 盘点对象.${m} + 1`,
  (m) => `盘点对象.${m}-盘点对象.基准`,
  (m) => `(盘点对象.${m}) * 2`,
  (m) => `盘点对象.${m} + 5%`,
  (m) => `Def(a,1); Def(b,2); ${m}`,
];

const tokenShape = (token: Token) => [
  token.kind,
  token.text,
  token.value,
  token.percent ?? null,
  token.line,
  token.column,
  token.offset,
];
const issueShape = (issue: { code: string; length: number; line: number; column: number; offset: number }) => [
  issue.code,
  issue.length,
  issue.line,
  issue.column,
  issue.offset,
];
const issueOf = (error: unknown) => (error as { issue: Parameters<typeof issueShape>[0] }).issue;

function lex(source: string, run: (text: string) => readonly Token[], isIssue: (error: unknown) => boolean) {
  try {
    return { tokens: run(source).map(tokenShape) };
  } catch (error) {
    if (!isIssue(error)) throw error;
    return { issue: issueShape(issueOf(error)) };
  }
}
const oldLex = (source: string) => lex(source, oldTokenize, (error) => error instanceof OldSyntaxIssueError);
const frozenLex = (source: string) =>
  lex(source, legacyTokenize, (error) => (error as { name?: string }).name === 'SyntaxIssueError');

function parseShape(result: ParseResult | OldParseResult) {
  return result.ok ? { program: result.program } : { issue: issueShape(result.errors[0]!) };
}

/** 逐一比较，收集不一致的文本；全部相同时 mismatches 为空（不对十万条各写一个断言）。 */
function mismatchesOf(sources: readonly string[], same: (source: string) => boolean): string[] {
  const found: string[] = [];
  for (const source of sources) {
    if (!same(source)) {
      found.push(source);
      if (found.length >= 10) break;
    }
  }
  return found;
}

const contextual = (members: readonly string[], contexts = CONTEXTS) =>
  members.flatMap((member) => contexts.map((context) => context(member)));

describe('AC-EXP-21 冻结的旧成员词法 = 5aa1d1ad 的实现（差分，DEC-485 / DEC-228）', () => {
  const sources = [...FIRST_ROUND.map((member) => CONTEXTS[0]!(member)), ...contextual(RANDOM_MEMBERS)];

  it(`词法：${sources.length} 条生成文本，词（种类、原文、值、行列、偏移）与错误位置逐一相同`, () => {
    const same = (source: string) => JSON.stringify(frozenLex(source)) === JSON.stringify(oldLex(source));
    expect(mismatchesOf(sources, same)).toEqual([]);
  }, 60_000);

  it('语法分析：同一批文本，语法树（含字段引用的 path / text / end / 位置）与错误位置逐一相同', () => {
    expect(
      mismatchesOf(
        sources,
        (source) =>
          JSON.stringify(parseShape(parseFormula(source, { legacyMembers: true }))) ===
          JSON.stringify(parseShape(oldParseFormula(source))),
      ),
    ).toEqual([]);
  }, 60_000);

  it('成员文本串 legacyMemberRun：与旧词法对 `对象.` 之后连续（无空白）的名字链读到的原文相同', () => {
    const start = '盘点对象.'.length;
    const expectedRun = (source: string) => {
      const tokens = oldTokenize(source);
      let run = '';
      let cursor = start;
      for (let index = 2; ; index += 2) {
        const name = tokens[index];
        if (!name || (name.kind !== 'identifier' && name.kind !== 'keyword') || name.offset !== cursor) break;
        run += name.text;
        cursor += name.text.length;
        const dot = tokens[index + 1];
        if (dot?.kind !== 'dot' || dot.offset !== cursor) break;
        run += '.';
        cursor += 1;
      }
      return run.endsWith('.') ? run.slice(0, -1) : run;
    };
    const lexable = FIRST_ROUND.map((member) => CONTEXTS[0]!(member)).filter((source) => 'tokens' in oldLex(source));
    expect(mismatchesOf(lexable, (source) => legacyMemberRun(source, start) === expectedRun(source))).toEqual([]);
  }, 60_000);

  it('覆盖面：小数、多段连字符、深路径、数字开头、下划线、中文、关键字同形都出现在批量文本里', () => {
    const all = new Set(FIRST_ROUND.concat(RANDOM_MEMBERS));
    const has = (pattern: RegExp) => [...all].some((member) => pattern.test(member));
    expect(has(/-\d\.\d/)).toBe(true);
    expect(has(/\w-\w+-\w/)).toBe(true);
    expect(has(/-\S*\.\S*-/)).toBe(true);
    expect(has(/^1a/)).toBe(true);
    expect(has(/_z|x_y/)).toBe(true);
    expect(has(/甲|乙丙/)).toBe(true);
    expect(has(/真|and/)).toBe(true);
    expect(has(/--/)).toBe(true);
    expect(has(/ - | \. /)).toBe(true);
  });

  it('规模限制按旧词法的词数算：每处引用 3 个词，100 处远不到 800；新词法把连字符切开后超限', () => {
    const member = 'a-b-c-d-e-f-g-h-i-j';
    const text = Array.from({ length: 100 }, () => `盘点对象.${member}`).join(' + ');
    expect(parseFormula(text, { legacyMembers: true }).ok).toBe(true);
    expect(oldParseFormula(text).ok).toBe(true);
    const current = parseFormula(text, { fieldExists: () => false });
    expect(current.ok).toBe(false);
    // 当前解释读不了，历史解释仍给出引用：引用判定取两者并集，不因规模限制漏保护
    expect(nameTextReferences(text, [member])).toBeUndefined();
    expect(formulaReferences(text, [member])).toEqual([`盘点对象.${member}`]);
    expect(textMentionsField(text, member, [member])).toBe(true);
  });
});

const A = '44444444-4444-4444-8444-444444444444';
const A15 = '55555555-5555-4555-8555-555555555555';
const Z = '66666666-6666-4666-8666-666666666666';
const field = (id: string, name: string) => ({ id, name, kind: 'number' as const });

describe('AC-EXP-21 P2-1：历史比较走旧词法（小数写法 a-1.5，DEC-485）', () => {
  it('字段 a、a-1.5 都在：两种解释一致（整段字段 a-1.5），但 bound 路径不支持名字里带“.”的字段 → unresolved，不绑定到 a', () => {
    const result = rebindLegacyFormula('盘点对象.a-1.5', [field(A, 'a'), field(A15, 'a-1.5')]);
    expect(result).toMatchObject({ ok: false, issue: 'UNKNOWN_FIELD', candidates: [A15] });
  });

  it('a-1.5 已改名为 z：旧词法的整段 a-1.5 与当前的 a 减 1.5 不一致 → unresolved，原文不动，a 与 z 都不换义', () => {
    const result = rebindLegacyFormula('盘点对象.a-1.5', [field(A, 'a'), field(Z, 'z')]);
    expect(result).toMatchObject({ ok: false, issue: 'AMBIGUOUS_FIELD' });
  });

  it('只有 a：旧词法的 a-1.5 是未知字段，当前解释是 a 减 1.5 → unresolved，不换义', () => {
    expect(rebindLegacyFormula('盘点对象.a-1.5', [field(A, 'a')])).toMatchObject({ ok: false });
  });

  it('旧词法读不出来的存量文本（行首注释是新写法）进入 unresolved', () => {
    expect(rebindLegacyFormula('// 注释\n盘点对象.a', [field(A, 'a')])).toMatchObject({
      ok: false,
      issue: 'AMBIGUOUS_FIELD',
    });
  });
});

describe('AC-EXP-21 P2-2：删除 / 改名守卫对 legacy 文本以旧词法的引用集合为准（DEC-485 / DEC-431①）', () => {
  const DEEP = 'a-b.c-d';

  it('深路径、多段连字符：字段 a-b.c-d 被 `盘点对象.a-b.c-d` 引用', () => {
    expect(legacyTextReferences('盘点对象.a-b.c-d')).toEqual(['盘点对象.a-b.c-d']);
    expect(textMentionsField('盘点对象.a-b.c-d', DEEP, [DEEP])).toBe(true);
    expect(formulaReferences('盘点对象.a-b.c-d', [DEEP])).toContain('盘点对象.a-b.c-d');
  });

  it('小数写法：字段 a-1.5 被 `盘点对象.a-1.5` 引用；改名后（目录里没有 a-1.5）改名固化仍认得它', () => {
    expect(textMentionsField('盘点对象.a-1.5', 'a-1.5', ['a', 'a-1.5'])).toBe(true);
    expect(textMentionsField('盘点对象.a-1.5', 'a-1.5', ['a', 'z'])).toBe(true);
  });

  it('宁可多保护：减法读法的字段 a 也被保护（新保存的 `盘点对象.a-1.5` 在目录没有 a-1.5 时是 a 减 1.5）', () => {
    expect(textMentionsField('盘点对象.a-1.5', 'a', ['a'])).toBe(true);
  });

  it('两种解释一致时不多保护：a、a-b 并存，`Def(b,3); 盘点对象.a-b` 不引用 a', () => {
    expect(textMentionsField('Def(b,3); 盘点对象.a-b', 'a', ['a', 'a-b'])).toBe(false);
    expect(textMentionsField('Def(b,3); 盘点对象.a-b', 'a-b', ['a', 'a-b'])).toBe(true);
  });

  it('旧词法读不出来、当前解释读得出来的文本（新写法）仍按当前解释判定', () => {
    expect(textMentionsField('// 注释\n盘点对象.a', 'a', ['a'])).toBe(true);
  });
});

describe('AC-EXP-21 legacy 渲染走旧词法：隐藏字段 a-1.5、只可见 a（DEC-485 / DEC-406）', () => {
  const visibleFields = [{ id: A, name: 'a' }];

  it('`盘点对象.a-1.5` 整段是不可见字段，不露出一截', () => {
    expect(renderFormula('盘点对象.a-1.5', { binding: 'legacy', visibleFields })).toMatchObject({
      ok: true,
      text: '盘点对象.〔不可见字段〕',
    });
  });

  it('深路径 `盘点对象.a-b.c-d` 同样整段遮住', () => {
    expect(renderFormula('盘点对象.a-b.c-d + 1', { binding: 'legacy', visibleFields })).toMatchObject({
      ok: true,
      text: '盘点对象.〔不可见字段〕 + 1',
    });
  });

  it('可见字段名就是 a-1.5 时原样显示', () => {
    const shown = [{ id: A15, name: 'a-1.5' }];
    expect(renderFormula('盘点对象.a-1.5', { binding: 'legacy', visibleFields: shown })).toMatchObject({
      ok: true,
      text: '盘点对象.a-1.5',
    });
  });
});

describe('AC-EXP-21 新保存的写法：已存在字段优先，小数与多段连字符不再被切开（#89-4）', () => {
  const exists =
    (...paths: string[]) =>
    (path: string) =>
      paths.includes(path);

  it('目录里有 盘点对象.a-1.5：`盘点对象.a-1.5 + 1` 是一个字段', () => {
    const checked = validateFormula('盘点对象.a-1.5 + 1', {
      isKnownField: () => true,
      fieldExists: exists('盘点对象.a-1.5'),
    });
    expect(checked).toMatchObject({ ok: true, fields: ['盘点对象.a-1.5'] });
  });

  it('目录里没有：`盘点对象.a-1.5` 仍是 a 减 1.5', () => {
    const checked = validateFormula('盘点对象.a-1.5', { isKnownField: () => true, fieldExists: exists('盘点对象.a') });
    expect(checked).toMatchObject({ ok: true, fields: ['盘点对象.a'] });
  });

  it('多段连字符的深路径 `盘点对象.a-b.c-d` 整段并入', () => {
    const checked = validateFormula('盘点对象.a-b.c-d', {
      isKnownField: () => true,
      fieldExists: exists('盘点对象.a-b.c-d'),
    });
    expect(checked).toMatchObject({ ok: true, fields: ['盘点对象.a-b.c-d'] });
    expect(nameTextReferences('盘点对象.a-b.c-d', ['a-b.c-d'])).toEqual(['盘点对象.a-b.c-d']);
  });

  it('只有 a-1 没有 a-1.5：`盘点对象.a-1.5` 的写法整体是 a-1.5（旧词法同读），不并入 a-1，按 a 减 1.5', () => {
    const checked = validateFormula('盘点对象.a-1.5', {
      isKnownField: () => true,
      fieldExists: exists('盘点对象.a-1'),
    });
    expect(checked).toMatchObject({ ok: true, fields: ['盘点对象.a'] });
  });

  it('bound 路径不支持名字里带“.”的字段：可见字段里有 a-1.5 时报找不到字段，不悄悄读成 a 减 1.5；只可见 a 时仍是 a 减 1.5', () => {
    const catalogVersion = { current: 1, submitted: 1 };
    const both = bindFormula('盘点对象.a-1.5 + 1', {
      visibleFields: [
        { id: A, name: 'a' },
        { id: A15, name: 'a-1.5' },
      ],
      catalogVersion,
    });
    expect(both).toMatchObject({ ok: false, failure: { code: 'FORMULA_INVALID' } });
    const only = bindFormula('盘点对象.a-1.5', { visibleFields: [{ id: A, name: 'a' }], catalogVersion });
    expect(only).toMatchObject({ ok: true, fieldIds: [A] });
  });
});
