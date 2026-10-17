/**
 * BE-14a3 与 #398（BE-14a2）的衔接：
 * - 失效（真实接口 POST /offers/:id/invalidate）在同一事务里作废在途审批：单个实例 cancelled、待办消失、Offer 回到未发起
 *   审批（节点允许 / 禁止撤回两种，作废不看撤回开关）；批量（最保守口径）整张批量单 cancelled，同单其他 Offer 回到未发起
 *   审批、可重新发起；
 * - 行操作：列表与详情的 rowActions 里出现“发起审批”（与发起入口同口径：Offer 编辑开关），并同时保留当前审批人 / 节点；
 *   无编辑开关、审批中、审批通过都不出现；
 * - 未决 14：失效一侧遇到死锁 / 序列化冲突时返回 409 OFFER_CONCURRENT_CONFLICT，不是 500。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as approvalModule from '../../apps/api/src/modules/offer/approval.js';
import { offerApprovalWorld, reasonOf, type OfferView } from './AC-OF-BE14a3-support.js';

const testDb = useTestDb();

interface RowActions {
  readonly primary: readonly string[];
  readonly menu: readonly string[];
}
type Listed = OfferView & { readonly rowActions: RowActions };

async function world(label: string) {
  const w = await offerApprovalWorld(testDb().db, label);
  const todos = async (userId: string) => (await w.todos(userId)).items;
  const invalidate = async (offer: OfferView) => {
    const response = await w.invalidateRaw(await w.get(offer.id));
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as OfferView;
  };
  return { ...w, todos, invalidate };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('失效接口作废在途审批（#398 衔接）', () => {
  it('单个、节点允许撤回：失效后实例作废、负责人待办消失，Offer 失效且回到未发起审批', async () => {
    const w = await world('void-single');
    const offer = await w.social(w.applicant);
    await w.json(await w.submitRaw(offer));
    expect(await w.todos(w.head.userId)).toHaveLength(1);
    const after = await w.invalidate(offer);
    expect(after).toMatchObject({ status: 'invalid', approvalStatus: 'unsubmitted' });
    expect((await w.instance(offer.id)).status).toBe('cancelled');
    expect(await w.todos(w.head.userId)).toEqual([]);
    expect(await w.get(offer.id)).toMatchObject({ status: 'invalid', currentApprovers: [] });
  });

  it('单个、节点禁止撤回：发起人撤不回，失效时照样作废（不看撤回开关）', async () => {
    const w = await world('void-locked');
    await w.publishedProcess({
      code: `OF3_LOCKED_${randomUUID().replaceAll('-', '')}`.slice(0, 60),
      approvalType: 'offer',
      conditions: { items: [{ no: 1, field: 'offer.offerType', operator: 'eq', value: 'social' }] },
      nodes: [{ key: 'locked', approver: 'offer_department_head', actions: { revoke: false } }],
    });
    const offer = await w.social(w.applicant);
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
    const [gone, kept] = [await w.social(w.applicant), await w.social(w.applicant)];
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

  it('没有在途审批的 Offer 失效照常（不动审批）', async () => {
    const w = await world('void-none');
    const offer = await w.social(w.applicant);
    expect(await w.invalidate(offer)).toMatchObject({ status: 'invalid', approvalStatus: 'unsubmitted' });
  });

  it('未决 14：失效一侧遇到死锁 / 序列化冲突 → 409 OFFER_CONCURRENT_CONFLICT，Offer 不变', async () => {
    const w = await world('void-deadlock');
    const offer = await w.social(w.applicant);
    await w.json(await w.submitRaw(offer));
    for (const code of ['40P01', '40001']) {
      vi.spyOn(approvalModule, 'lockOfferBatches').mockRejectedValueOnce(
        Object.assign(new Error('模拟锁冲突'), { code }),
      );
      expect(await reasonOf(await w.invalidateRaw(await w.get(offer.id))), code).toMatchObject({
        status: 409,
        code: 'CONFLICT',
        reason: 'OFFER_CONCURRENT_CONFLICT',
      });
    }
    expect(await w.get(offer.id)).toMatchObject({ status: 'pending', approvalStatus: 'approving' });
    expect((await w.instance(offer.id)).status).toBe('running');
  });
});

describe('行操作“发起审批”（#398 rowActions 接线）', () => {
  const actionsOf = (offer: Listed) => [...offer.rowActions.primary, ...offer.rowActions.menu];

  it('未发起 / 不通过的待发：列表与详情都有 submitApproval，同时带当前审批人 / 节点；审批中、审批通过没有', async () => {
    const w = await world('row-actions');
    const fresh = await w.offer(w.applicant);
    const detail = await w.json<Listed>(await w.request(w.applicant.userId, 'GET', `/api/tenant/offers/${fresh.id}`));
    expect(detail.rowActions.primary).toEqual(['submitApproval']);
    expect(detail).toMatchObject({ currentApprovers: [], currentApprovalNode: null });
    const listed = await w.json<{ items: Listed[] }>(
      await w.request(w.applicant.userId, 'GET', '/api/tenant/offers?view=unsubmitted'),
    );
    expect(actionsOf(listed.items.find((item) => item.id === fresh.id)!)).toContain('submitApproval');

    await w.json(await w.submitRaw(fresh));
    const approving = await w.json<{ items: Listed[] }>(
      await w.request(w.applicant.userId, 'GET', '/api/tenant/offers?view=approving'),
    );
    const row = approving.items.find((item) => item.id === fresh.id)!;
    expect(actionsOf(row)).not.toContain('submitApproval');
    expect(row).toMatchObject({ currentApprovalNode: '录用部门负责人', currentApprovers: ['部门负责人'] });

    await w.decide(await w.instance(fresh.id), w.head, 'approve');
    const approved = await w.json<Listed>(await w.request(w.applicant.userId, 'GET', `/api/tenant/offers/${fresh.id}`));
    expect(actionsOf(approved)).not.toContain('submitApproval');
  });

  it('反例：没有 Offer 编辑开关的人列表和详情里都没有 submitApproval', async () => {
    const w = await world('row-actions-denied');
    const fresh = await w.offer(w.applicant);
    const detail = (await (await w.denyRead(w.applicant, `/${fresh.id}`)).json()) as Listed;
    expect(actionsOf(detail)).not.toContain('submitApproval');
    const listed = (await (await w.denyRead(w.applicant, '?view=unsubmitted')).json()) as { items: Listed[] };
    expect(actionsOf(listed.items.find((item) => item.id === fresh.id)!)).not.toContain('submitApproval');
  });
});
