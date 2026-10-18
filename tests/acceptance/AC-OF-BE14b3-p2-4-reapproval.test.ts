/**
 * BE-14b3 第 1 轮审查返工 P2-4：OF-R4 两个分支都要实际发起审批（34 OF-R4、AC-OF-02）。
 * 用真实流程：发布 Offer 审批预置、真实提交 + 部门负责人同意得到“审批通过”（不用 SQL 强改 approval_status），再改必审字段：
 * 开关开 → 原单出现新的 running 实例和待办；开关关 → 原单失效，复制的新单有 running 实例和待办。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { offerApprovalWorld, type OfferView } from './AC-OF-BE14a3-support.js';
import { uniqueSuffix } from './support/unique.js';

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
  /** 同步所需的真实职级（夹具里的裸职级没有版本，同步会拒绝）。 */
  const levelType = await w.json<{ id: string }>(
    await w.request(w.hr.id, 'POST', '/api/tenant/job/level-types', {
      ifMatch: 0,
      body: { name: '审批同步职级体系', code: `LT${uniqueSuffix()}`, startDate: '2020-01-01' },
    }),
    201,
  );
  const realLevel = await w.json<{ id: string }>(
    await w.request(w.hr.id, 'POST', '/api/tenant/job/levels', {
      ifMatch: 0,
      body: {
        name: '审批同步职级',
        code: `JL${uniqueSuffix()}`,
        level: 5,
        levelTypeId: levelType.id,
        startDate: '2020-01-01',
      },
    }),
    201,
  );
  const employment = (path: string) => w.request(as, 'GET', `/api/tenant/employment${path}`);
  const entries = async (view: string) =>
    (
      await w.json<{ items: { id: string; entryStatus: number | null }[] }>(
        await employment(`/pending-entries?view=${view}`),
      )
    ).items;
  /** 真实审批通过 → 发送 → 接受（接受时同步出待入职）的社招 Offer。 */
  async function syncedApprovedOffer(): Promise<OfferView> {
    const created = await w.json<OfferView>(
      await w.request(as, 'POST', OFFERS, {
        ifMatch: 0,
        body: {
          entry: 'offer',
          channelName: '内推',
          name: '审批同步候选人',
          personalEmail: `of3-${uniqueSuffix()}@example.com`,
          departmentId: w.department,
          plannedEntryDate: '2026-11-01',
          levelId: realLevel.id,
          directManagerId: w.manager.employeeId,
          hrbpId: w.head.employeeId,
          costCenter: 'CC-001',
          contractCompanyId: w.company,
          salaryAfterRegular: 10000,
        },
      }),
      201,
    );
    await w.json(await w.submitRaw(created));
    await w.decide(await w.instance(created.id), w.head, 'approve');
    const sent = await w.request(as, 'POST', `${OFFERS}/${created.id}/send`, {
      ifMatch: (await w.get(created.id)).revision,
      body: {},
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    const accepted = await w.request(as, 'POST', `${OFFERS}/${created.id}/transfer`, {
      ifMatch: (await w.get(created.id)).revision,
      body: { target: 'accepted', acceptTime: '2026-10-17' },
    });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const done = await w.get(created.id);
    expect(done).toMatchObject({ status: 'accepted', approvalStatus: 'approved', syncStatus: 'success' });
    return done;
  }
  const headTodos = async () => (await w.todos(w.head.userId)).items;
  /** 业务单的全部实例（发起人视角）：旧的已通过实例保留，新发起的是 running，且负责人在新实例上恰有一条待办。 */
  async function expectNewRunningInstance(businessId: string, oldInstances: number) {
    const all = await w.instanceOfAll(businessId, w.applicant.userId);
    expect(all.map((instance) => instance.status).sort()).toEqual(
      [...Array<string>(oldInstances).fill('approved'), 'running'].sort(),
    );
    const running = all.find((instance) => instance.status === 'running')!;
    expect(w.pending(running).map((task) => task.assigneeUserId)).toEqual([w.head.userId]);
    expect((await headTodos()).filter((todo) => todo.instanceId === running.id)).toHaveLength(1);
  }
  return { ...w, put, approvedOffer, syncedApprovedOffer, entries, headTodos, expectNewRunningInstance };
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
    await w.expectNewRunningInstance(offer.id, 1);
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
    await w.expectNewRunningInstance(offer.id, 1);
  });

  it('改非必审字段 → 不重新发起审批，审批通过保持', async () => {
    const w = await world('p24-on-other', true);
    const offer = await w.approvedOffer();
    const edited = await w.json<Edited>(await w.put(offer, { costCenter: 'CC-NEW' }));
    expect(edited).toMatchObject({ approvalStatus: 'approved' });
    expect(await w.headTodos()).toEqual([]);
  });
});

describe('P2-4 OF-R4 已接受 + 待入职（真实审批 + 同步）', () => {
  it('开关开：改必审字段 → 回待发，待入职取消，原单重新发起审批（新实例 + 待办）', async () => {
    const w = await world('p24-on-accepted', true);
    const offer = await w.syncedApprovedOffer();
    expect(await w.entries('all')).toHaveLength(1);
    const edited = await w.json<Edited>(await w.put(offer, { salaryAfterRegular: 14000 }));
    expect(edited).toMatchObject({ id: offer.id, status: 'pending', approvalStatus: 'approving' });
    expect(await w.entries('all')).toHaveLength(0);
    expect(await w.entries('cancelled')).toHaveLength(1);
    await w.expectNewRunningInstance(offer.id, 1);
  });

  it('开关关：原单失效且待入职删除，复制的新单发起审批', async () => {
    const w = await world('p24-off-accepted', false);
    const offer = await w.syncedApprovedOffer();
    const copy = await w.json<Edited>(await w.put(offer, { salaryAfterRegular: 14000 }));
    expect(copy).toMatchObject({ approvalStatus: 'approving', replacedOfferId: offer.id, hasPendingEntry: false });
    expect(await w.get(offer.id)).toMatchObject({ status: 'invalid' });
    expect(await w.entries('all')).toHaveLength(0);
    expect(await w.entries('cancelled')).toHaveLength(0);
    await w.expectNewRunningInstance(copy.id, 0);
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
    await w.expectNewRunningInstance(copy.id, 0);
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
