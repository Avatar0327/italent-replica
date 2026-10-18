/**
 * BE-14a2：OF-R3 发送前须审批（AC-OF-01 判定部分）与转移状态的两项按钮权限（34 §2.1 转移权限，DEC-533④ / 537③ / 503）。
 * 发送动作本身在 BE-14b；本段只有按 Offer 类型设置的开关与拦截判定接口。
 * 转移状态只按两项按钮控制：行主按钮入口查 OfferLineOpStatusTransfer@list_row，顶部工具栏入口查 Offer.StatusTransfer@list，
 * 两项各自独立；system_admin 不越过业务对象权限。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, offerRealWorld, offerWorld, type OfferBody } from './AC-OF-BE14a-support.js';

const testDb = useTestDb();
const SETTING = '/api/tenant/settings/offer.send_requires_approval';
const ROW = 'OfferLineOpStatusTransfer';
const TOOLBAR = 'Offer.StatusTransfer';
const accept = { target: 'accepted', acceptTime: '2026-10-16' };

describe('AC-OF-01 发送前须审批（判定）', () => {
  it('开关按类型：出厂都关；社招开启后未审批不能发送、审批通过可以；实习不受社招开关影响', async () => {
    const w = await offerWorld(testDb().db, 'send');
    const as = { user: w.user.id, tenant: w.tenant.id };
    const setting = await w.seeder.request('GET', SETTING, as);
    expect(setting.status, await setting.clone().text()).toBe(200);
    expect(await setting.json()).toMatchObject({ value: { social: false, campus: false, intern: false } });
    const social = await w.social();
    const intern = await w.intern();
    const check = async (offer: OfferBody) => {
      const response = await w.request('GET', `/${offer.id}/send-check`);
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as { allowed: boolean; reason: string | null; offerType: string };
    };
    expect(await check(social)).toMatchObject({ allowed: true, reason: null, offerType: 'social' });
    const invalid = await w.seeder.request('PUT', SETTING, { ...as, ifMatch: 0, body: { value: { social: true } } });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).details).toMatchObject({ reason: 'SETTING_VALUE_INVALID' });
    const saved = await w.seeder.request('PUT', SETTING, {
      ...as,
      ifMatch: 0,
      body: { value: { social: true, campus: false, intern: false } },
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await check(social)).toMatchObject({ allowed: false, reason: 'OFFER_APPROVAL_REQUIRED' });
    expect(await check(intern)).toMatchObject({ allowed: true, offerType: 'intern' });
    await w.force(social.id, 'approval_status', 'approving');
    expect(await check(social)).toMatchObject({ allowed: false, reason: 'OFFER_APPROVAL_IN_PROGRESS' });
    await w.force(social.id, 'approval_status', 'approved');
    expect(await check(social)).toMatchObject({ allowed: true, reason: null });
    await w.force(social.id, 'status', 'sent');
    expect(await check(social)).toMatchObject({ allowed: false, reason: 'OFFER_NOT_PENDING' });
  });

  it('类型为空按社招开关判断（OF-R12）', async () => {
    const w = await offerWorld(testDb().db, 'send-null');
    const as = { user: w.user.id, tenant: w.tenant.id };
    await w.seeder.request('PUT', SETTING, {
      ...as,
      ifMatch: 0,
      body: { value: { social: true, campus: false, intern: false } },
    });
    const offer = await w.social({ offerType: null });
    const response = await w.request('GET', `/${offer.id}/send-check`);
    expect(await response.json()).toMatchObject({
      allowed: false,
      reason: 'OFFER_APPROVAL_REQUIRED',
      offerType: 'social',
    });
  });
});

describe('转移状态两项按钮权限（真实授权器）', () => {
  it('只有行级按钮：行主按钮入口可转移，顶部工具栏入口 403；列表不给工具栏转移', async () => {
    const w = await offerRealWorld(testDb().db, 'row-only', [], [TOOLBAR]);
    const offer = await w.social();
    const toolbar = await w.real('POST', `/${offer.id}/toolbar-transfer`, { ifMatch: 1, body: accept });
    expect(toolbar.status, await toolbar.clone().text()).toBe(403);
    expect(await w.get(offer.id)).toMatchObject({ status: 'pending', revision: 1 });
    const listed = await w.real('GET', '?view=pending');
    expect(((await listed.json()) as { toolbarActions: string[] }).toolbarActions).toEqual([]);
    const form = await w.real('GET', `/${offer.id}/transfer-form`);
    expect(await form.json()).toMatchObject({ targets: ['accepted', 'rejected'] });
    const row = await w.real('POST', `/${offer.id}/transfer`, { ifMatch: 1, body: accept });
    expect(row.status, await row.clone().text()).toBe(200);
  });

  it('只有工具栏按钮：顶部工具栏入口可转移，行主按钮入口 403，行操作里没有转移', async () => {
    const w = await offerRealWorld(testDb().db, 'toolbar-only', [], [ROW]);
    const offer = await w.social();
    const detail = (await (await w.real('GET', `/${offer.id}`)).json()) as { rowActions: { menu: string[] } };
    expect(detail.rowActions.menu).not.toContain('transfer');
    const row = await w.real('POST', `/${offer.id}/transfer`, { ifMatch: 1, body: accept });
    expect(row.status, await row.clone().text()).toBe(403);
    const toolbar = await w.real('POST', `/${offer.id}/toolbar-transfer`, { ifMatch: 1, body: accept });
    expect(toolbar.status, await toolbar.clone().text()).toBe(200);
  });

  it('撤掉行级按钮后同键重放 403；范围外 Offer 404；system_admin 无 Offer 按钮权限 403', async () => {
    const w = await offerRealWorld(testDb().db, 'replay');
    const offer = await w.social();
    const key = randomUUID();
    const first = await w.real('POST', `/${offer.id}/transfer`, { ifMatch: 1, idempotencyKey: key, body: accept });
    expect(first.status, await first.clone().text()).toBe(200);
    await w.denyButtons([ROW]);
    const replay = await w.real('POST', `/${offer.id}/transfer`, { ifMatch: 1, idempotencyKey: key, body: accept });
    expect(replay.status).toBe(403);
    const outsideOrg = await w.seeder.request('POST', '/api/tenant/org/organizations', {
      user: w.user.id,
      tenant: w.tenant.id,
      ifMatch: 0,
      body: { name: '范围外录用部门', parents: { admin: { parentId: w.tenant.id } }, establishedOn: '2026-01-01' },
    });
    const outside = await w.intern({ departmentId: ((await outsideOrg.json()) as { id: string }).id });
    await w.denyButtons([]);
    const hidden = await w.real('POST', `/${outside.id}/transfer`, { ifMatch: 1, body: accept });
    expect(hidden.status).toBe(404);
    const admin = await w.adminRequest('POST', `/${outside.id}/transfer`, { ifMatch: 1, body: accept });
    expect(admin.status, await admin.clone().text()).toBe(403);
    expect(await w.get(outside.id)).toMatchObject({ status: 'pending', revision: 1 });
  });

  it('失效按对象编辑开关：无编辑权 403、不失效', async () => {
    const w = await offerRealWorld(testDb().db, 'invalidate-access');
    const offer = await w.social();
    await w.dropUpdate();
    const response = await w.real('POST', `/${offer.id}/invalidate`, {
      ifMatch: 1,
      body: { reasonCode: 'candidate_gave_up' },
    });
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await w.get(offer.id)).toMatchObject({ status: 'pending', revision: 1 });
  });
});

/**
 * 第 2 轮（#398 审查 P2-1）：行操作按真实授权器裁剪。编辑 / 失效看编辑开关、复制看新增开关、删除看删除开关，
 * 都只判开关（不带字段）；有权时必须出现，无权时不出现。列表行与详情一致。
 */
describe('P2-1 行操作在真实授权器下按数据操作开关裁剪', () => {
  type Actions = { primary: string[]; menu: string[] };
  const detailActions = async (w: Awaited<ReturnType<typeof offerRealWorld>>, id: string) => {
    const response = await w.real('GET', `/${id}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { rowActions: Actions }).rowActions;
  };
  const listActions = async (w: Awaited<ReturnType<typeof offerRealWorld>>, view: string, id: string) => {
    const response = await w.real('GET', `?view=${view}`);
    expect(response.status, await response.clone().text()).toBe(200);
    const items = ((await response.json()) as { items: (OfferBody & { rowActions: Actions })[] }).items;
    return items.find((item) => item.id === id)!.rowActions;
  };

  it('新增 / 编辑 / 删除都有权：待发有编辑、转移、失效、删除；审批通过主按钮编辑；失效主按钮复制', async () => {
    const w = await offerRealWorld(testDb().db, 'actions-allowed');
    const pending = await w.social();
    const approved = await w.social();
    await w.force(approved.id, 'approval_status', 'approved');
    const invalid = await w.social();
    await w.invalidated(invalid.id);
    // BE-14a3：发起审批与编辑同一开关，接线后在待发主按钮出现；BE-14b1：发送在下拉
    const full = {
      primary: ['submitApproval'],
      menu: ['edit', 'send', 'transfer', 'invalidate', 'view', 'delete'],
    };
    expect(await detailActions(w, pending.id)).toEqual(full);
    expect(await listActions(w, 'pending', pending.id)).toEqual(full);
    expect(await detailActions(w, approved.id)).toEqual({ primary: ['edit'], menu: ['invalidate'] });
    expect(await detailActions(w, invalid.id)).toEqual({ primary: ['copy'], menu: ['view'] });
    expect(await listActions(w, 'invalid', invalid.id)).toEqual({ primary: ['copy'], menu: ['view'] });
  });

  it('无编辑开关：编辑、失效（及依赖编辑开关的转移按钮）不出现；无新增开关：复制不出现；无删除开关：删除不出现', async () => {
    const w = await offerRealWorld(testDb().db, 'actions-denied');
    const pending = await w.social();
    const invalid = await w.social();
    await w.invalidated(invalid.id);
    await w.setOps({ update: false });
    expect(await detailActions(w, pending.id)).toEqual({ primary: [], menu: ['view', 'delete'] });
    expect(await listActions(w, 'pending', pending.id)).toEqual({ primary: [], menu: ['view', 'delete'] });
    await w.setOps({ create: false, delete: false });
    expect(await detailActions(w, pending.id)).toEqual({
      primary: ['submitApproval'],
      menu: ['edit', 'send', 'transfer', 'invalidate', 'view'],
    });
    expect(await detailActions(w, invalid.id)).toEqual({ primary: [], menu: ['view'] });
    expect(await listActions(w, 'invalid', invalid.id)).toEqual({ primary: [], menu: ['view'] });
  });
});
