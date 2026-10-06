import { randomUUID } from 'node:crypto';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, permissionAdmin } from './AC-APV-support.js';
import { createProfile, setObjectPermission } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/employment';
const formId = 'TenantBase.TransferMultiFormView';
async function fixture() {
  const w = await approvalWorld(database().db, 'manager-round3');
  w.setNow('2026-10-01T01:00:00Z');
  const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
  const a = await w.org('负责组织 A');
  const b = await w.org('负责组织 B');
  const outside = await w.org('范围外组织');
  const manager = await w.person('纯经理', a);
  const employee = await w.person('申请员工', a);
  await w.setOrgRoles(a, { head: manager.employeeId });
  await w.setOrgRoles(b, { head: manager.employeeId });
  const actor = w.as(manager.userId);
  const admin = await permissionAdmin(w);
  const profile = await createProfile(admin, 'department_manager_self_service');
  const definition = MODULE_OBJECTS.employmentRecord;
  const configured = await setObjectPermission(
    admin,
    profile,
    {
      dataOperations: { create: true, update: true, delete: false },
      fields: definition.fields.map((f) => ({ fieldCode: f.code, view: true, edit: !f.system })),
      buttons: ['Transfer.Manager', 'Employment.Preview', 'Employment.Submit', 'Employment.Edit'].map((buttonCode) => ({
        buttonCode,
        level: 'detail' as const,
      })),
    },
    definition.code,
  );
  expect(configured.status).toBe(200);
  const personPermission = await setObjectPermission(
    admin,
    profile,
    {
      dataOperations: { create: false, update: false, delete: false },
      fields: MODULE_OBJECTS.employee.fields.map((f) => ({ fieldCode: f.code, view: true, edit: false })),
      buttons: [],
    },
    MODULE_OBJECTS.employee.code,
  );
  expect(personPermission.status).toBe(200);
  const scope = await admin.api.request('PUT', `/api/tenant/permission/scopes/${manager.userId}/TenantBase`, {
    ...admin.asAdmin,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [a, b, outside].map((orgId) => ({ orgId, includeDescendants: true })) },
  });
  expect(scope.status).toBe(200);
  await w.publishedProcess({ nodes: [{ key: 'owner', approver: 'owner' }] });
  const revision = async () =>
    (await w.json<{ revision: number }>(await w.request(w.hr.id, 'GET', `${BASE}/employees/${employee.employeeId}`)))
      .revision;
  const draft = async (fields: object = { departmentId: b }, form = formId) =>
    w.json<{ id: string; revision: number }>(
      await api.request('POST', `${BASE}/transfers/employees/${employee.employeeId}`, {
        ...actor,
        ifMatch: await revision(),
        body: {
          initiator: 'manager',
          transferTypeCode: 'in_department',
          formId: form,
          effectiveDate: '2026-11-01',
          mode: 'application',
          fields,
        },
      }),
      201,
    );
  const job = async (kind: string, body: object = {}) =>
    (
      await w.json<{ id: string }>(
        await w.request(w.hr.id, 'POST', `/api/tenant/job/${kind}`, {
          ifMatch: 0,
          body: { name: `合成${kind}`, startDate: '2025-01-01', ...body },
        }),
        201,
      )
    ).id;
  return { ...w, api, actor, admin, profile, a, b, outside, employee, manager, draft, revision, job };
}

describe('AC-TRF-41/42 第三轮：同单参照与删除统计', () => {
  it('保存后撤销目标组织负责关系，submit 拒绝；来源仍在负责范围、通用范围仍包含目标', async () => {
    const w = await fixture();
    const saved = await w.draft();
    await w.setOrgRoles(w.b, { head: null });
    const result = await w.api.request('POST', `${BASE}/businesses/${saved.id}/submit`, {
      ...w.actor,
      ifMatch: saved.revision,
      body: {},
    });
    expect(result.status, await result.clone().text()).toBe(403);
    expect(await w.business(saved.id)).toMatchObject({ status: 'draft', revision: saved.revision });
  });

  it('成功 submit 同键重放：撤销目标负责关系后返回 403', async () => {
    const w = await fixture();
    const saved = await w.draft();
    const options = { ...w.actor, ifMatch: saved.revision, body: {}, idempotencyKey: randomUUID() };
    const path = `${BASE}/businesses/${saved.id}/submit`;
    expect((await w.api.request('POST', path, options)).status).toBe(200);
    expect((await w.api.request('POST', path, options)).status).toBe(200);
    await w.setOrgRoles(w.b, { head: null });
    const replay = await w.api.request('POST', path, options);
    expect(replay.status, await replay.clone().text()).toBe(403);
  });

  it.each(['departmentId', 'postId', 'levelId', 'sequenceId', 'directManagerId'] as const)(
    '有 Employment.Edit 但无 HR：PATCH 范围外 %s 被拒，单据不变',
    async (field) => {
      const w = await fixture();
      const saved = await w.draft();
      const postId = await w.job('posts');
      const levelId = await w.job('levels', { level: 9 });
      const sequenceId = await w.job('sequences');
      const directManagerId = (await w.person('范围外经理', w.outside)).employeeId;
      const fields = { [field]: { departmentId: w.outside, postId, levelId, sequenceId, directManagerId }[field] };
      const result = await w.api.request('PATCH', `${BASE}/businesses/${saved.id}`, {
        ...w.actor,
        ifMatch: saved.revision,
        body: { fields },
      });
      expect(result.status, `${JSON.stringify(fields)}: ${await result.clone().text()}`).toBe(403);
      expect(await w.business(saved.id)).toMatchObject({ revision: saved.revision, fields: { departmentId: w.b } });
    },
  );

  it('成功 PATCH 同键重放也复查参照；显式改回范围内部门可以修正旧草稿', async () => {
    const w = await fixture();
    const saved = await w.draft({ departmentId: w.a });
    const path = `${BASE}/businesses/${saved.id}`;
    const options = {
      ...w.actor,
      ifMatch: saved.revision,
      body: { fields: { departmentId: w.b } },
      idempotencyKey: randomUUID(),
    };
    const patched = await w.json<{ revision: number }>(await w.api.request('PATCH', path, options));
    expect((await w.api.request('PATCH', path, options)).status).toBe(200);
    await w.setOrgRoles(w.b, { head: null });
    const replay = await w.api.request('PATCH', path, options);
    expect(replay.status, await replay.clone().text()).toBe(403);
    const repaired = await w.api.request('PATCH', path, {
      ...w.actor,
      ifMatch: patched.revision,
      body: { fields: { departmentId: w.a } },
    });
    expect(repaired.status, await repaired.clone().text()).toBe(200);
  });

  it('只读继承的历史职务不要求仍在候选中，PATCH 与 submit 保留例外', async () => {
    const w = await fixture();
    const oldPost = await w.job('posts'); // 没有负责组织职位引用，不是可选职务。
    await w.json(
      await w.request(w.hr.id, 'POST', `${BASE}/employees/${w.employee.employeeId}/businesses`, {
        ifMatch: await w.revision(),
        body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-02-01', fields: { postId: oldPost } },
      }),
      201,
    );
    await w.json(
      await w.request(w.hr.id, 'PUT', `${BASE}/transfers/forms/${formId}`, {
        ifMatch: 0,
        body: { name: '历史职务只读', group: 'transfer', fieldModes: { 'preset:postId': 'readonly' } },
      }),
    );
    const saved = await w.draft();
    const updated = await w.json<{ revision: number }>(
      await w.api.request('PATCH', `${BASE}/businesses/${saved.id}`, {
        ...w.actor,
        ifMatch: saved.revision,
        body: { effectiveDate: '2026-12-01' },
      }),
    );
    const submitted = await w.api.request('POST', `${BASE}/businesses/${saved.id}/submit`, {
      ...w.actor,
      ifMatch: updated.revision,
      body: {},
    });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    expect(await w.business(saved.id)).toMatchObject({ status: 'in_review', fields: { postId: oldPost } });
  });

  it('删除离职草稿后，离职中计数 / 列表 / 在岗标记均清除；其他未删除草稿仍计入', async () => {
    const w = await fixture();
    const leave = await w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', `${BASE}/employees/${w.employee.employeeId}/businesses`, {
        ifMatch: await w.revision(),
        body: {
          kind: 'leave',
          mode: 'application',
          effectiveDate: '2026-12-01',
          lastWorkDate: '2026-11-30',
          fields: {},
        },
      }),
      201,
    );
    const team = async (category: string) =>
      w.json<{ items: { id: string; leaving: boolean }[]; counts: { leaving: number } }>(
        await w.api.request('GET', `${BASE}/transfers/manager/team?category=${category}`, w.actor),
      );
    expect((await team('leaving')).counts.leaving).toBe(1);
    expect((await team('active')).items.find((e) => e.id === w.employee.employeeId)?.leaving).toBe(true);
    const removed = await w.request(w.hr.id, 'DELETE', `${BASE}/businesses/${leave.id}`, { ifMatch: leave.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
    const after = await team('leaving');
    expect(after.counts.leaving).toBe(0);
    expect(after.items.map((e) => e.id)).not.toContain(w.employee.employeeId);
    expect((await team('active')).items.find((e) => e.id === w.employee.employeeId)?.leaving).toBe(false);
  });
});

async function removeManagerEntry(w: Awaited<ReturnType<typeof fixture>>) {
  const result = await setObjectPermission(
    w.admin,
    w.profile,
    {
      dataOperations: { create: true, update: true, delete: false },
      fields: MODULE_OBJECTS.employmentRecord.fields.map((f) => ({ fieldCode: f.code, view: true, edit: !f.system })),
      buttons: ['Employment.Preview', 'Employment.Submit', 'Employment.Edit'].map((buttonCode) => ({
        buttonCode,
        level: 'detail' as const,
      })),
    },
    MODULE_OBJECTS.employmentRecord.code,
  );
  expect(result.status).toBe(200);
  expect(await w.json(await w.api.request('GET', `${BASE}/transfers/manager`, w.actor))).toMatchObject({
    identity: 'department_manager',
    canApply: false,
    canViewReporting: false,
  });
}

describe('AC-TRF-41 第四轮：撤除经理入口不能关闭范围检查', () => {
  it('只移除 Transfer.Manager 后，越界 PATCH 仍拒绝且单据不变', async () => {
    const w = await fixture();
    const saved = await w.draft();
    const path = `${BASE}/businesses/${saved.id}`;
    const options = { ...w.actor, ifMatch: saved.revision, body: { fields: { departmentId: w.outside } } };
    expect((await w.api.request('PATCH', path, options)).status).toBe(403);
    await removeManagerEntry(w);
    const result = await w.api.request('PATCH', path, options);
    expect(result.status, await result.clone().text()).toBe(403);
    expect(await w.business(saved.id)).toMatchObject({ revision: saved.revision, fields: { departmentId: w.b } });
  });

  it.each(['a', 'b'] as const)('移除按钮并撤销组织 %s 负责关系，来源或目标越界的提交均拒绝', async (org) => {
    const w = await fixture();
    const saved = await w.draft();
    await w.setOrgRoles(w[org], { head: null });
    await removeManagerEntry(w);
    const result = await w.api.request('POST', `${BASE}/businesses/${saved.id}/submit`, {
      ...w.actor,
      ifMatch: saved.revision,
      body: {},
    });
    expect(result.status, await result.clone().text()).toBe(403);
    expect(await w.business(saved.id)).toMatchObject({ revision: saved.revision, status: 'draft' });
  });

  it.each(['PATCH', 'submit'] as const)('成功 %s 原键重放在移除经理入口后拒绝', async (action) => {
    const w = await fixture();
    const saved = await w.draft({ departmentId: w.a });
    const method = action === 'PATCH' ? 'PATCH' : 'POST';
    const path = `${BASE}/businesses/${saved.id}${action === 'submit' ? '/submit' : ''}`;
    const options = {
      ...w.actor,
      ifMatch: saved.revision,
      body: action === 'PATCH' ? { fields: { departmentId: w.b } } : {},
      idempotencyKey: randomUUID(),
    };
    expect((await w.api.request(method, path, options)).status).toBe(200);
    expect((await w.api.request(method, path, options)).status).toBe(200);
    const before = await w.business(saved.id);
    await removeManagerEntry(w);
    const replay = await w.api.request(method, path, options);
    expect(replay.status, await replay.clone().text()).toBe(403);
    expect(await w.business(saved.id)).toEqual(before);
  });
});
