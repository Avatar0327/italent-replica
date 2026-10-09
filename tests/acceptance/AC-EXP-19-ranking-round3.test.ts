/**
 * AC-EXP-19 第 3 轮（F-045，PR #114 Sol Ultra 第 2 轮审查 N1 / N2）：
 * N1 分组的相等口径与旧实现的 valuesEqual 完全一致：文本与文本按文本比较（"1" 与 "01"、"1e0"、"100%" 不同组），
 * 数值与数字文本、日期与日期格式文本按 = 的口径相等；= 不传递时（"1"、1、"01"）每人按自己的取值找同组。
 * emptyInEquality = "fail" 时，参与排名的人里有空分组即报 EMPTY_IN_COMPARISON（旧实现口径）。
 * N2 排名表缓存键对非有限的 Def 取值（Infinity、-Infinity、NaN）不碰撞：批量求值不论人员顺序都与逐人求值一致。
 */
import {
  DEFAULT_SEMANTICS,
  evaluateBatch,
  evaluateFormula,
  inMemorySubject,
  type EvaluationContext,
  type EvaluationResult,
  type InMemoryRankingMember,
  type PlainValue,
  type StaticKind,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { CALENDAR, PROJECT, contextFor } from './AC-EXP-support.js';

const valueOf = (result: EvaluationResult) => (result.ok ? result.value : { code: result.failure.code });
const num = (value: number) => ({ kind: 'number', value });
const OUT = { code: 'OUT_OF_SCOPE' };

const KINDS: Record<string, StaticKind> = { 'person.score': 'number', 'person.group': 'text' };
const fieldKind = (path: string) => KINDS[path];

const member = (id: string, score: number, fields: Record<string, PlainValue>): InMemoryRankingMember => ({
  id,
  fields: { 'person.score': score, ...fields },
});

function contextOf(members: readonly InMemoryRankingMember[], id: string, extra: Partial<EvaluationContext> = {}) {
  const self = members.find((m) => m.id === id)!;
  return { ...contextFor({ ...self.fields }, { ports: { ranking: members }, subjectId: id }), fieldKind, ...extra };
}

/** 逐人求值，与一次批量求值（同一总体）结果须相同。 */
function ranksOf(formula: string, members: readonly InMemoryRankingMember[], extra: Partial<EvaluationContext> = {}) {
  const single = members.map((m) => valueOf(evaluateFormula(formula, contextOf(members, m.id, extra))));
  const subjects = members.map((m) => inMemorySubject(m.id, m.fields));
  const batch = evaluateBatch([{ field: 'person.rank', priority: 1, formula }], subjects, {
    calendar: CALENDAR,
    project: PROJECT,
    fieldKind,
    ...extra,
  });
  if (!batch.ok) throw new Error('批量求值失败');
  expect(members.map((m) => valueOf(batch.results[m.id]!['person.rank']!))).toEqual(single);
  return single;
}

const GROUP4 = (mode: string) => `Ranking("${mode}", person.score, true, person.group)`;
const pair = (a: PlainValue, b: PlainValue) => [
  member('A', 100, { 'person.group': a }),
  member('B', 90, { 'person.group': b }),
];

describe('N1 审查最小复现：第 4 参数分组值 "1" / "01" 是两组', () => {
  it('名次 [1, 1]，百分位 [100, 100]', () => {
    expect(ranksOf(GROUP4('排序号'), pair('1', '01'))).toEqual([num(1), num(1)]);
    expect(ranksOf(GROUP4('百分位'), pair('1', '01'))).toEqual([num(100), num(100)]);
  });
});

describe('N1 文本与文本按文本比较：数值写法不同的文本不同组', () => {
  it.each([
    ['"1" / "1e0"', '1', '1e0'],
    ['"100%" / "1"', '100%', '1'],
    ['"1.0" / "1"', '1.0', '1'],
    ['"+1" / "1"', '+1', '1'],
    ['" 1" / "1"（前导空格）', ' 1', '1'],
    ['"-0" / "0"', '-0', '0'],
    ['单选 "1" / 单选 "01"', { optionValue: '1', label: '一' }, { optionValue: '01', label: '一' }],
    ['单选 "1" / 文本 "01"', { optionValue: '1' }, '01'],
  ] as const)('%s → 各自一组', (_label, a, b) => {
    expect(ranksOf(GROUP4('排序号'), pair(a, b))).toEqual([num(1), num(1)]);
  });
});

describe('N1 按 = 的口径相等的取值同组', () => {
  it.each([
    ['"1" / "1"', '1', '1'],
    ['数值 1 / 文本 "01"', 1, '01'],
    ['文本 "100%" / 数值 1', '100%', 1],
    ['单选 1 / 文本 "01"', { optionValue: 1 }, '01'],
    ['单选 "01" / 数值 1', { optionValue: '01' }, 1],
    ['"2026" / 2026', '2026', 2026],
    ['日期格式文本 "2020/1/31" / "2020/01/31"', '2020/1/31', '2020/01/31'],
    ['空 / 空', null, null],
  ] as const)('%s → 同组', (_label, a, b) => {
    expect(ranksOf(GROUP4('排序号'), pair(a, b))).toEqual([num(1), num(2)]);
  });

  it('= 不传递时每人按自己的取值找同组："1"、1、"01"', () => {
    const members = [
      member('A', 100, { 'person.group': '1' }),
      member('B', 90, { 'person.group': 1 }),
      member('C', 80, { 'person.group': '01' }),
    ];
    // A 与 B 同组；B 与 A、C 同组；C 与 B 同组
    expect(ranksOf(GROUP4('排序号'), members)).toEqual([num(1), num(2), num(2)]);
    expect(ranksOf(GROUP4('百分位'), members)).toEqual([num(50), num(66.67), num(100)]);
  });

  it('多个分组参数逐个按 = 比较（第 4 数值 / 文本混写、第 5 文本）', () => {
    const members = [
      member('A', 100, { 'person.group': '1', 'person.g2': 'x' }),
      member('B', 90, { 'person.group': 1, 'person.g2': 'x' }),
      member('C', 80, { 'person.group': '01', 'person.g2': 'y' }),
    ];
    expect(ranksOf('Ranking("排序号", person.score, true, person.group, person.g2)', members)).toEqual([
      num(1),
      num(2),
      num(1),
    ]);
  });
});

describe('N1 第 4 参数表达式返回的文本、第 5 参数的文本分组用同一口径', () => {
  it('第 4 参数 IF 返回 "1" / "01"：两组', () => {
    const formula = 'Ranking("排序号", person.score, true, 如果 person.score > 95 那么 "1" 否则 "01")';
    expect(ranksOf(formula, pair('-', '-'))).toEqual([num(1), num(1)]);
  });

  it('第 5 参数文本字段 "1" / "01"：两组；"1" / "1"：同组', () => {
    const formula = 'Ranking("排序号", person.score, true, 1, person.group)';
    expect(ranksOf(formula, pair('1', '01'))).toEqual([num(1), num(1)]);
    expect(ranksOf(formula, pair('1', '1'))).toEqual([num(1), num(2)]);
  });
});

describe('N1 emptyInEquality = "fail"：参与排名的人里有空分组 → EMPTY_IN_COMPARISON（旧实现口径）', () => {
  const failing = { semantics: { ...DEFAULT_SEMANTICS, emptyInEquality: 'fail' as const } };
  const EMPTY_FAIL = { code: 'EMPTY_IN_COMPARISON' };

  it('有人分组为空：所有人都报 EMPTY_IN_COMPARISON', () => {
    expect(ranksOf(GROUP4('排序号'), pair('g', null), failing)).toEqual([EMPTY_FAIL, EMPTY_FAIL]);
  });

  it('没有空分组：照常排名', () => {
    expect(ranksOf(GROUP4('排序号'), pair('g', 'g'), failing)).toEqual([num(1), num(2)]);
  });

  it('默认口径（compare）：空与空同组', () => {
    expect(ranksOf(GROUP4('排序号'), pair('g', null))).toEqual([num(1), num(1)]);
  });
});

describe('N2 非有限的 Def 取值不在缓存键里碰撞：批量求值不论人员顺序都与逐人求值一致', () => {
  /** 尺度 1e308：A 符号 2（+∞）、B 符号 -2（-∞）、C 两项相减（NaN）。 */
  const MEMBERS = [
    member('A', 100, {
      'person.scale': 1e308,
      'person.sign': 2,
      'person.sign2': 0,
      'person.g1': 'p',
      'person.g2': 'r',
    }),
    member('B', 90, {
      'person.scale': 1e308,
      'person.sign': -2,
      'person.sign2': 0,
      'person.g1': 'q',
      'person.g2': 'r',
    }),
    member('C', 95, { 'person.scale': 1e308, 'person.sign': 2, 'person.sign2': 2, 'person.g1': 'q', 'person.g2': 'r' }),
  ];
  const DEF = 'Def(x, person.scale * person.sign - person.scale * person.sign2); ';
  const permutations = <T>(items: readonly T[]): T[][] =>
    items.length <= 1
      ? [[...items]]
      : items.flatMap((item, i) =>
          permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
        );

  /** 逐人求值（无缓存）作基准；全部 6 种人员顺序的批量求值都须与它相同。 */
  function check(formula: string, expected: readonly unknown[]) {
    const single = MEMBERS.map((m) => valueOf(evaluateFormula(formula, contextOf(MEMBERS, m.id))));
    expect(single).toEqual(expected);
    for (const order of permutations(MEMBERS)) {
      const subjects = order.map((m) => inMemorySubject(m.id, m.fields));
      const batch = evaluateBatch([{ field: 'person.rank', priority: 1, formula }], subjects, {
        calendar: CALENDAR,
        project: PROJECT,
      });
      if (!batch.ok) throw new Error('批量求值失败');
      const byId = MEMBERS.map((m) => valueOf(batch.results[m.id]!['person.rank']!));
      expect(byId, `顺序 ${order.map((m) => m.id).join('→')}`).toEqual(single);
    }
  }

  it('审查反例：第 3 参数 x > 0（A=+∞、B=-∞、C=NaN）', () => {
    check(`${DEF}Ranking("排序号", person.score, x > 0)`, [num(1), OUT, OUT]);
  });

  it('嵌套在第 3 参数的逻辑表达式里', () => {
    check(`${DEF}Ranking("排序号", person.score, (x > 0) 且 true)`, [num(1), OUT, OUT]);
  });

  it('第 5 参数过滤', () => {
    check(`${DEF}Ranking("排序号", person.score, true, 1, x > 0)`, [num(1), OUT, OUT]);
  });

  it('第 4 参数分组：按本人的 x 选分组字段', () => {
    // A（+∞）按 g1 分组，独自一组；B、C 按 g2 分组，三人同组：C 95 第 2、B 90 第 3
    check(`${DEF}Ranking("排序号", person.score, true, 如果 x > 0 那么 person.g1 否则 person.g2)`, [
      num(1),
      num(3),
      num(2),
    ]);
  });
});
