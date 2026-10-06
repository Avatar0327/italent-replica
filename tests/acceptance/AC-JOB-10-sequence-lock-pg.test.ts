/** 真 PG 锁屏障：同步必须在员工锁后重读快照，不覆盖并发更正，也不与职务外键 KEY SHARE 成环。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { editEmploymentRecord } from '../../apps/api/src/modules/employment/record-edit.js';
import { runSequenceSyncJobs } from '../../apps/api/src/modules/job/sequence-worker.js';
import { orgPeopleWorld, resultRows } from './AC-ORG-people-support.js';
import { allowAll } from './support/tenant-api.js';
const database = useTestDb();
async function waitForEmployeeLock(db: Db) {
  for (let i = 0; i < 200; i++) {
    const [row] = resultRows<{ count: number }>(
      await db.execute(sql`
      SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query LIKE '%employment_employees%'`),
    );
    if (Number(row?.count) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('同步任务没有等待员工锁');
}
it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  'AC-JOB-10 同步与任职更正交错，员工→业务锁顺序且不丢新字段',
  async () => {
    const { db } = database();
    const world = await orgPeopleWorld(db, 'f021pg');
    const org = await world.org('部门');
    const old = await world.job('sequences', '旧序列');
    const next = await world.job('sequences', '新序列');
    const post = await world.job('posts', '职务', { sequenceId: old.id });
    const employee = await world.hire('员工', { departmentId: org.id, postId: post.id, sequenceId: old.id });
    expect(
      (
        await world.call('PATCH', `job/posts/${post.id}`, {
          ifMatch: 1,
          body: { sequenceId: next.id, effectiveDate: '2026-10-01' },
        })
      ).status,
    ).toBe(200);
    const now = new Date('2026-10-01T02:00:00Z');
    let pending: ReturnType<typeof runSequenceSyncJobs> | undefined;
    await withTenant(db, world.tenant.id, async (tx) => {
      await tx.execute(sql`SELECT id FROM employment_employees WHERE tenant_id=${world.tenant.id}
      AND id=${employee.id}::uuid FOR NO KEY UPDATE`);
      pending = runSequenceSyncJobs(db, world.tenant.id, { clock: () => now, authorize: allowAll });
      await waitForEmployeeLock(db);
      await tx.execute(sql`SELECT id FROM job_post_objects WHERE tenant_id=${world.tenant.id}
      AND id=${post.id}::uuid FOR KEY SHARE`);
      await editEmploymentRecord(
        tx,
        {
          tenantId: world.tenant.id,
          userId: world.user.id,
          timezone: world.tenant.timezone,
          now,
          commandId: randomUUID(),
          expectedRevision: 1,
        },
        employee.recordId,
        { fields: { place: '并发写入的新地点' } },
      );
    });
    expect(await pending).toMatchObject({ completed: 1, failed: 0 });
    expect((await world.record(employee.recordId)).fields).toMatchObject({
      sequenceId: next.id,
      place: '并发写入的新地点',
    });
  },
);
