/**
 * AC-EXP-19 DEC-311④（F-045，PR #114 第 4 轮清单补充二，用户已定）：emptyInEquality = "fail" 时，
 * 省略分组参数的 2～3 参写法按旧版失败——旧实现把缺省的分组当空值与每个参与者比较，报 EMPTY_IN_COMPARISON。
 * 本人不参与排名（不满足第 3 参数条件）时与旧版一样先返回 OUT_OF_SCOPE；默认口径（compare）不受影响。
 * 逐人求值与各种顺序的批量求值一致。
 */
import {
  DEFAULT_SEMANTICS,
  evaluateBatch,
  evaluateFormula,
  inMemorySubject,
  type EvaluationContext,
  type EvaluationResult,
  type InMemoryRankingMember,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { CALENDAR, PROJECT, contextFor } from './AC-EXP-support.js';

const valueOf = (result: EvaluationResult) => (result.ok ? result.value : { code: result.failure.code });
const num = (value: number) => ({ kind: 'number', value });
const OUT = { code: 'OUT_OF_SCOPE' };
const EMPTY_FAIL = { code: 'EMPTY_IN_COMPARISON' };
const FAILING = { ...DEFAULT_SEMANTICS, emptyInEquality: 'fail' as const };

const MEMBERS: InMemoryRankingMember[] = [
  { id: 'A', fields: { 'person.score': 100, 'person.include': true } },
  { id: 'B', fields: { 'person.score': 90, 'person.include': true } },
  { id: 'C', fields: { 'person.score': 80, 'person.include': false } },
];

function contextOf(id: string, extra: Partial<EvaluationContext>): EvaluationContext {
  const self = MEMBERS.find((m) => m.id === id)!;
  return { ...contextFor({ ...self.fields }, { ports: { ranking: MEMBERS }, subjectId: id }), ...extra };
}

const permutations = <T>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
      );

/** 逐人求值与 6 种顺序的批量求值须一致。 */
function ranksOf(formula: string, extra: Partial<EvaluationContext> = {}) {
  const single = MEMBERS.map((m) => valueOf(evaluateFormula(formula, contextOf(m.id, extra))));
  for (const order of permutations(MEMBERS)) {
    const subjects = order.map((m) => inMemorySubject(m.id, m.fields));
    const batch = evaluateBatch([{ field: 'person.rank', priority: 1, formula }], subjects, {
      calendar: CALENDAR,
      project: PROJECT,
      ...extra,
    });
    if (!batch.ok) throw new Error('批量求值失败');
    const byId = MEMBERS.map((m) => valueOf(batch.results[m.id]!['person.rank']!));
    expect(byId, `顺序 ${order.map((m) => m.id).join('→')}`).toEqual(single);
  }
  return single;
}

describe('DEC-311④ emptyInEquality = fail 且省略分组参数：按旧版失败', () => {
  it.each(['排序号', '百分位'])('2 参（%s）：参与排名的人都报 EMPTY_IN_COMPARISON', (mode) => {
    expect(ranksOf(`Ranking("${mode}", person.score)`, { semantics: FAILING })).toEqual([
      EMPTY_FAIL,
      EMPTY_FAIL,
      EMPTY_FAIL,
    ]);
  });

  it('3 参：满足条件的人报 EMPTY_IN_COMPARISON；不满足条件的人先返回 OUT_OF_SCOPE', () => {
    expect(ranksOf('Ranking("排序号", person.score, person.include)', { semantics: FAILING })).toEqual([
      EMPTY_FAIL,
      EMPTY_FAIL,
      OUT,
    ]);
  });

  it('默认口径（compare）不受影响：2 参、3 参照常排名', () => {
    expect(ranksOf('Ranking("排序号", person.score)')).toEqual([num(1), num(2), num(3)]);
    expect(ranksOf('Ranking("排序号", person.score, person.include)')).toEqual([num(1), num(2), OUT]);
  });

  it('有分组参数（4 参）时仍按逐列比较：无空值照常排名', () => {
    const formula = 'Ranking("排序号", person.score, person.include, "g")';
    expect(ranksOf(formula, { semantics: FAILING })).toEqual([num(1), num(2), OUT]);
  });
});
