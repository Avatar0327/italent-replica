import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { scenario, versions } from './AC-JOB-sequence-support.js';
import { resultRows } from './AC-ORG-people-support.js';
const testDb = useTestDb();
it('AC-JOB-11 1001条候选整体拒绝，职务版本、任职版本与任务均不残留', async () => {
  const { db } = testDb();
  const s = await scenario(db);
  // 批量准备真实表中的999条审批中载荷，加现有当前/未来2条。避免用1001次HTTP建档掩盖边界断言。
  await withTenant(db, s.world.tenant.id, async (tx) => {
    await tx.execute(sql`CREATE TEMP TABLE f021_many(id uuid) ON COMMIT DROP`);
    await tx.execute(sql`INSERT INTO f021_many SELECT gen_random_uuid() FROM generate_series(1,999)`);
    await tx.execute(
      sql`INSERT INTO employment_business_objects(id,tenant_id,employee_id)
      SELECT id,${s.world.tenant.id},${s.employee.id}
      FROM f021_many`,
    );
    await tx.execute(sql`INSERT INTO employment_payload_versions
      SELECT (jsonb_populate_record(NULL::employment_payload_versions,
     to_jsonb(p)||jsonb_build_object('id',f.id,'business_id',f.id,'version_no',1,'previous_version_id',NULL,
       'command_id',NULL,'trigger_business_id',NULL,'is_record_snapshot',false,
      'mode','application','kind','transfer','effective_date','2026-10-20'))).*

      FROM f021_many f CROSS JOIN LATERAL (SELECT * FROM employment_payload_versions
      WHERE tenant_id=${s.world.tenant.id} AND business_id=${s.current.id}::uuid ORDER BY version_no DESC LIMIT 1) p`);
    await tx.execute(sql`INSERT INTO employment_state_events
      (tenant_id,employee_id,business_id,payload_version_id,state,event_no,command_id)
     SELECT ${s.world.tenant.id},${s.employee.id},id,id,'in_review',1,'fixture-1001' FROM f021_many`);
  });
  const before = await versions(db, s.world.tenant.id, s.employee.id);
  expect(
    (await s.call('PATCH', `posts/${s.target.id}`, { sequenceId: s.nextSequence.id, effectiveDate: '2026-10-05' }, 1))
      .status,
  ).toBe(413);
  expect((await s.call('POST', 'posts/sync-sequence', { items: [{ id: s.target.id, revision: 1 }] })).status).toBe(413);
  expect(await versions(db, s.world.tenant.id, s.employee.id)).toEqual(before);
  expect(await (await s.call('GET', `posts/${s.target.id}?asOf=2026-10-05`)).json()).toMatchObject({
    revision: 1,
    sequenceId: s.oldSequence.id,
  });
  await withTenant(db, s.world.tenant.id, async (tx) =>
    expect(
      resultRows(
        await tx.execute(sql`SELECT id FROM employment_outbox WHERE event_type='job.sequence-sync.requested'`),
      ),
    ).toEqual([]),
  );
});
