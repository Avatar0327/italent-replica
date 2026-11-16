import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { tenantApi } from './support/tenant-api.js';
import { signWorld, SIGN_AT, rows } from './AC-TRF-F481-s2-support.js';

const database = useTestDb();
it('AC-TRF-F481-06 真实审批 HTTP：他人批准当天生效，签署发起人仍为提交人', async () => {
  const w = await signWorld(database().db, '06-http');
  const business = await w.saved(await w.transfer(w.person, { linkage: w.linkage() }));
  const [task] = await withTenant(w.db, w.tenantId, async (tx) =>
    rows<{ id: string; userId: string; revision: number }>(
      await tx.execute(sql`SELECT t.id,t.assignee_user_id AS "userId",i.revision
      FROM approval_tasks t JOIN approval_instances i ON i.tenant_id=t.tenant_id AND i.id=t.instance_id
      WHERE t.tenant_id=${w.tenantId} AND i.business_type='employment'
        AND i.business_id=${business.id}::uuid AND t.status='pending'`),
    ),
  );
  expect(task).toBeDefined();
  expect(task!.userId).not.toBe(w.session.user.id);
  const api = tenantApi(w.db, { clock: () => new Date(SIGN_AT) });
  const response = await api.request('POST', `/api/tenant/approval/tasks/${task!.id}/approve`, {
    user: task!.userId,
    tenant: w.tenantId,
    ifMatch: task!.revision,
    body: {},
  });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await w.tasks()).toEqual([
    expect.objectContaining({ status: 'signing', businessId: business.id, initiatorUserId: w.session.user.id }),
  ]);
  expect(await w.notices()).toEqual([]);
});
