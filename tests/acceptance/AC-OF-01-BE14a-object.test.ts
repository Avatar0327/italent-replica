/**
 * BE-14a Offer 对象：三个新建入口与按类型必填（OF-R1 / R12，DEC-527③ / 532⑤）、编辑 / 删除 / 复制、拒绝 / 失效原因字典（A37）、
 * 转移状态两项按钮权限（DEC-533④ / 503）、数据范围、发送前须审批的拦截判定（OF-R3，AC-OF-01 判定部分），
 * 以及需要联动待入职时的机读拒绝（纯函数）。
 */
import type { Authorizer } from '@italent/api';
import { planOfferInvalidation, planOfferTransition } from '@italent/domain';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, offerWorld, type OfferBody } from './AC-OF-BE14a-support.js';

const testDb = useTestDb();
const deny =
  (...resources: string[]): Authorizer =>
  (request) =>
    !resources.some((r) => request.resource === r || request.action === r);

describe('BE-14a 新建入口与必填', () => {
  it('社招 10 项必填（类型为空按社招）；实习只 4 项；缺项 400 列出字段、不写入', async () => {
    const w = await offerWorld(testDb().db, 'required');
    const { costCenter: _c, levelId: _l, ...partial } = w.socialFields();
    const response = await w.request('POST', '', { ifMatch: 0, body: { entry: 'offer', ...partial } });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).details).toMatchObject({
      reason: 'OFFER_FORM_INCOMPLETE',
      fields: ['levelId', 'costCenter'],
    });
    expect((await w.list('view=all')).total).toBe(0);
    expect(await w.social()).toMatchObject({ offerType: null, source: 'new_hire', status: 'pending' });
    expect(await w.social({ offerType: 'campus' })).toMatchObject({ offerType: 'campus' });
    expect(await w.intern()).toMatchObject({ offerType: 'intern', entry: 'intern', approvalStatus: 'unsubmitted' });
    const wrong = await w.request('POST', '', {
      ifMatch: 0,
      body: { entry: 'offer', offerType: 'intern', ...w.internFields() },
    });
    expect((await errorOf(wrong)).details).toMatchObject({ reason: 'OFFER_TYPE_MISMATCH' });
  });

  it('校招生提前实习须先选一份校招 Offer 并带出基本信息；引用不存在 400；多余字段 400', async () => {
    const w = await offerWorld(testDb().db, 'campus');
    const campus = await w.social({ offerType: 'campus', mobile: '13800000000' });
    const { name: _n, personalEmail: _e, ...rest } = w.internFields();
    const early = await w.create({ entry: 'campus_early_intern', campusOfferId: campus.id, ...rest });
    expect(early).toMatchObject({
      offerType: 'intern',
      campusOfferId: campus.id,
      name: campus.name,
      personalEmail: campus.personalEmail,
      mobile: '13800000000',
    });
    const noCampus = await w.request('POST', '', {
      ifMatch: 0,
      body: { entry: 'campus_early_intern', ...w.internFields() },
    });
    expect((await errorOf(noCampus)).details).toMatchObject({ reason: 'OFFER_CAMPUS_REQUIRED' });
    const social = await w.social();
    const notCampus = await w.request('POST', '', {
      ifMatch: 0,
      body: { entry: 'campus_early_intern', campusOfferId: social.id, ...w.internFields() },
    });
    expect((await errorOf(notCampus)).details).toMatchObject({ reason: 'OFFER_CAMPUS_REQUIRED' });
    const badRef = await w.request('POST', '', {
      ifMatch: 0,
      body: { entry: 'offer', ...w.socialFields(), levelId: crypto.randomUUID() },
    });
    expect(badRef.status).toBe(400);
    expect((await errorOf(badRef)).details).toMatchObject({ reason: 'OFFER_REFERENCE_INVALID' });
    const extra = await w.request('POST', '', {
      ifMatch: 0,
      body: { entry: 'offer', ...w.socialFields(), status: 'sent' },
    });
    expect(extra.status).toBe(400);
  });
});

describe('BE-14a 编辑、删除、复制', () => {
  it('待发可编辑（保存后重校必填）与删除；已拒绝不可编辑删除；复制只限失效，新 Offer 回待发并记来源', async () => {
    const w = await offerWorld(testDb().db, 'edit');
    const offer = await w.social({ salaryBeforeRegular: 12000.5 });
    expect(offer.salaryBeforeRegular).toBe(12000.5);
    const cleared = await w.request('PUT', `/${offer.id}`, { ifMatch: 1, body: { costCenter: null } });
    expect((await errorOf(cleared)).details).toMatchObject({ fields: ['costCenter'] });
    const edited = await w.request('PUT', `/${offer.id}`, { ifMatch: 1, body: { plannedEntryDate: '2026-12-01' } });
    expect(await edited.json()).toMatchObject({ plannedEntryDate: '2026-12-01', revision: 2 });
    const removable = await w.social();
    expect((await w.request('DELETE', `/${removable.id}`, { ifMatch: 1 })).status).toBe(200);
    expect((await w.request('GET', `/${removable.id}`)).status).toBe(404);
    const audits = await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`SELECT action FROM audit_events WHERE tenant_id=${w.tenant.id} AND object_id=${removable.id}
        ORDER BY occurred_at`),
    );
    const actions = ((Array.isArray(audits) ? audits : audits.rows) as { action: string }[]).map((a) => a.action);
    expect(actions.sort()).toEqual(['offer.create', 'offer.delete']);
    const rejected = await w.moved(await w.get(offer.id), {
      target: 'rejected',
      refusalTime: '2026-10-16',
      refusalReasonCode: 'other',
    });
    for (const [method, body] of [
      ['PUT', { name: '改名' }],
      ['DELETE', undefined],
    ] as const) {
      const response = await w.request(method, `/${offer.id}`, { ifMatch: rejected.revision, body });
      expect((await errorOf(response)).details).toMatchObject({ reason: 'OFFER_NOT_EDITABLE' });
    }
    const copyRejected = await w.request('POST', `/${offer.id}/copy`, { ifMatch: rejected.revision });
    expect((await errorOf(copyRejected)).details).toMatchObject({ reason: 'OFFER_COPY_NOT_ALLOWED' });
    const source = await w.social();
    const invalid = (await (await w.invalidate(source, { reasonCode: 'candidate_gave_up' })).json()) as OfferBody;
    const copied = await w.request('POST', `/${source.id}/copy`, { ifMatch: invalid.revision });
    expect(copied.status).toBe(201);
    expect(await copied.json()).toMatchObject({
      status: 'pending',
      approvalStatus: 'unsubmitted',
      copiedFromOfferId: source.id,
      name: source.name,
      invalidReasonCode: null,
    });
  });
});

describe('BE-14a 拒绝 / 失效原因字典', () => {
  it('预置拒绝原因 5 项、失效原因 2 项；可新增、停用；停用项不能再选', async () => {
    const w = await offerWorld(testDb().db, 'dictionary');
    const list = async (kind: string) =>
      (
        (await (await w.request('GET', `/dictionaries/${kind}`)).json()) as {
          items: { id: string; code: string; name: string; revision: number }[];
        }
      ).items;
    expect((await list('refusal-reasons')).map((i) => i.name)).toEqual([
      '薪酬福利不满意',
      '发展空间受限',
      '有更好的工作机会',
      '个人原因',
      '其他原因',
    ]);
    expect((await list('invalid-reasons')).map((i) => i.name)).toEqual(['候选人放弃', '背调不通过']);
    const added = await w.request('POST', '/dictionaries/refusal-reasons', {
      ifMatch: 0,
      body: { code: 'Personal', name: '重复' },
    });
    expect((await errorOf(added)).details).toMatchObject({ reason: 'OFFER_DICTIONARY_CODE_TAKEN' });
    const growth = (await list('refusal-reasons')).find((i) => i.code === 'growth')!;
    const off = await w.request('PUT', `/dictionaries/refusal-reasons/${growth.id}`, {
      ifMatch: 1,
      body: { enabled: false },
    });
    expect(await off.json()).toMatchObject({ enabled: false, revision: 2 });
    const offer = await w.social();
    const response = await w.transfer(offer, {
      target: 'rejected',
      refusalTime: '2026-10-16',
      refusalReasonCode: 'growth',
    });
    expect((await errorOf(response)).details).toMatchObject({ reason: 'OFFER_DICTIONARY_DISABLED' });
    expect((await w.request('GET', '/dictionaries/unknown')).status).toBe(400);
  });
});

describe('BE-14a 转移状态两项按钮权限（只按按钮控制，DEC-533④ / 503）', () => {
  it('顶部入口只认 Offer.StatusTransfer@list，行主按钮只认 OfferLineOpStatusTransfer@list_row；行操作随之隐藏', async () => {
    const db = testDb().db;
    const row = await offerWorld(db, 'btn-row', deny('TenantBase.Offer#OfferLineOpStatusTransfer@list_row'));
    const offer = await row.social();
    expect((await row.get(offer.id)).rowActions!.menu).not.toContain('transfer');
    const byRow = await row.transfer(offer, { target: 'accepted', acceptTime: '2026-10-16' });
    expect(byRow.status).toBe(403);
    const byToolbar = await row.transfer(offer, { target: 'accepted', acceptTime: '2026-10-16', entry: 'toolbar' });
    expect(byToolbar.status, await byToolbar.clone().text()).toBe(200);
    const list = await offerWorld(db, 'btn-list', deny('TenantBase.Offer#Offer.StatusTransfer@list'));
    const other = await list.social();
    expect((await list.get(other.id)).rowActions!.menu).toContain('transfer');
    const denied = await list.transfer(other, { target: 'accepted', acceptTime: '2026-10-16', entry: 'toolbar' });
    expect(denied.status).toBe(403);
    expect((await list.get(other.id)).status).toBe('pending');
  });

  it('没有数据范围（默认空）时列表为空、新建 404；跨租户读取 404', async () => {
    const db = testDb().db;
    const w = await offerWorld(db, 'scope');
    const offer = await w.social();
    const blind = await offerWorld(db, 'scope-blind', deny('data.scope.all'));
    expect((await blind.list('view=all')).total).toBe(0);
    const create = await blind.request('POST', '', { ifMatch: 0, body: { entry: 'offer', ...blind.socialFields() } });
    expect(create.status).toBe(404);
    expect((await w.request('GET', `/${offer.id}`, { tenant: blind.tenant.id, user: blind.user.id })).status).toBe(404);
  });
});

describe('AC-OF-01 发送前须审批（判定部分）', () => {
  it('社招开关开着、未审批 → 不允许发送（OFFER_APPROVAL_REQUIRED）；出厂关时允许；实习不受社招开关影响', async () => {
    const w = await offerWorld(testDb().db, 'send');
    const offer = await w.social();
    const intern = await w.intern();
    const check = async (id: string) =>
      (await (await w.request('GET', `/${id}/send-check`)).json()) as Record<string, unknown>;
    expect(await check(offer.id)).toMatchObject({ allowed: true, reason: null, offerType: 'social' });
    const put = await w.seeder.request('PUT', '/api/tenant/settings/offer.send_requires_approval', {
      user: w.user.id,
      tenant: w.tenant.id,
      ifMatch: 0,
      body: { value: { social: true, campus: false, intern: false } },
    });
    expect(put.status, await put.clone().text()).toBe(200);
    expect(await check(offer.id)).toMatchObject({ allowed: false, reason: 'OFFER_APPROVAL_REQUIRED' });
    expect(await check(intern.id)).toMatchObject({ allowed: true });
    await w.force(offer.id, 'approval_status', 'approved');
    expect(await check(offer.id)).toMatchObject({ allowed: true });
    const invalidValue = await w.seeder.request('PUT', '/api/tenant/settings/offer.send_requires_approval', {
      user: w.user.id,
      tenant: w.tenant.id,
      ifMatch: 1,
      body: { value: { social: 'yes' } },
    });
    expect(invalidValue.status).toBe(400);
  });
});

describe('BE-14a 联动待入职的分支给机读拒绝（BE-14b 接线）', () => {
  it('已有待入职时转已拒绝、失效都拒绝 OFFER_SYNC_NOT_READY；已接受 → 已入职一律拒绝', () => {
    const facts = { approvalStatus: 'unsubmitted', offerType: null, hasPendingEntry: true } as const;
    const refusal = { refusalTime: '2026-10-16', refusalReasonCode: 'personal' };
    for (const status of ['sent', 'accepted'] as const) {
      expect(planOfferTransition({ ...facts, status }, 'rejected', refusal)).toEqual({
        ok: false,
        reason: 'OFFER_SYNC_NOT_READY',
      });
      expect(planOfferInvalidation({ ...facts, status }, { reasonCode: 'candidate_gave_up' })).toMatchObject({
        reason: 'OFFER_SYNC_NOT_READY',
      });
    }
    expect(
      planOfferTransition({ ...facts, status: 'accepted', hasPendingEntry: false }, 'onboarded', {}),
    ).toMatchObject({
      reason: 'OFFER_SYNC_NOT_READY',
    });
  });
});
