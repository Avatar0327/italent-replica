/**
 * BE-14b1：OF-R3 / OF-R4 前半——必审字段设置，以及审批通过后修改必审字段须清掉旧的“审批通过”（AC-OF-02 前半）。
 * “审批通过允许再次发起”开关的两条分支由 BE-14b3 接线（真实审批流用例见 AC-OF-BE14b3-p2-4-reapproval）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { offerWorld, type OfferBody } from './AC-OF-BE14a-support.js';
import { overrideSetting, requireApproval } from './AC-OF-BE14b1-support.js';

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

  // 改必审字段后的去向（OF-R4：回待发并实际发起审批 / 失效并复制新单发起审批，AC-OF-02）自 BE-14b3 起会真实发起审批，
  // 需要已发布的 Offer 审批流程，用例见 AC-OF-BE14b3-p2-4-reapproval（真实提交 + 同意得到审批通过，不再用 SQL 强改状态）。

  it('改非必审字段、或必审字段写回原值：审批通过保持，仍可发送', async () => {
    const w = await offerWorld(testDb().db, 'review-keep');
    const offer = await approvedOffer(w);
    const other = await edit(w, offer, { costCenter: 'CC-002' });
    expect(await other.json()).toMatchObject({ approvalStatus: 'approved' });
    const same = await edit(w, await w.get(offer.id), { salaryAfterRegular: 10000 });
    expect(await same.json()).toMatchObject({ approvalStatus: 'approved' });
    expect(await sendCheck(w, offer.id)).toMatchObject({ allowed: true, reason: null });
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
