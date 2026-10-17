/**
 * BE-14a3 第 2 轮（#398 衔接）：审批中的 Offer 被失效后，在途审批由本单的 cancelOfferApprovals 在失效事务内收口。
 * #398 的失效命令尚未合入 main：这里以可信事务模拟它的写入（主状态失效、失效字段、revision + 1），并在同一事务里调用
 * 本单入口——#398 合入后由后合方把该入口接进失效事务（PR 描述“未决 / 假设”）。
 * - 单个：实例作废、待办消失、Offer 回到未发起审批（节点允许撤回 / 禁止撤回两种，作废都不看撤回开关）；
 * - 批量（最保守口径）：整张批量单作废，同单其他 Offer 回到未发起审批。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { cancelOfferApprovals } from '../../apps/api/src/modules/offer/approval.js';
import { offerApprovalWorld, reasonOf, type OfferView } from './AC-OF-BE14a3-support.js';

const testDb = useTestDb();

async function world(label: string) {
  const w = await offerApprovalWorld(testDb().db, label);
  /** 模拟 #398 失效事务：锁 Offer、改失效状态与 revision，再在同一事务里作废在途审批。 */
  const invalidate = (offer: OfferView) =>
    withTenant(w.db, w.tenant.id, async (tx) => {
      await tx.execute(sql`SELECT 1 FROM offers WHERE id = ${offer.id} FOR UPDATE`);
      await tx.execute(sql`UPDATE offers SET status = 'invalid', invalid_reason_code = 'candidate_gave_up',
        invalid_at = now(), revision = revision + 1 WHERE id = ${offer.id}`);
      const ctx = { tenantId: w.tenant.id, userId: w.applicant.userId, timezone: 'Asia/Shanghai' };
      await cancelOfferApprovals(tx, { ...ctx, now: w.clock(), commandId: randomUUID() }, offer.id);
    });
  const todos = async (userId: string) => (await w.todos(userId)).items;
  return { ...w, invalidate, todos };
}

describe('失效后作废在途审批（#398 衔接）', () => {
  it('单个、节点允许撤回：实例作废、负责人待办消失，Offer 失效且回到未发起审批', async () => {
    const w = await world('void-single');
    const offer = await w.offer(w.applicant);
    await w.json(await w.submitRaw(offer));
    expect(await w.todos(w.head.userId)).toHaveLength(1);
    await w.invalidate(offer);
    expect((await w.instance(offer.id)).status).toBe('cancelled');
    expect(await w.todos(w.head.userId)).toEqual([]);
    expect(await w.get(offer.id)).toMatchObject({ status: 'invalid', approvalStatus: 'unsubmitted' });
  });

  it('单个、节点禁止撤回：发起人撤不回，失效时照样作废（不看撤回开关）', async () => {
    const w = await world('void-locked');
    await w.publishedProcess({
      code: `OF3_LOCKED_${randomUUID().replaceAll('-', '')}`.slice(0, 60),
      approvalType: 'offer',
      conditions: { items: [{ no: 1, field: 'offer.offerType', operator: 'eq', value: 'intern' }] },
      nodes: [{ key: 'locked', approver: 'offer_department_head', actions: { revoke: false } }],
    });
    const offer = await w.offer(w.applicant);
    await w.json(await w.submitRaw(offer));
    const view = await w.instance(offer.id);
    expect(view.currentNodeKey).toBe('locked');
    const refused = await w.instanceAction(w.applicant.userId, view.id, 'withdraw', view.revision);
    expect(await reasonOf(refused)).toMatchObject({ status: 409, reason: 'APPROVAL_ACTION_DISABLED' });
    await w.invalidate(offer);
    expect((await w.instance(offer.id)).status).toBe('cancelled');
    expect(await w.todos(w.head.userId)).toEqual([]);
  });

  it('批量：一份失效 → 整张批量单作废、上级待办消失，同单其他 Offer 回到未发起审批、可重新发起', async () => {
    const w = await world('void-batch');
    const [gone, kept] = [await w.offer(w.applicant), await w.offer(w.applicant)];
    const batch = await w.json<{ id: string }>(await w.batchRaw({ offerIds: [gone.id, kept.id] }), 201);
    expect(await w.todos(w.manager.userId)).toHaveLength(1);
    await w.invalidate(gone);
    expect((await w.instance(batch.id)).status).toBe('cancelled');
    expect(await w.todos(w.manager.userId)).toEqual([]);
    expect(await w.get(gone.id)).toMatchObject({ status: 'invalid', approvalStatus: 'unsubmitted' });
    const back = await w.get(kept.id);
    expect(back).toMatchObject({ status: 'pending', approvalStatus: 'unsubmitted', currentApprovers: [] });
    expect((await w.json<OfferView>(await w.submitRaw(back))).approvalStatus).toBe('approving');
  });
});
