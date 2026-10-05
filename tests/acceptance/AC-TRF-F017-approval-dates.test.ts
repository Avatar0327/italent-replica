import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { approvalWorld, transferScene } from './AC-APV-support.js';
const database = useTestDb();
it.each([true, false])('DEC-195 完成详情日期披露=%s，不改实例快照', async (showDate) => {
  const w = await approvalWorld(database().db, 'f017-r2-dates');
  const scene = await transferScene(w);
  await w.publishedProcess({
    nodes: [
      { key: 'owner', approver: 'owner', formFields: showDate ? ['effectiveDate', 'departmentId'] : ['departmentId'] },
    ],
  });
  const draft = await w.application(
    scene.subject.employeeId,
    { departmentId: scene.to },
    { effectiveDate: '2026-10-05' },
  );
  const instance = await w.submit(draft);
  const snapshot = () =>
    withTenant(w.db, w.tenant.id, async (tx) => {
      const result = await tx.execute(
        sql`SELECT to_jsonb(v), (SELECT to_jsonb(p) FROM employment_payload_versions p
          WHERE p.tenant_id=i.tenant_id AND p.business_id=i.business_id AND p.version_no=1) AS submitted_payload
        FROM approval_process_versions v
        JOIN approval_instances i ON i.tenant_id=v.tenant_id AND i.version_id=v.id
        WHERE i.tenant_id=${w.tenant.id} AND i.id=${instance.id}::uuid`,
      );
      return Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
    });
  const before = await snapshot();
  w.setNow('2026-10-08T01:00:00Z');
  const task = instance.tasks.find((t) => t.status === 'pending')!;
  const response = await w.taskAction(task.assigneeUserId, task.id, 'approve', instance.revision, {});
  expect(response.status, await response.clone().text()).toBe(200);
  const detail = await w.detail(instance.id);
  if (showDate)
    expect(detail.form.values).toMatchObject({
      originalEffectiveDate: '2026-10-05',
      actualEffectiveDate: '2026-10-08',
    });
  if (!showDate) {
    expect(detail.form.values).not.toHaveProperty('originalEffectiveDate');
    expect(detail.form.values).not.toHaveProperty('actualEffectiveDate');
  }
  expect(await snapshot()).toEqual(before);
});
