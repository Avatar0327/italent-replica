/**
 * BE-7 PT-3b 第 2 轮 P2-1：数据范围是“直线汇报关系”（reporting / direct）时，真实授权器下的合法预览 / 新增不得被误拒为 404。
 * 旧实现在入口与命令 guard 里用同步的 requireEmploymentScope——它底层的 scopeAllows 遇到带 personQuery 的 reporting 范围一律拒绝，
 * 不做真实的关系查询；现在统一走事务内的 requireScopedEmploymentObject（scopeAllowsInTransaction）。
 * 全程用真实授权器（createPermissionAuthorizer，tenantApi 的 authorize: undefined），不用权限替身：
 * 操作人是经理本人（人员—账号绑定），直线下属在范围内，无关员工在范围外。
 */
import { randomUUID } from 'node:crypto';
import {
  permissionScopePolicies,
  permissionScopePolicyRules,
  permissionUserPersonLinks,
  sql,
  withTenant,
} from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { loginEmailOf } from './AC-EMP-support.js';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const TODAY = '2026-10-01';
const clock = () => new Date(`${TODAY}T01:00:00.000Z`);
const OBJECT = MODULE_OBJECTS.employmentRecord;
const BASE = '/api/tenant/employment';

async function reportingWorld() {
  const world = await seedPermissionWorld(database().db);
  const { db, tenant } = world;
  const setup = tenantApi(db, { clock });
  const asAdmin = world.asAdmin;
  const send = async (method: string, path: string, body?: unknown, ifMatch?: number) => {
    const response = await setup.request(method, `${BASE}${path}`, {
      ...asAdmin,
      ...(ifMatch === undefined ? {} : { ifMatch }),
      ...(body ? { body } : {}),
    });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return (await response.json()) as { id: string; revision: number };
  };
  const org = async (name: string) => {
    const response = await setup.request('POST', '/api/tenant/org/organizations', {
      ...asAdmin,
      ifMatch: 0,
      body: { name, establishedOn: '2025-01-01', parents: { admin: { parentId: tenant.id } } },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  };
  const primaryOrg = await org(`汇报主职部门${randomUUID()}`);
  const partTimeOrg = await org(`汇报兼职部门${randomUUID()}`);

  // 操作人 = 经理本人：先绑定账号再入职（已绑定的人员入职无需登录邮箱，DEC-140）
  const operator = await addMember(world, 'pt-reporting-operator');
  const hired = async (name: string, directManagerId: string | null, linked = false) => {
    const employee = await send('POST', '/employees', { name, code: randomUUID() }, 0);
    if (linked)
      await withTenant(db, tenant.id, (tx) =>
        tx
          .insert(permissionUserPersonLinks)
          .values({ tenantId: tenant.id, userId: operator.id, employeeId: employee.id }),
      );
    await send(
      'POST',
      `/employees/${employee.id}/businesses`,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-01-01',
        fields: { departmentId: primaryOrg.id, directManagerId },
        ...(linked ? {} : { loginEmail: loginEmailOf(employee.id) }),
      },
      employee.revision,
    );
    return employee;
  };
  const manager = await hired('汇报经理', null, true);
  const subordinate = await hired('直线下属', manager.id);
  const stranger = await hired('范围外员工', null);

  // 操作人：任职记录对象的新增 / 按钮 / 字段权限完整，数据范围 = 直线汇报关系（entity 级策略，按 employeeId 判人员）
  const profile = await createProfile(world, `pt${randomUUID()}`, { apps: ['TenantBase'] });
  await makeGrantable(world, [profile.id]);
  expect(
    (
      await setObjectPermission(
        world,
        profile,
        {
          dataOperations: { create: true, update: false, delete: false },
          fields: OBJECT.fields.map((field) => ({ fieldCode: field.code, view: true, edit: !field.system })),
          buttons: OBJECT.buttons.map((button) => ({ buttonCode: button.code, level: button.level })),
        },
        OBJECT.code,
      )
    ).status,
  ).toBe(200);
  expect((await grant(world, operator.id, profile.id)).status).toBe(201);
  await withTenant(db, tenant.id, async (tx) => {
    const [policy] = await tx
      .insert(permissionScopePolicies)
      .values({
        tenantId: tenant.id,
        appCode: 'TenantBase',
        objectCode: OBJECT.code,
        targetKind: 'entity',
        targetCode: OBJECT.code,
        personField: 'employeeId',
      })
      .returning();
    await tx
      .insert(permissionScopePolicyRules)
      .values({ tenantId: tenant.id, policyId: policy!.id, dimension: 'reporting', relationMode: 'direct' });
  });

  const real = tenantApi(db, { authorize: undefined, clock });
  const as = (method: string, path: string, options: { body?: unknown; idempotencyKey?: string } = {}) =>
    real.request(method, `${BASE}${path}`, { user: operator.id, tenant: tenant.id, ...options });
  const body = (patch: Record<string, unknown> = {}) => ({
    partTimeType: 'part_time',
    startDate: '2026-09-01',
    fields: { departmentId: partTimeOrg.id },
    ...patch,
  });
  const partTimeCount = () =>
    withTenant(db, tenant.id, async (tx) => {
      const [row] = rowsOf<{ n: number }>(
        await tx.execute(sql`SELECT (SELECT count(*)::int FROM employment_records
            WHERE tenant_id=${tenant.id} AND service_type <> 'primary')
          + (SELECT count(*)::int FROM audit_events WHERE tenant_id=${tenant.id}
            AND object_type='employment-part-time') AS n`),
      );
      return row!.n;
    });
  return { subordinate, stranger, partTimeOrg, as, body, partTimeCount, send };
}

describe('P2-1 直线汇报关系范围下的兼职预览 / 新增（真实授权器）', () => {
  it('基线：汇报范围内的下属，操作人能读到管理员建的兼职（200）；范围外员工的兼职读不到', async () => {
    const x = await reportingWorld();
    const mine = await x.send('POST', `/employees/${x.subordinate.id}/part-times`, x.body());
    expect((await x.as('GET', `/part-times/${mine.id}`)).status).toBe(200);
    const theirs = await x.send('POST', `/employees/${x.stranger.id}/part-times`, x.body());
    expect((await x.as('GET', `/part-times/${theirs.id}`)).status).toBe(404);
  });

  it('① 汇报范围内的直线下属：预览 200、新增 201（回执是兼职记录读形状）', async () => {
    const x = await reportingWorld();
    const preview = await x.as('POST', `/employees/${x.subordinate.id}/part-times/preview`, { body: x.body() });
    expect(preview.status, await preview.clone().text()).toBe(200);
    const created = await x.as('POST', `/employees/${x.subordinate.id}/part-times`, { body: x.body() });
    expect(created.status, await created.clone().text()).toBe(201);
    expect(await created.json()).toMatchObject({
      employeeId: x.subordinate.id,
      fields: { departmentId: x.partTimeOrg.id },
    });
  });

  it('② 汇报范围外的员工：预览 / 新增都被拒（404），无任何写入', async () => {
    const x = await reportingWorld();
    const before = await x.partTimeCount();
    for (const path of ['/part-times/preview', '/part-times'] as const) {
      const response = await x.as('POST', `/employees/${x.stranger.id}${path}`, { body: x.body() });
      expect(response.status, path).toBe(404);
    }
    expect(await x.partTimeCount()).toBe(before);
  });

  it('③ 同键重放在汇报范围下仍返回首次结果，不再写入', async () => {
    const x = await reportingWorld();
    const key = randomUUID();
    const first = await x.as('POST', `/employees/${x.subordinate.id}/part-times`, {
      body: x.body(),
      idempotencyKey: key,
    });
    expect(first.status, await first.clone().text()).toBe(201);
    const created = await first.json();
    const before = await x.partTimeCount();
    const again = await x.as('POST', `/employees/${x.subordinate.id}/part-times`, {
      body: x.body(),
      idempotencyKey: key,
    });
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(created);
    expect(await x.partTimeCount()).toBe(before);
  });
});
