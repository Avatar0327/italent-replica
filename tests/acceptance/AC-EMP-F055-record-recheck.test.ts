/**
 * F-055（R3-T02 拆分方案 §10.2 ②）：recheckRecordEvent 三态——处理时按“当前”时间轴复核记录是否仍有效。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { f055World } from './AC-EMP-F055-support.js';

const database = useTestDb();

describe('F-055 recheckRecordEvent', () => {
  it('未到期 not_yet（带当前生效日）；到期 effective（带记录）', async () => {
    const w = await f055World(database().db, 'f055-recheck-basic');
    const id = await w.transfer('2026-10-05');
    expect(await w.recheck(id, '2026-10-04')).toEqual({ kind: 'not_yet', effectiveDate: '2026-10-05' });
    const due = await w.recheck(id, '2026-10-05');
    expect(due.kind).toBe('effective');
    if (due.kind === 'effective') expect(due.record).toMatchObject({ id, effectiveDate: '2026-10-05' });
  });

  it('到期前删除 → gone；删除后到期日当天与之后仍是 gone', async () => {
    const w = await f055World(database().db, 'f055-recheck-deleted');
    const id = await w.transfer('2026-10-05');
    await w.remove(id);
    for (const day of ['2026-10-02', '2026-10-05', '2026-11-01'])
      expect(await w.recheck(id, day)).toEqual({ kind: 'gone', reason: 'RECORD_NOT_EFFECTIVE' });
  });

  it('撤销：未生效的申请被 HR 撤销，从未上过时间轴 → gone', async () => {
    const w = await f055World(database().db, 'f055-recheck-revoked');
    const application = await w.apply(w.subject.employee.id, '2026-10-20', { departmentId: w.to.id });
    const revoked = await w.session.request('POST', `/businesses/${application.id}/revoke`, {
      ifMatch: (await w.business(application.id)).revision,
    });
    expect(revoked.status).toBe(200);
    expect(await w.recheck(application.id, '2026-10-21')).toEqual({ kind: 'gone', reason: 'RECORD_NOT_EFFECTIVE' });
  });

  it('改期后返回新的 not_yet 日期；改到今天或更早则变为 effective', async () => {
    const w = await f055World(database().db, 'f055-recheck-moved');
    const id = await w.transfer('2026-10-20');
    expect(await w.recheck(id, '2026-10-10')).toEqual({ kind: 'not_yet', effectiveDate: '2026-10-20' });
    await w.moveTimeline(id, '2026-10-30');
    expect(await w.recheck(id, '2026-10-25')).toEqual({ kind: 'not_yet', effectiveDate: '2026-10-30' });
    await w.moveTimeline(id, '2026-10-08');
    expect((await w.recheck(id, '2026-10-10')).kind).toBe('effective');
  });

  it('跨租户记录 ID 读不到 → gone（不泄露存在性）', async () => {
    const database_ = database().db;
    const mine = await f055World(database_, 'f055-recheck-tenant-a');
    const theirs = await f055World(database_, 'f055-recheck-tenant-b');
    const id = await theirs.transfer('2026-10-05');
    expect((await theirs.recheck(id, '2026-10-05')).kind).toBe('effective');
    expect(await mine.recheck(id, '2026-10-05')).toEqual({ kind: 'gone', reason: 'RECORD_NOT_EFFECTIVE' });
  });

  it('非 UUID 的记录标识被拒绝', async () => {
    const w = await f055World(database().db, 'f055-recheck-invalid');
    await expect(w.recheck('not-a-uuid', '2026-10-05')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
