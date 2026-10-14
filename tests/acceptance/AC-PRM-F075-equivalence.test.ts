/**
 * AC-PRM-F075 对照转录的规范化口径（#177 审查 P3-2）：只规范化生成标识与技术时间字段，业务时间原值参与比较，
 * 所以“比较通过”不会抹平业务时间的回退。
 */
import { describe, expect, it } from 'vitest';
import { type Step, transcriptOf } from './support/f075-equivalence.js';

const step = (body: unknown): Step => ({ name: 's', status: 200, body });
const A = '6d8f8f0e-2a4d-4b8b-8d64-5b0c2f7a9e11';
const B = '7d8f8f0e-2a4d-4b8b-8d64-5b0c2f7a9e12';

describe('AC-PRM-F075 转录规范化', () => {
  it('生成标识按首次出现顺序编号；不同对象的标识仍可区分', () => {
    const out = transcriptOf([step({ id: A, other: B, again: A })]) as { body: Record<string, string> }[];
    expect(out[0]!.body).toEqual({ id: '<id:1>', other: '<id:2>', again: '<id:1>' });
  });

  it('技术时间字段 createdAt / updatedAt 占位；业务时间（含完整时间戳）与其他字段原值保留', () => {
    const body = {
      createdAt: '2026-10-09 19:21:18.242+00',
      updatedAt: '2026-10-09T19:21:18.242Z',
      startDate: '2026-01-01',
      dueAt: '2026-03-01T04:00:00.000Z',
      effectiveDate: '2026-03-01 04:00:00+00',
      note: '截止 2026-03-01T04:00:00Z',
    };
    const out = transcriptOf([step(body)]) as { body: Record<string, string> }[];
    expect(out[0]!.body).toEqual({ ...body, createdAt: '<ts>', updatedAt: '<ts>' });
  });

  it('业务时间不同 → 规范化后仍不相等（不会被抹平）', () => {
    const left = transcriptOf([step({ dueAt: '2026-03-01T04:00:00.000Z' })]);
    const right = transcriptOf([step({ dueAt: '2026-03-02T04:00:00.000Z' })]);
    expect(left).not.toEqual(right);
  });
});
