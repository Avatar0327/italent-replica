/**
 * F-192a 取消入职对齐（后端；DEC-546 / DEC-548 / DEC-550，docs/02_业务建模/34 EN-R9）：
 * ①取消不传原因默认“其他原因”（other），写进动作日志与审计；
 * ②Offer 联动出站端口（BE-14 接）：取消 → onEntryCancelled，已取消改期恢复 → onEntryRestored，同事务、抛错整笔回滚；
 * ③入站端口 cancelPendingEntryForOfferRefusal：复用取消内核，不再回调 onEntryCancelled；
 * ④失效 Offer 删除待入职（F-171 端口）：记录删除、不进“已取消入职”。
 * 用桩登记端口验证调用次数与参数；测试时钟 2026-10-01，业务数据均为合成数据。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelPendingEntryForOfferRefusal,
  deletePendingEntry,
} from '../../apps/api/src/modules/employment/entry-actions.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import {
  type EntryOfferHooks,
  registerEntryOfferHooks,
  resetEntryOfferHooksForTest,
} from '../../apps/api/src/modules/employment/entry-offer-hooks.js';
import {
  addPending,
  businessRevision,
  entryAction,
  entryActionRows,
  entryRecords,
  entryWorld,
  portContext,
  type EntryWorld,
} from './AC-EN-BE2a-support.js';

const testDb = useTestDb();
const CANCELLED = 1;
const POSTPONED = 2;

const stub = {
  onEntryCancelled: vi.fn<EntryOfferHooks['onEntryCancelled']>(async () => undefined),
  onEntryRestored: vi.fn<EntryOfferHooks['onEntryRestored']>(async () => undefined),
};
beforeEach(() => {
  stub.onEntryCancelled.mockReset().mockResolvedValue(undefined);
  stub.onEntryRestored.mockReset().mockResolvedValue(undefined);
  registerEntryOfferHooks(stub);
});
afterEach(() => resetEntryOfferHooksForTest());

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
}

async function auditRows(w: EntryWorld, action: string) {
  return withTenant(w.db, w.session.tenant.id, async (tx) =>
    rowsOf<{ objectId: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>(
      await tx.execute(sql`SELECT object_id AS "objectId", before, after FROM audit_events
        WHERE tenant_id=${w.session.tenant.id} AND action=${action} ORDER BY occurred_at, id`),
    ),
  );
}

async function ledgerCount(w: EntryWorld): Promise<number> {
  return withTenant(w.db, w.session.tenant.id, async (tx) =>
    Number(
      rowsOf<{ n: string }>(
        await tx.execute(sql`SELECT count(*)::text AS n FROM command_ledger WHERE tenant_id=${w.session.tenant.id}`),
      )[0]!.n,
    ),
  );
}

async function outboxCount(w: EntryWorld): Promise<number> {
  return withTenant(w.db, w.session.tenant.id, async (tx) =>
    Number(
      rowsOf<{ n: string }>(
        await tx.execute(sql`SELECT count(*)::text AS n FROM employment_outbox WHERE tenant_id=${w.session.tenant.id}`),
      )[0]!.n,
    ),
  );
}

/** 同命令键（Idempotency-Key）的动作请求：重放要走命令台账（AGENTS §10 幂等）。 */
function keyedAction(
  w: EntryWorld,
  recordId: string,
  action: 'cancel' | 'postpone',
  revision: number,
  body: object,
  key: string,
) {
  return w.session.request('POST', `/pending-entries/${recordId}/${action}`, {
    ifMatch: revision,
    body,
    idempotencyKey: key,
  });
}

async function viewIds(w: EntryWorld, view: string): Promise<string[]> {
  const response = await w.session.request('GET', `/pending-entries?view=${view}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: { id: string }[] }).items.map((item) => item.id);
}

async function cancelOk(w: EntryWorld, recordId: string, body: object = {}) {
  const response = await entryAction(w, recordId, 'cancel', body);
  expect(response.status, await response.clone().text()).toBe(200);
}

describe('F-192a(DEC-546 / DEC-548) 取消入职默认原因（其他原因）', () => {
  it('不传原因：动作日志与审计的原因都是 other；显式原因照旧', async () => {
    const w = await entryWorld(testDb().db, 'f192a-default-reason');
    const first = await addPending(w, '2026-10-10', '默认原因员工');
    await cancelOk(w, first.recordId);
    const second = await addPending(w, '2026-10-11', '显式原因员工');
    await cancelOk(w, second.recordId, { reason: 'personal', remark: '候选人另有安排' });
    // 测试时钟固定，同刻写入的行按随机 ID 排序：按业务 ID 取行
    const actions = await entryActionRows(w);
    expect(actions.find((row) => row.businessId === first.recordId)).toMatchObject({
      action: 'cancel',
      reasonCode: 'other',
      remark: null,
    });
    expect(actions.find((row) => row.businessId === second.recordId)).toMatchObject({
      reasonCode: 'personal',
      remark: '候选人另有安排',
    });
    const audits = await auditRows(w, 'employment.entry.cancel');
    expect(audits.find((row) => row.objectId === first.recordId)?.after).toMatchObject({
      reason: 'other',
      entryStatus: CANCELLED,
    });
    expect(audits.find((row) => row.objectId === second.recordId)?.after).toMatchObject({
      reason: 'personal',
      remark: '候选人另有安排',
    });
  });
});

describe('F-192a(DEC-546 / DEC-548) Offer 联动出站端口', () => {
  it('取消调用 onEntryCancelled 恰好一次；重复取消 409 不再调用', async () => {
    const w = await entryWorld(testDb().db, 'f192a-hook-cancel');
    const { employee, recordId } = await addPending(w);
    await cancelOk(w, recordId, { reason: 'growth' });
    expect(stub.onEntryCancelled).toHaveBeenCalledTimes(1);
    expect(stub.onEntryCancelled.mock.calls[0]![2]).toEqual({ employeeId: employee.id, businessId: recordId });
    expect(stub.onEntryCancelled.mock.calls[0]![1]).toMatchObject({ tenantId: w.session.tenant.id });
    expect((await entryAction(w, recordId, 'cancel', {})).status).toBe(409);
    expect(stub.onEntryCancelled).toHaveBeenCalledTimes(1);
    expect(stub.onEntryRestored).not.toHaveBeenCalled();
  });

  it('端口抛错整笔回滚：记录状态、动作日志、审计、命令台账都不变', async () => {
    const w = await entryWorld(testDb().db, 'f192a-hook-cancel-fail');
    const { employee, recordId } = await addPending(w);
    const ledgerBefore = await ledgerCount(w);
    const auditBefore = (await auditRows(w, 'employment.record.status')).length;
    stub.onEntryCancelled.mockRejectedValue(new Error('offer unavailable'));
    const response = await entryAction(w, recordId, 'cancel', { reason: 'personal' });
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect((await entryRecords(w, employee.id))[0]).toMatchObject({ entryStatus: 0 });
    expect(await entryActionRows(w)).toEqual([]);
    expect(await auditRows(w, 'employment.entry.cancel')).toEqual([]);
    expect((await auditRows(w, 'employment.record.status')).length).toBe(auditBefore);
    expect(await ledgerCount(w)).toBe(ledgerBefore);
  });

  it('已取消 → 改期恢复：调用 onEntryRestored 恰好一次，状态延期，不传日期', async () => {
    const w = await entryWorld(testDb().db, 'f192a-hook-restore');
    const { employee, recordId } = await addPending(w, '2026-10-10');
    await cancelOk(w, recordId);
    const response = await entryAction(w, recordId, 'postpone', { effectiveDate: '2026-09-20', remark: '补办' });
    expect(response.status, await response.clone().text()).toBe(200);
    const [record] = await entryRecords(w, employee.id);
    expect(record).toMatchObject({ entryStatus: POSTPONED, effectiveDate: '2026-09-20' });
    expect(stub.onEntryRestored).toHaveBeenCalledTimes(1);
    const event = stub.onEntryRestored.mock.calls[0]![2];
    expect(event).toEqual({ employeeId: employee.id, businessId: record!.id, previousBusinessId: recordId });
    expect(Object.keys(event)).not.toContain('effectiveDate');
    expect(stub.onEntryCancelled).toHaveBeenCalledTimes(1);
  });

  it('恢复时端口抛错：仍是已取消、原记录保留、不留延期记录', async () => {
    const w = await entryWorld(testDb().db, 'f192a-hook-restore-fail');
    const { employee, recordId } = await addPending(w, '2026-10-10');
    await cancelOk(w, recordId);
    const ledgerBefore = await ledgerCount(w);
    const outboxBefore = await outboxCount(w);
    stub.onEntryRestored.mockRejectedValue(new Error('offer unavailable'));
    const response = await entryAction(w, recordId, 'postpone', { effectiveDate: '2026-10-20' });
    expect(response.status).toBeGreaterThanOrEqual(500);
    const records = await entryRecords(w, employee.id);
    expect(records.map((r) => [r.id, r.entryStatus, r.effectiveDate])).toEqual([[recordId, CANCELLED, '2026-10-10']]);
    expect((await entryActionRows(w)).map((row) => row.action)).toEqual(['cancel']);
    // 回滚到取消完成之后：失败的恢复命令没有留下台账成功条目，也没有多出 outbox 行
    expect(await ledgerCount(w)).toBe(ledgerBefore);
    expect(await outboxCount(w)).toBe(outboxBefore);
  });

  it('未取消的改期、编辑、手动删除都不调用两个端口', async () => {
    const w = await entryWorld(testDb().db, 'f192a-hook-silent');
    const { recordId } = await addPending(w, '2026-10-10');
    const postponed = await entryAction(w, recordId, 'postpone', { effectiveDate: '2026-10-20' });
    expect(postponed.status, await postponed.clone().text()).toBe(200);
    const newId = ((await postponed.json()) as { id: string }).id;
    const edited = await w.session.request('PATCH', `/pending-entries/${newId}`, {
      ifMatch: await businessRevision(w, newId),
      body: { effectiveDate: '2026-10-25', probation: true },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const editedId = ((await edited.json()) as { id: string }).id;
    const removed = await w.session.request('DELETE', `/pending-entries/${editedId}`, {
      ifMatch: await businessRevision(w, editedId),
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(stub.onEntryCancelled).not.toHaveBeenCalled();
    expect(stub.onEntryRestored).not.toHaveBeenCalled();
  });

  it('已取消记录删除、已取消记录编辑也不调用端口', async () => {
    const w = await entryWorld(testDb().db, 'f192a-hook-cancelled-silent');
    const { recordId } = await addPending(w, '2026-10-10');
    await cancelOk(w, recordId);
    stub.onEntryCancelled.mockClear();
    const edited = await w.session.request('PATCH', `/pending-entries/${recordId}`, {
      ifMatch: await businessRevision(w, recordId),
      body: { effectiveDate: '2026-10-12', probation: false },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const editedId = ((await edited.json()) as { id: string }).id;
    const removed = await w.session.request('DELETE', `/pending-entries/${editedId}`, {
      ifMatch: await businessRevision(w, editedId),
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(stub.onEntryCancelled).not.toHaveBeenCalled();
    expect(stub.onEntryRestored).not.toHaveBeenCalled();
  });
});

describe('F-192a(DEC-546 / DEC-548) 同命令重放', () => {
  it('同键重放取消：返回与首次相同，端口只调用一次，动作日志、审计、台账都不增加', async () => {
    const w = await entryWorld(testDb().db, 'f192a-replay-cancel');
    const { recordId } = await addPending(w);
    const revision = await businessRevision(w, recordId);
    const key = randomUUID();
    const body = { reason: 'personal', remark: '候选人另有安排' };
    const first = await keyedAction(w, recordId, 'cancel', revision, body, key);
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBody = await first.json();
    const counts = async () => [
      (await entryActionRows(w)).length,
      (await auditRows(w, 'employment.entry.cancel')).length,
      await ledgerCount(w),
      await outboxCount(w),
    ];
    const before = await counts();
    const replay = await keyedAction(w, recordId, 'cancel', revision, body, key);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(stub.onEntryCancelled).toHaveBeenCalledTimes(1);
    expect(await counts()).toEqual(before);
    expect(before.slice(0, 2)).toEqual([1, 1]);
  });

  it('同键重放“已取消 → 改期恢复”：返回与首次相同，端口只调用一次，不生成第二条延期记录', async () => {
    const w = await entryWorld(testDb().db, 'f192a-replay-restore');
    const { employee, recordId } = await addPending(w, '2026-10-10');
    await cancelOk(w, recordId);
    const revision = await businessRevision(w, recordId);
    const key = randomUUID();
    const body = { effectiveDate: '2026-10-20', remark: '补办' };
    const first = await keyedAction(w, recordId, 'postpone', revision, body, key);
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBody = await first.json();
    const auditBefore = (await auditRows(w, 'employment.entry.postpone')).length;
    expect(auditBefore).toBe(1);
    const actionsBefore = (await entryActionRows(w)).length;
    const ledgerBefore = await ledgerCount(w);
    const outboxBefore = await outboxCount(w);
    const replay = await keyedAction(w, recordId, 'postpone', revision, body, key);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(stub.onEntryRestored).toHaveBeenCalledTimes(1);
    const records = await entryRecords(w, employee.id);
    expect(records.map((r) => [r.entryStatus, r.effectiveDate])).toEqual([[POSTPONED, '2026-10-20']]);
    expect((await entryActionRows(w)).length).toBe(actionsBefore);
    expect((await auditRows(w, 'employment.entry.postpone')).length).toBe(auditBefore);
    expect(await ledgerCount(w)).toBe(ledgerBefore);
    expect(await outboxCount(w)).toBe(outboxBefore);
  });
});

describe('F-192a(DEC-546 / DEC-548) Offer 入站端口', () => {
  it('拒绝已接受 Offer 自动取消入职：进已取消、原因正确、日期不变，且不回调 onEntryCancelled', async () => {
    const w = await entryWorld(testDb().db, 'f192a-offer-refuse');
    const { employee, recordId, business } = await addPending(w, '2026-10-10');
    await withTenant(w.db, w.session.tenant.id, (tx) =>
      cancelPendingEntryForOfferRefusal(tx, portContext(w, business.revision), recordId, {
        reason: 'better_offer',
        remark: 'Offer 已拒绝',
      }),
    );
    expect((await entryRecords(w, employee.id))[0]).toMatchObject({
      entryStatus: CANCELLED,
      effectiveDate: '2026-10-10',
    });
    expect(await viewIds(w, 'cancelled')).toEqual([recordId]);
    expect(await entryActionRows(w)).toMatchObject([
      { action: 'cancel', reasonCode: 'better_offer', remark: 'Offer 已拒绝', businessId: recordId },
    ]);
    expect(await auditRows(w, 'employment.entry.cancel')).toMatchObject([
      { objectId: recordId, after: { reason: 'better_offer' } },
    ]);
    expect(stub.onEntryCancelled).not.toHaveBeenCalled();
  });

  it('不传原因记为 other；记录已取消时幂等（不重复写日志）', async () => {
    const w = await entryWorld(testDb().db, 'f192a-offer-refuse-idem');
    const { recordId } = await addPending(w);
    const cancel = async () => {
      const revision = await businessRevision(w, recordId);
      await withTenant(w.db, w.session.tenant.id, (tx) =>
        cancelPendingEntryForOfferRefusal(tx, portContext(w, revision), recordId, {}),
      );
    };
    await cancel();
    await cancel();
    expect(await entryActionRows(w)).toMatchObject([{ action: 'cancel', reasonCode: 'other' }]);
    expect(await entryActionRows(w)).toHaveLength(1);
  });

  // 两层防线各锁一次：对方租户自己的事务（行级安全挡住）；对方租户的 ctx 套在本租户事务上（只剩 SQL 里的租户谓词）
  it.each([
    ['对方租户自己的事务', 'other'],
    ['对方租户 ctx 套在本租户事务上', 'own'],
  ] as const)('跨租户 ctx 取消本租户记录（%s）：被拒 NOT_FOUND，记录、动作日志、审计都不变', async (_name, txOf) => {
    const w = await entryWorld(testDb().db, `f192a-offer-xtenant-${txOf}-a`);
    const other = await entryWorld(testDb().db, `f192a-offer-xtenant-${txOf}-b`);
    const { employee, recordId, business } = await addPending(w, '2026-10-10');
    const txTenant = txOf === 'other' ? other.session.tenant.id : w.session.tenant.id;
    await expect(
      withTenant(w.db, txTenant, (tx) =>
        cancelPendingEntryForOfferRefusal(tx, portContext(other, business.revision), recordId, { reason: 'other' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await entryRecords(w, employee.id))[0]).toMatchObject({ entryStatus: 0 });
    expect(await entryActionRows(w)).toEqual([]);
    expect(await auditRows(w, 'employment.entry.cancel')).toEqual([]);
    expect(await entryActionRows(other)).toEqual([]);
    expect(await auditRows(other, 'employment.entry.cancel')).toEqual([]);
  });

  it('空数据范围 ctx 取消：被拒 NOT_FOUND，记录、动作日志、审计都不变', async () => {
    const w = await entryWorld(testDb().db, 'f192a-offer-empty-scope');
    const { employee, recordId, business } = await addPending(w, '2026-10-10');
    await expect(
      withTenant(w.db, w.session.tenant.id, (tx) =>
        cancelPendingEntryForOfferRefusal(tx, { ...portContext(w, business.revision), scope: EMPTY_SCOPE }, recordId, {
          reason: 'other',
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await entryRecords(w, employee.id))[0]).toMatchObject({ entryStatus: 0 });
    expect(await entryActionRows(w)).toEqual([]);
    expect(await auditRows(w, 'employment.entry.cancel')).toEqual([]);
  });

  it('已办理入职的记录不能被 Offer 拒绝取消', async () => {
    const w = await entryWorld(testDb().db, 'f192a-offer-refuse-hired');
    const { recordId } = await addPending(w, '2026-09-01');
    expect((await entryAction(w, recordId, 'complete', { probation: false })).status).toBe(200);
    const revision = await businessRevision(w, recordId);
    await expect(
      withTenant(w.db, w.session.tenant.id, (tx) =>
        cancelPendingEntryForOfferRefusal(tx, portContext(w, revision), recordId, { reason: 'other' }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'NOT_PENDING_ENTRY' } });
  });
});

describe('F-192a(DEC-546 / DEC-548) 失效 Offer 删除待入职（F-171 端口）', () => {
  it('记录被删除，已取消视图与全部待入职里都查不到，也不触发 Offer 端口', async () => {
    const w = await entryWorld(testDb().db, 'f192a-offer-invalid');
    const { employee, recordId, business } = await addPending(w);
    await withTenant(w.db, w.session.tenant.id, (tx) =>
      deletePendingEntry(tx, portContext(w, business.revision), recordId),
    );
    expect(await entryRecords(w, employee.id)).toEqual([]);
    expect(await viewIds(w, 'cancelled')).toEqual([]);
    expect(await viewIds(w, 'all')).toEqual([]);
    expect(await entryActionRows(w)).toEqual([]);
    expect(stub.onEntryCancelled).not.toHaveBeenCalled();
    expect(stub.onEntryRestored).not.toHaveBeenCalled();
  });
});
