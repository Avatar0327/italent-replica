/**
 * AC-DM-26（纯函数部分）：最终执行日期与同日先后的单一来源（docs/08_设计/R2-T03_离职管理设计.md §5.0 / §5.0A，DEC-496④）。
 */
import { describe, expect, it } from 'vitest';
import { resolveLateExecution, resolveLateLeave } from './late-execution.js';
import {
  compareExecutionOrder,
  EXECUTION_KINDS,
  finalExecutionDate,
  type ExecutionKey,
  type ExecutionKind,
} from './execution-order.js';

const base = { lastWorkDate: null, executionDate: '2026-10-18' } as const;

describe('finalExecutionDate（§5.0）', () => {
  it.each([
    ['计划日已过：迟到调动顺延到执行日（DEC-186）', '2026-10-10', '2026-10-18'],
    ['计划日当天执行：不顺延', '2026-10-18', '2026-10-18'],
    ['计划日在未来：保持计划日', '2026-10-25', '2026-10-25'],
  ])('调动：%s', (_name, planned, expected) => {
    expect(finalExecutionDate({ ...base, kind: 'transfer', plannedEffectiveDate: planned })).toBe(expected);
  });

  it.each([
    ['最后工作日 + 1 已过：顺延到执行日（DEC-263① / 272）', '2026-10-15', '2026-10-18'],
    ['最后工作日 + 1 正是执行日：不顺延', '2026-10-17', '2026-10-18'],
    ['最后工作日 + 1 在未来：保持', '2026-10-24', '2026-10-25'],
  ])('离职（给最后工作日）：%s', (_name, lastWorkDate, expected) => {
    expect(
      finalExecutionDate({
        kind: 'leave',
        plannedEffectiveDate: '2026-10-16',
        lastWorkDate,
        executionDate: '2026-10-18',
      }),
    ).toBe(expected);
  });

  it('离职：只调用 late-execution.ts 既有函数，与 resolveLateLeave 逐日等价', () => {
    for (const lastWorkDate of ['2026-09-30', '2026-10-17', '2026-10-18', '2026-12-31'])
      for (const executionDate of ['2026-10-01', '2026-10-18', '2027-01-01'])
        expect(
          finalExecutionDate({ kind: 'leave', plannedEffectiveDate: '1900-01-01', lastWorkDate, executionDate }),
        ).toBe(resolveLateLeave({ lastWorkDate, executionDate }).effectiveDate);
  });

  it('离职：未给最后工作日时由计划日（= 最后工作日 + 1）推出，结果与调动同式 max(计划日, 执行日)', () => {
    for (const planned of ['2026-10-10', '2026-10-18', '2026-10-25'])
      expect(finalExecutionDate({ ...base, kind: 'leave', plannedEffectiveDate: planned })).toBe(
        resolveLateExecution({ plannedEffectiveDate: planned, executionDate: '2026-10-18' }).effectiveDate,
      );
  });

  it('退休沿用离职的迟到顺延（R2-T04 §4.2，DEC-638 A-15）：与 leave 逐日等价', () => {
    for (const lastWorkDate of ['2026-09-30', '2026-10-17', '2026-10-18', '2026-12-31'])
      for (const executionDate of ['2026-10-01', '2026-10-18', '2027-01-01']) {
        const input = { plannedEffectiveDate: '1900-01-01', lastWorkDate, executionDate };
        expect(finalExecutionDate({ ...input, kind: 'retirement' })).toBe(
          finalExecutionDate({ ...input, kind: 'leave' }),
        );
      }
    expect(
      finalExecutionDate({ ...base, kind: 'retirement', plannedEffectiveDate: '2026-10-10', lastWorkDate: '2026-10-09' }),
    ).toBe('2026-10-18');
    expect(finalExecutionDate({ ...base, kind: 'retirement', plannedEffectiveDate: '2026-10-25' })).toBe('2026-10-25');
  });

  it.each(EXECUTION_KINDS.filter((kind) => !['transfer', 'leave', 'retirement'].includes(kind)))(
    '%s 按原生效日落地，不随执行日顺延（契约 C-5 末句）',
    (kind) => {
      expect(finalExecutionDate({ ...base, kind, plannedEffectiveDate: '2026-10-10' })).toBe('2026-10-10');
      expect(finalExecutionDate({ ...base, kind, plannedEffectiveDate: '2026-10-25' })).toBe('2026-10-25');
    },
  );
});

const key = (overrides: Partial<ExecutionKey>): ExecutionKey => ({
  finalDate: '2026-10-18',
  plannedDate: '2026-10-18',
  opensCycle: false,
  operationKey: 1,
  ...overrides,
});

describe('compareExecutionOrder（契约 C-3 唯一规则）', () => {
  it('① 最终执行日期先比', () => {
    expect(compareExecutionOrder(key({ finalDate: '2026-10-17' }), key({ finalDate: '2026-10-18' }))).toBeLessThan(0);
    expect(compareExecutionOrder(key({ finalDate: '2026-10-19' }), key({ finalDate: '2026-10-18' }))).toBeGreaterThan(
      0,
    );
  });

  it('② 同日比计划生效日（DEC-195①），计划日更早的在前', () => {
    expect(compareExecutionOrder(key({ plannedDate: '2026-10-10' }), key({ plannedDate: '2026-10-16' }))).toBeLessThan(
      0,
    );
  });

  it('③ 计划日也相同：开新周期的 kind（hire / rehire / retire_rehire）排后', () => {
    expect(compareExecutionOrder(key({ opensCycle: true }), key({ opensCycle: false }))).toBeGreaterThan(0);
    expect(compareExecutionOrder(key({ opensCycle: false }), key({ opensCycle: true }))).toBeLessThan(0);
  });

  it('④ 最后看操作序号；没有序号（正在落地的直接业务）视为最新，与 SQL ORDER BY 默认的 NULLS LAST 一致', () => {
    expect(compareExecutionOrder(key({ operationKey: 1 }), key({ operationKey: 2 }))).toBeLessThan(0);
    expect(compareExecutionOrder(key({ operationKey: null }), key({ operationKey: 99 }))).toBeGreaterThan(0);
    expect(compareExecutionOrder(key({ operationKey: null }), key({ operationKey: null }))).toBe(0);
    expect(compareExecutionOrder(key({}), key({}))).toBe(0);
  });

  it('第 5 轮 P2-01 原反例：迟到调动 T（计划 10-10）与离职（E = 10-16）在 10-18 同时执行，T 排在离职之前', () => {
    const a = '2026-10-18';
    const transfer: ExecutionKey = {
      finalDate: finalExecutionDate({
        kind: 'transfer',
        plannedEffectiveDate: '2026-10-10',
        lastWorkDate: null,
        executionDate: a,
      }),
      plannedDate: '2026-10-10',
      opensCycle: false,
      operationKey: 7,
    };
    const exit: ExecutionKey = {
      finalDate: finalExecutionDate({
        kind: 'leave',
        plannedEffectiveDate: '2026-10-16',
        lastWorkDate: '2026-10-15',
        executionDate: a,
      }),
      plannedDate: '2026-10-16',
      opensCycle: false,
      operationKey: 3,
    };
    expect([exit, transfer].sort(compareExecutionOrder)).toEqual([transfer, exit]);
  });

  it('是全序：随机键上与逐键字典序独立实现一致，且反对称、可传递排序稳定', () => {
    let state = 20261018;
    const random = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    const date = () => `2026-10-${String(10 + Math.floor(random() * 4)).padStart(2, '0')}`;
    const keys = Array.from({ length: 200 }, (): ExecutionKey => ({
      finalDate: date(),
      plannedDate: date(),
      opensCycle: random() < 0.3,
      operationKey: random() < 0.15 ? null : Math.floor(random() * 5),
    }));
    const tuple = (k: ExecutionKey) =>
      [
        k.finalDate,
        k.plannedDate,
        k.opensCycle ? '1' : '0',
        k.operationKey === null ? 'z' : String(k.operationKey),
      ].join('|');
    const expected = [...keys].sort((x, y) => (tuple(x) < tuple(y) ? -1 : tuple(x) > tuple(y) ? 1 : 0));
    expect([...keys].sort(compareExecutionOrder).map(tuple)).toEqual(expected.map(tuple));
    for (const x of keys.slice(0, 40))
      for (const y of keys.slice(0, 40))
        expect(Math.sign(compareExecutionOrder(x, y)) + Math.sign(compareExecutionOrder(y, x))).toBe(0);
  });
});

describe('类型', () => {
  it('EXECUTION_KINDS 覆盖任职业务的全部 kind', () => {
    const kinds: readonly ExecutionKind[] = EXECUTION_KINDS;
    expect(new Set(kinds)).toEqual(
      new Set([
        'hire',
        'rehire',
        'retire_rehire',
        'regularization',
        'transfer',
        'org_adjustment',
        'leave',
        'retirement',
        'intern_regularization',
      ]),
    );
  });
});
