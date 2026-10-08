/**
 * AC-EXP-19 DEC-310 补充（F-045，PR #114 第 4 轮清单补充）：第 3 参数为裸是否型（字段、短字段名、Def、常量）时
 * 按旧语义作过滤条件，取值为“否”的成员返回 OUT_OF_SCOPE，不得名次、不进名次与百分位的分母；
 * 叠加第 4 / 5 参数分组时同样成立；逐人求值与各种顺序的批量求值一致，且与旧实现的结果相同。
 * 例外（旧语义，结果不变）：Def 变量按本人作用域求值，所有成员都用本人的取值判断。
 */
import {
  evaluateBatch,
  evaluateFormula,
  inMemorySubject,
  type EvaluationContext,
  type EvaluationResult,
  type InMemoryRankingMember,
  type StaticKind,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { CALENDAR, PROJECT, contextFor } from './AC-EXP-support.js';

const valueOf = (result: EvaluationResult) => (result.ok ? result.value : { code: result.failure.code });
const num = (value: number) => ({ kind: 'number', value });
const OUT = { code: 'OUT_OF_SCOPE' };

const KINDS: Record<string, StaticKind> = {
  'person.score': 'number',
  'person.include': 'boolean',
  include: 'boolean',
  'person.group': 'text',
};
const fieldKind = (path: string) => KINDS[path];

/** “否”的 B 分数最高：若被当成参与者，会排第 1 并改变 A、C 的名次与百分位。 */
const fields = (score: number, include: boolean, group: string) => ({
  'person.score': score,
  'person.include': include,
  include,
  'person.group': group,
});
const MEMBERS: InMemoryRankingMember[] = [
  { id: 'A', fields: fields(80, true, 'g') },
  { id: 'B', fields: fields(100, false, 'g') },
  { id: 'C', fields: fields(60, true, 'g') },
];

function contextOf(id: string, typed: boolean): EvaluationContext {
  const self = MEMBERS.find((m) => m.id === id)!;
  const base = contextFor({ ...self.fields }, { ports: { ranking: MEMBERS }, subjectId: id });
  return typed ? { ...base, fieldKind } : base;
}

const permutations = <T>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
      );

/** 逐人求值（带 / 不带类型目录）与 6 种顺序的批量求值须一致。 */
function ranksOf(formula: string) {
  const single = MEMBERS.map((m) => valueOf(evaluateFormula(formula, contextOf(m.id, true))));
  expect(MEMBERS.map((m) => valueOf(evaluateFormula(formula, contextOf(m.id, false))))).toEqual(single);
  for (const order of permutations(MEMBERS)) {
    for (const typed of [true, false]) {
      const subjects = order.map((m) => inMemorySubject(m.id, m.fields));
      const batch = evaluateBatch([{ field: 'person.rank', priority: 1, formula }], subjects, {
        calendar: CALENDAR,
        project: PROJECT,
        ...(typed ? { fieldKind } : {}),
      });
      if (!batch.ok) throw new Error('批量求值失败');
      const byId = MEMBERS.map((m) => valueOf(batch.results[m.id]!['person.rank']!));
      expect(byId, `顺序 ${order.map((m) => m.id).join('→')}`).toEqual(single);
    }
  }
  return single;
}

describe('DEC-310 第 3 参数裸是否型：“否”的成员 OUT_OF_SCOPE，不得名次、不进分母', () => {
  it.each([
    ['完整字段', 'person.include'],
    ['短字段名', 'include'],
  ])('%s：名次 A=1、C=2，百分位 A=50、C=100，B 为 OUT_OF_SCOPE', (_label, condition) => {
    expect(ranksOf(`Ranking("排序号", person.score, ${condition})`)).toEqual([num(1), OUT, num(2)]);
    expect(ranksOf(`Ranking("百分位", person.score, ${condition})`)).toEqual([num(50), OUT, num(100)]);
  });

  it.each([
    ['叠加第 4 参数分组', 'Ranking("排序号", person.score, person.include, person.group)'],
    ['叠加第 4、5 参数分组', 'Ranking("排序号", person.score, person.include, person.group, person.group)'],
    ['短字段名叠加第 4 参数分组', 'Ranking("排序号", person.score, include, person.group)'],
  ])('%s', (_label, formula) => {
    expect(ranksOf(formula)).toEqual([num(1), OUT, num(2)]);
  });

  it('是否型常量：true 全员参与（B 第 1），false 全员 OUT_OF_SCOPE', () => {
    expect(ranksOf('Ranking("排序号", person.score, true)')).toEqual([num(2), num(1), num(3)]);
    expect(ranksOf('Ranking("排序号", person.score, false)')).toEqual([OUT, OUT, OUT]);
  });

  it('是否型 Def（旧语义：按本人作用域求值，所有成员都用本人的取值）：本人为“否”→ OUT_OF_SCOPE', () => {
    // A、C 本人为“是”：三人都参与（B 100 第 1）；B 本人为“否”：没人满足 → OUT_OF_SCOPE
    expect(ranksOf('Def(x, person.include); Ranking("排序号", person.score, x)')).toEqual([num(2), OUT, num(3)]);
  });
});
