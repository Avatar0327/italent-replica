/**
 * BE-14a2 Offer 状态转移、失效与行操作矩阵（34 §2.1、OF-R7；AC-OF-08 / 09 / 16～20，DEC-529 / 532 / 533 / 537）。
 * 已发 / 已入职 / 审批中等要 BE-14a3 / BE-14b 入口才能到达的状态用可信 SQL 造数；需要联动待入职的分支断言机读拒绝
 * OFFER_SYNC_NOT_READY。行操作只返回本段已接线的动作（发送、重发、编辑并同步、审批、邮件、签署等归 BE-14a3 / BE-14b），
 * 原站完整矩阵由纯函数给出、另行断言。
 */
import * as domain from '@italent/domain';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, offerWorld, type OfferBody } from './AC-OF-BE14a-support.js';

const testDb = useTestDb();
const reject = { target: 'rejected', refusalTime: '2026-10-16', refusalReasonCode: 'personal' };
type Actions = { primary: string[]; menu: string[] };
const actionsOf = (offer: OfferBody) => offer.rowActions as Actions | undefined;

describe('AC-OF-09 / 17 转移表单必填', () => {
  it('转已接受不填接受 offer 时间 → 400 且状态不变；填了即已接受，写审计', async () => {
    const w = await offerWorld(testDb().db, 'accept');
    const offer = await w.social();
    const response = await w.transfer(offer, { target: 'accepted' });
    expect(response.status, await response.clone().text()).toBe(400);
    expect((await errorOf(response)).details).toMatchObject({
      reason: 'OFFER_FORM_INCOMPLETE',
      fields: ['acceptTime'],
    });
    expect(await w.get(offer.id)).toMatchObject({ status: 'pending', revision: 1 });
    expect(await w.moved(offer, { target: 'accepted', acceptTime: '2026-10-16' })).toMatchObject({
      status: 'accepted',
      acceptTime: '2026-10-16',
      revision: 2,
    });
    const audits = await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE object_id = ${offer.id}
        AND action = 'offer.transfer'`),
    );
    const rows = (Array.isArray(audits) ? audits : (audits as { rows: { n: number }[] }).rows) as { n: number }[];
    expect(rows[0]!.n).toBe(1);
  });

  it('已发转已拒绝：拒绝时间、原因必填，备注可空；原因只能选启用的字典项', async () => {
    const w = await offerWorld(testDb().db, 'refuse');
    const offer = await w.social();
    await w.force(offer.id, 'status', 'sent');
    for (const [body, field] of [
      [{ target: 'rejected', refusalReasonCode: 'personal' }, 'refusalTime'],
      [{ target: 'rejected', refusalTime: '2026-10-16' }, 'refusalReasonCode'],
    ] as const) {
      const response = await w.transfer(offer, body);
      expect(response.status, await response.clone().text()).toBe(400);
      expect((await errorOf(response)).details).toMatchObject({ reason: 'OFFER_FORM_INCOMPLETE', fields: [field] });
    }
    const unknown = await w.transfer(offer, { ...reject, refusalReasonCode: 'nope' });
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).details).toMatchObject({ reason: 'OFFER_DICTIONARY_UNKNOWN' });
    expect(await w.get(offer.id)).toMatchObject({ status: 'sent', revision: 1 });
    expect(await w.moved(offer, reject)).toMatchObject({
      status: 'rejected',
      refusalTime: '2026-10-16',
      refusalReasonCode: 'personal',
      refusalRemark: null,
      revision: 2,
    });
  });

  it('停用的拒绝原因不能选用（400 OFFER_DICTIONARY_DISABLED）', async () => {
    const w = await offerWorld(testDb().db, 'refuse-disabled');
    const items = (await (await w.request('GET', '/dictionaries/refusal-reasons')).json()) as {
      items: { id: string; code: string; revision: number; name: string }[];
    };
    const personal = items.items.find((item) => item.code === 'personal')!;
    const disabled = await w.request('PUT', `/dictionaries/refusal-reasons/${personal.id}`, {
      ifMatch: personal.revision,
      body: { code: 'personal', name: personal.name, enabled: false },
    });
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    const offer = await w.social();
    const response = await w.transfer(offer, reject);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).details).toMatchObject({ reason: 'OFFER_DICTIONARY_DISABLED' });
  });
});

describe('AC-OF-08 已拒绝退回待发', () => {
  it('回到未发起审批；拒绝三项保留但详情不显示，转移表单带出原值', async () => {
    const w = await offerWorld(testDb().db, 'back');
    const offer = await w.social();
    await w.force(offer.id, 'approval_status', 'approved');
    const rejected = await w.moved({ ...offer }, { ...reject, refusalRemark: '去了别家' });
    expect(rejected).toMatchObject({ status: 'rejected', approvalStatus: 'approved', refusalRemark: '去了别家' });
    const pending = await w.moved(rejected, { target: 'pending' });
    expect(pending).toMatchObject({ status: 'pending', approvalStatus: 'unsubmitted', revision: 3 });
    const detail = await w.get(offer.id);
    for (const field of ['refusalTime', 'refusalReasonCode', 'refusalRemark']) {
      expect(detail).not.toHaveProperty(field);
      expect(pending).not.toHaveProperty(field);
    }
    const form = await w.request('GET', `/${offer.id}/transfer-form`);
    expect(form.status, await form.clone().text()).toBe(200);
    expect(await form.json()).toMatchObject({
      status: 'pending',
      revision: 3,
      targets: ['accepted', 'rejected'],
      refusalTime: '2026-10-16',
      refusalReasonCode: 'personal',
      refusalRemark: '去了别家',
    });
  });

  it('已接受不能直接回待发（须先经已拒绝）；已接受 → 已入职给机读拒绝；终态不能转移；revision 冲突 409', async () => {
    const w = await offerWorld(testDb().db, 'guards');
    const accepted = await w.moved(await w.social(), { target: 'accepted', acceptTime: '2026-10-16' });
    const back = await w.transfer(accepted, { target: 'pending' });
    expect(back.status).toBe(409);
    expect((await errorOf(back)).details).toMatchObject({ reason: 'OFFER_TRANSITION_INVALID' });
    const onboard = await w.transfer(accepted, { target: 'onboarded' });
    expect(onboard.status).toBe(409);
    expect((await errorOf(onboard)).details).toMatchObject({ reason: 'OFFER_SYNC_NOT_READY' });
    expect(await w.get(accepted.id)).toMatchObject({ status: 'accepted', revision: 2 });
    const form = (await (await w.request('GET', `/${accepted.id}/transfer-form`)).json()) as { targets: string[] };
    expect(form.targets).toEqual(['rejected']);
    const stale = await w.transfer({ ...accepted, revision: 1 }, reject);
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).code).toBe('REVISION_CONFLICT');
    const onboarded = await w.social();
    await w.force(onboarded.id, 'status', 'onboarded');
    const done = await w.transfer(onboarded, reject);
    expect((await errorOf(done)).details).toMatchObject({ reason: 'OFFER_TRANSITION_INVALID' });
  });

  it('审批中的待发不能转移（409 OFFER_APPROVAL_IN_PROGRESS），转移表单无候选', async () => {
    const w = await offerWorld(testDb().db, 'approving');
    const offer = await w.social();
    await w.force(offer.id, 'approval_status', 'approving');
    const response = await w.transfer(offer, { target: 'accepted', acceptTime: '2026-10-16' });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).details).toMatchObject({ reason: 'OFFER_APPROVAL_IN_PROGRESS' });
    const form = (await (await w.request('GET', `/${offer.id}/transfer-form`)).json()) as { targets: string[] };
    expect(form.targets).toEqual([]);
  });

  it('顶部工具栏入口与行主按钮入口同一转移规则；多余字段 400', async () => {
    const w = await offerWorld(testDb().db, 'toolbar');
    const offer = await w.social();
    const extra = await w.transfer(offer, { target: 'accepted', acceptTime: '2026-10-16', status: 'invalid' });
    expect(extra.status).toBe(400);
    const response = await w.transfer(offer, { target: 'accepted', acceptTime: '2026-10-16' }, 'toolbar');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'accepted', revision: 2 });
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
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).details).toMatchObject({ reason: 'OFFER_DICTIONARY_UNKNOWN' });
    expect(await w.get(offer.id)).toMatchObject({ status: 'pending', revision: 1 });
    const response = await w.invalidate(offer, { reasonCode: 'background_check_failed' });
    expect(response.status, await response.clone().text()).toBe(200);
    const invalid = (await response.json()) as OfferBody;
    expect(invalid).toMatchObject({
      status: 'invalid',
      invalidReasonCode: 'background_check_failed',
      invalidRemark: null,
      revision: 2,
    });
    expect(invalid.invalidAt).toBeTruthy();
    expect(actionsOf(await w.get(offer.id))).toEqual({ primary: ['copy'], menu: ['view'] });
    const revive = await w.transfer(invalid, { target: 'pending' });
    expect((await errorOf(revive)).details).toMatchObject({ reason: 'OFFER_TRANSITION_INVALID' });
    const again = await w.invalidate(invalid, { reasonCode: 'candidate_gave_up' });
    expect((await errorOf(again)).details).toMatchObject({ reason: 'OFFER_INVALIDATION_NOT_ALLOWED' });
    const form = (await (await w.request('GET', `/${offer.id}/transfer-form`)).json()) as { targets: string[] };
    expect(form.targets).toEqual([]);
  });

  it('实习待发与已拒绝不提供失效（409）；已发、已接受、社招待发可失效且不看审批状态', async () => {
    const w = await offerWorld(testDb().db, 'invalid-scope');
    const intern = await w.intern();
    expect(actionsOf(await w.get(intern.id))!.menu).not.toContain('invalidate');
    const denied = await w.invalidate(intern, { reasonCode: 'candidate_gave_up', remark: '备注' });
    expect(denied.status).toBe(409);
    expect((await errorOf(denied)).details).toMatchObject({ reason: 'OFFER_INVALIDATION_NOT_ALLOWED' });
    const rejected = await w.moved(await w.social(), reject);
    expect((await w.invalidate(rejected, { reasonCode: 'candidate_gave_up' })).status).toBe(409);
    const approving = await w.social();
    await w.force(approving.id, 'approval_status', 'approving');
    const ok = await w.invalidate(approving, { reasonCode: 'candidate_gave_up', remark: '放弃' });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toMatchObject({ status: 'invalid', invalidRemark: '放弃' });
    for (const status of ['sent', 'accepted']) {
      const offer = await w.intern();
      if (status === 'accepted') await w.force(offer.id, 'accept_time', '2026-10-16');
      await w.force(offer.id, 'status', status);
      const response = await w.invalidate(offer, { reasonCode: 'candidate_gave_up' });
      expect(response.status, `${status}：${await response.clone().text()}`).toBe(200);
    }
  });
});

describe('AC-OF-16 / 19 / 20 行操作矩阵', () => {
  it('原站矩阵（纯函数）：已拒绝下拉没有转移与失效；失效只剩复制 / 查看；已入职主按钮查看邮件', () => {
    const rowActions = (domain as unknown as Record<string, unknown>).offerRowActions as
      ((offer: { status: string; approvalStatus: string; offerType: string | null }) => Actions) | undefined;
    expect(typeof rowActions).toBe('function');
    const of = (status: string, approvalStatus = 'unsubmitted', offerType: string | null = 'social') =>
      rowActions!({ status, approvalStatus, offerType });
    expect(of('pending')).toEqual({
      primary: ['submitApproval'],
      menu: ['edit', 'send', 'transfer', 'invalidate', 'linkIntern', 'view', 'delete'],
    });
    expect(of('pending', 'unsubmitted', 'intern').menu).not.toContain('invalidate');
    expect(of('pending', 'approving')).toEqual({ primary: ['urge', 'delegate', 'revoke'], menu: ['invalidate'] });
    expect(of('sent')).toEqual({
      primary: ['resend'],
      menu: ['editSync', 'transfer', 'viewMail', 'invalidate', 'view'],
    });
    expect(of('accepted')).toEqual({
      primary: ['editSync'],
      menu: ['transfer', 'viewMail', 'invalidate', 'sign', 'view'],
    });
    expect(of('rejected')).toEqual({ primary: ['transfer'], menu: ['viewMail', 'view'] });
    expect(of('onboarded')).toEqual({ primary: ['viewMail'], menu: ['sign', 'view'] });
    expect(of('invalid')).toEqual({ primary: ['copy'], menu: ['viewMail', 'view'] });
  });

  // BE-14a3 接线后“发起审批”出现在待发主按钮；审批中的催办 / 转交 / 撤销仍未接线
  it('接口只返回已接线的动作：发送 / 重发 / 编辑并同步 / 审批中动作 / 邮件 / 签署 / 关联实习生不出现', async () => {
    const w = await offerWorld(testDb().db, 'matrix');
    const pending = await w.social();
    expect(actionsOf(await w.get(pending.id))).toEqual({
      primary: ['submitApproval'],
      menu: ['edit', 'transfer', 'invalidate', 'view', 'delete'],
    });
    const approved = await w.social();
    await w.force(approved.id, 'approval_status', 'approved');
    expect(actionsOf(await w.get(approved.id))).toEqual({ primary: ['edit'], menu: ['invalidate'] });
    const cases: [string, Actions][] = [
      ['sent', { primary: [], menu: ['transfer', 'invalidate', 'view'] }],
      ['accepted', { primary: [], menu: ['transfer', 'invalidate', 'view'] }],
      ['onboarded', { primary: [], menu: ['view'] }],
    ];
    for (const [status, actions] of cases) {
      const offer = await w.social();
      if (status === 'accepted') await w.force(offer.id, 'accept_time', '2026-10-16');
      await w.force(offer.id, 'status', status);
      expect(actionsOf(await w.get(offer.id)), status).toEqual(actions);
    }
    const rejected = await w.moved(await w.social(), reject);
    expect(actionsOf(await w.get(rejected.id))).toEqual({ primary: ['transfer'], menu: ['view'] });
    const listed = await w.list('view=rejected');
    expect(listed.items.map((item) => actionsOf(item))).toEqual([{ primary: ['transfer'], menu: ['view'] }]);
    expect((listed as unknown as { toolbarActions: string[] }).toolbarActions).toEqual(['transfer']);
  });

  it('有待入职记录时（BE-14b 同步后才有）转移与失效一律机读拒绝 OFFER_SYNC_NOT_READY（纯函数）', () => {
    const fns = domain as unknown as Record<string, (...args: unknown[]) => { ok: boolean; reason?: string }>;
    expect(typeof fns.planOfferTransition).toBe('function');
    const facts = { status: 'accepted', approvalStatus: 'unsubmitted', offerType: 'social', hasPendingEntry: true };
    expect(fns.planOfferTransition!(facts, 'rejected', reject)).toMatchObject({
      ok: false,
      reason: 'OFFER_SYNC_NOT_READY',
    });
    expect(fns.planOfferInvalidation!(facts, { reasonCode: 'candidate_gave_up' })).toMatchObject({
      ok: false,
      reason: 'OFFER_SYNC_NOT_READY',
    });
    const sent = { ...facts, status: 'sent' };
    expect(fns.planOfferTransition!(sent, 'pending', {})).toMatchObject({ ok: false, reason: 'OFFER_SYNC_NOT_READY' });
    expect(fns.planOfferTransition!({ ...facts, hasPendingEntry: false }, 'rejected', reject)).toMatchObject({
      ok: true,
    });
  });
});
