/**
 * F-241：确认清单 S 的过滤条件在 SQL 里一次给全（审批中 ∪ 已批准未落地且计划生效日 > L），小规模语义校验。
 * 预览、创建 / 提交的确认校验、迟到生效重算共用 pendingTransferAckSet 一个入口；大规模回归见 AC-EXIT-F241-ack-filter-pg。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';

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
