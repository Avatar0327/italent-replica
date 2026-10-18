/**
 * AC-PT-13 主职周期边界（docs/08_设计/R2-T05_兼职设计.md §4.3A，§9 PB-22、PB-58、PB-59；PT-3a 服务层）：
 * 离职钩子只在落地那一刻结束兼职、不补发，所以所有人工写入口都过同一个边界校验：兼职区间不得越过该周期已生效离职 /
 * 退休的最后工作日 L（B-2，越界当次拒绝、不自动截断，A-16）；未落地离职的最后工作日 Lp 之后开始的拒绝、跨越的只提示（B-3 / B-4）。
 * 撤销（删除）离职后边界随时间轴记录消失而解除。日期框架：今天 2026-10-01，主职 2025-01-01 入职。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { serviceWorld } from './AC-PT-service-support.js';

const database = useTestDb();

describe('B-2：已生效离职（L = 09-15，离职生效日 09-16）', () => {
  it('PB-58：无结束日 / 结束日 09-20 → 409 PART_TIME_BEYOND_EXIT（detail.lastWorkDate），结束日 09-15 成功', async () => {
    const w = await serviceWorld(database().db, 'pt13-beyond');
    await w.leave('2026-09-15');
    const before = await w.writes();
    for (const endDate of [null, '2026-09-20']) {
      const error = await w.rejection({ startDate: '2026-09-01', endDate });
      expect(error.code).toBe('CONFLICT');
      expect(w.reason(error)).toBe('PART_TIME_BEYOND_EXIT');
      expect(error.details).toMatchObject({ lastWorkDate: '2026-09-15' });
    }
    expect(await w.writes()).toEqual(before);
    const ok = await w.create({ startDate: '2026-09-01', endDate: '2026-09-15' });
    expect(ok).toMatchObject({ endDate: '2026-09-15', serviceStatus: 'ended' });
  });

  it('PB-59：补录开始日 09-17（离职之后）→ 409 PART_TIME_PRIMARY_NOT_ACTIVE（B-1）', async () => {
    const w = await serviceWorld(database().db, 'pt13-after-exit');
    await w.leave('2026-09-15');
    const error = await w.rejection({ startDate: '2026-09-17', endDate: '2026-09-18' });
    expect(error.code).toBe('CONFLICT');
    expect(w.reason(error)).toBe('PART_TIME_PRIMARY_NOT_ACTIVE');
  });

  it('撤销离职后边界解除：删除离职记录后同样的补录成功（正例，§4.3A 末）', async () => {
    const w = await serviceWorld(database().db, 'pt13-undone');
    const exit = await w.leave('2026-09-15');
    expect(w.reason(await w.rejection({ startDate: '2026-09-01', endDate: null }))).toBe('PART_TIME_BEYOND_EXIT');
    const removed = await w.request('DELETE', `/businesses/${exit.id}`, { ifMatch: exit.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
    const ok = await w.create({ startDate: '2026-09-01', endDate: null });
    expect(ok.endDate).toBeNull();
  });
});

describe('B-3 / B-4：未落地离职（Lp = 09-15）', () => {
  it('PB-22：开始 09-07 无结束日 → 成功并提示 PART_TIME_SPANS_PENDING_EXIT；开始 09-16 → 409 PART_TIME_AFTER_EXIT', async () => {
    const w = await serviceWorld(database().db, 'pt13-pending');
    await w.pendingExit('2026-09-15');
    const spans = await w.create({ startDate: '2026-09-07', endDate: null });
    expect(spans.warnings).toEqual(['PART_TIME_SPANS_PENDING_EXIT']);
    const within = await w.create({ startDate: '2026-09-07', endDate: '2026-09-15' });
    expect(within.warnings).toEqual([]);
    const before = await w.writes();
    const error = await w.rejection({ startDate: '2026-09-16', endDate: null });
    expect(error.code).toBe('CONFLICT');
    expect(w.reason(error)).toBe('PART_TIME_AFTER_EXIT');
    expect(error.details).toMatchObject({ lastWorkDate: '2026-09-15' });
    expect(await w.writes()).toEqual(before);
  });

  it('已批准未落地（approved）同样计入；取多条未落地离职中最早的最后工作日', async () => {
    const w = await serviceWorld(database().db, 'pt13-pending-approved');
    await w.pendingExit('2026-09-25', 'approved');
    await w.pendingExit('2026-09-15', 'in_review');
    expect(w.reason(await w.rejection({ startDate: '2026-09-20', endDate: '2026-09-22' }))).toBe(
      'PART_TIME_AFTER_EXIT',
    );
  });

  it('草稿等未提交的离职不计（只认审批中 / 已批准未落地）', async () => {
    const w = await serviceWorld(database().db, 'pt13-pending-draft');
    await w.pendingExit('2026-09-15', 'draft');
    const ok = await w.create({ startDate: '2026-09-20', endDate: null });
    expect(ok.warnings).toEqual([]);
  });
});
