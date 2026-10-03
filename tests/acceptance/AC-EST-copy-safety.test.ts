import { randomUUID } from 'node:crypto';
import { createUser, grantMembership, sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { establishmentSession, type CopyJob } from './AC-EST-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

describe('AC-EST 复制成功幂等与审计失败整批回滚', () => {
  it('入队与执行命令重放只生成一批下期编制和一次结果通知', async () => {
    const session = await establishmentSession(testDb().db, 'est-copy-idempotent');
    const org = await session.create('幂等复制部门');
    const scheme = await session.scheme();
    const source = await session.capacity(org.id, scheme.id, { localCapacity: 7, strictControl: true });
    const key = randomUUID();
    const options = { ifMatch: 0, idempotencyKey: key, body: { capacityIds: [source.id] } };
    const enqueued = await session.request('POST', '/copy-jobs', options);
    expect(enqueued.status).toBe(202);
    const pending = (await enqueued.json()) as CopyJob;
    const replay = await session.request('POST', '/copy-jobs', options);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(pending);
    const executeOptions = { ifMatch: pending.revision, idempotencyKey: randomUUID(), body: {} };
    const executed = await session.request('POST', `/copy-jobs/${pending.id}/execute`, executeOptions);
    expect(executed.status).toBe(200);
    const result = (await executed.json()) as CopyJob;
    expect(result).toMatchObject({ status: 'succeeded', attempts: 1, failureReason: null });
    const executeReplay = await session.request('POST', `/copy-jobs/${pending.id}/execute`, executeOptions);
    expect(executeReplay.status).toBe(200);
    expect(await executeReplay.json()).toEqual(result);
    const next = await session.capacities({ orgId: org.id, periodStart: '2027-01-01' });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ localCapacity: 7, strictControl: true });
    const notices = await session.request('GET', '/notifications');
    expect(notices.status).toBe(200);
    expect(
      ((await notices.json()) as { items: { jobId?: string }[] }).items.filter((item) => item.jobId === pending.id),
    ).toHaveLength(1);
  });

  it('同租户其他成员不能读取复制任务接收人的通知', async () => {
    const { db } = testDb();
    const session = await establishmentSession(db, 'est-copy-notice-scope');
    const org = await session.create('通知隔离部门');
    const scheme = await session.scheme();
    const source = await session.capacity(org.id, scheme.id);
    const enqueued = await session.request('POST', '/copy-jobs', {
      ifMatch: 0,
      body: { capacityIds: [source.id] },
    });
    const pending = (await enqueued.json()) as CopyJob;
    await session.request('POST', `/copy-jobs/${pending.id}/execute`, {
      ifMatch: pending.revision,
      body: {},
    });

    const other = await createUser(db, { email: `other-${randomUUID()}@example.com`, displayName: '其他成员' }, cmd());
    await grantMembership(db, { tenantId: session.tenant.id, userId: other.id, expectedRevision: 0 }, cmd());
    const response = await tenantApi(db).request('GET', '/api/tenant/establishment/notifications', {
      tenant: session.tenant.id,
      user: other.id,
    });
    expect(response.status).toBe(200);
    // D-003：保留接收人隔离断言，并明确有范围但没有通知。
    expect(await response.json()).toEqual({ items: [], hasDataPermission: true });
  });

  it('审计存储拒绝写入时目标编制和任务状态均回滚，恢复后可按原revision执行', async () => {
    const { db } = testDb();
    const session = await establishmentSession(db, 'est-copy-audit');
    const org = await session.create('审计回滚复制部门');
    const scheme = await session.scheme();
    const source = await session.capacity(org.id, scheme.id);
    const enqueued = await session.request('POST', '/copy-jobs', {
      ifMatch: 0,
      body: { capacityIds: [source.id] },
    });
    expect(enqueued.status).toBe(202);
    const pending = (await enqueued.json()) as CopyJob;
    await db.execute(sql`CREATE FUNCTION est_test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit storage unavailable'; END $$`);
    await db.execute(sql`CREATE TRIGGER est_test_fail_audit_trigger
      BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION est_test_fail_audit()`);
    try {
      const failed = await session.request('POST', `/copy-jobs/${pending.id}/execute`, {
        ifMatch: pending.revision,
        body: {},
      });
      expect(failed.status).toBe(500);
      expect(await session.capacities({ orgId: org.id, periodStart: '2027-01-01' })).toEqual([]);
    } finally {
      await db.execute(sql`DROP TRIGGER est_test_fail_audit_trigger ON audit_events`);
      await db.execute(sql`DROP FUNCTION est_test_fail_audit()`);
    }
    const retried = await session.request('POST', `/copy-jobs/${pending.id}/execute`, {
      ifMatch: pending.revision,
      body: {},
    });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(await session.capacities({ orgId: org.id, periodStart: '2027-01-01' })).toHaveLength(1);
  });
});
