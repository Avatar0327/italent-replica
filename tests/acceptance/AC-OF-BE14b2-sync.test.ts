/**
 * BE-14b2 Offer 同步待入职（34 OF-R1 / R8 / R10、文末字段映射；AC-OF-04 / 06 / 10 / 12、AC-EN-08 Offer 侧；F-201 ①②）。
 * 同步经 createEmploymentBusiness 的 pendingEntry 通道；失败（含严格控编超编）记在 Offer 上，不回滚“接受”；
 * 夜间补同步按租户时区的业务日判定。
 */
import * as domain from '@italent/domain';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runOfferSyncSweep } from '../../apps/api/src/modules/offer/sync-scheduler.js';
import { findOfferByPendingEntry } from '../../apps/api/src/modules/offer/sync.js';
import { errorOf, offerRealWorld } from './AC-OF-BE14a-support.js';
import { fullSocial, syncWorld } from './AC-OF-BE14b2-support.js';

const testDb = useTestDb();
const rows = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
const at = (day: string) => ({ clock: () => new Date(`${day}T04:00:00.000Z`) });

describe('OF-R8 同步时机设置与判定（纯函数）', () => {
  const offer = (status: string, plannedEntryDate: string) => ({ status, plannedEntryDate });
  it('出厂默认：开，接受时，30 天，在职实习生 Offer 同步开；取值校验拒绝非法值', () => {
    expect(domain.OFFER_SYNC_DEFAULT).toEqual({ enabled: true, mode: 'on_accept', days: 30, internConversion: true });
    const ok = domain.OFFER_SYNC_DEFAULT;
    expect(domain.validOfferSyncSetting(ok)).toBe(true);
    for (const bad of [{ ...ok, mode: 'never' }, { ...ok, days: 0 }, { ...ok, days: 91 }, { ...ok, enabled: 1 }, null])
      expect(domain.validOfferSyncSetting(bad)).toBe(false);
  });

  it('按时机判定该不该自动同步', () => {
    const set = (mode: string, extra = {}) => ({ ...domain.OFFER_SYNC_DEFAULT, mode, ...extra }) as never;
    const due = (setting: never, status: string, date: string) =>
      domain.offerSyncDue(setting, offer(status, date), '2026-10-17');
    expect(due(set('on_send'), 'sent', '2027-01-01')).toBe(true);
    expect(due(set('on_send'), 'pending', '2027-01-01')).toBe(false);
    expect(due(set('on_accept'), 'sent', '2026-10-18')).toBe(false);
    expect(due(set('on_accept'), 'accepted', '2027-01-01')).toBe(true);
    expect(due(set('on_accept_within_days'), 'accepted', '2026-12-01')).toBe(false); // 45 天
    expect(due(set('on_accept_within_days'), 'accepted', '2026-11-16')).toBe(true); // 恰好 30 天
    expect(due(set('on_accept_within_days'), 'accepted', '2026-10-01')).toBe(true); // 日期已过
    expect(due(set('on_accept', { enabled: false }), 'accepted', '2026-10-18')).toBe(false);
  });

  it('同步类型（OF-R1，DEC-532⑤）：社招 / 校招 = 内部员工 + 劳动合同，实习 = 实习生 + 实习协议', () => {
    expect(domain.offerSyncKind('social')).toEqual({ employType: 'internal', contractKind: 'labor' });
    expect(domain.offerSyncKind('campus')).toEqual({ employType: 'internal', contractKind: 'labor' });
    expect(domain.offerSyncKind(null)).toEqual({ employType: 'internal', contractKind: 'labor' });
    expect(domain.offerSyncKind('intern')).toEqual({ employType: 'intern', contractKind: 'internship_agreement' });
  });
});

describe('AC-OF-10 / AC-EN-08 接受时同步', () => {
  it('同步时机 = 接受时：接受后出现待入职，部门 / 计划入职日 / 职级 / 上级 / 试用期 / 合同日期带入', async () => {
    const w = await syncWorld(testDb().db, 'sync-accept');
    const offer = await fullSocial(w);
    const after = await w.accepted(offer);
    expect(after).toMatchObject({
      status: 'accepted',
      syncStatus: 'success',
      syncReason: null,
      syncMessage: null,
      syncAttempts: 1,
      hasPendingEntry: true,
      syncedContractKind: 'labor',
    });
    expect(after.pendingEntryBusinessId).toEqual(expect.any(String));
    const entry = await w.entryOf(after);
    expect(entry).toMatchObject({
      name: '合成候选人',
      effectiveDate: '2026-11-01',
      employeeStatus: 1,
      departmentId: w.department.id,
      probation: true,
      contractStartDate: '2026-11-01',
      contractEndDate: '2028-10-31',
    });
    const record = await w.record(entry.id);
    expect(record.fields).toMatchObject({
      employType: 'internal',
      departmentId: w.department.id,
      levelId: w.level.id,
      directManagerId: w.manager.id,
      place: '上海',
    });
    const [person] = rows<{ name: string; id_number: string; mobile_phone: string; email: string; gender: string }>(
      await withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT name, id_number, mobile_phone, email, gender FROM personnel_employee_versions
          WHERE employee_id = ${entry.employeeId}::uuid ORDER BY revision DESC LIMIT 1`),
      ),
    );
    expect(person).toMatchObject({ name: '合成候选人', mobile_phone: '13800000000', gender: 'male' });
    expect(person!.email).toBe(offer.personalEmail);
    const [audit] = rows<{ n: number }>(
      await withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE object_id = ${offer.id}
          AND action = 'offer.sync'`),
      ),
    );
    expect(audit!.n).toBe(1);
  });

  it('接受前不同步；转已拒绝 / 其他状态不触发同步', async () => {
    const w = await syncWorld(testDb().db, 'sync-none');
    const offer = await w.social();
    expect(await w.read(offer.id)).toMatchObject({ syncStatus: null, hasPendingEntry: false, syncAttempts: 0 });
    expect(await w.entries()).toHaveLength(0);
  });

  it('同步开关关闭：接受后不同步；手动“立即同步”成功', async () => {
    const w = await syncWorld(testDb().db, 'sync-manual');
    await w.timing({ enabled: false });
    const offer = await w.social();
    const accepted = await w.accepted(offer);
    expect(accepted).toMatchObject({ syncStatus: null, hasPendingEntry: false });
    expect(await w.entries()).toHaveLength(0);
    const synced = await w.synced(accepted);
    expect(synced).toMatchObject({ syncStatus: 'success', hasPendingEntry: true, syncAttempts: 1 });
    expect(synced.revision).toBe(accepted.revision + 1);
    expect(await w.entries()).toHaveLength(1);
  });
});

describe('AC-OF-12 社招与实习各同步一次', () => {
  it('社招 = 内部员工 + 劳动合同；实习 = 实习生 + 实习协议', async () => {
    const w = await syncWorld(testDb().db, 'sync-kinds');
    const social = await w.accepted(await w.social());
    const intern = await w.accepted(await w.intern({ contractEndDate: '2027-04-30' }));
    expect(social).toMatchObject({ syncStatus: 'success', syncedContractKind: 'labor' });
    expect(intern).toMatchObject({ syncStatus: 'success', syncedContractKind: 'internship_agreement' });
    expect((await w.record(social.pendingEntryBusinessId!)).fields.employType).toBe('internal');
    expect((await w.record(intern.pendingEntryBusinessId!)).fields.employType).toBe('intern');
    expect(await w.entryOf(intern)).toMatchObject({ contractStartDate: '2026-11-01', contractEndDate: '2027-04-30' });
  });
});

describe('AC-OF-04 接受且距入职日 ≤ N 天：夜间补同步', () => {
  it('接受时距入职 49 天不同步；夜间任务到距 30 天那天同步，之后重复跑不再生成', async () => {
    const w = await syncWorld(testDb().db, 'sync-nightly');
    await w.timing({ mode: 'on_accept_within_days', days: 30 });
    const offer = await w.social({ plannedEntryDate: '2026-12-05' });
    const accepted = await w.accepted(offer);
    expect(accepted).toMatchObject({ syncStatus: null, hasPendingEntry: false });

    const early = await runOfferSyncSweep(w.db, at('2026-11-04'));
    expect(early.synced).toEqual([]);
    expect(await w.read(offer.id)).toMatchObject({ syncStatus: null, hasPendingEntry: false });

    const due = await runOfferSyncSweep(w.db, at('2026-11-05'));
    expect(due.synced).toEqual([offer.id]);
    const done = await w.read(offer.id);
    expect(done).toMatchObject({ syncStatus: 'success', hasPendingEntry: true, syncAttempts: 1 });

    expect((await runOfferSyncSweep(w.db, at('2026-11-06'))).synced).toEqual([]);
    expect(await w.entries()).toHaveLength(1);
  });

  it('接受时已在 30 天内：当场同步', async () => {
    const w = await syncWorld(testDb().db, 'sync-within');
    await w.timing({ mode: 'on_accept_within_days', days: 30 });
    const accepted = await w.accepted(await w.social({ plannedEntryDate: '2026-11-10' }));
    expect(accepted).toMatchObject({ syncStatus: 'success', hasPendingEntry: true });
  });

  it('夜间任务只处理自己租户到期的 Offer；已失败的当天不重复重试，次日重试', async () => {
    const w = await syncWorld(testDb().db, 'sync-retry-day');
    await w.timing({ mode: 'on_accept_within_days', days: 90 });
    const capacity = await w.strictCapacity();
    const accepted = await w.accepted(await w.social());
    expect(accepted).toMatchObject({ syncStatus: 'failed', syncAttempts: 1 });
    await w.relaxCapacity(capacity);
    expect((await runOfferSyncSweep(w.db, at('2026-10-17'))).synced).toEqual([]); // 同一业务日不重试
    expect((await runOfferSyncSweep(w.db, at('2026-10-18'))).synced).toEqual([accepted.id]);
    expect(await w.read(accepted.id)).toMatchObject({ syncStatus: 'success', syncAttempts: 2, syncReason: null });
  });
});

describe('AC-OF-06 严格控编超编：接受成功，同步失败', () => {
  it('接受成功；同步失败记原因、次数；未生成待入职也未建人员；放开控编后手动重试成功', async () => {
    const w = await syncWorld(testDb().db, 'sync-strict');
    const capacity = await w.strictCapacity();
    const offer = await w.social();
    const accepted = await w.accepted(offer);
    expect(accepted).toMatchObject({
      status: 'accepted',
      syncStatus: 'failed',
      syncReason: 'ESTABLISHMENT_EXCEEDED',
      syncAttempts: 1,
      hasPendingEntry: false,
    });
    expect(accepted.syncMessage).toEqual(expect.any(String));
    expect(await w.entries()).toHaveLength(0);
    const [created] = rows<{ n: number }>(
      await withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT count(*)::int AS n FROM employment_employees WHERE code LIKE 'OFR-%'`),
      ),
    );
    expect(created!.n).toBe(0);

    await w.relaxCapacity(capacity);
    const retried = await w.synced(accepted);
    expect(retried).toMatchObject({ syncStatus: 'success', syncReason: null, syncMessage: null, syncAttempts: 2 });
    expect(await w.entries()).toHaveLength(1);
  });
});

describe('立即同步：状态守卫、幂等、版本', () => {
  it('待发 / 已拒绝 / 失效 / 已发（非发送时机）不能同步 → 409 OFFER_SYNC_STATE_INVALID', async () => {
    const w = await syncWorld(testDb().db, 'sync-guard');
    const pending = await w.social();
    for (const [offer, status] of [
      [pending, 'pending'],
      [await w.social(), 'sent'],
      [await w.social(), 'rejected'],
      [await w.social(), 'invalid'],
    ] as const) {
      if (status !== 'pending') await w.force(offer.id, 'status', status);
      const current = await w.read(offer.id);
      const response = await w.sync(current);
      expect(response.status, status).toBe(409);
      expect((await errorOf(response)).details).toMatchObject({ reason: 'OFFER_SYNC_STATE_INVALID' });
    }
    expect(await w.entries()).toHaveLength(0);
  });

  it('同步时机 = 发送时：已发 Offer 可立即同步', async () => {
    const w = await syncWorld(testDb().db, 'sync-on-send');
    await w.timing({ mode: 'on_send' });
    const offer = await w.social();
    await w.force(offer.id, 'status', 'sent');
    expect(await w.synced(await w.read(offer.id))).toMatchObject({ syncStatus: 'success', hasPendingEntry: true });
  });

  it('已同步后再点同步：幂等，不再生成待入职，revision 不变；revision 过期 → 409', async () => {
    const w = await syncWorld(testDb().db, 'sync-idem');
    const first = await w.accepted(await w.social());
    const again = await w.synced(first);
    expect(again).toMatchObject({ pendingEntryBusinessId: first.pendingEntryBusinessId, syncAttempts: 1 });
    expect(again.revision).toBe(first.revision);
    expect(await w.entries()).toHaveLength(1);
    const stale = await w.sync(first, first.revision - 1);
    expect(stale.status).toBe(409);
  });
});

describe('OF-R8 关联在职实习生', () => {
  it('只能关联实习生；在职实习生的 Offer 同步开关关闭时不同步（改走实习转正），解除关联后可同步', async () => {
    const w = await syncWorld(testDb().db, 'sync-intern');
    await w.timing({ internConversion: false });
    const offer = await w.social();
    const link = (employeeId: string | null) =>
      w.request('POST', `/${offer.id}/link-employee`, { ifMatch: 1, body: { employeeId } });
    const notIntern = await w.internEmployee('在职内部员工', 'internal');
    const refused = await link(notIntern.id);
    expect(refused.status).toBe(400);
    expect((await errorOf(refused)).details).toMatchObject({ reason: 'OFFER_LINK_NOT_INTERN' });

    const intern = await w.internEmployee('在职实习生');
    const linked = await link(intern.id);
    expect(linked.status, await linked.clone().text()).toBe(200);
    expect(await linked.json()).toMatchObject({ linkedEmployeeId: intern.id, revision: 2 });

    const accepted = await w.accepted({ id: offer.id, revision: 2 });
    expect(accepted).toMatchObject({ syncStatus: null, hasPendingEntry: false });
    const blocked = await w.sync(accepted);
    expect(blocked.status).toBe(409);
    expect((await errorOf(blocked)).details).toMatchObject({ reason: 'OFFER_SYNC_INTERN_CONVERSION' });

    const unlink = await w.request('POST', `/${offer.id}/link-employee`, {
      ifMatch: accepted.revision,
      body: { employeeId: null },
    });
    expect(unlink.status).toBe(409); // 只有待发 / 已发的 Offer 可改关联
    expect((await errorOf(unlink)).details).toMatchObject({ reason: 'OFFER_LINK_NOT_ALLOWED' });
  });
});

describe('F-201 ① Offer 与待入职的关联', () => {
  it('取消不换 ID；改期恢复换新 ID 时端口更新关联；普通改期靠记录链找到最新记录；按待入职反查 Offer', async () => {
    const w = await syncWorld(testDb().db, 'sync-link');
    const synced = await w.accepted(await w.social());
    const first = synced.pendingEntryBusinessId!;
    const cancelled = await w.entryAction(first, 'cancel', {});
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    // 取消入职的联动（改 Offer 状态）归 b3：本单 Offer 仍是已接受，关联不变
    expect(await w.read(synced.id)).toMatchObject({ status: 'accepted', pendingEntryBusinessId: first });

    const restored = await w.entryAction(first, 'postpone', { effectiveDate: '2026-11-15' });
    expect(restored.status, await restored.clone().text()).toBe(200);
    const second = ((await restored.json()) as { id: string }).id;
    expect(second).not.toBe(first);
    expect(await w.read(synced.id)).toMatchObject({ status: 'accepted', pendingEntryBusinessId: second });
    const [stored] = rows<{ pending_entry_business_id: string }>(
      await withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT pending_entry_business_id FROM offers WHERE id = ${synced.id}`),
      ),
    );
    expect(stored!.pending_entry_business_id).toBe(second);

    const ordinary = await w.entryAction(second, 'postpone', { effectiveDate: '2026-11-20' });
    expect(ordinary.status, await ordinary.clone().text()).toBe(200);
    const third = ((await ordinary.json()) as { id: string }).id;
    expect(await w.read(synced.id)).toMatchObject({ pendingEntryBusinessId: third });

    const found = await withTenant(w.db, w.tenant.id, (tx) => findOfferByPendingEntry(tx, w.tenant.id, third));
    expect(found).toMatchObject({ id: synced.id });
    const none = await withTenant(w.db, w.tenant.id, (tx) =>
      findOfferByPendingEntry(tx, w.tenant.id, '00000000-0000-4000-8000-000000000000'),
    );
    expect(none).toBeNull();
  });
});

describe('F-201 ② 入站调用带受控上下文：招聘专员无人员范围也能同步，且受 Offer 自身权限约束', () => {
  it('只有 Offer 范围的成员立即同步成功；范围外 Offer 404；无编辑权 403', async () => {
    const w = await syncWorld(testDb().db, 'sync-scope', await offerRealWorld(testDb().db, 'sync-scope'));
    await w.timing({ enabled: false });
    const offer = await w.accepted(await w.social());
    const response = await w.real('POST', `/${offer.id}/sync`, { ifMatch: offer.revision, body: {} });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ syncStatus: 'success', hasPendingEntry: true });
    expect(await w.entries()).toHaveLength(1);

    const other = await w.accepted(await w.social());
    await w.force(other.id, 'department_id', await outsideDepartment(w));
    const hidden = await w.real('POST', `/${other.id}/sync`, { ifMatch: other.revision, body: {} });
    expect(hidden.status).toBe(404);

    await w.dropUpdate();
    const third = await w.accepted(await w.social());
    const denied = await w.real('POST', `/${third.id}/sync`, { ifMatch: third.revision, body: {} });
    expect(denied.status).toBe(403);
  });
});

/** 范围外部门（offerRealWorld 建了一个但没返回 ID）：另建一个。 */
async function outsideDepartment(w: Awaited<ReturnType<typeof syncWorld>>): Promise<string> {
  const response = await w.seeder.request('POST', '/api/tenant/org/organizations', {
    user: w.user.id,
    tenant: w.tenant.id,
    ifMatch: 0,
    body: { name: `范围外同步部门-${crypto.randomUUID()}`, parents: { admin: { parentId: w.tenant.id } } },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}
