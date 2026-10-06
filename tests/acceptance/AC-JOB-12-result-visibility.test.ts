import { expect, it } from 'vitest';
import { MODULE_OBJECTS } from '@italent/domain';
import { fixture, profile } from './AC-JOB-permission-support.js';
import { addMember, grant, setObjectPermission } from './AC-PRM-support.js';
import { now } from './AC-JOB-sequence-support.js';
import { runSequenceSyncJobs } from '../../apps/api/src/modules/job/sequence-worker.js';

async function reader() {
  const s = await fixture();
  const w = s.permissions;
  const p = await profile(w);
  const user = await addMember(w, '同步回执查看人');
  expect((await grant(w, user.id, p.id)).status).toBe(201);
  expect(
    (
      await w.api.request('PUT', `/api/tenant/permission/profiles/${p.id}/data-scopes/TenantBase`, {
        ...w.asAdmin,
        ifMatch: 0,
        body: { targetKind: 'entity', targetCode: MODULE_OBJECTS.jobPost.code, seeAll: true },
      })
    ).status,
  ).toBe(200);
  const as = { user: user.id, tenant: w.tenant.id };
  let scopeRevision = 0;
  const scope = async (orgIds: string[]) => {
    const response = await w.api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
      ...w.asAdmin,
      ifMatch: scopeRevision,
      body: { kind: 'org_range', orgRanges: orgIds.map((orgId) => ({ orgId, includeDescendants: false })) },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    scopeRevision++;
  };
  const submit = async (change = false) => {
    const response = change
      ? await w.api.request('PATCH', `/api/tenant/job/posts/${s.target.id}`, {
          ...as,
          ifMatch: 1,
          body: { sequenceId: s.nextSequence.id, effectiveDate: '2026-10-05' },
        })
      : await w.api.request('POST', '/api/tenant/job/posts/sync-sequence', {
          ...as,
          ifMatch: 0,
          body: { items: [{ id: s.target.id, revision: 1 }] },
        });
    expect(response.status, await response.clone().text()).toBe(change ? 200 : 202);
    expect(await runSequenceSyncJobs(s.db, w.tenant.id, { clock: () => now })).toMatchObject({
      completed: 1,
      failed: 0,
    });
  };
  const receipts = async (count: number, skipped: { recordId: string; reason: string }[]) => {
    const response = await w.api.request('GET', '/api/tenant/job/sequence-sync/messages', as);
    expect(response.status).toBe(200);
    const { items } = await response.json();
    expect(items).toHaveLength(1);
    const task = await w.api.request('GET', `/api/tenant/job/sequence-sync/tasks/${items[0].message.taskId}`, as);
    expect(task.status).toBe(200);
    const result = await task.json();
    for (const receipt of [items[0].message, result.result]) {
      expect.soft(receipt.count).toBe(count);
      expect.soft(receipt.skipped).toEqual(expect.arrayContaining(skipped));
      expect.soft(receipt.skipped).toHaveLength(skipped.length);
    }
    return JSON.stringify({ items, result });
  };
  return { ...s, w, p, user, as, scope, submit, receipts };
}

it('AC-JOB-12 相同序列、任职范围为空：任务详情与完成通知均不泄露 UNCHANGED 目标', async () => {
  const s = await reader();
  const detail = await s.w.api.request('GET', `/api/tenant/employment/records/${s.current.id}`, s.as);
  expect(detail.status).toBe(404);
  await s.submit();
  const text = await s.receipts(0, []);
  for (const id of [s.current.id, s.future.id, s.employee.id]) expect(text).not.toContain(id);
  expect(text).not.toContain('UNCHANGED');
});

it('AC-JOB-12 相同序列、部分可见：两个接口只返回可见目标的跳过原因，完成后撤范围立即隐藏', async () => {
  const s = await reader();
  const outside = await s.world.org('范围外部门');
  const hidden = await s.world.hire('范围外员工', {
    departmentId: outside.id,
    postId: s.target.id,
    sequenceId: s.oldSequence.id,
  });
  await s.scope([s.org.id]);
  await s.submit();
  const text = await s.receipts(
    0,
    [s.current, s.future].map((r) => ({ recordId: r.id, reason: 'UNCHANGED' })),
  );
  expect(text).not.toContain(hidden.id);
  await s.scope([]);
  expect(await s.receipts(0, [])).not.toContain(s.current.id);
});

it.each(['范围', '字段'])('AC-JOB-12 完成后撤销%s权限，两接口按可见结果重算计数', async (revocation) => {
  const s = await reader();
  const outside = await s.world.org('随后撤权部门');
  await s.world.hire('随后撤权员工', { departmentId: outside.id, postId: s.target.id, sequenceId: s.oldSequence.id });
  await s.scope([s.org.id, outside.id]);
  await s.submit(true);
  await s.receipts(3, []);
  if (revocation === '范围') {
    await s.scope([s.org.id]);
    await s.receipts(2, []);
    await s.scope([]);
    await s.receipts(0, []);
    return;
  }
  const definition = MODULE_OBJECTS.employmentRecord;
  expect(
    (
      await setObjectPermission(
        s.w,
        s.p,
        {
          dataOperations: { create: false, update: false, delete: false },
          fields: definition.fields
            .filter((f) => f.code !== 'sequenceId')
            .map((f) => ({ fieldCode: f.code, view: true, edit: false })),
          buttons: [],
        },
        definition.code,
      )
    ).status,
  ).toBe(200);
  await s.receipts(0, []);
});
