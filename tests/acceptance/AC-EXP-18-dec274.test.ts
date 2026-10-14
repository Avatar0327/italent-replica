/**
 * AC-EXP-18 DEC-274（取证 Q-M0-84 实测，`26` §8.9；修订 DEC-265“保存时拒绝循环”）：
 * ① 保存 / 启用时检测到循环依赖只给不阻断的提示，列出成环的项目与依赖路径，允许保存；
 * ② 计算时只要存在循环，整次计算不写入任何值，结果为“计算失败：循环依赖 A→B→A”；
 * ③ 同一优先级内按依赖关系排序计算。
 * 引擎侧覆盖排序（保存校验）与批量求值；计算状态展示与审计由 R3-T04 落实（见 PR 描述）。
 */
import { evaluateBatch, inMemorySubject, orderComputationItems, type ComputationItem } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { CALENDAR } from './AC-EXP-support.js';

const item = (field: string, priority: number, formula: string): ComputationItem => ({ field, priority, formula });

/** 原站实测的结构：A、B 同为优先级 1 且互相引用，C 读出 A、B，另有一个独立的常量项目。 */
const CYCLIC_RULE = [
  item('盘点对象.A', 1, '盘点对象.B + 1'),
  item('盘点对象.B', 1, '盘点对象.A + 10'),
  item('盘点对象.C', 2, '盘点对象.A * 1000 + 盘点对象.B'),
  item('盘点对象.探针', 1, '77'),
];

describe('DEC-274 ① 保存 / 启用：循环依赖不阻断，只提示成环的项目与依赖路径', () => {
  it('允许保存，cycles 给出依赖路径，warnings 给出提示文案', () => {
    const ordered = orderComputationItems(CYCLIC_RULE);
    expect(ordered.ok).toBe(true);
    if (!ordered.ok) return;
    expect(ordered.cycles).toEqual([['盘点对象.A', '盘点对象.B', '盘点对象.A']]);
    const prompt = ordered.warnings.find((warning) => warning.includes('循环依赖'));
    expect(prompt).toContain('盘点对象.A→盘点对象.B→盘点对象.A');
    expect(prompt).toContain('计算时将整次失败');
  });

  it('受循环牵连的项目（依赖成环项目的 C）也在提示里列出；不相关的项目照常排序', () => {
    const ordered = orderComputationItems(CYCLIC_RULE);
    if (!ordered.ok) throw new Error('应允许保存');
    expect(ordered.blocked).toEqual(['盘点对象.A', '盘点对象.B', '盘点对象.C']);
    expect(ordered.warnings.join('\n')).toContain('盘点对象.C');
    expect(ordered.order.map((entry) => entry.field)).toContain('盘点对象.探针');
    expect(ordered.order).toHaveLength(CYCLIC_RULE.length);
  });

  it('多个环分别列出', () => {
    const ordered = orderComputationItems([
      item('盘点对象.a', 1, '盘点对象.b'),
      item('盘点对象.b', 1, '盘点对象.a'),
      item('盘点对象.x', 1, '盘点对象.x + 1'),
    ]);
    if (!ordered.ok) throw new Error('应允许保存');
    expect(ordered.cycles).toEqual([
      ['盘点对象.a', '盘点对象.b', '盘点对象.a'],
      ['盘点对象.x', '盘点对象.x'],
    ]);
  });

  it('没有循环时 cycles 为空、blocked 为空', () => {
    const ordered = orderComputationItems([item('盘点对象.a', 1, '1'), item('盘点对象.b', 1, '盘点对象.a')]);
    if (!ordered.ok) throw new Error('应允许保存');
    expect(ordered.cycles).toEqual([]);
    expect(ordered.blocked).toEqual([]);
  });

  it('公式语法错误仍然拒绝保存（与循环提示区分）', () => {
    expect(orderComputationItems([item('盘点对象.a', 1, '1 +')])).toMatchObject({
      ok: false,
      failure: { code: 'SYNTAX_ERROR' },
    });
  });
});

describe('DEC-274 ② 计算：存在循环时整次不写任何值，明确报“计算失败：循环依赖 A→B→A”', () => {
  const subjects = [inMemorySubject('e1', { '盘点对象.A': 5, '盘点对象.B': 6 }), inMemorySubject('e2', {})];

  it('整批失败，不返回任何对象的任何结果（独立的探针项目也不算），不是“计算成功”', () => {
    const batch = evaluateBatch(CYCLIC_RULE, subjects, { calendar: CALENDAR });
    expect(batch.ok).toBe(false);
    expect(batch).not.toHaveProperty('results');
    if (batch.ok) return;
    expect(batch.failure).toMatchObject({
      code: 'CYCLIC_DEPENDENCY',
      message: '计算失败：循环依赖 盘点对象.A→盘点对象.B→盘点对象.A',
      cycle: ['盘点对象.A', '盘点对象.B', '盘点对象.A'],
    });
  });

  it('多个环时失败信息列出全部环', () => {
    const batch = evaluateBatch(
      [item('盘点对象.a', 1, '盘点对象.b'), item('盘点对象.b', 1, '盘点对象.a'), item('盘点对象.x', 1, '盘点对象.x')],
      subjects,
      { calendar: CALENDAR },
    );
    expect(batch).toMatchObject({
      ok: false,
      failure: {
        code: 'CYCLIC_DEPENDENCY',
        message: '计算失败：循环依赖 盘点对象.a→盘点对象.b→盘点对象.a；盘点对象.x→盘点对象.x',
      },
    });
  });
});

describe('DEC-274 ③ 同一优先级内按依赖关系排序计算（原站两个方向都读到同轮新值）', () => {
  it.each([
    ['A = B + 1，B = 5（A 在前）', [item('盘点对象.A', 1, '盘点对象.B + 1'), item('盘点对象.B', 1, '5')], 6, 5],
    ['A = 5，B = A + 1（A 在前）', [item('盘点对象.A', 1, '5'), item('盘点对象.B', 1, '盘点对象.A + 1')], 5, 6],
  ] as const)('%s：读到的是同轮新值', (_label, items, a, b) => {
    const batch = evaluateBatch(items, [inMemorySubject('e1', { '盘点对象.A': 6, '盘点对象.B': 6 })], {
      calendar: CALENDAR,
    });
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.results.e1?.['盘点对象.A']).toEqual({ ok: true, value: { kind: 'number', value: a } });
    expect(batch.results.e1?.['盘点对象.B']).toEqual({ ok: true, value: { kind: 'number', value: b } });
  });
});
