import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { approvalWorld, type Person } from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/self-service';
let world: Awaited<ReturnType<typeof approvalWorld>>;
let api: ReturnType<typeof tenantApi>;
let department: string;
let self: Person;
let other: Person;
const request = (path: string, method = 'GET', body?: unknown, revision?: number, user = self.userId) =>
  api.request(method, `${BASE}${path}`, { ...world.as(user), body, ifMatch: revision });
const input = () => ({ effectiveDate: '2026-10-19', fields: { departmentId: department } });

beforeAll(async () => {
  world = await approvalWorld(database().db, 'employee-self-service');
  api = tenantApi(database().db, { authorize: undefined, clock: world.clock });
  department = await world.org('合成部门');
  self = await world.person('本人', department, { place: '权限外地址' });
  other = await world.person('其他员工', department);
  await world.publishedProcess({ nodes: [{ key: 'owner_review', approver: 'owner' }] });
});

describe('R1-T13 员工自助（真实授权器、无员工授权行）', () => {
  it('AC-TRF-37：自动获得本人只读档案；大小写 UUID 统一，其他人不可读', async () => {
    const profile = await world.json<Record<string, unknown>>(await request('/profile'));
    expect(profile).toMatchObject({ employee: { id: self.employeeId, name: '本人' } });
    expect(JSON.stringify(profile)).not.toContain('权限外地址');
    expect((await request(`/employees/${self.employeeId.toUpperCase()}/records`)).status).toBe(200);
    expect((await request(`/employees/${other.employeeId}/records`)).status).toBe(403);
    expect((await request('/profile', 'PATCH', { name: '伪造姓名' })).status).toBe(404);
    const unbound = await world.member('未绑定员工');
    expect((await request('/profile', 'GET', undefined, undefined, unbound)).status).toBe(403);
  });

  it('AC-TRF-38：代发起在途与作废记录保留，原任职结束日期不截断，我的申请不列代发起', async () => {
    const draft = await world.application(
      self.employeeId,
      { departmentId: department },
      { effectiveDate: '2026-10-20' },
    );
    await world.submit(draft);
    const list = () => request(`/employees/${self.employeeId}/records`);
    const pending = await world.json<{ items: Record<string, unknown>[] }>(await list());
    expect(pending.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: draft.id, approvalStatus: '审批中', stopDate: null }),
        expect.objectContaining({ kind: 'hire', stopDate: '9999-12-31' }),
      ]),
    );
    expect(pending.items.every((row) => !Object.hasOwn(row, 'actions'))).toBe(true);
    const current = await world.business(draft.id);
    await world.json(
      await world.request(world.hr.id, 'POST', `/api/tenant/employment/businesses/${draft.id}/revoke`, {
        ifMatch: current.revision,
        body: {},
      }),
    );
    const voided = await world.json<{ items: Record<string, unknown>[] }>(await list());
    expect(voided.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: draft.id, approvalStatus: '作废' })]),
    );
    const applications = await world.json<{ items: { businessId: string }[] }>(await request('/applications'));
    expect(applications.items.some((item) => item.businessId === draft.id)).toBe(false);
  });

  it('AC-TRF-01/39：同一 HR 表单按身份裁剪；日期与新部门必填，拒绝越权字段与直接调动', async () => {
    const preview = await world.json<{ form: { id: string; fieldModes: Record<string, string> }; fields: object }>(
      await request('/transfer/preview', 'POST', input()),
    );
    expect(preview.form.id).toBe('TenantBase.TransferMultiFormView');
    expect(Object.keys(preview.form.fieldModes).sort()).toEqual([
      'preset:departmentId',
      'preset:directManagerId',
      'preset:levelId',
      'preset:postId',
      'preset:sequenceId',
    ]);
    expect(preview.fields).toHaveProperty('departmentId', department);
    for (const body of [
      { ...input(), fields: {} },
      { ...input(), fields: { remarks: '越权写入' } },
      { ...input(), mode: 'direct' },
      { ...input(), employeeId: other.employeeId },
      { fields: {} },
    ]) {
      expect([400, 403]).toContain(
        (
          await request(
            '/transfer',
            'POST',
            body,
            (await world.json<{ employee: { revision: number } }>(await request('/profile'))).employee.revision,
          )
        ).status,
      );
    }
    const saved = await world.json<{ id: string; status: string }>(
      await request(
        '/transfer',
        'POST',
        input(),
        (await world.json<{ employee: { revision: number } }>(await request('/profile'))).employee.revision,
      ),
      201,
    );
    expect(saved.status).toBe('in_review');
    const instance = await world.instanceOf(saved.id, self.userId);
    expect(
      instance.tasks.filter((task) => task.status === 'pending').every((task) => task.assigneeUserId !== self.userId),
    ).toBe(true);
    expect(instance.tasks.some((task) => task.isExceptionAdmin)).toBe(true);
  });

  it('AC-TRF-40：我的申请表格列、只读详情；HR撤销后已终止且无当前处理人', async () => {
    const list = await world.json<{
      items: { id: string; businessId: string; revision: number; currentHandlers: string[] }[];
    }>(await request('/applications'));
    expect(list.items).toHaveLength(1);
    const item = list.items[0]!;
    expect(item).toMatchObject({ status: '审批中', category: '人事变动', initiator: '本人', reason: '' });
    expect(item).toHaveProperty('title');
    expect(item.currentHandlers).not.toHaveLength(0);
    expect(item).not.toHaveProperty('canWithdraw');
    expect((await request(`/applications/${item.id}/withdraw`, 'POST', {}, item.revision)).status).toBe(404);
    expect((await request(`/applications/${item.id}`, 'GET', undefined, undefined, other.userId)).status).toBe(404);
    expect(await world.json(await request(`/applications/${item.id}`))).not.toHaveProperty('actions');
    const current = await world.business(item.businessId);
    await world.json(
      await world.request(world.hr.id, 'POST', `/api/tenant/employment/businesses/${item.businessId}/revoke`, {
        ifMatch: current.revision,
        body: {},
      }),
    );
    expect(await world.json(await request('/applications'))).toMatchObject({
      items: [{ status: '已终止', currentHandlers: [] }],
    });
    expect((await world.business(item.businessId)).status).toBe('voided');
  });

  it('AC-TRF-37/40：跨租户、解除绑定与未知业务一律拒绝', async () => {
    const foreign = await approvalWorld(database().db, 'self-foreign');
    const foreignPerson = await foreign.person('外租户员工', await foreign.org('外租户部门'));
    expect((await request(`/employees/${foreignPerson.employeeId}/records`)).status).toBe(403);
    expect((await api.request('GET', `${BASE}/profile`, { user: self.userId, tenant: foreign.tenant.id })).status).toBe(
      403,
    );
    expect((await request(`/applications/${randomUUID()}/withdraw`, 'POST', {}, 1)).status).toBe(404);
    const revoked = await world.person('解除绑定', department);
    expect((await request('/profile', 'GET', undefined, undefined, revoked.userId)).status).toBe(200);
    await withTenant(database().db, world.tenant.id, (tx) =>
      tx.execute(sql`
      DELETE FROM permission_user_person_links WHERE tenant_id=${world.tenant.id} AND user_id=${revoked.userId}
    `),
    );
    expect((await request('/profile', 'GET', undefined, undefined, revoked.userId)).status).toBe(403);
  });
});
