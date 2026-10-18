/**
 * BE-14b3 编辑并同步（OF-R14、AC-OF-11、F-171⑤）与再次发起审批两分支（OF-R4）。
 * 编辑接口带 syncPendingEntry（默认 false）：true 仅在已同步且未取消入职时把改动推送到待入职；推送遇业务规则拒绝，Offer 编辑保留、
 * 同步状态记失败。OF-R4 两分支（真实审批流）见 AC-OF-BE14b3-p2-4-reapproval。
 */
import * as domain from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, type OfferBody } from './AC-OF-BE14a-support.js';
import { overrideSetting } from './AC-OF-BE14b1-support.js';
import { fullSocial, syncWorld, type SyncOffer, type SyncWorld } from './AC-OF-BE14b2-support.js';

const testDb = useTestDb();
type Edited = SyncOffer & { entrySync?: string; replacedOfferId?: string; copiedFromOfferId?: string };

const edit = (w: SyncWorld, offer: Pick<OfferBody, 'id' | 'revision'>, body: Record<string, unknown>) =>
  w.request('PUT', `/${offer.id}`, { ifMatch: offer.revision, body });
async function edited(w: SyncWorld, offer: Pick<OfferBody, 'id' | 'revision'>, body: Record<string, unknown>) {
  const response = await edit(w, offer, body);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Edited;
}

describe('AC-OF-11 编辑并同步（计划入职日）', () => {
  it('选“否”（含不带该字段）：Offer 改了、待入职不变；选“是”：待入职同步改日期，合同起始日、记录关联随之', async () => {
    const w = await syncWorld(testDb().db, 'es-date');
    const offer = await w.accepted(await fullSocial(w));
    const entry = await w.entryOf(offer);
    expect(entry.effectiveDate).toBe('2026-11-01');

    const no = await edited(w, offer, { plannedEntryDate: '2026-12-01', syncPendingEntry: false });
    expect(no.plannedEntryDate).toBe('2026-12-01');
    const omitted = await edited(w, no, { plannedEntryDate: '2026-12-05' });
    expect(omitted.entrySync).toBeUndefined();
    expect(await w.entryOf(omitted)).toMatchObject({ id: entry.id, effectiveDate: '2026-11-01' });

    const yes = await edited(w, omitted, { plannedEntryDate: '2026-12-15', syncPendingEntry: true });
    expect(yes).toMatchObject({
      status: 'accepted',
      entrySync: 'pushed',
      syncStatus: 'success',
      plannedEntryDate: '2026-12-15',
    });
    const pushed = await w.entryOf(yes);
    expect(pushed).toMatchObject({
      employeeId: entry.employeeId,
      effectiveDate: '2026-12-15',
      contractStartDate: '2026-12-15',
      entryStatus: 0,
    });
    expect(pushed.id).not.toBe(entry.id); // 任职记录不可原地改日期：替换为新记录，沿记录链关联
    expect(await w.entries()).toHaveLength(1);
  });

  it('选“是”同步其他映射项：姓名（员工信息）、试用期、合同终止日', async () => {
    const w = await syncWorld(testDb().db, 'es-fields');
    const offer = await w.accepted(await fullSocial(w));
    const yes = await edited(w, offer, {
      name: '改名候选人',
      hasProbation: false,
      contractEndDate: '2029-10-31',
      syncPendingEntry: true,
    });
    expect(yes.entrySync).toBe('pushed');
    expect(await w.entryOf(yes)).toMatchObject({
      name: '改名候选人',
      probation: false,
      contractEndDate: '2029-10-31',
      effectiveDate: '2026-11-01',
    });
  });

  it('已发（时机 = 发送时）同样可编辑并同步；Offer 没变化的推送项不白换记录', async () => {
    const w = await syncWorld(testDb().db, 'es-sent');
    await w.timing({ mode: 'on_send' });
    const sent = await w.read((await (await w.send(await w.social())).json()).id);
    const same = await edited(w, sent, { costCenter: 'CC-NEW', syncPendingEntry: true });
    expect(same.entrySync).toBe('unchanged');
    expect((await w.entryOf(same)).id).toBe(sent.pendingEntryBusinessId);
    const moved = await edited(w, same, { plannedEntryDate: '2026-11-30', syncPendingEntry: true });
    expect(moved.entrySync).toBe('pushed');
    expect((await w.entryOf(moved)).effectiveDate).toBe('2026-11-30');
  });

  it('不推送的情形：未同步、已取消入职 → 只保存 Offer（skipped）', async () => {
    const w = await syncWorld(testDb().db, 'es-skip');
    const plain = await w.social();
    const sent = await (await w.send(plain)).json();
    expect((await edited(w, sent, { plannedEntryDate: '2026-12-01', syncPendingEntry: true })).entrySync).toBe(
      'skipped',
    );

    expect(
      (await overrideSetting(w, domain.OFFER_LINKAGE_KEY, { entryCancelRejects: false, reapprovalAllowed: true }))
        .status,
    ).toBe(200);
    const offer = await w.accepted(await w.social());
    expect((await w.entryAction(offer.pendingEntryBusinessId!, 'cancel', {})).status).toBe(200);
    const skipped = await edited(w, await w.read(offer.id), { plannedEntryDate: '2026-12-01', syncPendingEntry: true });
    expect(skipped.entrySync).toBe('skipped');
    expect(await w.entries('cancelled')).toMatchObject([
      { id: offer.pendingEntryBusinessId, effectiveDate: '2026-11-01' },
    ]);
  });

  it('推送被业务规则拒绝（入职日早于部门设立日）：Offer 编辑保留，同步状态失败并记原因，待入职不变；修正后再推送成功', async () => {
    const w = await syncWorld(testDb().db, 'es-fail');
    const offer = await w.accepted(await w.social());
    const failed = await edited(w, offer, { plannedEntryDate: '2025-12-01', syncPendingEntry: true });
    expect(failed).toMatchObject({ entrySync: 'failed', plannedEntryDate: '2025-12-01', syncStatus: 'failed' });
    expect(failed.syncReason).toEqual(expect.any(String));
    expect(await w.entryOf(failed)).toMatchObject({ id: offer.pendingEntryBusinessId, effectiveDate: '2026-11-01' });
    const fixed = await edited(w, failed, { plannedEntryDate: '2026-11-10', syncPendingEntry: true });
    expect(fixed).toMatchObject({ entrySync: 'pushed', syncStatus: 'success', syncReason: null, syncMessage: null });
    expect((await w.entryOf(fixed)).effectiveDate).toBe('2026-11-10');
  });

  it('版本冲突 409；失效 / 已拒绝 / 已入职的 Offer 不能编辑；已发、已接受行操作含 editSync', async () => {
    const w = await syncWorld(testDb().db, 'es-guard');
    const offer = await w.accepted(await w.social());
    const stale = await edit(w, { id: offer.id, revision: offer.revision - 1 }, { costCenter: 'X' });
    expect(stale.status).toBe(409);
    const detail = (await w.get(offer.id)) as OfferBody & { rowActions: { primary: string[] } };
    expect(detail.rowActions.primary).toContain('editSync');
    const rejected = await w.moved(offer, {
      target: 'rejected',
      refusalTime: '2026-10-18',
      refusalReasonCode: 'personal',
    });
    const denied = await edit(w, rejected, { costCenter: 'X' });
    expect((await errorOf(denied)).details).toMatchObject({ reason: 'OFFER_NOT_EDITABLE' });
  });
});
