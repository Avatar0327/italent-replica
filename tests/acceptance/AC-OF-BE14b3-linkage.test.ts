/**
 * BE-14b3 Offer ↔ 待入职联动（34 §2.1、OF-R4 / R7 / R9；AC-OF-03、AC-OF-17～20 联动部分、AC-EN-08 联动部分；F-201 ③）。
 * 转已拒绝 / 已发退回待发取消入职，失效删除待入职，办理入职联动已入职，取消入职按 OF-R9 开关联动已拒绝，改期恢复回已接受；
 * 末尾是“真实 Offer 状态 × OF-R9 开关”组合矩阵（逐格正反例）。
 */
import { sql, withTenant } from '@italent/db';
import * as domain from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { loginEmailOf } from './AC-EMP-support.js';
import { errorOf } from './AC-OF-BE14a-support.js';
import { overrideSetting } from './AC-OF-BE14b1-support.js';
import { syncWorld, type SyncOffer, type SyncWorld } from './AC-OF-BE14b2-support.js';

const testDb = useTestDb();
const REJECT = {
  target: 'rejected',
  refusalTime: '2026-10-18',
  refusalReasonCode: 'personal',
  refusalRemark: '合成备注',
};
const rows = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];

/** OF-R9 / OF-R4 联动开关整份覆盖（出厂都开）。 */
const linkage = (w: SyncWorld, value: Partial<domain.OfferLinkageSetting>) =>
  overrideSetting(w, domain.OFFER_LINKAGE_KEY, { ...domain.OFFER_LINKAGE_DEFAULT, ...value });

/** 直接读 Offer 行（响应对非已拒绝状态隐藏拒绝字段，保留与否看库）。 */
async function offerRow(w: SyncWorld, id: string) {
  const [row] = rows<Record<string, unknown>>(
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`SELECT status, accept_time::text AS "acceptTime", refusal_time::text AS "refusalTime",
        refusal_reason_code AS "refusalReasonCode", pending_entry_business_id::text AS "entryId" FROM offers
        WHERE id = ${id}::uuid`),
    ),
  );
  return row!;
}
/** Offer 当前关联的待入职在哪个视图：live（待入职）/ cancelled（已取消入职）/ hired（已入职）/ gone（已删除）。 */
async function entryState(w: SyncWorld, offerId: string) {
  const id = (await w.read(offerId)).pendingEntryBusinessId;
  for (const [view, state] of [
    ['all', 'live'],
    ['cancelled', 'cancelled'],
    ['hired', 'hired'],
  ] as const)
    if ((await w.entries(view)).some((entry) => entry.id === id)) return state;
  return 'gone';
}
const completeEntry = async (w: SyncWorld, id: string) =>
  w.employment('POST', `/pending-entries/${id}/complete`, {
    ifMatch: await w.businessRevision(id),
    body: { probation: false },
  });

describe('领域判定（纯函数）', () => {
  const offer = (status: domain.OfferStatus, hasPendingEntry: boolean) =>
    ({ status, approvalStatus: 'unsubmitted', offerType: 'social', hasPendingEntry }) as const;
  it('放开 OFFER_SYNC_NOT_READY：有待入职也能转移；手动转已入职只限未同步待入职', () => {
    expect(domain.planOfferTransition(offer('accepted', true), 'rejected', REJECT)).toMatchObject({ ok: true });
    expect(domain.planOfferTransition(offer('sent', true), 'pending', {})).toMatchObject({ ok: true });
    expect(domain.planOfferTransition(offer('accepted', false), 'onboarded', {})).toMatchObject({
      ok: true,
      patch: { status: 'onboarded' },
    });
    expect(domain.planOfferTransition(offer('accepted', true), 'onboarded', {})).toMatchObject({
      ok: false,
      reason: 'OFFER_ENTRY_LINKED',
    });
    expect(domain.planOfferInvalidation(offer('accepted', true), { reasonCode: 'candidate_gave_up' })).toMatchObject({
      ok: true,
    });
  });
  it('转移联动取消入职：转已拒绝、已发退回待发；其余不动', () => {
    const cancels = (status: domain.OfferStatus, target: domain.OfferStatus, linked = true) =>
      domain.offerTransitionCancelsEntry({ status, hasPendingEntry: linked }, target);
    expect(cancels('accepted', 'rejected')).toBe(true);
    expect(cancels('sent', 'rejected')).toBe(true);
    expect(cancels('sent', 'pending')).toBe(true);
    expect(cancels('accepted', 'rejected', false)).toBe(false);
    expect(cancels('rejected', 'pending')).toBe(false);
    expect(cancels('rejected', 'accepted')).toBe(false);
  });
  it('OF-R9 与 OF-R4 开关：出厂都开，取值校验；消费判定只认已发 / 已接受', () => {
    expect(domain.OFFER_LINKAGE_DEFAULT).toEqual({ entryCancelRejects: true, reapprovalAllowed: true });
    for (const bad of [{ entryCancelRejects: true }, { entryCancelRejects: 1, reapprovalAllowed: true }, null])
      expect(domain.validOfferLinkageSetting(bad)).toBe(false);
    const on = domain.OFFER_LINKAGE_DEFAULT;
    expect(domain.offerRejectsOnEntryCancel(on, { status: 'accepted' })).toBe(true);
    expect(domain.offerRejectsOnEntryCancel(on, { status: 'pending' })).toBe(false);
    expect(domain.offerRejectsOnEntryCancel({ ...on, entryCancelRejects: false }, { status: 'sent' })).toBe(false);
  });
});

describe('AC-OF-03 转已拒绝联动取消待入职', () => {
  it('已接受 Offer（已有待入职）转已拒绝：待入职取消；再转回已接受不重建待入职', async () => {
    const w = await syncWorld(testDb().db, 'link-reject');
    const offer = await w.accepted(await w.social());
    const entryId = offer.pendingEntryBusinessId!;
    const rejected = await w.moved(offer, REJECT);
    expect(rejected).toMatchObject({
      status: 'rejected',
      refusalReasonCode: 'personal',
      pendingEntryBusinessId: entryId,
    });
    expect(await entryState(w, offer.id)).toBe('cancelled');
    const again = await w.moved(rejected, { target: 'accepted', acceptTime: '2026-10-19' });
    expect(again).toMatchObject({ status: 'accepted', pendingEntryBusinessId: entryId });
    expect(await entryState(w, offer.id)).toBe('cancelled');
    expect(await w.entries()).toHaveLength(0);
    expect(await w.entries('cancelled')).toHaveLength(1);
  });

  it('AC-OF-17：不填拒绝时间 / 原因 → 400，状态不变，待入职原样保留', async () => {
    const w = await syncWorld(testDb().db, 'link-reject-invalid');
    const offer = await w.accepted(await w.social());
    const denied = await w.transfer(offer, { target: 'rejected', refusalRemark: '只有备注' });
    expect(denied.status).toBe(400);
    expect(await w.read(offer.id)).toMatchObject({ status: 'accepted', hasPendingEntry: true });
    expect(await entryState(w, offer.id)).toBe('live');
  });

  it('顶部工具栏入口同样联动；取消原因取拒绝原因', async () => {
    const w = await syncWorld(testDb().db, 'link-reject-toolbar');
    const offer = await w.accepted(await w.social());
    const response = await w.transfer(offer, REJECT, 'toolbar');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await entryState(w, offer.id)).toBe('cancelled');
    const [log] = rows<{ reason: string }>(
      await withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT reason_code AS reason FROM employment_entry_actions WHERE action = 'cancel'`),
      ),
    );
    expect(log!.reason).toBe('personal');
  });

  it('已发（时机 = 发送时，已同步）转已拒绝、或退回待发：待入职取消', async () => {
    const w = await syncWorld(testDb().db, 'link-sent');
    await w.timing({ mode: 'on_send' });
    const first = await w.read((await (await w.send(await w.social())).json()).id);
    expect(first.hasPendingEntry).toBe(true);
    const back = await w.moved(first, { target: 'pending' });
    expect(back.status).toBe('pending');
    expect(await entryState(w, first.id)).toBe('cancelled');
    const second = await w.read((await (await w.send(await w.social())).json()).id);
    await w.moved(second, REJECT);
    expect(await entryState(w, second.id)).toBe('cancelled');
  });

  it('待入职已被手工删除（Offer 上关联悬空）：转已拒绝照常成功，不联动', async () => {
    const w = await syncWorld(testDb().db, 'link-dangling');
    const offer = await w.accepted(await w.social());
    const deleted = await w.employment('DELETE', `/pending-entries/${offer.pendingEntryBusinessId}`, {
      ifMatch: await w.businessRevision(offer.pendingEntryBusinessId!),
    });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await w.moved(offer, REJECT)).toMatchObject({ status: 'rejected' });
  });

  it('实习转正产物（没有待入职）：转已拒绝 / 失效只改 Offer，不动任职记录', async () => {
    const w = await syncWorld(testDb().db, 'link-intern');
    const intern = await w.internEmployee('在职实习生');
    const offer = await w.social({ personalEmail: loginEmailOf(intern.id), source: 'intern_conversion' });
    const link = await w.request('POST', `/${offer.id}/link-employee`, {
      ifMatch: offer.revision,
      body: { employeeId: intern.id },
    });
    expect(link.status, await link.clone().text()).toBe(200);
    const accepted = await w.accepted(await w.read(offer.id));
    expect(accepted.syncTarget).toBe('intern_regularization');
    const before = (await w.recordsOf(intern.id)).length;
    expect(await w.moved(accepted, REJECT)).toMatchObject({ status: 'rejected' });
    expect((await w.recordsOf(intern.id)).length).toBe(before);
  });
});

describe('失效删除待入职（OF-R7，AC-OF-18 联动部分）', () => {
  it('已接受 + 待入职：失效即删除待入职，关联解除，失效后不可恢复', async () => {
    const w = await syncWorld(testDb().db, 'link-invalidate');
    const offer = await w.accepted(await w.social());
    const response = await w.invalidate(offer, { reasonCode: 'candidate_gave_up' });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'invalid', hasPendingEntry: false });
    expect(await w.entries()).toHaveLength(0);
    expect((await offerRow(w, offer.id)).entryId).toBeNull();
    const revived = await w.transfer(await w.read(offer.id), { target: 'pending' });
    expect((await errorOf(revived)).details).toMatchObject({ reason: 'OFFER_TRANSITION_INVALID' });
  });

  it('原因仍必填；失效校验失败时待入职原样保留（整笔回滚）', async () => {
    const w = await syncWorld(testDb().db, 'link-invalidate-form');
    const offer = await w.accepted(await w.social());
    const missing = await w.invalidate(offer, {});
    expect((await errorOf(missing)).details).toMatchObject({ reason: 'OFFER_FORM_INCOMPLETE' });
    expect(await w.entries()).toHaveLength(1);
    expect(await w.read(offer.id)).toMatchObject({ status: 'accepted', hasPendingEntry: true });
  });

  it('已发 + 待入职（发送时同步）同样删除；无待入职时确定即失效', async () => {
    const w = await syncWorld(testDb().db, 'link-invalidate-sent');
    await w.timing({ mode: 'on_send' });
    const sent = await w.read((await (await w.send(await w.social())).json()).id);
    expect((await w.invalidate(sent, { reasonCode: 'background_check_failed' })).status).toBe(200);
    expect(await w.entries()).toHaveLength(0);
    const plain = await w.social();
    expect((await w.invalidate(plain, { reasonCode: 'candidate_gave_up' })).status).toBe(200);
  });
});

describe('已接受 → 已入职（AC-EN-08 联动部分）', () => {
  it('待入职办理入职：Offer 联动为已入职，行操作变为已入职矩阵（AC-OF-20）', async () => {
    const w = await syncWorld(testDb().db, 'link-complete');
    const offer = await w.accepted(await w.social());
    const done = await completeEntry(w, offer.pendingEntryBusinessId!);
    expect(done.status, await done.clone().text()).toBe(200);
    const after = (await w.get(offer.id)) as SyncOffer & { rowActions?: { primary: string[] } };
    expect(after.status).toBe('onboarded');
    expect(after.pendingEntryBusinessId).toBe(offer.pendingEntryBusinessId);
  });

  it('改期后的记录（ID 已换）办理入职：沿记录链找到 Offer 并联动', async () => {
    const w = await syncWorld(testDb().db, 'link-complete-chain');
    const offer = await w.accepted(await w.social());
    const moved = await w.entryAction(offer.pendingEntryBusinessId!, 'postpone', { effectiveDate: '2026-11-20' });
    expect(moved.status, await moved.clone().text()).toBe(200);
    const current = (await w.read(offer.id)).pendingEntryBusinessId!;
    expect((await completeEntry(w, current)).status).toBe(200);
    expect((await w.read(offer.id)).status).toBe('onboarded');
  });

  it('手动转已入职：已有待入职 409 OFFER_ENTRY_LINKED；未同步待入职（同步关闭）可以', async () => {
    const w = await syncWorld(testDb().db, 'link-manual');
    const linked = await w.accepted(await w.social());
    const denied = await w.transfer(linked, { target: 'onboarded' });
    expect(denied.status).toBe(409);
    expect((await errorOf(denied)).details).toMatchObject({ reason: 'OFFER_ENTRY_LINKED' });
    const form = (await (await w.request('GET', `/${linked.id}/transfer-form`)).json()) as { targets: string[] };
    expect(form.targets).not.toContain('onboarded');

    await w.timing({ enabled: false });
    const free = await w.accepted(await w.social());
    const formFree = (await (await w.request('GET', `/${free.id}/transfer-form`)).json()) as { targets: string[] };
    expect(formFree.targets).toContain('onboarded');
    expect(await w.moved(free, { target: 'onboarded' })).toMatchObject({ status: 'onboarded' });
  });
});

describe('OF-R9 取消入职联动 Offer、改期恢复', () => {
  const cancel = (w: SyncWorld, offer: SyncOffer) => w.entryAction(offer.pendingEntryBusinessId!, 'cancel', {});

  it('开关开（出厂）：取消入职 → Offer 已拒绝（拒绝时间 = 租户当天，原因“其他原因”）；改期恢复 → 回已接受，拒绝信息保留', async () => {
    const w = await syncWorld(testDb().db, 'link-r9-on');
    const offer = await w.accepted(await w.social());
    expect((await cancel(w, offer)).status).toBe(200);
    expect(await offerRow(w, offer.id)).toMatchObject({
      status: 'rejected',
      refusalTime: '2026-10-17',
      refusalReasonCode: 'other',
    });
    const restored = await w.entryAction(offer.pendingEntryBusinessId!, 'postpone', { effectiveDate: '2026-11-15' });
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(await offerRow(w, offer.id)).toMatchObject({
      status: 'accepted',
      refusalReasonCode: 'other',
      refusalTime: '2026-10-17',
    });
    expect((await w.read(offer.id)).plannedEntryDate).toBe('2026-11-01'); // 拟入职日期不跟着改期变（DEC-546）
  });

  it('开关关：取消入职后 Offer 保持已接受；改期恢复也不动', async () => {
    const w = await syncWorld(testDb().db, 'link-r9-off');
    expect((await linkage(w, { entryCancelRejects: false })).status).toBe(200);
    const offer = await w.accepted(await w.social());
    expect((await cancel(w, offer)).status).toBe(200);
    expect((await w.read(offer.id)).status).toBe('accepted');
    expect(
      (await w.entryAction(offer.pendingEntryBusinessId!, 'postpone', { effectiveDate: '2026-11-15' })).status,
    ).toBe(200);
    expect((await w.read(offer.id)).status).toBe('accepted');
  });

  it('开关配置接口：非法值 400', async () => {
    const w = await syncWorld(testDb().db, 'link-r9-setting');
    expect((await overrideSetting(w, domain.OFFER_LINKAGE_KEY, { entryCancelRejects: 'yes' })).status).toBe(400);
  });
});

/**
 * F-201③ 真实 Offer 状态 × OF-R9 开关组合矩阵：每格造出该状态（有待入职），取消入职，核对 Offer 终态与待入职。
 * 正例 = 已发 / 已接受且开关开 → 已拒绝；其余格（开关关、待发、已拒绝、已入职）都不得改 Offer。
 */
describe('F-201③ 状态 × OF-R9 开关矩阵', () => {
  type Cell = { status: string; on: boolean; expected: string; cancelStatus: 200 | 409 };
  const cells: Cell[] = [
    { status: 'accepted', on: true, expected: 'rejected', cancelStatus: 200 },
    { status: 'accepted', on: false, expected: 'accepted', cancelStatus: 200 },
    { status: 'sent', on: true, expected: 'rejected', cancelStatus: 200 },
    { status: 'sent', on: false, expected: 'sent', cancelStatus: 200 },
    { status: 'pending', on: true, expected: 'pending', cancelStatus: 200 },
    { status: 'pending', on: false, expected: 'pending', cancelStatus: 200 },
    { status: 'rejected', on: true, expected: 'rejected', cancelStatus: 409 },
    { status: 'rejected', on: false, expected: 'rejected', cancelStatus: 409 },
    { status: 'onboarded', on: true, expected: 'onboarded', cancelStatus: 409 },
    { status: 'onboarded', on: false, expected: 'onboarded', cancelStatus: 409 },
  ];
  it.each(cells)('Offer $status × 开关 $on → $expected（取消入职 $cancelStatus）', async (cell) => {
    const w = await syncWorld(testDb().db, `matrix-${cell.status}-${cell.on}`);
    expect((await linkage(w, { entryCancelRejects: cell.on })).status).toBe(200);
    await w.timing({ mode: 'on_send' });
    let offer = (await w.read((await (await w.send(await w.social())).json()).id)) as SyncOffer; // 已发 + 待入职
    if (cell.status !== 'sent') offer = await w.accepted(offer);
    if (cell.status === 'pending') await w.force(offer.id, 'status', 'pending');
    if (cell.status === 'rejected') offer = (await w.moved(offer, REJECT)) as SyncOffer;
    if (cell.status === 'onboarded') expect((await completeEntry(w, offer.pendingEntryBusinessId!)).status).toBe(200);
    const response = await w.entryAction(offer.pendingEntryBusinessId!, 'cancel', {});
    expect(response.status, await response.clone().text()).toBe(cell.cancelStatus);
    expect((await w.read(offer.id)).status).toBe(cell.expected);
    // 取消成功的格：待入职一定是取消状态；失败的格：待入职状态没被碰（已拒绝本来就是取消，已入职已不在待入职）
    if (cell.cancelStatus === 200) expect(await entryState(w, offer.id)).toBe('cancelled');
  });
});
