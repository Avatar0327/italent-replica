import { expect, it } from 'vitest';
import { compileSuccessionLevel, RULE_COMPILER_VERSION, type SuccessionLevelRow } from '@italent/domain';
import { evaluateRisk, riskMeasure, riskIncumbents } from '../../packages/domain/src/succession/risk.js';
const calendar = { today: '2026-10-01', timeZone: 'Asia/Shanghai' };
const row: SuccessionLevelRow = {
  rowNo: 1,
  subject: 'successor',
  fieldCode: null,
  filterOperator: null,
  filterValues: [],
  measure: 'count',
  comparator: 'between',
  threshold: 1,
  thresholdHigh: 2,
  isPercent: false,
};
const people = {
  incumbents: [
    { id: 'a', age: 20 },
    { id: 'b', age: 30 },
  ],
  successors: [{ id: 'c', age: 30 }],
};
const level = (id: string, rows = [row]) => {
  const rules = { expression: '1', rows };
  const compiled = compileSuccessionLevel('risk', rules, []);
  if (!compiled.ok) throw new Error('测试规则编译失败');
  return { id, rules, formula: compiled.compiled.formula, compilerVersion: RULE_COMPILER_VERSION, compileError: null };
};
it('AC-SC-risk 度量逐项：人数、现任占比、继任者占比、过滤与零分母', () => {
  expect(riskMeasure(row, people, calendar)).toBe(1);
  expect(riskMeasure({ ...row, measure: 'count_over_incumbents' }, people, calendar)).toBe(0.5);
  expect(riskMeasure({ ...row, measure: 'count_over_successors' }, people, calendar)).toBe(1);
  expect(
    riskMeasure(
      { ...row, subject: 'incumbent', fieldCode: 'age', filterOperator: 'eq', filterValues: [30] },
      people,
      calendar,
    ),
  ).toBe(1);
  expect(riskMeasure({ ...row, measure: 'count_over_incumbents' }, { ...people, incumbents: [] }, calendar)).toBeNull();
  expect(riskMeasure(row, { ...people, successors: [] }, calendar)).toBeNull();
});
it('AC-SC-risk 兼职开关分别计入；同一人员不重复计数', () => {
  expect(riskIncumbents(people.incumbents, [people.incumbents[0]!, { id: 'd' }], false)).toHaveLength(2);
  expect(riskIncumbents(people.incumbents, [people.incumbents[0]!, { id: 'd' }], true)).toHaveLength(3);
});
it('AC-SC-risk B2b between 含两端；比例不舍入，先命中优先；空值 ne 不误命中', () => {
  for (const count of [1, 2]) {
    const population = { ...people, successors: Array.from({ length: count }, (_, i) => ({ id: String(i) })) };
    expect(evaluateRisk([level('first'), level('second')], population, calendar)).toBe('first');
  }
  expect(evaluateRisk([level('outside', [{ ...row, threshold: 2 }])], people, calendar)).toBeNull();
  expect(
    evaluateRisk(
      [level('ratio', [{ ...row, measure: 'count_over_incumbents', comparator: 'eq', threshold: 0.5 }])],
      people,
      calendar,
    ),
  ).toBe('ratio');
  expect(
    evaluateRisk(
      [level('empty', [{ ...row, comparator: 'ne', threshold: 0 }])],
      { ...people, successors: [] },
      calendar,
    ),
  ).toBeNull();
});
it('AC-SC-risk 缓存失效、来源无权 / 不可用使对象失败，不向下匹配', () => {
  expect(() => evaluateRisk([{ ...level('stale'), compilerVersion: 'old' }, level('next')], people, calendar)).toThrow(
    'RULE_CACHE_STALE',
  );
  for (const status of ['forbidden', 'unavailable'] as const)
    expect(() =>
      riskMeasure(
        { ...row, fieldCode: 'age', filterOperator: 'eq', filterValues: [30] },
        { ...people, successors: [{ id: 'hidden', age: { status } }] },
        calendar,
      ),
    ).toThrow(status === 'forbidden' ? 'FIELD_FORBIDDEN' : 'DATA_UNAVAILABLE');
});
