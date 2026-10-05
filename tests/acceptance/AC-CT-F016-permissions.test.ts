/** P1 / P2-1：请求全部走真实授权器；仅夹具创建业务用 trusted setup。 */
import { bootstrapTenantAdmin } from '@italent/api';
import { sql, withTenant, permissionScopePolicies, permissionScopePolicyRules } from '@italent/db';
import { MODULE_OBJECTS, STANDARD_PROFILES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { contractWorld } from './AC-CT-support.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { cmd, tenantApi, type RequestOptions } from './support/tenant-api.js';
import { rowsOf } from '../../apps/api/src/modules/contracts/context.js';

const database = useTestDb();
const object = MODULE_OBJECTS.contract;
const clock = () => new Date('2026-10-01T01:00:00Z');
async function fixture(label: string, dimension: 'management' | 'using_user' | 'reporting' = 'management') {
  const w = await contractWorld(database().db, `f016-prm-${label}`);
  const api = tenantApi(w.db, { authorize: undefined, clock });
  const adminRecord = await bootstrapTenantAdmin(
    w.db,
    { tenantId: w.session.tenant.id, userId: w.session.user.id },
    cmd(),
  );
  const seed = {
    db: w.db,
    tenant: w.session.tenant,
    admin: w.session.user,
    adminRecord,
    api,
    asAdmin: { tenant: w.session.tenant.id, user: w.session.user.id },
  };
  const user = await addMember(seed, '合同HR');
  const profile = await createProfile(seed, `contract-${label}`);
  for (const definition of [
    object,
    MODULE_OBJECTS.contractSettings,
    MODULE_OBJECTS.contractRules,
    MODULE_OBJECTS.contractType,
    MODULE_OBJECTS.contractCompany,
  ]) {
    expect(
      (
        await setObjectPermission(
          seed,
          profile,
          {
            dataOperations: { create: true, update: true, delete: true },
            fields: definition.fields.map((f) => ({ fieldCode: f.code, view: true, edit: !f.system })),
            buttons: definition.buttons.map((b) => ({ buttonCode: b.code, level: b.level })),
          },
          definition.code,
        )
      ).status,
    ).toBe(200);
  }
  await makeGrantable(seed, [profile.id]);
  expect((await grant(seed, user.id, profile.id)).status).toBe(201);
  async function scope(inside: boolean, revision = 0) {
    const response = await api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
      ...seed.asAdmin,
      ifMatch: revision,
      body: { kind: 'org_range', orgRanges: inside ? [{ orgId: w.org.id, includeDescendants: false }] : [] },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  if (dimension !== 'management')
    await withTenant(w.db, seed.tenant.id, async (tx) => {
      const [p] = await tx
        .insert(permissionScopePolicies)
        .values({
          tenantId: seed.tenant.id,
          appCode: 'TenantBase',
          objectCode: object.code,
          targetKind: 'entity',
          targetCode: object.code,
          personField: 'employeeId',
        })
        .returning();
      await tx.insert(permissionScopePolicyRules).values({
        tenantId: seed.tenant.id,
        policyId: p!.id,
        dimension,
        relationMode: dimension === 'reporting' ? 'direct' : null,
      });
    });
  const request = (method: string, path: string, opts: RequestOptions = {}) =>
    api.request(method, `/api/tenant/contracts${path}`, { ...opts, tenant: seed.tenant.id, user: user.id });
  return { ...w, seed, api, user, profile, scope, real: request };
}

describe('AC-CT F-016 真实权限接入', () => {
  it('P2-1 管理单元人员范围应用于列表、详情和新建，撤销立即失效', async () => {
    const w = await fixture('managed');
    const c = await w.create();
    await w.scope(true);
    const list = await w.real('GET', '?view=all&pageSize=1');
    expect(await list.json()).toMatchObject({ items: [{ id: c.id }] });
    expect((await w.real('GET', `/records/${c.id}`)).status).toBe(200);
    expect(
      (
        await w.real('POST', '/commands', {
          ifMatch: 0,
          body: {
            operation: 'create',
            mode: 'direct',
            employeeId: w.employee.id,
            fields: { ...w.fields, typeId: w.otherType.id },
          },
        })
      ).status,
    ).toBe(201);
    await w.scope(false, 1);
    expect((await w.real('GET', `/records/${c.id}`)).status).toBe(404);
  });
  it('P2-1 汇报范围复用当前任职关系，范围外合同不可见', async () => {
    const w = await fixture('reports', 'reporting');
    const manager = await w.session.employee();
    await w.session.business(
      manager.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2025-01-01', fields: { departmentId: w.org.id } },
      manager.revision,
    );
    const current = await w.session.getEmployee(w.employee.id);
    await w.session.business(
      w.employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-01', fields: { directManagerId: manager.id } },
      current.revision,
    );
    await withTenant(w.db, w.seed.tenant.id, async (tx) => {
      // 账号人员绑定是可信建档夹具，真实授权器仍解析汇报人员 SQL。
      await tx.execute(sql`DELETE FROM permission_user_person_links WHERE employee_id=${manager.id}::uuid`);
      await tx.execute(sql`INSERT INTO permission_user_person_links(tenant_id,user_id,employee_id)
        VALUES (${w.seed.tenant.id},${w.user.id},${manager.id})`);
    });
    const c = await w.create();
    expect(await (await w.real('GET', '?view=valid')).json()).toMatchObject({ items: [] });
    expect(await (await w.real('GET', '?view=all')).json()).toMatchObject({ items: [{ id: c.id }] });
    expect((await w.real('GET', `/records/${c.id}`)).status).toBe(200);
  });
  it('P1-2 我创建的初始化必须逐条检查真实创建人，整批无删除', async () => {
    const w = await fixture('initialize', 'using_user');
    const c = await w.create();
    await w.scope(true);
    const r = await w.real('GET', `/employees/${w.employee.id}/revision`);
    expect(r.status).toBe(200);
    const { revision } = (await r.json()) as { revision: number };
    const response = await w.real('POST', '/imports', {
      ifMatch: 0,
      body: {
        mode: 'initialize',
        revisions: { [w.employee.id]: revision },
        rows: [{ employeeId: w.employee.id, fields: w.fields }],
      },
    });
    expect(response.status).toBe(404);
    expect((await w.request('GET', `/records/${c.id}`)).status).toBe(200);
  });
  it('DEC-180④ 我创建的不能为管理范围外员工新建', async () => {
    const w = await fixture('create-scope', 'using_user');
    const response = await w.real('POST', '/commands', {
      ifMatch: 0,
      body: { operation: 'create', mode: 'direct', employeeId: w.employee.id, fields: w.fields },
    });
    expect(response.status).toBe(404);
    await w.scope(true);
    expect(
      (
        await w.real('POST', '/commands', {
          ifMatch: 0,
          body: { operation: 'create', mode: 'direct', employeeId: w.employee.id, fields: w.fields },
        })
      ).status,
    ).toBe(201);
  });
  it('P1-3 普通HR即使持有旧配置对象权限也不能配置；标准身份不再预置', async () => {
    const w = await fixture('config');
    const response = await w.real('PUT', '/settings', { ifMatch: 0, body: { autoRenew: true } });
    expect(response.status).toBe(403);
    const rules = await w.real('POST', '/rules', {
      ifMatch: 0,
      body: { name: '无权规则', priority: 1, orgIds: [], personIds: [], details: [] },
    });
    expect(rules.status).toBe(403);
    for (const preset of STANDARD_PROFILES.filter((p) => p.hr)) {
      expect(
        preset.objects.some((p) =>
          ['TenantBase.ContractSettings', 'TenantBase.ContractRenewalRule'].includes(p.objectCode),
        ),
      ).toBe(false);
    }
  });
  it('DEC-180① 租户管理员可授予/撤销管理员记录的合同配置能力，版本和审计有效', async () => {
    const w = await fixture('delegate');
    const response = await w.api.request('POST', '/api/tenant/permission/admins', {
      ...w.seed.asAdmin,
      ifMatch: 0,
      body: {
        userId: w.user.id,
        role: 'employee_admin',
        grantableAdminRoles: [],
        grantableProfileIds: [],
        contractConfiguration: true,
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const admin = (await response.json()) as { id: string; revision: number };
    expect((await w.real('PUT', '/settings', { ifMatch: 0, body: { autoRenew: true } })).status).toBe(200);
    const revoke = await w.api.request('PUT', `/api/tenant/permission/admins/${admin.id}`, {
      ...w.seed.asAdmin,
      ifMatch: admin.revision,
      body: { grantableAdminRoles: [], grantableProfileIds: [], contractConfiguration: false },
    });
    expect(revoke.status).toBe(200);
    expect((await w.real('PUT', '/settings', { ifMatch: 1, body: { autoRenew: false } })).status).toBe(403);
  });
  it('P2-8 主数据撤销范围后原幂等键不能重放旧数据', async () => {
    const w = await fixture('master-replay');
    const scopePath = `/api/tenant/permission/profiles/${w.profile.id}/data-scopes/TenantBase`;
    const body = { targetKind: 'entity', targetCode: MODULE_OBJECTS.contractType.code, seeAll: true };
    expect((await w.api.request('PUT', scopePath, { ...w.seed.asAdmin, ifMatch: 0, body })).status).toBe(200);
    const command = { ifMatch: 0, idempotencyKey: 'master-repeat', body: { code: 'REPLAY', name: '不能重放的类型' } };
    expect((await w.real('POST', '/master-data/types', command)).status).toBe(201);
    expect(
      (await w.api.request('PUT', scopePath, { ...w.seed.asAdmin, ifMatch: 1, body: { ...body, seeAll: false } }))
        .status,
    ).toBe(200);
    const replay = await w.real('POST', '/master-data/types', command);
    expect(replay.status).toBe(404);
    expect(await replay.text()).not.toContain('不能重放的类型');
    await withTenant(w.db, w.seed.tenant.id, async (tx) => {
      expect(rowsOf(await tx.execute(sql`SELECT id FROM contract_types WHERE code='REPLAY'`))).toHaveLength(1);
    });
  });
});
