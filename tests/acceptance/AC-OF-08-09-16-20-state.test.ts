/**
 * BE-14a Offer 状态机、失效与行操作矩阵（34 §2.1、OF-R7；AC-OF-08 / 09 / 16 / 17 / 18 / 19 / 20，DEC-529 / 532 / 533 / 537）。
 * 已发 / 已入职等要 BE-14b 入口才能到达的状态用可信 SQL 造数；需要联动待入职的分支断言机读拒绝 OFFER_SYNC_NOT_READY。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, offerWorld, type OfferBody } from './AC-OF-BE14a-support.js';

const testDb = useTestDb();
const reject = { target: 'rejected', refusalTime: '2026-10-16', refusalReasonCode: 'personal' };

describe('AC-OF-09 / 17 转移表单必填', () => {
  it('转已接受不填接受 offer 时间 → 400 且状态不变；填了即已接受', async () => {
    const w = await offerWorld(testDb().db, 'accept');
    const offer = await w.social();
    const response = await w.transfer(offer, { target: 'accepted' });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({
      details: { reason: 'OFFER_FORM_INCOMPLETE', fields: ['acceptTime'] },
    });
    expect(await w.get(offer.id)).toMatchObject({ status: 'pending', revision: 1 });
    expect(await w.moved(offer, { target: 'accepted', acceptTime: '2026-10-16' })).toMatchObject({
      status: 'accepted',
      acceptTime: '2026-10-16',
      revision: 2,
    });
  });

  it('已发转已拒绝：拒绝时间、原因必填，备注可空；原因只能选启用的字典项', async () => {
    const w = await offerWorld(testDb().db, 'refuse');
    const offer = await w.social();
    await w.force(offer.id, 'status', 'sent');
    for (const body of [
      { target: 'rejected', refusalReasonCode: 'personal' },
      { target: 'rejected', refusalTime: '2026-10-16' },
    ]) {
      const response = await w.transfer(offer, body);
      expect(response.status).toBe(400);
      expect((await errorOf(response)).details).toMatchObject({ reason: 'OFFER_FORM_INCOMPLETE' });
    }
    const unknown = await w.transfer(offer, { ...reject, refusalReasonCode: 'nope' });
    expect((await errorOf(unknown)).details).toMatchObject({ reason: 'OFFER_DICTIONARY_UNKNOWN' });
    expect((await w.get(offer.id)).status).toBe('sent');
    expect(await w.moved(offer, reject)).toMatchObject({
      status: 'rejected',
      refusalTime: '2026-10-16',
      refusalReasonCode: 'personal',
      refusalRemark: null,
    });
  });
});

describe('AC-OF-08 已拒绝退回待发', () => {
  it('回到未发起审批、主操作发起 Offer 审批；拒绝三项保留但详情不显示，转移表单带出原值', async () => {
    const w = await offerWorld(testDb().db, 'back');
    const offer = await w.social();
    const rejected = await w.moved(offer, { ...reject, refusalRemark: '去了别家' });
    expect((await w.get(offer.id)).rowActions).toEqual({ primary: ['transfer'], menu: ['viewMail', 'view'] });
    const pending = await w.moved(rejected, { target: 'pending' });
    expect(pending).toMatchObject({ status: 'pending', approvalStatus: 'unsubmitted' });
    const detail = await w.get(offer.id);
    expect(detail.rowActions!.primary).toEqual(['submitApproval']);
    for (const field of ['refusalTime', 'refusalReasonCode', 'refusalRemark']) expect(detail).not.toHaveProperty(field);
    const form = await w.request('GET', `/${offer.id}/transfer-form`);
    expect(await form.json()).toMatchObject({
      targets: ['accepted', 'rejected'],
      refusalTime: '2026-10-16',
      refusalReasonCode: 'personal',
      refusalRemark: '去了别家',
    });
  });

  it('已接受不能直接回待发（须先经已拒绝）；已接受 → 已入职与终态转移都给机读拒绝', async () => {
    const w = await offerWorld(testDb().db, 'guards');
    const accepted = await w.moved(await w.social(), { target: 'accepted', acceptTime: '2026-10-16' });
    const back = await w.transfer(accepted, { target: 'pending' });
    expect(back.status).toBe(409);
    expect((await errorOf(back)).details).toMatchObject({ reason: 'OFFER_TRANSITION_INVALID' });
    const onboard = await w.transfer(accepted, { target: 'onboarded' });
    expect(onboard.status).toBe(409);
    expect((await errorOf(onboard)).details).toMatchObject({ reason: 'OFFER_SYNC_NOT_READY' });
    expect((await w.get(accepted.id)).status).toBe('accepted');
    const stale = await w.transfer({ ...accepted, revision: 1 }, reject);
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).code).toBe('REVISION_CONFLICT');
  });
});

describe('AC-OF-18 / 19 失效', () => {
  it('不填失效原因不能提交；原因走字典；确定即失效、不可恢复，行操作只剩复制 / 查看', async () => {
    const w = await offerWorld(testDb().db, 'invalid');
    const offer = await w.social();
    const missing = await w.invalidate(offer, { remark: '备注' });
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).details).toMatchObject({ reason: 'OFFER_FORM_INCOMPLETE', fields: ['reasonCode'] });
    const unknown = await w.invalidate(offer, { reasonCode: 'personal' });
    expect((await errorOf(unknown)).details).toMatchObject({ reason: 'OFFER_DICTIONARY_UNKNOWN' });
    const response = await w.invalidate(offer, { reasonCode: 'background_check_failed' });
    expect(response.status, await response.clone().text()).toBe(200);
    const invalid = (await response.json()) as OfferBody;
    expect(invalid).toMatchObject({
      status: 'invalid',
      invalidReasonCode: 'background_check_failed',
      invalidRemark: null,
    });
    expect(invalid.invalidAt).toBeTruthy();
    expect((await w.get(offer.id)).rowActions).toEqual({ primary: ['copy'], menu: ['viewMail', 'view'] });
    const revive = await w.transfer(invalid, { target: 'pending' });
    expect((await errorOf(revive)).details).toMatchObject({ reason: 'OFFER_TRANSITION_INVALID' });
    const form = await w.request('GET', `/${offer.id}/transfer-form`);
    expect(((await form.json()) as { targets: string[] }).targets).toEqual([]);
  });

  it('实习待发与已拒绝不提供失效（409）；已发、已接受、社招待发可失效且不看审批状态', async () => {
    const w = await offerWorld(testDb().db, 'invalid-scope');
    const intern = await w.intern();
    expect((await w.get(intern.id)).rowActions!.menu).not.toContain('invalidate');
    const denied = await w.invalidate(intern, { reasonCode: 'candidate_gave_up' });
    expect(denied.status).toBe(409);
    expect((await errorOf(denied)).details).toMatchObject({ reason: 'OFFER_INVALIDATION_NOT_ALLOWED' });
    const rejected = await w.moved(await w.social(), reject);
    expect((await w.invalidate(rejected, { reasonCode: 'candidate_gave_up' })).status).toBe(409);
    const approving = await w.social();
    await w.force(approving.id, 'approval_status', 'approving');
    expect((await w.get(approving.id)).rowActions).toEqual({
      primary: ['urge', 'delegate', 'revoke'],
      menu: ['invalidate'],
    });
    expect((await w.invalidate(approving, { reasonCode: 'candidate_gave_up' })).status).toBe(200);
    for (const status of ['sent', 'accepted']) {
      const offer = await w.intern();
      if (status === 'accepted') await w.force(offer.id, 'accept_time', '2026-10-16');
      await w.force(offer.id, 'status', status);
      expect((await w.invalidate(offer, { reasonCode: 'candidate_gave_up' })).status).toBe(200);
    }
  });
});

describe('AC-OF-16 / 19 / 20 行操作矩阵', () => {
  it('按状态给出行主按钮与下拉：已拒绝下拉没有转移与失效；已入职主按钮查看邮件', async () => {
    const w = await offerWorld(testDb().db, 'matrix');
    const pending = await w.social();
    expect((await w.get(pending.id)).rowActions).toEqual({
      primary: ['submitApproval'],
      menu: ['edit', 'send', 'transfer', 'invalidate', 'linkIntern', 'view', 'delete'],
    });
    const cases: [string, { primary: string[]; menu: string[] }][] = [
      ['sent', { primary: ['resend'], menu: ['editSync', 'transfer', 'viewMail', 'invalidate', 'view'] }],
      ['onboarded', { primary: ['viewMail'], menu: ['sign', 'view'] }],
    ];
    for (const [status, actions] of cases) {
      const offer = await w.social();
      await w.force(offer.id, 'status', status);
      expect((await w.get(offer.id)).rowActions).toEqual(actions);
    }
    const accepted = await w.moved(await w.social(), { target: 'accepted', acceptTime: '2026-10-16' });
    expect((await w.get(accepted.id)).rowActions).toEqual({
      primary: ['editSync'],
      menu: ['transfer', 'viewMail', 'invalidate', 'sign', 'view'],
    });
    const rejected = await w.moved(await w.social(), reject);
    const refused = (await w.get(rejected.id)).rowActions!;
    expect(refused.menu).not.toContain('transfer');
    expect(refused.menu).not.toContain('invalidate');
  });
});

describe('BE-14a 视图', () => {
  it('10 个视图带编码、筛选与列序列宽；列表按视图状态 / 审批子状态过滤、可筛选、分页', async () => {
    const w = await offerWorld(testDb().db, 'views');
    const response = await w.request('GET', '/views');
    const { items } = (await response.json()) as {
      items: { key: string; code: string; columns: { label: string; width: number }[] }[];
    };
    expect(items.map((v) => v.key)).toEqual([
      'pending',
      'unsubmitted',
      'approving',
      'approved',
      'sent',
      'accepted',
      'rejected',
      'onboarded',
      'all',
      'invalid',
    ]);
    expect(items.every((v) => v.code.endsWith('NavView'))).toBe(true);
    expect(items.find((v) => v.key === 'pending')!.columns.at(-1)).toEqual({
      label: 'Offer附件',
      width: 262,
      field: null,
    });
    const a = await w.social({ name: '甲候选人' });
    await w.social({ name: '乙候选人' });
    await w.moved(await w.social({ name: '丙候选人' }), reject);
    expect((await w.list('view=pending')).total).toBe(2);
    expect((await w.list('view=unsubmitted')).total).toBe(2);
    expect((await w.list('view=approving')).total).toBe(0);
    expect((await w.list('view=rejected')).items.map((o) => o.name)).toEqual(['丙候选人']);
    expect((await w.list('view=all')).total).toBe(3);
    expect((await w.list(`view=pending&name=${encodeURIComponent('甲')}`)).items.map((o) => o.id)).toEqual([a.id]);
    const page = await w.list('view=all&page=2&pageSize=2');
    expect(page).toMatchObject({ total: 3 });
    expect(page.items).toHaveLength(1);
    expect((await w.request('GET', '?view=unknown')).status).toBe(400);
    expect((await w.request('GET', '?view=pending&resume=x')).status).toBe(400);
  });
});
