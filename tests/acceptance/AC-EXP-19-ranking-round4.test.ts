/**
 * AC-EXP-19 第 4 轮（F-045，PR #114 Sol Ultra 第 3 轮审查 N1 / N2）：
 * N1 emptyInEquality = "fail" 时，分组按旧 valuesEqual 逐对象、逐列短路比较：前面的列已不相等就不再比后面的列，
 * 只有比到空值那一列才报 EMPTY_IN_COMPARISON。
 * N2 日期型 Def 的非有限分量（年 / 月 / 日为 ±∞、NaN）不在缓存键里碰撞：逐人求值与各种顺序的批量求值一致。
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
const EMPTY_FAIL = { code: 'EMPTY_IN_COMPARISON' };

const KINDS: Record<string, StaticKind> = {
  'person.score': 'number',
  'person.g1': 'text',
  'person.g2': 'text',
  'person.amount': 'number',
};
const fieldKind = (path: string) => KINDS[path];
const FAILING = { ...DEFAULT_SEMANTICS, emptyInEquality: 'fail' as const };

const member = (
  id: string,
  score: number,
  fields: Record<string, PlainValue>,
  forbidden?: readonly string[],
): InMemoryRankingMember => ({ id, fields: { 'person.score': score, ...fields }, forbidden });

function contextOf(members: readonly InMemoryRankingMember[], id: string, extra: Partial<EvaluationContext>) {
  const self = members.find((m) => m.id === id)!;
  const base = contextFor(
    { ...self.fields },
    { ports: { ranking: members }, subjectId: id, forbidden: self.forbidden },
  );
  return { ...base, fieldKind, ...extra };
}

const permutations = <T>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
      );

/** 逐人求值（无缓存）为基准；各种人员顺序的批量求值都须与它一致。 */
function ranksOf(formula: string, members: readonly InMemoryRankingMember[], extra: Partial<EvaluationContext> = {}) {
  const single = members.map((m) => valueOf(evaluateFormula(formula, contextOf(members, m.id, extra))));
  for (const order of permutations(members)) {
    const subjects = order.map((m) => inMemorySubject(m.id, m.fields, { forbidden: m.forbidden }));
    const batch = evaluateBatch([{ field: 'person.rank', priority: 1, formula }], subjects, {
      calendar: CALENDAR,
      project: PROJECT,
      fieldKind,
      ...extra,
    });
    if (!batch.ok) throw new Error('批量求值失败');
    const byId = members.map((m) => valueOf(batch.results[m.id]!['person.rank']!));
    expect(byId, `顺序 ${order.map((m) => m.id).join('→')}`).toEqual(single);
  }
  return single;
}

describe('N1 emptyInEquality = fail：逐对象、逐列短路比较', () => {
  const FORMULA = 'Ranking("排序号", person.score, true, person.g1, person.g2)';
  const run = (members: readonly InMemoryRankingMember[], formula = FORMULA) =>
    ranksOf(formula, members, { semantics: FAILING });

  it('审查反例：A(100, "a", "x")、B(90, "b", 空) → A=1，B=EMPTY_IN_COMPARISON', () => {
    const members = [
      member('A', 100, { 'person.g1': 'a', 'person.g2': 'x' }),
      member('B', 90, { 'person.g1': 'b', 'person.g2': null }),
    ];
    expect(run(members)).toEqual([num(1), EMPTY_FAIL]);
  });

  it('第 5 参数的空值来自表达式（IF 不命中）', () => {
    const members = [member('A', 100, { 'person.g1': 'a' }), member('B', 90, { 'person.g1': 'b' })];
    const formula = 'Ranking("排序号", person.score, true, person.g1, 如果 person.score > 95 那么 "x")';
    expect(run(members, formula)).toEqual([num(1), EMPTY_FAIL]);
  });

  it('第 5 参数的字段缺失（按空值分组）', () => {
    const members = [member('A', 100, { 'person.g1': 'a', 'person.g2': 'x' }), member('B', 90, { 'person.g1': 'b' })];
    expect(run(members)).toEqual([num(1), EMPTY_FAIL]);
  });

  it('第 5 参数读取失败（无权读取，按空值分组）', () => {
    const members = [
      member('A', 100, { 'person.g1': 'a', 'person.g2': 'x' }),
      member('B', 90, { 'person.g1': 'b', 'person.g2': 'y' }, ['person.g2']),
    ];
    expect(run(members)).toEqual([num(1), EMPTY_FAIL]);
  });

  it('数字 / 文本混合：第 4 参数 1 与 "2" 不相等 → 短路；1 与 "01" 相等 → 继续比到空值', () => {
    const unequal = [
      member('A', 100, { 'person.g1': 1, 'person.g2': 'x' }),
      member('B', 90, { 'person.g1': '2', 'person.g2': null }),
    ];
    expect(run(unequal)).toEqual([num(1), EMPTY_FAIL]);
    const equal = [
      member('A', 100, { 'person.g1': 1, 'person.g2': 'x' }),
      member('B', 90, { 'person.g1': '01', 'person.g2': null }),
    ];
    expect(run(equal)).toEqual([EMPTY_FAIL, EMPTY_FAIL]);
  });

  it('第 4 参数本身为空：与任何人比较都先比到空值', () => {
    const members = [
      member('A', 100, { 'person.g1': 'a', 'person.g2': 'x' }),
      member('B', 90, { 'person.g1': null, 'person.g2': 'y' }),
    ];
    expect(run(members)).toEqual([EMPTY_FAIL, EMPTY_FAIL]);
  });

  it('没有空值：照常排名；第 4 参数相同、第 5 参数不同 → 各自一组', () => {
    const members = [
      member('A', 100, { 'person.g1': 'a', 'person.g2': 'x' }),
      member('B', 90, { 'person.g1': 'a', 'person.g2': 'y' }),
    ];
    expect(run(members)).toEqual([num(1), num(1)]);
  });
});

describe('N2 日期型 Def 的非有限分量不在缓存键里碰撞', () => {
  /** A 得分 10、amount=1e308（年份 +∞）；B 得分 9、amount=-1e308（年份 -∞）。 */
  const MEMBERS = [
    member('A', 10, { 'person.amount': 1e308, 'person.g1': 'p', 'person.g2': 'r' }),
    member('B', 9, { 'person.amount': -1e308, 'person.g1': 'q', 'person.g2': 'r' }),
  ];
  const BASE = 'ToDate("2020/01/01")';

  it.each([
    ['AddYears', `AddYears(${BASE}, person.amount)`],
    ['AddMonths（外层，年份已是 ±∞）', `AddMonths(AddYears(${BASE}, person.amount), 1)`],
    ['DateAdd 年', `DateAdd("y", person.amount, ${BASE})`],
    ['DateAdd 月（外层）', `DateAdd("m", 1, DateAdd("y", person.amount, ${BASE}))`],
    ['FirstDay', `FirstDay(AddYears(${BASE}, person.amount))`],
    ['LastDay', `LastDay(AddYears(${BASE}, person.amount))`],
    ['ToDate', `ToDate(AddYears(${BASE}, person.amount))`],
  ])('%s：第 3 参数条件 Year(x) > 0 → A=1、B=OUT_OF_SCOPE', (_label, date) => {
    expect(ranksOf(`Def(x, ${date}); Ranking("排序号", person.score, Year(x) > 0)`, MEMBERS)).toEqual([num(1), OUT]);
  });

  it('第 5 参数条件', () => {
    const formula = `Def(x, AddYears(${BASE}, person.amount)); Ranking("排序号", person.score, true, 1, Year(x) > 0)`;
    expect(ranksOf(formula, MEMBERS)).toEqual([num(1), OUT]);
  });

  it('第 4 参数嵌套分组：按本人的 x 选分组字段', () => {
    // A（+∞）按 g1 分组，独自一组；B（-∞）按 g2 分组，两人同组，B 第 2
    const formula =
      `Def(x, AddYears(${BASE}, person.amount)); ` +
      'Ranking("排序号", person.score, true, 如果 Year(x) > 0 那么 person.g1 否则 person.g2)';
    expect(ranksOf(formula, MEMBERS)).toEqual([num(1), num(2)]);
  });
});
