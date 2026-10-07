/** P1 / P2-1：请求全部走真实授权器；仅夹具创建业务用 trusted setup。 */
import { bootstrapTenantAdmin, createPermissionAuthorizer } from '@italent/api';
import { sql, withTenant, permissionScopePolicies, permissionScopePolicyRules } from '@italent/db';
import { MODULE_OBJECTS, STANDARD_PROFILES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { contractWorld } from './AC-CT-support.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { cmd, tenantApi, type RequestOptions } from './support/tenant-api.js';
import { resubmit } from '../../apps/api/src/modules/approval/actions.js';
import { requireResubmitRight } from '../../apps/api/src/modules/approval/access.js';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { rowsOf } from '../../apps/api/src/modules/contracts/context.js';

const database = useTestDb();
const object = MODULE_OBJECTS.contract;
const clock = () => new Date('2026-10-01T01:00:00Z');
async function fixture(label: string, dimension: 'management' | 'using_user' | 'reporting' | 'mixed' = 'management') {
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
        dimension: dimension === 'mixed' ? 'using_user' : dimension,
        relationMode: dimension === 'reporting' ? 'direct' : null,
      });
      if (dimension === 'mixed')
        await tx.insert(permissionScopePolicyRules).values({
          tenantId: seed.tenant.id,
          policyId: p!.id,
          dimension: 'management',
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
  it.each(['edit', 'change'])('P2-N2 %s 导入按本人合同维护范围，撤销人员新建范围仍可维护', async (mode) => {
    const w = await fixture(`import-${mode}`, 'using_user');
    await w.scope(true);
    const response = await w.real('POST', '/commands', {
      ifMatch: 0,
      body: {
        operation: 'create',
        mode: 'direct',
        employeeId: w.employee.id,
        fields: { ...w.fields, endDate: '2027-09-30' },
      },
    });
    expect(response.status).toBe(201);
    const c = (await response.json()) as { id: string; number: string; revision: number };
    await w.scope(false, 1);
    expect((await w.real('GET', `/records/${c.id}`)).status).toBe(200);
    const imported = await w.real('POST', '/imports', {
      ifMatch: 0,
      body: {
        mode,
        rows: [
          {
            employeeId: w.employee.id,
            revision: c.revision,
            originalEffectiveDate: w.fields.effectiveDate,
            fields:
              mode === 'edit'
                ? { number: c.number, regularSalary: '100' }
                : { typeId: w.type.id, effectiveDate: '2026-10-01', regularSalary: '100' },
          },
        ],
      },
    });
    expect(imported.status, await imported.clone().text()).toBe(200);
    const unmatched = await w.real('POST', '/imports/preview', {
      ifMatch: 0,
      body: {
        mode,
        rows: [
          {
            employeeId: w.employee.id,
            revision: 1,
            originalEffectiveDate: '2099-01-01',
            fields: { number: 'not-a-contract', typeId: w.type.id, effectiveDate: '2099-02-01' },
          },
        ],
      },
    });
    expect(unmatched.status).toBe(404);
    // 同一权限仍不能给此人新增合同，也不能初始化重建。
    expect(
      (
        await w.real('POST', '/imports', {
          ifMatch: 0,
          body: { mode: 'add', rows: [{ employeeId: w.employee.id, fields: w.fields }] },
        })
      ).status,
    ).toBe(404);
  });
  it.each([
    { operation: 'create', entry: 'approval' },
    { operation: 'create', entry: 'todos' },
    { operation: 'renew', entry: 'approval' },
    { operation: 'renew', entry: 'todos' },
    { operation: 'change', entry: 'approval' },
    { operation: 'change', entry: 'todos' },
    { operation: 'terminate', entry: 'approval' },
    { operation: 'terminate', entry: 'todos' },
  ] as const)('DEC-202 $operation / $entry 重提复核人员范围或目标真实创建人', async ({ operation, entry }) => {
    const w = await fixture(`resubmit-${operation}-${entry}`, 'mixed');
    const target = operation === 'create' ? null : await w.create({ endDate: '2027-09-30' });
    await installApprovalFallbacks(w.db, w.seed.tenant.id, w.seed.admin.id);
    await w.scope(true);
    const response = await w.real('POST', '/commands', {
      ifMatch: target?.revision ?? 0,
      body: {
        operation,
        targetId: target?.id,
        mode: 'application',
        employeeId: w.employee.id,
        fields:
          operation === 'terminate'
            ? { actualTerminationDate: '2026-10-01' }
            : operation === 'change'
              ? { companyId: w.company.id }
              : { ...w.fields, effectiveDate: '2027-10-01', endDate: '2028-09-30' },
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const request = (await response.json()) as { id: string };
    const [task] = await withTenant(w.db, w.seed.tenant.id, async (tx) =>
      rowsOf<{
        id: string;
        userId: string;
        instanceId: string;
        revision: number;
      }>(
        await tx.execute(sql`SELECT t.id,t.assignee_user_id AS "userId",i.id AS "instanceId",i.revision
      FROM approval_tasks t JOIN approval_instances i ON i.tenant_id=t.tenant_id AND i.id=t.instance_id
      WHERE i.business_id=${request.id}::uuid AND t.status='pending'`),
      ),
    );
    const trusted = tenantApi(w.db, { clock });
    expect(
      (
        await trusted.request('POST', `/api/tenant/approval/tasks/${task!.id}/reject`, {
          tenant: w.seed.tenant.id,
          user: task!.userId,
          ifMatch: task!.revision,
          body: {},
        })
      ).status,
    ).toBe(200);
    const [instance] = await withTenant(w.db, w.seed.tenant.id, async (tx) =>
      rowsOf<{ revision: number }>(
        await tx.execute(sql`SELECT revision FROM approval_instances WHERE id=${task!.instanceId}::uuid`),
      ),
    );
    await w.scope(false, 1);
    const retry = (fields: Record<string, unknown> = {}) =>
      entry === 'approval'
        ? w.api.request('POST', `/api/tenant/approval/instances/${task!.instanceId}/resubmit`, {
            tenant: w.seed.tenant.id,
            user: w.user.id,
            ifMatch: instance!.revision,
            body: { fields },
          })
        : w.real('POST', '/todos/batch', {
            ifMatch: 0,
            body: { action: 'resubmit', items: [{ id: task!.instanceId, revision: instance!.revision }] },
          });
    const denied = await retry();
    if (entry === 'approval') expect(denied.status).toBe(404);
    else expect(await denied.json()).toMatchObject({ items: [{ status: 404 }] });
    await withTenant(w.db, w.seed.tenant.id, async (tx) => {
      expect(
        rowsOf(
          await tx.execute(sql`SELECT status FROM approval_instances
        WHERE id=${task!.instanceId}::uuid`),
        ),
      ).toEqual([{ status: 'returned' }]);
    });
    // 模拟入口预检通过后撤权：锁内 hook 必须重新用真实授权器拒绝。
    const deps = { db: w.db, clock, authorize: createPermissionAuthorizer(w.db) };
    const lockedContext = {
      tenantId: w.seed.tenant.id,
      userId: w.user.id,
      timezone: 'Asia/Shanghai',
      now: clock(),
      commandId: 'locked-resubmit',
      expectedRevision: instance!.revision,
    };
    await expect(
      withTenant(w.db, w.seed.tenant.id, (tx) =>
        resubmit(
          tx,
          {
            ...lockedContext,
            recheckContractResubmit: (tx, id, corrections) =>
              requireResubmitRight(
                deps as Parameters<typeof requireResubmitRight>[0],
                lockedContext,
                id,
                corrections,
                tx,
              ),
          },
          task!.instanceId,
        ),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await w.scope(true, 2);
    let corrections = {};
    let customId: string | undefined;
    if (entry === 'approval' && operation === 'create') {
      const field = await w.session.request('POST', '/custom-fields', {
        ifMatch: 0,
        body: { name: '重提备注', objectType: 'contract', valueType: 'text' },
      });
      expect(field.status).toBe(201);
      customId = ((await field.json()) as { id: string }).id;
      expect(
        (
          await setObjectPermission(
            w.seed,
            w.profile,
            {
              dataOperations: { create: true, update: true, delete: true },
              fields: [
                ...object.fields.map((f) => ({ fieldCode: f.code, view: true, edit: !f.system })),
                { fieldCode: `custom:${customId}`, view: true, edit: true },
              ],
              buttons: object.buttons.map((b) => ({ buttonCode: b.code, level: b.level })),
            },
            object.code,
          )
        ).status,
      ).toBe(200);
      corrections = { customFields: { [customId.toUpperCase()]: '规范化后鉴权' } };
    }
    const allowed = await retry(corrections);
    expect(allowed.status, await allowed.clone().text()).toBe(200);
    if (entry === 'todos') expect(await allowed.json()).toMatchObject({ items: [{ status: 200 }] });
    if (customId)
      await withTenant(w.db, w.seed.tenant.id, async (tx) => {
        expect(
          rowsOf(
            await tx.execute(sql`SELECT custom_fields FROM contract_requests
        WHERE id=${request.id}::uuid`),
          ),
        ).toEqual([{ custom_fields: { [customId]: '规范化后鉴权' } }]);
      });
  });
  it.each(['commands', 'batch'])('DEC-202 %s 续签本人合同仍需人员新建范围', async (entry) => {
    const w = await fixture(`own-renew-${entry}`, 'mixed');
    await w.scope(true);
    const created = await w.real('POST', '/commands', {
      ifMatch: 0,
      body: {
        operation: 'create',
        mode: 'direct',
        employeeId: w.employee.id,
        fields: { ...w.fields, endDate: '2027-09-30' },
      },
    });
    expect(created.status).toBe(201);
    const target = (await created.json()) as { id: string; revision: number };
    await w.scope(false, 1);
    expect((await w.real('GET', `/records/${target.id}`)).status).toBe(200);
    const command = {
      operation: 'renew',
      mode: 'direct',
      employeeId: w.employee.id,
      targetId: target.id,
      fields: { effectiveDate: '2027-10-01', endDate: '2028-09-30' },
    };
    const denied = await w.real('POST', `/${entry}`, {
      ifMatch: entry === 'commands' ? target.revision : 0,
      body: entry === 'commands' ? command : { items: [{ revision: target.revision, command }] },
    });
    expect(denied.status).toBe(404);
    await withTenant(w.db, w.seed.tenant.id, async (tx) => {
      expect(
        rowsOf(
          await tx.execute(sql`SELECT id FROM contract_records
        WHERE employee_id=${w.employee.id}::uuid`),
        ),
      ).toEqual([{ id: target.id }]);
    });
  });
});
