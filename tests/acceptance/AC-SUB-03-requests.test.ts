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
  const items = (await (await s.request('GET', s.path('education'))).json()) as {
    items: { id: string; revision: number }[];
  };
  expect(items).toMatchObject({ items: [{ school: '申请大学', sourceType: 'self_service', sourceId: request.id }] });
  const applied = items.items[0] as { id: string; revision: number };
  const edited = await s.request('PATCH', `${s.path('education')}/${applied.id}`, {
    ifMatch: applied.revision,
    body: { school: 'HR复核大学' },
  });
  expect(await edited.json()).toMatchObject({ sourceType: 'hr_direct', sourceId: null });
  expect(await (await s.request('GET', `${s.path('education')}/${applied.id}/history`)).json()).toMatchObject({
    items: [
      { sourceType: 'hr_direct', sourceId: null },
      { sourceType: 'self_service', sourceId: request.id },
    ],
  });
});

it('AC-SUB-01 客户端不能伪造系统来源字段', async () => {
  const s = await personnelSession(database().db);
  expect(
    (
      await s.request('POST', s.path('education'), {
        ifMatch: 0,
        body: { school: '合成大学', sourceType: 'self_service', sourceId: randomUUID() },
      })
    ).status,
  ).toBe(400);
});

it('自助申请绑定本人；不同 patch 的同键请求冲突；目标版本过期不部分落地', async () => {
  const db = database().db;
  const s = await personnelSession(db);
  const payload = { employeeId: s.employee.id, subset: 'education', values: { school: '申请大学' } };
  expect((await s.request('POST', '/change-requests', { ifMatch: 0, body: payload })).status).toBe(404);
  await withTenant(db, s.tenant.id, (tx) =>
    tx.execute(sql`INSERT INTO permission_user_person_links
    (tenant_id,user_id,employee_id) VALUES(${s.tenant.id},${s.user.id},${s.employee.id})`),
  );
  const item = await s.add('education', { school: '原始值' });
  const body = { ...payload, recordId: item.id, targetRevision: item.revision };
  const key = randomUUID();
  const first = await s.request('POST', '/change-requests', { ifMatch: 0, body, idempotencyKey: key });
  expect(first.status).toBe(201);
  const request = (await first.json()) as { id: string; revision: number };
  expect(
    (
      await s.request('POST', '/change-requests', {
        ifMatch: 0,
        body: { ...body, values: { school: '另一个内容' } },
        idempotencyKey: key,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await s.request('PATCH', `${s.path('education')}/${item.id}`, {
        ifMatch: 1,
        body: { school: 'HR新值' },
      })
    ).status,
  ).toBe(200);
  const { applyApprovedChange } = await import('../../apps/api/src/modules/personnel/change-requests.js');
  const ctx = {
    tenantId: s.tenant.id,
    userId: s.user.id,
    timezone: s.tenant.timezone,
    commandId: randomUUID(),
    expectedRevision: request.revision,
    now: new Date('2026-10-01T01:00:00Z'),
  };
  await expect(applyApprovedChange(db, ctx, request.id)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await (await s.request('GET', `/change-requests/${request.id}`)).json()).toMatchObject({
    status: 'pending_approval',
    revision: 1,
  });
  expect(await (await s.request('GET', `${s.path('education')}/${item.id}`)).json()).toMatchObject({
    school: 'HR新值',
    sourceType: 'hr_direct',
  });
  await withTenant(db, s.tenant.id, (tx) =>
    tx.execute(sql`DELETE FROM permission_user_person_links
    WHERE tenant_id=${s.tenant.id} AND user_id=${s.user.id}`),
  );
  expect((await s.request('POST', '/change-requests', { ifMatch: 0, body, idempotencyKey: key })).status).toBe(404);
});
