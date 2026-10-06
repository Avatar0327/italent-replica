import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { runEmploymentActivations } from '@italent/api';
import { scenario, worker, now } from './AC-JOB-sequence-support.js';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';
const testDb = useTestDb();
it('AC-JOB-08 DEC-218 同步不改审批实例，真实审批仍可通过并以新序列生效', async () => {
  const { db } = testDb();
  const s = await scenario(db);
  await installApprovalFallbacks(db, s.world.tenant.id, s.world.user.id);
  const employee = await s.world.getEmployee(s.employee.id);
  const draft = await s.world.business(
    s.employee.id,
    {
      kind: 'transfer',
      mode: 'application',
      effectiveDate: '2026-10-15',
      fields: { postId: s.target.id, sequenceId: s.oldSequence.id },
    },
    employee.revision,
  );
  expect(
    (await s.world.request('POST', `/businesses/${draft.id}/submit`, { ifMatch: draft.revision, body: {} })).status,
  ).toBe(200);
  const snapshot = () =>
    withTenant(db, s.world.tenant.id, async (tx) =>
      resultRows<{ instance: { id: string; revision: number }; taskId: string; userId: string }>(
        await tx.execute(sql`
 SELECT to_jsonb(i) AS instance,t.id AS "taskId",t.assignee_user_id AS "userId" FROM approval_instances i
 JOIN approval_tasks t ON t.tenant_id=i.tenant_id AND t.instance_id=i.id AND t.status='pending'
 WHERE i.business_id=${draft.id}::uuid`),
      ),
    );
  const before = await snapshot();
  expect(before).toHaveLength(1);
  expect(
    (await s.call('PATCH', `posts/${s.target.id}`, { sequenceId: s.nextSequence.id, effectiveDate: '2026-10-05' }, 1))
      .status,
  ).toBe(200);
  await worker(db, s.world.tenant.id);
  expect(await snapshot()).toEqual(before);
  const task = before[0]!;
  const api = tenantApi(db, { clock: () => now });
  const response = await api.request('POST', `/api/tenant/approval/tasks/${task.taskId}/approve`, {
    user: task.userId,
    tenant: s.world.tenant.id,
    ifMatch: task.instance.revision,
    body: { comment: '同意' },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  await runEmploymentActivations(
    db,
    cmd(),
    { tenantId: s.world.tenant.id },
    { clock: () => new Date('2026-10-15T01:00:00Z') },
  );
  expect((await s.world.record(draft.id)).fields.sequenceId).toBe(s.nextSequence.id);
});
