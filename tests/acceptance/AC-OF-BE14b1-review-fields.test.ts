/**
 * BE-14b1：OF-R3 / OF-R4 前半——必审字段设置，以及审批通过后修改必审字段须清掉旧的“审批通过”（AC-OF-02 前半）。
 * “审批通过允许再次发起”开关的两条分支（回待发并取消入职 / 失效并复制）归 BE-14b3。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, offerWorld, type OfferBody } from './AC-OF-BE14a-support.js';
import { overrideSetting, requireApproval, send } from './AC-OF-BE14b1-support.js';

const testDb = useTestDb();
const KEY = 'offer.review_fields';
const review = (social: string[]) => ({ social, campus: [], intern: [] });

describe('必审字段设置（OF-R3）', () => {
  it('取值校验：须三种类型齐全、只能是非必填的 Offer 字段、不重复', async () => {
    const w = await offerWorld(testDb().db, 'review-setting');
    const bad: unknown[] = [
      { social: ['salaryAfterRegular'] },
      review(['noSuchField']),
      review(['name']),
      review(['workPlace', 'workPlace']),
      { social: 'workPlace', campus: [], intern: [] },
      { social: ['costCenter'], campus: [], intern: [] },
    ];
    for (const value of bad) expect((await overrideSetting(w, KEY, value)).status, JSON.stringify(value)).toBe(400);
    const ok = await overrideSetting(w, KEY, review(['salaryAfterRegular', 'workPlace']));
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toMatchObject({ value: review(['salaryAfterRegular', 'workPlace']) });
  });

  it('出厂都为空', async () => {
    const w = await offerWorld(testDb().db, 'review-default');
    const response = await w.seeder.request('GET', `/api/tenant/settings/${KEY}`, {
      user: w.user.id,
      tenant: w.tenant.id,
    });
    expect(await response.json()).toMatchObject({ value: review([]) });
  });
});

describe('AC-OF-02 前半：审批通过后改必审字段，旧审批通过作废', () => {
  async function approvedOffer(w: Awaited<ReturnType<typeof offerWorld>>) {
    expect((await requireApproval(w)).status).toBe(200);
    expect((await overrideSetting(w, KEY, review(['salaryAfterRegular', 'workPlace']))).status).toBe(200);
    const offer = await w.social({ salaryAfterRegular: 10000 });
    await w.force(offer.id, 'approval_status', 'approved');
    return w.get(offer.id);
  }
  const edit = (w: Awaited<ReturnType<typeof offerWorld>>, offer: OfferBody, body: Record<string, unknown>) =>
    w.request('PUT', `/${offer.id}`, { ifMatch: offer.revision, body });
  const sendCheck = async (w: Awaited<ReturnType<typeof offerWorld>>, id: string) =>
    (await (await w.request('GET', `/${id}/send-check`)).json()) as { allowed: boolean; reason: string | null };

  it('改必审字段（基本工资）：审批回到未发起，发送判定与发送都被拒', async () => {
    const w = await offerWorld(testDb().db, 'review-edit');
    const offer = await approvedOffer(w);
    const response = await edit(w, offer, { salaryAfterRegular: 12000 });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ approvalStatus: 'unsubmitted', salaryAfterRegular: 12000 });
    expect(await sendCheck(w, offer.id)).toMatchObject({ allowed: false, reason: 'OFFER_APPROVAL_REQUIRED' });
    const denied = await send(w, await w.get(offer.id));
    expect((await errorOf(denied)).details).toMatchObject({ reason: 'OFFER_APPROVAL_REQUIRED' });
  });

  it('改非必审字段、或必审字段写回原值：审批通过保持，仍可发送', async () => {
    const w = await offerWorld(testDb().db, 'review-keep');
    const offer = await approvedOffer(w);
    const other = await edit(w, offer, { costCenter: 'CC-002' });
    expect(await other.json()).toMatchObject({ approvalStatus: 'approved' });
    const same = await edit(w, await w.get(offer.id), { salaryAfterRegular: 10000 });
    expect(await same.json()).toMatchObject({ approvalStatus: 'approved' });
    expect(await sendCheck(w, offer.id)).toMatchObject({ allowed: true, reason: null });
  });

  it('已发退回待发后改必审字段：不得复用旧的审批通过', async () => {
    const w = await offerWorld(testDb().db, 'review-sent-back');
    const offer = await approvedOffer(w);
    expect((await send(w, offer)).status).toBe(200);
    const back = await w.moved(await w.get(offer.id), { target: 'pending' });
    expect(back).toMatchObject({ status: 'pending', approvalStatus: 'approved' });
    const response = await edit(w, back, { workPlace: '上海' });
    expect(await response.json()).toMatchObject({ approvalStatus: 'unsubmitted' });
    expect(await sendCheck(w, offer.id)).toMatchObject({ allowed: false, reason: 'OFFER_APPROVAL_REQUIRED' });
  });

  it('该类型没开“发送前须审批”或类型不同：必审字段不起作用', async () => {
    const w = await offerWorld(testDb().db, 'review-off');
    expect((await overrideSetting(w, KEY, review(['salaryAfterRegular']))).status).toBe(200);
    const social = await w.social({ salaryAfterRegular: 10000 });
    await w.force(social.id, 'approval_status', 'approved');
    const response = await edit(w, await w.get(social.id), { salaryAfterRegular: 12000 });
    expect(await response.json()).toMatchObject({ approvalStatus: 'approved' });
    expect((await requireApproval(w)).status).toBe(200);
    const intern = await w.intern();
    await w.force(intern.id, 'approval_status', 'approved');
    const internEdit = await edit(w, await w.get(intern.id), { workPlace: '北京' });
    expect(await internEdit.json()).toMatchObject({ approvalStatus: 'approved' });
  });
});
