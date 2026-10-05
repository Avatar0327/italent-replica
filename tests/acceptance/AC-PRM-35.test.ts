/** AC-PRM-35：组织角色范围保留停用前最后一版负责人 / HRBP（DEC-160）。 */
import { randomUUID } from 'node:crypto';
import { permissionUserPersonLinks, sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveDataScope } from '../../apps/api/src/modules/permission/scope-resolver.js';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import { loginEmailOf } from './AC-EMP-support.js';

const database = useTestDb();
const asOf = '2026-10-01';
const clock = () => new Date(`${asOf}T01:00:00Z`);
type Created = { id: string; revision: number };
type Person = { id: string; recordId: string };
type Identity = { user: string; tenant: string };
type Role = 'head' | 'hrbp';

async function fixture(role: Role) {
  const db = database().db;
  const seed = await seedPermissionWorld(db);
  const api = tenantApi(db, { authorize: undefined, clock });
  const setup = tenantApi(db, { clock });
  const world = { ...seed, api };
  async function create(path: string, body: unknown, revision = 0) {
    const response = await setup.request('POST', `/api/tenant/${path}`, { ...world.asAdmin, ifMatch: revision, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as Created;
  }
  const org = (name: string, parentId = world.tenant.id) =>
    create('org/organizations', { name, establishedOn: '2025-01-01', parents: { admin: { parentId } } });
  const employee = async (departmentId?: string): Promise<Person> => {
    const person = await create('employment/employees', { code: randomUUID(), name: '角色范围测试人员' });
    if (!departmentId) return { id: person.id, recordId: '' };
    const hire = await create(
      `employment/employees/${person.id}/businesses`,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-01-01',
        fields: { departmentId },
        loginEmail: loginEmailOf(person.id),
      },
      person.revision,
    );
    return { id: person.id, recordId: hire.id };
  };
  // 同 AC-PRM-34：DEC-129 不允许停用仍有在职人员的组织；用追加版本模拟原站存量 / 导入数据，保留版本链与层级。
  async function version(
    organization: Created,
    startDate: string,
    enabled: boolean,
    holder: string | null,
    stopDate = '9999-12-31',
  ) {
    await withTenant(db, world.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT id FROM org_versions
        WHERE tenant_id=${world.tenant.id} AND org_id=${organization.id}::uuid
        ORDER BY start_date DESC,version_no DESC LIMIT 1`);
      const [old] = (Array.isArray(result) ? result : (result as { rows: { id: string }[] }).rows) as { id: string }[];
      const versionId = randomUUID();
      const field = role === 'head' ? 'person_in_charge_id' : 'hrbp_id';
      await tx.execute(sql`INSERT INTO org_versions
        SELECT (jsonb_populate_record(NULL::org_versions,to_jsonb(v) || jsonb_build_object(
          'id',${versionId}::uuid,'version_no',v.version_no+1,'previous_version_id',v.id,
          'start_date',${startDate}::date,'stop_date',${stopDate}::date,'enabled',${enabled}::boolean,${field}::text,${holder}::uuid))).*
        FROM org_versions v WHERE v.tenant_id=${world.tenant.id} AND v.id=${old!.id}::uuid`);
      await tx.execute(sql`INSERT INTO org_hierarchy_links(tenant_id,version_id,dimension,parent_org_id,sequence)
        SELECT tenant_id,${versionId}::uuid,dimension,parent_org_id,sequence FROM org_hierarchy_links
        WHERE tenant_id=${world.tenant.id} AND version_id=${old!.id}::uuid`);
    });
  }
  const profile = await createProfile(world, `role-${randomUUID()}`);
  for (const definition of [MODULE_OBJECTS.employee, MODULE_OBJECTS.employmentRecord]) {
    const response = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: definition.fields.map((field) => ({ fieldCode: field.code, view: true, edit: false })),
        buttons: [],
      },
      definition.code,
    );
    expect(response.status).toBe(200);
    const policy = await api.request(
      'PUT',
      `/api/tenant/permission/scope-policies/TenantBase/${definition.code}/entity/${definition.code}`,
      {
        ...world.asAdmin,
        ifMatch: 0,
        body: {
          personField: definition === MODULE_OBJECTS.employee ? 'id' : 'employeeId',
          ...(definition === MODULE_OBJECTS.employmentRecord ? { departmentField: 'departmentId' } : {}),
          rules: [{ dimension: 'organization', roleCode: role }],
        },
      },
    );
    expect(policy.status, await policy.clone().text()).toBe(200);
  }
  await makeGrantable(world, [profile.id]);
  async function reader(label: string) {
    const person = await employee();
    const user = await addMember(world, label);
    await withTenant(db, world.tenant.id, (tx) =>
      tx
        .insert(permissionUserPersonLinks)
        .values({ tenantId: world.tenant.id, userId: user.id, employeeId: person.id }),
    );
    expect((await grant(world, user.id, profile.id)).status).toBe(201);
    return { personId: person.id, as: { user: user.id, tenant: world.tenant.id } };
  }
  const resolve = (as: Identity, date = asOf, objectCode = MODULE_OBJECTS.employee.code) =>
    withTenant(db, world.tenant.id, (tx) =>
      resolveDataScope(tx, {
        tenantId: world.tenant.id,
        userId: as.user,
        appCode: 'TenantBase',
        asOf: date,
        objectCode,
      }),
    );
  async function visibility(as: Identity, person: Person) {
    const get = (path: string) => api.request('GET', `/api/tenant/employment${path}`, as);
    const list = await get('/employees');
    expect(list.status).toBe(200);
    const records = await get(`/employees/${person.id}/records`);
    return {
      listed: ((await list.json()) as { items: { id: string }[] }).items.some((item) => item.id === person.id),
      detail: (await get(`/employees/${person.id}`)).status,
      records:
        records.status === 200
          ? ((await records.json()) as { items: { id: string }[] }).items.map((item) => item.id)
          : [],
      record: (await get(`/records/${person.recordId}`)).status,
    };
  }
  return { world, org, employee, version, reader, resolve, visibility, profile };
}
const visible = (person: Person) => ({ listed: true, detail: 200, records: [person.recordId], record: 200 });
const hidden = { listed: false, detail: 404, records: [], record: 404 };

describe.each<Role>(['head', 'hrbp'])('AC-PRM-35 %s 停用组织角色范围', (role) => {
  let w: Awaited<ReturnType<typeof fixture>>;
  let reader: Awaited<ReturnType<typeof w.reader>>;
  let former: Awaited<ReturnType<typeof w.reader>>;
  let root: Created;
  let child: Created;
  let grandchild: Created;
  let enabled: Created;
  let expired: Created;
  let people: Person[];
  let outsider: Person;
  beforeAll(async () => {
    w = await fixture(role);
    reader = await w.reader('current-role');
    former = await w.reader('former-role');
    root = await w.org('即将停用的范围根');
    child = await w.org('停用下级', root.id);
    grandchild = await w.org('停用下级的子树', child.id);
    enabled = await w.org('保持启用的范围根');
    expired = await w.org('按失效日期结束的范围根');
    people = await Promise.all([root, child, grandchild, enabled, expired].map((o) => w.employee(o.id)));
    outsider = await w.employee((await w.org('未负责组织')).id);
    await w.version(root, '2026-02-01', true, former.personId);
    // 同日最后版本生效：旧任职者不能因停用重新获得范围。
    await w.version(root, '2026-02-01', true, reader.personId);
    await w.version(enabled, '2026-02-01', true, reader.personId);
    await w.version(expired, '2026-02-01', true, reader.personId, '2026-08-31');
    // 停用版故意改回旧任职者，后一停用版本再清空；应始终取停用前最后一版。
    await w.version(root, '2026-09-01', false, former.personId);
    await w.version(root, '2026-09-15', false, null);
    await w.version(child, '2026-09-01', false, null);
    await w.version(root, '2026-11-01', true, former.personId);
  });
  it('停用根及停用下级、子树下的人员列表 / 详情与任职列表 / 详情仍可见', async () => {
    for (const person of people.slice(0, 3)) expect(await w.visibility(reader.as, person)).toEqual(visible(person));
    expect(await w.visibility(reader.as, outsider)).toEqual(hidden);
  });
  it('启用组织与按失效日期结束的组织仍保留角色范围', async () => {
    for (const person of people.slice(3)) expect(await w.visibility(reader.as, person)).toEqual(visible(person));
  });
  it('按查询日期和同日版本顺序取停用前最后任职者；未来重新启用才切换人员', async () => {
    const expected = [root.id, child.id, grandchild.id, enabled.id, expired.id].sort();
    expect([...(await w.resolve(reader.as, '2026-08-01')).orgIds].sort()).toEqual(expected);
    expect([...(await w.resolve(reader.as)).orgIds].sort()).toEqual(expected);
    expect((await w.resolve(former.as)).orgIds).toEqual([]);
    expect(await w.visibility(former.as, people[0]!)).toEqual(hidden);
    expect([...(await w.resolve(former.as, '2026-11-01')).orgIds].sort()).toEqual(
      [root.id, child.id, grandchild.id].sort(),
    );
    expect([...(await w.resolve(reader.as, '2026-11-01')).orgIds].sort()).toEqual([enabled.id, expired.id].sort());
  });
  it('最后启用版本已清空角色时保持 fail-closed，不回溯更早的持有人', async () => {
    const cleared = await w.org('停用前已撤角色');
    await w.version(cleared, '2026-02-01', true, reader.personId);
    await w.version(cleared, '2026-03-01', true, null);
    await w.version(cleared, '2026-09-01', false, reader.personId);
    expect((await w.resolve(reader.as)).orgIds).not.toContain(cleared.id);
  });
  it('动态授权的默认管理单元同样保留停用根，仍只含本级', async () => {
    const autoProfile = await createProfile(w.world, `auto-${randomUUID()}`);
    await withTenant(w.world.db, w.world.tenant.id, async (tx) => {
      const grantId = randomUUID();
      await tx.execute(sql`INSERT INTO permission_grants(id,tenant_id,user_id,profile_id,source)
        VALUES (${grantId}::uuid,${w.world.tenant.id},${reader.as.user},${autoProfile.id},'auto')`);
      await tx.execute(sql`INSERT INTO permission_dynamic_org_grants(tenant_id,grant_id,role_code)
        VALUES (${w.world.tenant.id},${grantId}::uuid,${role})`);
    });
    expect([...(await w.resolve(reader.as, asOf, 'TenantBase.Organization')).orgIds].sort()).toEqual(
      [root.id, enabled.id, expired.id].sort(),
    );
  });
  it('其他租户的停用组织及其人员与任职仍不可见', async () => {
    const other = await fixture(role);
    const foreignRoot = await other.org('其他租户的停用根');
    const foreign = await other.employee(foreignRoot.id);
    // 特意使用 A 租户相同的人员 UUID，验证 roleRoots 自身的 tenant_id 边界（人员引用为存量夹具）。
    await other.version(foreignRoot, '2026-02-01', true, reader.personId);
    await other.version(foreignRoot, '2026-09-01', false, reader.personId);
    expect((await w.resolve(reader.as)).orgIds).not.toContain(foreignRoot.id);
    expect(await w.visibility(reader.as, foreign)).toEqual(hidden);
    const response = await other.world.api.request('GET', `/api/tenant/employment/employees/${foreign.id}`, {
      user: reader.as.user,
      tenant: other.world.tenant.id,
    });
    expect([401, 403]).toContain(response.status);
  });
});
