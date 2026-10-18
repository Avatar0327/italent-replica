/**
 * BE-14b3 第 1 轮审查返工 P2-4：OF-R4 两个分支都要实际发起审批（34 OF-R4、AC-OF-02）。
 * 用真实流程：发布 Offer 审批预置、真实提交 + 部门负责人同意得到“审批通过”（不用 SQL 强改 approval_status），再改必审字段：
 * 开关开 → 原单出现新的 running 实例和待办；开关关 → 原单失效，复制的新单有 running 实例和待办。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { offerApprovalWorld, type OfferView } from './AC-OF-BE14a3-support.js';

const testDb = useTestDb();
const OFFERS = '/api/tenant/offers';
type Edited = OfferView & { replacedOfferId?: string; copiedFromOfferId?: string };

async function world(label: string, reapprovalAllowed: boolean) {
  const w = await offerApprovalWorld(testDb().db, label);
  const setting = async (key: string, value: unknown) => {
    const response = await w.request(w.hr.id, 'PUT', `/api/tenant/settings/${key}`, { ifMatch: 0, body: { value } });
    expect(response.status, await response.clone().text()).toBe(200);
  };
  await setting('offer.send_requires_approval', { social: true, campus: false, intern: false });
  await setting('offer.review_fields', { social: ['salaryAfterRegular'], campus: [], intern: [] });
  await setting('offer.linkage', { entryCancelRejects: true, reapprovalAllowed });
  const as = w.applicant.userId;
  const put = (offer: Pick<OfferView, 'id' | 'revision'>, body: Record<string, unknown>) =>
    w.request(as, 'PUT', `${OFFERS}/${offer.id}`, { ifMatch: offer.revision, body });
  /** 真实审批通过的社招待发 Offer：提交 → 部门负责人同意。 */
  async function approvedOffer(): Promise<OfferView> {
    const created = await w.social(w.applicant);
    const salaried = await w.json<OfferView>(await put(created, { salaryAfterRegular: 10000 }));
    await w.json(await w.submitRaw(salaried));
    await w.decide(await w.instance(salaried.id), w.head, 'approve');
    const approved = await w.get(salaried.id);
    expect(approved).toMatchObject({ status: 'pending', approvalStatus: 'approved' });
    return approved;
  }
  const headTodos = async () => (await w.todos(w.head.userId)).items;
  return { ...w, put, approvedOffer, headTodos };
}

describe('P2-4 OF-R4 开关开：原单重新发起审批', () => {
  it('待发 + 审批通过，改必审字段 → 原单审批中，出现新的 running 实例和负责人待办', async () => {
    const w = await world('p24-on-pending', true);
    const offer = await w.approvedOffer();
    expect(await w.headTodos()).toEqual([]);
    const edited = await w.json<Edited>(await w.put(offer, { salaryAfterRegular: 12000 }));
    expect(edited).toMatchObject({
      id: offer.id,
      status: 'pending',
      approvalStatus: 'approving',
      salaryAfterRegular: 12000,
    });
    expect((await w.instance(offer.id)).status).toBe('running');
    expect(await w.headTodos()).toHaveLength(1);
  });

  it('已发 + 审批通过，改必审字段 → 回待发并重新发起审批（新实例 + 待办）', async () => {
    const w = await world('p24-on-sent', true);
    const offer = await w.approvedOffer();
    const sent = await w.request(w.applicant.userId, 'POST', `${OFFERS}/${offer.id}/send`, {
      ifMatch: offer.revision,
      body: {},
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    const edited = await w.json<Edited>(await w.put(await w.get(offer.id), { salaryAfterRegular: 13000 }));
    expect(edited).toMatchObject({ id: offer.id, status: 'pending', approvalStatus: 'approving' });
    expect((await w.instance(offer.id)).status).toBe('running');
    expect(await w.headTodos()).toHaveLength(1);
  });

  it('改非必审字段 → 不重新发起审批，审批通过保持', async () => {
    const w = await world('p24-on-other', true);
    const offer = await w.approvedOffer();
    const edited = await w.json<Edited>(await w.put(offer, { costCenter: 'CC-NEW' }));
    expect(edited).toMatchObject({ approvalStatus: 'approved' });
    expect(await w.headTodos()).toEqual([]);
  });
});

describe('P2-4 OF-R4 开关关：失效原单，复制新单并发起审批', () => {
  it('原单失效；新单待发 → 审批中，有 running 实例和负责人待办，记被复制的 Offer', async () => {
    const w = await world('p24-off', false);
    const offer = await w.approvedOffer();
    const copy = await w.json<Edited>(await w.put(offer, { salaryAfterRegular: 12000 }));
    expect(copy).toMatchObject({
      status: 'pending',
      approvalStatus: 'approving',
      salaryAfterRegular: 12000,
      copiedFromOfferId: offer.id,
      replacedOfferId: offer.id,
    });
    expect(copy.id).not.toBe(offer.id);
    expect(await w.get(offer.id)).toMatchObject({ status: 'invalid' });
    expect((await w.instance(copy.id)).status).toBe('running');
    expect(await w.headTodos()).toHaveLength(1);
  });

  it('新单审批首节点为空（DEC-054）→ 整笔回滚：原单不失效、不产生复制件', async () => {
    const w = await world('p24-off-rollback', false);
    const offer = await w.approvedOffer();
    await w.setOrgRoles(w.department, { head: null });
    const response = await w.put(offer, { salaryAfterRegular: 12000 });
    expect(response.status).toBe(409);
    expect(await w.get(offer.id)).toMatchObject({ status: 'pending', approvalStatus: 'approved' });
    const listed = await w.json<{ total: number }>(
      await w.request(w.applicant.userId, 'GET', `${OFFERS}?view=pending`),
    );
    expect(listed.total).toBe(1);
  });
});
