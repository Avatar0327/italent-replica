import { randomUUID } from 'node:crypto';
import { auditEvents, eq, personnelEmployeeVersions, sql, withTenant } from '@italent/db';
import { EMPLOYEE_FIELDS, PERSONNEL_OBJECT, PERSONNEL_OBJECTS, STANDARD_PROFILES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeEach, describe, expect, it } from 'vitest';
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

const database = useTestDb();
const field = 'dailyWageStandard';
const base = '/api/tenant/personnel/employees';

async function fixture() {
  const world = await seedPermissionWorld(database().db);
  const setup = tenantApi(world.db);
  const create = async (path: string, body: object, ifMatch = 0) => {
    const res = await setup.request('POST', `/api/tenant/${path}`, { ...world.asAdmin, body, ifMatch });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as { id: string };
  };
  const org = await create('org/organizations', {
    name: '合成工资部门',
    establishedOn: '2020-01-01',
    parents: { admin: { parentId: world.tenant.id } },
  });
  const employee = await create('employment/employees', { code: `F325-${uniqueSuffix()}`, name: '合成员工' });
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
  const actor = async (label: string, view: boolean, edit: boolean, inScope = true) => {
    const user = await addMember(world, label);
    const profile = await createProfile(world, `${label}-${uniqueSuffix()}`);
    const configure = async (read: boolean, write: boolean) => {
      const res = await setObjectPermission(
        world,
        profile,
        {
          dataOperations: { create: false, update: true, delete: false },
          fields: definition.fields.map((f) => ({
            fieldCode: f.code,
            view: f.code !== field || read,
            edit: !f.system && (f.code !== field || write),
          })),
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
      body: { kind: 'org_range', orgRanges: inScope ? [{ orgId: org.id, includeDescendants: false }] : [] },
    });
    expect(scope.status).toBe(200);
    return { as: { tenant: world.tenant.id, user: user.id }, configure };
  };
  const writer = await actor('writer', true, true);
  const reader = await actor('reader', true, false);
  const hidden = await actor('hidden', false, false);
  const outside = await actor('outside', true, true, false);
  const path = `${base}/${employee.id}`;
  const read = async () => {
    const res = await world.api.request('GET', path, writer.as);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown> & { revision: number };
  };
  const write = async (value: unknown, as = writer.as, extra = {}) =>
    world.api.request('PATCH', path, {
      ...as,
      ifMatch: (await read()).revision,
      body: { [field]: value },
      ...extra,
    });
  const stored = () =>
    withTenant(world.db, world.tenant.id, async (tx) => ({
      versions: await tx
        .select()
        .from(personnelEmployeeVersions)
        .where(eq(personnelEmployeeVersions.employeeId, employee.id)),
      audits: await tx.select().from(auditEvents).where(eq(auditEvents.objectId, employee.id)),
    }));
  return { ...world, writer, reader, hidden, outside, path, employee, read, write, stored };
}

describe('AC-PER-F325 日工资标准（DEC-685① / DEC-687③）', () => {
  let w: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    w = await fixture();
  });

  it('有权写入、列表和详情均返回精确字符串；版本链、旧新值审计与幂等保留', async () => {
    expect((await w.read())[field]).toBeNull();
    const input = { ifMatch: 0, idempotencyKey: randomUUID() };
    const first = await w.write('123456789012.34', w.writer.as, input);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.json()).toMatchObject({ dailyWageStandard: '123456789012.34', revision: 1 });
    expect((await w.write('123456789012.34', w.writer.as, input)).status).toBe(200);
    expect(await w.read()).toMatchObject({ dailyWageStandard: '123456789012.34', revision: 1 });
    const list = await w.api.request('GET', base, w.writer.as);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ items: [{ id: w.employee.id, dailyWageStandard: '123456789012.34' }] });
    const changed = await w.write('250.50');
    expect(changed.status).toBe(200);
    const history = await w.api.request('GET', `${w.path}/history`, w.writer.as);
    expect(await history.json()).toMatchObject({
      items: [
        { revision: 2, dailyWageStandard: '250.50' },
        { revision: 1, dailyWageStandard: '123456789012.34' },
      ],
    });
    const { versions, audits } = await w.stored();
    expect(versions).toHaveLength(2);
    const changes = audits.filter((a) => a.objectType === PERSONNEL_OBJECT);
    expect(changes).toHaveLength(2);
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          before: expect.objectContaining({ dailyWageStandard: null }),
          after: expect.objectContaining({ dailyWageStandard: '123456789012.34' }),
        }),
        expect.objectContaining({
          before: { dailyWageStandard: '123456789012.34' },
          after: { dailyWageStandard: '250.50' },
        }),
      ]),
    );
  });

  it('无查看权时列表、详情、历史和其他字段写回执均不返回工资', async () => {
    expect((await w.write('250.50')).status).toBe(200);
    for (const path of [base, w.path, `${w.path}/history`]) {
      const res = await w.api.request('GET', path, w.hidden.as);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain(field);
      expect(body).not.toContain('250.50');
      expect(body).toContain('合成员工');
    }
    const res = await w.api.request('PATCH', w.path, {
      ...w.hidden.as,
      ifMatch: (await w.read()).revision,
      body: { engName: 'Synthetic' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(field);
    expect((await w.read())[field]).toBe('250.50');
  });

  it('无编辑权拒绝写入及清空；范围外及跨租户 ID 不可读写，数据和审计不变', async () => {
    expect((await w.write('250.50')).status).toBe(200);
    const before = await w.stored();
    for (const as of [w.reader.as, w.hidden.as]) {
      for (const value of ['99.00', null]) expect((await w.write(value, as)).status).toBe(403);
    }
    expect((await w.api.request('GET', w.path, w.outside.as)).status).toBe(404);
    expect((await w.write('99.00', w.outside.as)).status).toBe(404);
    const other = await fixture();
    expect((await other.api.request('GET', w.path, other.writer.as)).status).toBe(404);
    expect(
      (
        await other.api.request('PATCH', w.path, {
          ...other.writer.as,
          ifMatch: (await w.read()).revision,
          body: { [field]: '99.00' },
        })
      ).status,
    ).toBe(404);
    const rows = await withTenant(w.db, other.tenant.id, (tx) =>
      tx.execute(sql`SELECT id FROM personnel_employee_versions WHERE employee_id=${w.employee.id}::uuid`),
    );
    expect(Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows).toHaveLength(0);
    expect(await w.stored()).toEqual(before);
  });

  it.each(['-1.00', '1.001', 'money', '', '1e2', '1000000000000.00', 12.34])(
    '非法金额 %j 返回 422，原值、版本和审计不变',
    async (value) => {
      const before = await w.stored();
      const res = await w.write(value);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: { code: 'DAILY_WAGE_STANDARD_INVALID' } });
      expect(await w.stored()).toEqual(before);
    },
  );

  it('零值合法、可显式清空；旧 revision 拒绝、字段撤权后原命令不能重放', async () => {
    expect((await w.write('0.00')).status).toBe(200);
    expect((await w.read())[field]).toBe('0.00');
    const revision = (await w.read()).revision;
    expect((await w.write(null)).status).toBe(200);
    expect((await w.read())[field]).toBeNull();
    const before = await w.stored();
    expect((await w.write('50.00', w.writer.as, { ifMatch: revision })).status).toBe(409);
    expect(await w.stored()).toEqual(before);
    expect(before.audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ before: { dailyWageStandard: '0.00' }, after: { dailyWageStandard: null } }),
      ]),
    );
    const command = { ifMatch: (await w.read()).revision, idempotencyKey: randomUUID() };
    expect((await w.write('100.00', w.writer.as, command)).status).toBe(200);
    const saved = await w.stored();
    await w.writer.configure(true, false);
    expect((await w.write('100.00', w.writer.as, command)).status).toBe(403);
    expect(await w.stored()).toEqual(saved);
  });
});

describe('AC-PER-F325 字段目录和默认授权', () => {
  it('字段可单独授权，默认仅所属模块两类管理员读写', () => {
    expect(EMPLOYEE_FIELDS.find((f) => f.code === field)).toMatchObject({ code: field });
    expect(PERSONNEL_OBJECTS.find((o) => o.code === PERSONNEL_OBJECT)!.fields).toContainEqual({
      code: field,
      system: false,
    });
    const granted = STANDARD_PROFILES.filter((p) =>
      p.objects.some(
        (o) => o.objectCode === PERSONNEL_OBJECT && o.fields.some((f) => f.fieldCode === field && (f.view || f.edit)),
      ),
    );
    expect(granted.map((p) => p.code).sort()).toEqual(['standard_hr_admin', 'standard_org_system_admin']);
    for (const profile of granted)
      expect(profile.objects.find((o) => o.objectCode === PERSONNEL_OBJECT)!.fields).toContainEqual({
        fieldCode: field,
        view: true,
        edit: true,
      });
  });
});
