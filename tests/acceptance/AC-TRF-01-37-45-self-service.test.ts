import { randomUUID } from 'node:crypto';
import { grantMembership, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { approvalWorld, grantVisibleFields, permissionAdmin, type Person } from './AC-APV-support.js';
import { createProfile, setObjectPermission } from './AC-PRM-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/self-service';
let world: Awaited<ReturnType<typeof approvalWorld>>;
let api: ReturnType<typeof tenantApi>;
let department: string;
let admin: Awaited<ReturnType<typeof permissionAdmin>>;
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

  it('AC-TRF-45：我的申请表格列、只读详情；HR撤销后已终止且无当前处理人', async () => {
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
    expect(
      (
        await api.request('POST', `/api/tenant/approval/instances/${item.id}/withdraw`, {
          ...world.as(self.userId),
          body: {},
          ifMatch: item.revision,
        })
      ).status,
    ).toBe(403);
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
    await grantMembership(
      database().db,
      { tenantId: foreign.tenant.id, userId: self.userId, expectedRevision: 0 },
      cmd(),
    );
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

  it('AC-TRF-39：全租户部门候选与新经理自动带出，不开放他人档案', async () => {
    const target = await world.org('范围外目标部门');
    await world.setOrgRoles(target, { head: other.employeeId });
    const candidates = await world.json<{ items: { id: string }[] }>(
      await request('/transfer/references/departmentId?asOf=2026-10-19'),
    );
    expect(candidates.items.map((item) => item.id)).toContain(target);
    const preview = await world.json(
      await request('/transfer/preview', 'POST', {
        ...input(),
        fields: { departmentId: target.toUpperCase() },
      }),
    );
    expect(preview).toMatchObject({ fields: { departmentId: target, directManagerId: other.employeeId } });
    expect((await request(`/employees/${other.employeeId}/records`)).status).toBe(403);
  });

  it('AC-TRF-39：额外身份可见字段为只读；字段编辑权变更及撤权实时生效', async () => {
    admin = await permissionAdmin(world);
    const profile = await grantVisibleFields(admin, self.userId, ['place']);
    const read = await world.json(await request('/transfer/preview', 'POST', input()));
    expect(read).toMatchObject({
      form: { fieldModes: { 'preset:place': 'readonly' } },
      fields: { place: '权限外地址' },
    });
    const changed = { ...input(), fields: { departmentId: department, place: '合成新地址' } };
    expect((await request('/transfer/preview', 'POST', changed)).status).toBe(403);
    await world.json(
      await setObjectPermission(
        admin,
        profile,
        {
          dataOperations: { create: true, update: true, delete: false },
          fields: [{ fieldCode: 'place', view: true, edit: true }],
          buttons: [],
        },
        'TenantBase.EmploymentRecord',
      ),
    );
    expect(await world.json(await request('/transfer/preview', 'POST', changed))).toMatchObject({
      form: { fieldModes: { 'preset:place': 'editable' } },
      fields: { place: '合成新地址' },
    });
    await withTenant(database().db, world.tenant.id, (tx) =>
      tx.execute(sql`
      UPDATE permission_grants SET status='revoked' WHERE tenant_id=${world.tenant.id} AND profile_id=${profile.id}
    `),
    );
    expect((await request('/transfer/preview', 'POST', changed)).status).toBe(403);
    expect(JSON.stringify(await world.json(await request('/profile')))).not.toContain('权限外地址');
  });

  it('AC-TRF-45：审批通过未到生效日显示通过；重复命令不新增申请，旧revision拒绝', async () => {
    const actor = await world.person('通过申请员工', department);
    const own = await world.json<{ employee: { revision: number } }>(
      await request('/profile', 'GET', undefined, undefined, actor.userId),
    );
    const options = {
      ...world.as(actor.userId),
      body: input(),
      ifMatch: own.employee.revision,
      idempotencyKey: randomUUID(),
    };
    const saved = await world.json<{ id: string }>(await api.request('POST', `${BASE}/transfer`, options), 201);
    const replay = await world.json<{ id: string }>(await api.request('POST', `${BASE}/transfer`, options), 201);
    expect(replay.id).toBe(saved.id);
    expect((await api.request('POST', `${BASE}/transfer`, { ...options, idempotencyKey: randomUUID() })).status).toBe(
      409,
    );
    const instance = await world.instanceOf(saved.id, actor.userId);
    const task = world.pending(instance)[0]!;
    await world.json(await world.taskAction(task.assigneeUserId, task.id, 'approve', instance.revision));
    expect(await world.json(await request('/applications', 'GET', undefined, undefined, actor.userId))).toMatchObject({
      items: [{ status: '通过', currentHandlers: [] }],
    });
    expect((await world.business(saved.id)).status).toBe('approved');
  });

  it('AC-TRF-37/40：账号改绑后，旧幂等命令不能重放原员工的数据', async () => {
    const actor = await world.person('改绑前员工', department);
    const replacement = await world.person('改绑后员工', department);
    const profile = await world.json<{ employee: { revision: number } }>(
      await request('/profile', 'GET', undefined, undefined, actor.userId),
    );
    const options = {
      ...world.as(actor.userId),
      body: input(),
      ifMatch: profile.employee.revision,
      idempotencyKey: randomUUID(),
    };
    await world.json(await api.request('POST', `${BASE}/transfer`, options), 201);
    await withTenant(database().db, world.tenant.id, async (tx) => {
      await tx.execute(sql`DELETE FROM permission_user_person_links
        WHERE tenant_id=${world.tenant.id} AND user_id IN (${replacement.userId}::uuid,${actor.userId}::uuid)`);
      await tx.execute(sql`INSERT INTO permission_user_person_links(tenant_id,user_id,employee_id)
        VALUES(${world.tenant.id},${actor.userId}::uuid,${replacement.employeeId}::uuid)`);
    });
    expect(await world.json(await request('/profile', 'GET', undefined, undefined, actor.userId))).toMatchObject({
      employee: { id: replacement.employeeId },
    });
    expect((await api.request('POST', `${BASE}/transfer`, options)).status).toBe(409);
  });

  it('AC-TRF-39：自动员工身份可配置，未授权员工同样实时采用收紧后的字段权限', async () => {
    const profile = await createProfile(admin, 'employee_self_service');
    await world.json(
      await setObjectPermission(
        admin,
        profile,
        {
          dataOperations: { create: true, update: false, delete: false },
          fields: ['effectiveDate', 'departmentId', 'directManagerId'].map((fieldCode) => ({
            fieldCode,
            view: true,
            edit: true,
          })),
          // DEC-402②：三个本人调动按钮由身份校验，自建同编码身份须带上它们（本用例测字段口径，不测按钮）
          buttons: ['Transfer.Self', 'Employment.Create', 'Employment.Submit'].map((buttonCode) => ({
            buttonCode,
            level: 'detail',
          })),
        },
        'TenantBase.EmploymentRecord',
      ),
    );
    const preview = await world.json<{ form: { fieldModes: object }; fields: object }>(
      await request('/transfer/preview', 'POST', input()),
    );
    expect(preview).toMatchObject({ basicFieldModes: { reasonCode: 'hidden' }, reasons: [] });
    expect(preview.form.fieldModes).not.toHaveProperty('preset:postId');
    expect(preview.fields).not.toHaveProperty('levelId');
    expect(
      (await request('/transfer/preview', 'POST', { ...input(), fields: { departmentId: department, postId: null } }))
        .status,
    ).toBe(403);
    expect((await request('/transfer/references/postId')).status).toBe(403);
  });
});
