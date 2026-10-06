/** F-007 与 F-021：组织调整复制最新任职载荷；员工锁包含待执行调动的下属闭包。 */
import { useTestDb } from '@italent/testkit';
import { sql, withTenant } from '@italent/db';
import { expect, it } from 'vitest';
import { scenario, worker, versions } from './AC-JOB-sequence-support.js';
import { activationWorld } from './AC-TRF-activation-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { lockOrgEmploymentTargets } from '../../apps/api/src/modules/org/employment-linkage.js';

const database = useTestDb();
it.each([false, true])('AC-ORG-37 序列同步与组织调整两种顺序均保留追加历史（先同步=%s）', async (syncFirst) => {
  const db = database().db;
  const s = await scenario(db);
  const sync = async () => {
    const response = await s.call(
      'PATCH',
      `posts/${s.target.id}`,
      {
        sequenceId: s.nextSequence.id,
        effectiveDate: '2026-10-05',
        syncSequenceToAssignments: true,
      },
      1,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await worker(db, s.world.tenant.id)).toMatchObject({ completed: 1, failed: 0 });
  };
  if (syncFirst) await sync();
  const response = await s.world.patchOrg(s.org, {
    name: '组织同步组合改名',
    effectiveDate: '2026-10-09',
    addEmployment: true,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  if (!syncFirst) await sync();
  const records = await s.world.records(s.employee.id, '2026-10-09');
  const adjustment = records.find((r) => r.isCurrent)!;
  expect(adjustment).toMatchObject({
    effectiveDate: '2026-10-09',
    stopDate: '2026-10-11',
    fields: { sequenceId: s.nextSequence.id },
  });
  expect(records.find((r) => r.id === s.future.id)?.fields.sequenceId).toBe(s.nextSequence.id);
  expect(records.find((r) => r.id === s.employee.recordId)?.fields.sequenceId).toBe(s.oldSequence.id);
  const history = await versions(db, s.world.tenant.id, s.employee.id);
  expect(history.find((r) => r.businessId === adjustment.id)?.count).toBe(syncFirst ? 1 : 2);
  const beforeRetry = await versions(db, s.world.tenant.id, s.employee.id);
  await worker(db, s.world.tenant.id);
  expect(await versions(db, s.world.tenant.id, s.employee.id)).toEqual(beforeRetry);
});

it('AC-ORG-34 组织联动预锁待执行调动的参与员工闭包', async () => {
  const w = await activationWorld(database().db, 'org34closure');
  const person = await w.hired('组织员工');
  const subordinate = await w.hired('未来下属');
  await w.session.business(
    person.employee.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-15',
      fields: { departmentId: w.to.id, addedSubordinateIds: [subordinate.employee.id] },
    },
    person.hire.employeeRevision,
  );
  await withTenant(w.db, w.session.tenant.id, async (tx) => {
    const ctx = {
      tenantId: w.session.tenant.id,
      userId: w.session.user.id,
      timezone: 'Asia/Shanghai',
      now: new Date('2026-10-01T01:00:00Z'),
      commandId: 'org-closure',
      expectedRevision: 0,
    };
    // 10-16 只有主员工在调入组织，闭包仍须包含未来下属。
    const targets = await lockOrgEmploymentTargets(tx, ctx, w.to.id, '2026-10-16');
    expect(targets).toEqual([person.employee.id]);
    const [row] = resultRows<{ value: string | null }>(
      await tx.execute(sql`SELECT current_setting('italent.transfer_employee_locks', true) AS value`),
    );
    expect(JSON.parse(row?.value || '[]')).toEqual([person.employee.id, subordinate.employee.id].sort());
  });
});
