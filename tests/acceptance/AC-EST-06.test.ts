import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { establishmentSession, type CopyJob } from './AC-EST-support.js';

const testDb = useTestDb();

describe('AC-EST-06 复制下期具有持久异步边界并整批回滚', () => {
  it('一行目标周期已有编制，执行后failed并通知原因，另一行也不生成', async () => {
    const session = await establishmentSession(testDb().db, 'est06');
    const first = await session.create('复制可用部门');
    const conflicting = await session.create('复制冲突部门');
    const scheme = await session.scheme();
    const sources = await Promise.all([
      session.capacity(first.id, scheme.id),
      session.capacity(conflicting.id, scheme.id),
    ]);
    await session.capacity(conflicting.id, scheme.id, { periodStart: '2027-01-01', localCapacity: 20 });
    const before = await session.capacities({ periodStart: '2027-01-01' });

    const enqueued = await session.request('POST', '/copy-jobs', {
      ifMatch: 0,
      body: { capacityIds: sources.map((item) => item.id) },
    });
    expect(enqueued.status).toBe(202);
    const pending = (await enqueued.json()) as CopyJob;
    expect(pending).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await session.capacities({ periodStart: '2027-01-01' })).toEqual(before);

    const executed = await session.request('POST', `/copy-jobs/${pending.id}/execute`, {
      ifMatch: pending.revision,
      body: {},
    });
    expect(executed.status).toBe(200);
    const failed = (await executed.json()) as CopyJob;
    expect(failed).toMatchObject({ id: pending.id, status: 'failed', attempts: 1 });
    expect(failed.failureReason).toBeTruthy();
    expect(await session.capacities({ periodStart: '2027-01-01' })).toEqual(before);

    const notifications = await session.request('GET', '/notifications');
    expect(notifications.status).toBe(200);
    expect(((await notifications.json()) as { items: unknown[] }).items).toContainEqual(
      expect.objectContaining({ jobId: pending.id, status: 'pending', reason: failed.failureReason }),
    );
  });
});
