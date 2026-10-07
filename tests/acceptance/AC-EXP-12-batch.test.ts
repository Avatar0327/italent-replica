/**
 * AC-EXP-12：计算项目按优先级、再按引用依赖拓扑排序；循环依赖报错；批量求值返回每个对象的值或失败原因
 * （`26` §3.5 TR-R27，REQ-EXP-001）。
 */
import { evaluateBatch, inMemorySubject, orderComputationItems, type ComputationItem } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { CALENDAR, PROJECT } from './AC-EXP-support.js';

const item = (field: string, priority: number, formula: string): ComputationItem => ({ field, priority, formula });

describe('AC-EXP-12 计算优先级与依赖顺序', () => {
  it('先按优先级（数字越小越先算），同优先级按引用依赖拓扑排序', () => {
    const items = [
      item('盘点对象.等级', 1, '如果 盘点对象.综合得分 >= 80 那么 "A" 否则 "B"'),
      item('盘点对象.综合得分', 1, '(盘点对象.绩效得分 + 盘点对象.潜力得分) / 2'),
      item('盘点对象.标签', 2, '如果 盘点对象.等级 = "A" 那么 "高潜" 否则 ""'),
      item('盘点对象.备注', 0, '"固定文本"'),
    ];
    const ordered = orderComputationItems(items);
    expect(ordered.ok).toBe(true);
    if (!ordered.ok) return;
    expect(ordered.order.map((entry) => entry.field)).toEqual([
      '盘点对象.备注',
      '盘点对象.综合得分',
      '盘点对象.等级',
      '盘点对象.标签',
    ]);
  });

  it('优先级与依赖矛盾时以依赖为准，并在结果中给出提示', () => {
    const items = [item('盘点对象.b', 1, '盘点对象.a + 1'), item('盘点对象.a', 2, '1')];
    const ordered = orderComputationItems(items);
    expect(ordered.ok).toBe(true);
    if (!ordered.ok) return;
    expect(ordered.order.map((entry) => entry.field)).toEqual(['盘点对象.a', '盘点对象.b']);
    expect(ordered.warnings).toHaveLength(1);
  });

  it('循环依赖：CYCLIC_DEPENDENCY 并列出环上的字段', () => {
    const items = [
      item('盘点对象.a', 1, '盘点对象.b + 1'),
      item('盘点对象.b', 1, '盘点对象.c + 1'),
      item('盘点对象.c', 1, '盘点对象.a + 1'),
      item('盘点对象.d', 1, '1'),
    ];
    const ordered = orderComputationItems(items);
    expect(ordered.ok).toBe(false);
    if (ordered.ok) return;
    expect(ordered.failure.code).toBe('CYCLIC_DEPENDENCY');
    if (ordered.failure.code !== 'CYCLIC_DEPENDENCY') return;
    expect(ordered.failure.cycle).toEqual(['盘点对象.a', '盘点对象.b', '盘点对象.c', '盘点对象.a']);
  });

  it('公式有语法错误的项目在排序阶段就报错并给出位置', () => {
    const ordered = orderComputationItems([item('盘点对象.a', 1, '1 +')]);
    expect(ordered.ok).toBe(false);
    if (ordered.ok) return;
    expect(ordered.failure).toMatchObject({ code: 'SYNTAX_ERROR', field: '盘点对象.a', line: 1 });
  });
});

describe('AC-EXP-12 批量求值：每个对象得到值或失败原因，后算项目能引用先算项目的结果', () => {
  const items = [
    item('盘点对象.综合得分', 1, '(盘点对象.绩效得分 + 盘点对象.潜力得分) / 2'),
    item('盘点对象.等级', 1, '如果 盘点对象.综合得分 >= 80 那么 "A" 否则 "B"'),
    item('盘点对象.名次', 2, 'Ranking("排序号", 盘点对象.综合得分)'),
  ];
  const subjects = [
    inMemorySubject('e1', { '盘点对象.绩效得分': 90, '盘点对象.潜力得分': 80 }),
    inMemorySubject('e2', { '盘点对象.绩效得分': 60, '盘点对象.潜力得分': 70 }),
    // DEC-257 后空值按 0 参与四则不再失败，改用非数字文本制造计算失败
    inMemorySubject('e3', { '盘点对象.绩效得分': '缺考', '盘点对象.潜力得分': 70 }),
  ];

  it('失败对象只影响自身，依赖失败项目的后续项目标 DEPENDENCY_FAILED', () => {
    const batch = evaluateBatch(items, subjects, { calendar: CALENDAR, project: PROJECT });
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.results.e1).toMatchObject({
      '盘点对象.综合得分': { ok: true, value: { value: 85 } },
      '盘点对象.等级': { ok: true, value: { value: 'A' } },
      '盘点对象.名次': { ok: true, value: { value: 1 } },
    });
    expect(batch.results.e2).toMatchObject({
      '盘点对象.等级': { ok: true, value: { value: 'B' } },
      '盘点对象.名次': { ok: true, value: { value: 2 } },
    });
    expect(batch.results.e3).toMatchObject({
      '盘点对象.综合得分': { ok: false, failure: { code: 'TEXT_IN_ARITHMETIC' } },
      '盘点对象.等级': { ok: false, failure: { code: 'DEPENDENCY_FAILED' } },
    });
  });

  it('排名的人员范围默认是本次计算对象；计算失败的对象不参与排名', () => {
    const batch = evaluateBatch(items, subjects, { calendar: CALENDAR, project: PROJECT });
    if (!batch.ok) return;
    expect(batch.results.e3?.['盘点对象.名次']).toMatchObject({ ok: false, failure: { code: 'DEPENDENCY_FAILED' } });
    expect(batch.results.e2?.['盘点对象.名次']).toMatchObject({ ok: true, value: { value: 2 } });
  });

  it('空值按 0 参与四则（DEC-257）：对象照常算出值并参与排名', () => {
    const withEmpty = [
      ...subjects.slice(0, 2),
      inMemorySubject('e4', { '盘点对象.绩效得分': null, '盘点对象.潜力得分': 70 }),
    ];
    const batch = evaluateBatch(items, withEmpty, { calendar: CALENDAR, project: PROJECT });
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.results.e4).toMatchObject({
      '盘点对象.综合得分': { ok: true, value: { value: 35 } },
      '盘点对象.等级': { ok: true, value: { value: 'B' } },
      '盘点对象.名次': { ok: true, value: { value: 3 } },
    });
  });

  it('循环依赖时整批不执行，返回排序失败', () => {
    const cyclic = [item('盘点对象.a', 1, '盘点对象.b'), item('盘点对象.b', 1, '盘点对象.a')];
    const batch = evaluateBatch(cyclic, subjects, { calendar: CALENDAR });
    expect(batch).toMatchObject({ ok: false, failure: { code: 'CYCLIC_DEPENDENCY' } });
  });
});
