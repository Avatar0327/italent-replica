import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import {
  createProfile,
  makeGrantable,
  grant,
  setObjectPermission,
  addMember,
  type PermissionWorld,
} from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { auditApi } from './AC-AUD-support.js';
import { scenario, worker, versions, now } from './AC-JOB-sequence-support.js';
import { allowAll, cmd, tenantApi } from './support/tenant-api.js';
import { runSequenceSyncJobs } from '../../apps/api/src/modules/job/sequence-worker.js';
const testDb = useTestDb();
async function fixture() {
  const { db } = testDb();
  const s = await scenario(db);
  const adminRecord = await bootstrapTenantAdmin(db, { tenantId: s.world.tenant.id, userId: s.world.user.id }, cmd());
  const world: PermissionWorld = {
    db,
    tenant: s.world.tenant,
    admin: s.world.user,
    adminRecord,
    api: tenantApi(db, { authorize: undefined, clock: () => now }),
    asAdmin: { tenant: s.world.tenant.id, user: s.world.user.id },
  };
  return { ...s, db, permissions: world };
}
async function profile(world: PermissionWorld, button = true) {
  const profile = await createProfile(world, `sync-${randomUUID()}`);
  for (const definition of [MODULE_OBJECTS.jobPost, MODULE_OBJECTS.employmentRecord]) {
    const result = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: true, delete: false },
        fields: definition.fields.map((field) => ({ fieldCode: field.code, view: true, edit: !field.system })),
        buttons: definition === MODULE_OBJECTS.jobPost && button ? [{ buttonCode: 'syncSequence', level: 'list' }] : [],
      },
      definition.code,
    );
    expect(result.status, await result.clone().text()).toBe(200);
  }
  await makeGrantable(world, [profile.id]);
  return profile;
}
it('AC-JOB-11 真实授权器：列表按钮拒绝，入队后字段撤权/成员撤销均整单失败', async () => {
  const s = await fixture();
  const w = s.permissions;
  const p = await profile(w, false);
  const user = await addMember(w, '真实同步发起人');
  expect((await grant(w, user.id, p.id)).status).toBe(201);
  expect(
    (
      await w.api.request('PUT', `/api/tenant/permission/profiles/${p.id}/data-scopes/TenantBase`, {
        ...w.asAdmin,
        ifMatch: 0,
        body: { targetKind: 'app', targetCode: '', seeAll: true },
      })
    ).status,
  ).toBe(200);
  const submit = () =>
    w.api.request('POST', '/api/tenant/job/posts/sync-sequence', {
      user: user.id,
      tenant: w.tenant.id,
      ifMatch: 0,
      body: { items: [{ id: s.target.id, revision: 1 }] },
    });
  expect((await submit()).status).toBe(403);
  const definition = MODULE_OBJECTS.jobPost;
  expect(
    (
      await setObjectPermission(
        w,
        p,
        {
          dataOperations: { create: false, update: true, delete: false },
          fields: definition.fields.map((f) => ({ fieldCode: f.code, view: true, edit: !f.system })),
          buttons: [{ buttonCode: 'syncSequence', level: 'list' }],
        },
        definition.code,
      )
    ).status,
  ).toBe(200);
  // 来源序列与任职不同，且不提前创建同步任务。
  expect(
    (
      await s.world.request('PATCH', `/records/${s.current.id}`, {
        ifMatch: s.current.revision,
        body: { fields: { sequenceId: s.nextSequence.id } },
      })
    ).status,
  ).toBe(200);
  expect((await submit()).status).toBe(202);
  const before = await versions(s.db, w.tenant.id, s.employee.id);
  const employment = MODULE_OBJECTS.employmentRecord;
  expect(
    (
      await setObjectPermission(
        w,
        p,
        {
          dataOperations: { create: false, update: true, delete: false },
          fields: employment.fields.map((f) => ({
            fieldCode: f.code,
            view: true,
            edit: !f.system && f.code !== 'sequenceId',
          })),
          buttons: [],
        },
        employment.code,
      )
    ).status,
  ).toBe(200);
  expect(await runSequenceSyncJobs(s.db, w.tenant.id, { clock: () => now })).toMatchObject({ failed: 1 });
  expect(await versions(s.db, w.tenant.id, s.employee.id)).toEqual(before);
  expect(
    (await w.api.request('POST', `/api/tenant/permission/users/${user.id}/remove`, { ...w.asAdmin, ifMatch: 1 }))
      .status,
  ).toBe(200);
  expect(await runSequenceSyncJobs(s.db, w.tenant.id, { clock: () => now })).toMatchObject({ failed: 1 });
  expect(await versions(s.db, w.tenant.id, s.employee.id)).toEqual(before);
});
it('AC-JOB-10 真实审计查看：按逐条归属裁剪任务计数，隐藏序列字段后差异与任务均不可见', async () => {
  const s = await fixture();
  const w = s.permissions;
  const outside = await s.world.org('不可见归属');
  const hidden = await s.world.hire('不可见员工', {
    departmentId: outside.id,
    postId: s.target.id,
    sequenceId: s.oldSequence.id,
  });
  await s.world.business(
    hidden.id,
    {
      kind: 'org_adjustment',
      mode: 'direct',
      effectiveDate: '2026-10-12',
      fields: { departmentId: outside.id, postId: s.target.id, sequenceId: s.oldSequence.id },
    },
    hidden.revision,
  );
  const key = randomUUID();
  expect(
    (
      await s.call(
        'PATCH',
        `posts/${s.target.id}`,
        { sequenceId: s.nextSequence.id, effectiveDate: '2026-10-05' },
        1,
        key,
      )
    ).status,
  ).toBe(200);
  await worker(s.db, w.tenant.id, allowAll, { clock: () => new Date('2026-10-13T01:00:00Z') });
  const viewer = await memberWithAdminRole(w, 'audit_admin', '日志查看人');
  const p = await profile(w);
  expect((await grant(w, viewer.user.id, p.id)).status).toBe(201);
  expect(
    (
      await w.api.request('PUT', `/api/tenant/permission/scopes/${viewer.user.id}/TenantBase`, {
        ...w.asAdmin,
        ifMatch: 0,
        body: { kind: 'org_range', orgRanges: [{ orgId: s.org.id, includeDescendants: false }] },
      })
    ).status,
  ).toBe(200);
  const api = auditApi(s.db, '2026-10-13T01:00:00Z', { authorize: undefined });
  const as = { user: viewer.user.id, tenant: w.tenant.id };
  const query = { commandId: key, objectType: 'job-sequence-sync' };
  expect((await api.operationLogs(as, query)).items).toEqual([
    expect.objectContaining({
      totalCount: 2,
      successCount: 1,
      failureCount: 1,
      objectLabel: '任职序列同步任务',
      errorReport: [expect.objectContaining({ errorCode: 'BECAME_HISTORICAL' })],
    }),
  ]);
  expect(
    (await api.dataChanges(as, { commandId: key, objectType: 'employment-record', field: 'sequenceId' })).items,
  ).toHaveLength(1);
  // 请求/完成事件的全量目标数组不能通过数据变更接口泄露。
  expect((await api.dataChanges(as, query)).items).toEqual([]);
  const definition = MODULE_OBJECTS.employmentRecord;
  expect(
    (
      await setObjectPermission(
        w,
        p,
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
  expect((await api.operationLogs(as, query)).items).toEqual([]);
  expect((await api.dataChanges(as, { commandId: key, objectType: 'employment-record' })).items).toEqual([]);
});
