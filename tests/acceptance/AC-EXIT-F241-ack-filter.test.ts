/**
 * F-241：确认清单 S 的过滤条件在 SQL 里一次给全（审批中 ∪ 已批准未落地且计划生效日 > L），小规模语义校验。
 * 预览、创建 / 提交的确认校验、迟到生效重算共用 pendingTransferAckSet 一个入口；大规模回归见 AC-EXIT-F241-ack-filter-pg。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { downstreamWorld, type DownstreamWorld } from './AC-EXIT-downstream-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const LAST_WORK_DATE = '2026-10-20';

describe('F-241 确认清单过滤条件（SQL）', () => {
  it('前序（已批准且计划日 ≤ L）排除；审批中不论生效日都纳入；已批准且计划日 > L 纳入', async () => {
    const x = await downstreamWorld(database().db, 'f241-filter', TODAY);
    await x.transferIn('approved', '2026-10-10'); // 前序：先于离职落地
    const early = await x.transferIn('in_review', '2026-10-12'); // 审批中，生效日 ≤ L
    const late = await x.transferIn('in_review', '2026-11-05'); // 审批中，生效日 > L
    const approvedLater = await x.transferIn('approved', '2026-10-25'); // 已批准未落地，计划日 > L
    const response = await x.session.request('POST', `/exits/employees/${x.employee.id}/preview`, {
      body: { lastWorkDate: LAST_WORK_DATE },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const { ack } = (await response.json()) as { ack: { items: { businessId: string }[]; hiddenCount: number } };
    expect(ack.hiddenCount).toBe(0);
    expect(ack.items.map((item) => item.businessId).sort()).toEqual([early.id, late.id, approvedLater.id].sort());
  });
});

const LATE_DAY = '2026-10-22';

/**
 * 真实迟到生效：前序调动经申请、审批后由调度在 10-11 真正落地；离职 L=10-20 在 10-22 才执行，顺延成 L′=10-21。
 * 令牌哈希含 L，顺延后必变；只有 ID 集合真有差异才写 employment.exit.ack_set_changed。
 */
async function lateWorld(label: string) {
  const x = await downstreamWorld(database().db, label, TODAY);
  await x.transferIn('approved', '2026-10-10'); // 前序 ×2：先于离职落地
  await x.transferIn('approved', '2026-10-11');
  const kept = await x.transferIn('in_review', '2026-10-12');
  const other = await x.transferIn('in_review', '2026-11-05');
  const preview = await previewOf(x);
  expect(preview.ack!.items.map((item) => item.businessId).sort()).toEqual([kept.id, other.id].sort());
  const leave = await x.directLeave(LAST_WORK_DATE, { pendingTransferAck: preview.ack!.ackToken });
  const landed = await x.runScheduler('2026-10-11T01:00:00Z');
  expect(landed.activated).toHaveLength(2);
  return { x, leave, kept, other };
}
const previewOf = async (x: DownstreamWorld) => {
  const response = await x.session.request('POST', `/exits/employees/${x.employee.id}/preview`, {
    body: { lastWorkDate: LAST_WORK_DATE },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as { ack: { ackToken: string; items: { businessId: string }[] } };
};

describe('F-241 迟到生效重算：只在 ID 集合真有差异时写审计', () => {
  it('前序真实落地、集合不变：顺延后令牌哈希虽变，但不写 ack_set_changed', async () => {
    const { x, leave } = await lateWorld('f241-late-same');
    expect(await x.activate(leave.id, LATE_DAY)).toMatchObject({ outcome: 'effective', postponed: true });
    expect(await x.audits(leave.id, 'employment.exit.ack_set_changed')).toEqual([]);
  });

  it('集合确实变了（确认后一条审批中调动被驳回）：保留 ack_set_changed 审计，前后 ID 如实记录', async () => {
    const { x, leave, kept, other } = await lateWorld('f241-late-changed');
    await x.rejectInReview(other.id);
    expect(await x.activate(leave.id, LATE_DAY)).toMatchObject({ outcome: 'effective', postponed: true });
    const [audit] = await x.audits(leave.id, 'employment.exit.ack_set_changed');
    expect((audit!.before as { ids: string[] }).ids).toEqual([kept.id, other.id].sort());
    expect(audit!.after).toMatchObject({ ids: [kept.id], lastWorkDate: '2026-10-21' });
  });
});
