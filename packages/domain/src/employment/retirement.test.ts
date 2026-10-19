/**
 * AC-RT-08（纯函数部分）：退休类型由最后工作日 L 与创建时快照的预计退休日期 P 派生
 * （docs/08_设计/R2-T04_退休设计.md §3.5，DEC-638 A-3）。
 */
import { describe, expect, it } from 'vitest';
import { deriveRetireType, RETIRE_TYPES } from './retirement.js';

describe('deriveRetireType（§3.5）', () => {
  it.each([
    ['L 早于 P：提前退休', '2030-05-31', '2030-06-01', 'early'],
    ['L 等于 P：正常退休', '2030-06-01', '2030-06-01', 'normal'],
    ['L 晚于 P：延迟退休', '2030-06-02', '2030-06-01', 'delayed'],
    ['P 为空：无法判定', '2030-06-02', null, null],
    ['P 缺省：无法判定', '2030-06-02', undefined, null],
  ])('%s', (_name, lastWorkDate, expected, type) => {
    expect(deriveRetireType(lastWorkDate, expected)).toBe(type);
  });

  it('取值集合固定为 early / normal / delayed', () => {
    expect([...RETIRE_TYPES]).toEqual(['early', 'normal', 'delayed']);
  });
});
