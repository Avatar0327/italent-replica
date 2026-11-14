// F-474-6c 验收夹具（第 1、2 轮共用）：造租户、组织、员工，并按身份配置 personnel 对象的 custom:<id> 字段权限。
// 作用对象：复刻系统（合成数据）；全部走真实授权器（world.api），setup 是放行授权器的辅助入口。
import { randomUUID } from 'node:crypto';
import { auditEvents, eq, personnelEmployeeVersions, sql, withTenant, type Db } from '@italent/db';
import { PERSONNEL_OBJECT, PERSONNEL_OBJECTS } from '@italent/domain';
import { expect } from 'vitest';
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
import { uniqueSuffix } from './support/unique.js';

export const base = '/api/tenant/personnel/employees';
export type World = Awaited<ReturnType<typeof seedPermissionWorld>>;
export const key = (id: string) => `custom:${id}`;

export async function define(w: World, valueType: string, options: unknown[] = [], objectType = 'personnel') {
  const id = randomUUID();
  await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`INSERT INTO employment_custom_field_objects
      (id, tenant_id, code, name, object_type, value_type, options)
      VALUES (${id}, ${w.tenant.id}, ${id}, ${`合成${valueType}`}, ${objectType}, ${valueType},
        ${JSON.stringify(options)}::jsonb)`),
  );
  return id;
}

export async function fixture(db: Db) {
  const world = await seedPermissionWorld(db);
  const setup = tenantApi(world.db);
  const create = async (path: string, body: object, ifMatch = 0) => {
    const res = await setup.request('POST', `/api/tenant/${path}`, { ...world.asAdmin, body, ifMatch });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as { id: string };
  };
  const org = await create('org/organizations', {
    name: '合成自定义字段部门',
    establishedOn: '2020-01-01',
    parents: { admin: { parentId: world.tenant.id } },
  });
  const employee = await create('employment/employees', { code: `F474-${uniqueSuffix()}`, name: '合成员工' });
  await create(
    `employment/employees/${employee.id}/businesses`,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2020-01-01',
      fields: { departmentId: org.id },
      loginEmail: loginEmailOf(employee.id),
    },
    1,
  );
  const definition = PERSONNEL_OBJECTS.find((o) => o.code === PERSONNEL_OBJECT)!;
  /** view / edit：该身份可查看 / 可编辑的自定义字段 ID；预置字段一律可看可改，避免干扰。 */
  const actor = async (label: string, view: string[], edit: string[]) => {
    const user = await addMember(world, label);
    const profile = await createProfile(world, `${label}-${uniqueSuffix()}`);
    const configure = async (viewIds: string[], editIds: string[]) => {
      const res = await setObjectPermission(
        world,
        profile,
        {
          dataOperations: { create: false, update: true, delete: false },
          fields: [
            ...definition.fields.map((f) => ({ fieldCode: f.code, view: true, edit: !f.system })),
            ...[...new Set([...viewIds, ...editIds])].map((id) => ({
              fieldCode: key(id),
              view: viewIds.includes(id) || editIds.includes(id),
              edit: editIds.includes(id),
            })),
          ],
          buttons: definition.buttons.map((b) => ({ buttonCode: b.code, level: b.level })),
        },
        PERSONNEL_OBJECT,
      );
      expect(res.status, await res.clone().text()).toBe(200);
    };
    await configure(view, edit);
    await makeGrantable(world, [profile.id]);
    expect((await grant(world, user.id, profile.id)).status).toBe(201);
    const scope = await world.api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId: org.id, includeDescendants: false }] },
    });
    expect(scope.status).toBe(200);
    return { as: { tenant: world.tenant.id, user: user.id }, configure };
  };
  const path = `${base}/${employee.id}`;
  const read = async (as: { tenant: string; user: string }) => {
    const res = await world.api.request('GET', path, as);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Record<string, unknown> & { revision: number };
  };
  const patch = async (as: { tenant: string; user: string }, body: object, revision?: number) =>
    world.api.request('PATCH', path, { ...as, ifMatch: revision ?? (await read(as)).revision, body });
  const stored = () =>
    withTenant(world.db, world.tenant.id, async (tx) => ({
      versions: await tx
        .select()
        .from(personnelEmployeeVersions)
        .where(eq(personnelEmployeeVersions.employeeId, employee.id))
        .orderBy(personnelEmployeeVersions.revision),
      audits: await tx.select().from(auditEvents).where(eq(auditEvents.objectId, employee.id)),
    }));
  return { ...world, actor, path, employee, read, patch, stored, setup };
}
