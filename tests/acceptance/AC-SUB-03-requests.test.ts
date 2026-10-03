import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { personnelSession } from './AC-SUB-support.js';
const database = useTestDb();

it('AC-SUB-03 自助申请先待审批，可信审批完成后来源为申请 ID，重复执行不重复写入', async () => {
  const db = database().db;
  const s = await personnelSession(db);
  await withTenant(db, s.tenant.id, (tx) =>
    tx.execute(sql`INSERT INTO permission_user_person_links
    (tenant_id,user_id,employee_id) VALUES(${s.tenant.id},${s.user.id},${s.employee.id})`),
  );
  const response = await s.request('POST', '/change-requests', {
    ifMatch: 0,
    body: { employeeId: s.employee.id, subset: 'education', values: { school: '申请大学', educationLevel: '硕士' } },
  });
  expect(response.status).toBe(201);
  const request = (await response.json()) as { id: string; revision: number };
  expect(request).toMatchObject({ status: 'pending_approval' });
  expect(await (await s.request('GET', s.path('education'))).json()).toMatchObject({ items: [] });
  expect((await s.request('POST', `/change-requests/${request.id}/approve`, { ifMatch: 1 })).status).toBe(404);
  const { applyApprovedChange } = await import('../../apps/api/src/modules/personnel/change-requests.js');
  const ctx = {
    tenantId: s.tenant.id,
    userId: s.user.id,
    timezone: s.tenant.timezone,
    commandId: randomUUID(),
    expectedRevision: request.revision,
    now: new Date('2026-10-01T01:00:00Z'),
  };
  const first = await applyApprovedChange(db, ctx, request.id);
  expect(await applyApprovedChange(db, ctx, request.id)).toEqual(first);
  const items = await (await s.request('GET', s.path('education'))).json();
  expect(items).toMatchObject({ items: [{ school: '申请大学', sourceType: 'self_service', sourceId: request.id }] });
});
