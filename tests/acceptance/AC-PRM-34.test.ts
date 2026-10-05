/** AC-PRM-34：数据范围内的组织停用后范围不收缩（DEC-146，`11` §18）；不含下级与跨租户隔离不变。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS, type OrgId } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
  type PermissionWorld,
} from './AC-PRM-support.js';
import { expandScopeRoots, scopeHierarchyReader } from '../../apps/api/src/modules/permission/scope-hierarchy.js';
import { tenantApi } from './support/tenant-api.js';
import { loginEmailOf } from './AC-EMP-support.js';

const database = useTestDb();
const clock = () => new Date('2026-10-01T01:00:00.000Z');

interface Created {
  id: string;
  revision: number;
  employeeRevision?: number;
}

async function tenantFixture() {
  const db = database().db;
  const seed = await seedPermissionWorld(db);
  const api = tenantApi(db, { authorize: undefined, clock });
  const setup = tenantApi(db, { clock });
  const world = { ...seed, api };
  async function send(method: 'POST' | 'PATCH', path: string, body: unknown, revision: number) {
    const response = await setup.request(method, `/api/tenant/${path}`, { ...world.asAdmin, ifMatch: revision, body });
    expect(response.status, await response.clone().text()).toBe(method === 'POST' ? 201 : 200);
    return (await response.json()) as Created;
  }
  const org = (name: string, parentId = world.tenant.id) =>
    send('POST', 'org/organizations', { name, establishedOn: '2025-01-01', parents: { admin: { parentId } } }, 0);
  // 停用产生一条新的组织版本，而不是建档时直接停用。DEC-129 下整支仍有在职人员时接口拒绝停用（AC-ORG-14），
  // “停用组织下仍挂着在职员工”只会来自存量 / 导入数据（`11` §18 原站样本即此情形），所以这里与
  // AC-SUB-04-sort-ranks 同法直接写库追加停用版本，层级链接照抄原版本（下级不随之停用）。
  async function disable(organization: Created) {
    await withTenant(db, world.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT id FROM org_versions WHERE org_id=${organization.id}::uuid
        ORDER BY start_date DESC, version_no DESC LIMIT 1`);
      const [old] = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { id: string }[];
      const versionId = randomUUID();
      await tx.execute(sql`INSERT INTO org_versions
        SELECT (jsonb_populate_record(NULL::org_versions, to_jsonb(v) || jsonb_build_object(
          'id',${versionId}::uuid,'version_no',v.version_no+1,'previous_version_id',v.id,
          'start_date','2026-09-01'::date,'enabled',false))).*
        FROM org_versions v WHERE v.id=${old!.id}::uuid`);
      await tx.execute(sql`INSERT INTO org_hierarchy_links(tenant_id,version_id,dimension,parent_org_id,sequence)
        SELECT tenant_id, ${versionId}::uuid, dimension, parent_org_id, sequence
        FROM org_hierarchy_links WHERE version_id=${old!.id}::uuid`);
    });
  }
  async function employee(departmentId: string) {
    const created = await send('POST', 'employment/employees', { code: `E_${randomUUID()}`, name: '停用组织员工' }, 0);
    const hire = await send(
      'POST',
      `employment/employees/${created.id}/businesses`,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-01-01',
        fields: { departmentId },
        loginEmail: loginEmailOf(created.id),
      },
      created.revision,
    );
    return { id: created.id, recordId: hire.id };
  }
  const profile = await createProfile(world, `scope-disabled-${randomUUID().slice(0, 8)}`);
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
    expect(response.status, await response.clone().text()).toBe(200);
  }
  await makeGrantable(world, [profile.id]);
  async function reader(label: string, orgRanges: { orgId: string; includeDescendants: boolean }[]) {
    const user = await addMember(world, label);
    expect((await grant(world, user.id, profile.id)).status).toBe(201);
    const response = await api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return { user: user.id, tenant: world.tenant.id };
  }
  return { world, org, disable, employee, reader };
}

type Identity = { user: string; tenant: string };
type Employee = { id: string; recordId: string };

async function visibility(world: PermissionWorld, as: Identity, person: Employee) {
  const get = (path: string) => world.api.request('GET', `/api/tenant/employment${path}`, as);
  const list = await get('/employees');
  expect(list.status).toBe(200);
  const listed = ((await list.json()) as { items: { id: string }[] }).items.some((item) => item.id === person.id);
  const records = await get(`/employees/${person.id}/records`);
  const recordIds =
    records.status === 200 ? ((await records.json()) as { items: { id: string }[] }).items.map((r) => r.id) : [];
  return {
    listed,
    detail: (await get(`/employees/${person.id}`)).status,
    records: recordIds,
    record: (await get(`/records/${person.recordId}`)).status,
  };
}

const visible = (person: Employee) => ({ listed: true, detail: 200, records: [person.recordId], record: 200 });
const hidden = { listed: false, detail: 404, records: [], record: 404 };

describe('AC-PRM-34 数据范围内的组织停用后范围不收缩（DEC-146）', () => {
  let a: Awaited<ReturnType<typeof tenantFixture>>;
  let b: Awaited<ReturnType<typeof tenantFixture>>;
  let people: Record<'disabledChild' | 'underDisabled' | 'disabledRoot' | 'underDisabledRoot' | 'tenantB', Employee>;
  let readers: Record<'withDescendants' | 'rootOnly' | 'disabledRoot', Identity>;
  let tenantBOrgs: { root: string; disabled: string };
  let orgs: Record<'root' | 'disabledChild' | 'grandchild' | 'disabledRoot' | 'underDisabledRoot', string>;

  beforeAll(async () => {
    a = await tenantFixture();
    b = await tenantFixture();
    // 租户 A：范围根（启用）→ 被停用的下级 → 其下级（仍启用）；另一棵树的根本身被停用。
    const root = await a.org('范围根');
    const disabledChild = await a.org('停用下级', root.id);
    const grandchild = await a.org('停用下级的下级', disabledChild.id);
    const disabledRoot = await a.org('停用的范围根');
    const underDisabledRoot = await a.org('停用根的下级', disabledRoot.id);
    orgs = {
      root: root.id,
      disabledChild: disabledChild.id,
      grandchild: grandchild.id,
      disabledRoot: disabledRoot.id,
      underDisabledRoot: underDisabledRoot.id,
    };
    people = {
      disabledChild: await a.employee(disabledChild.id),
      underDisabled: await a.employee(grandchild.id),
      disabledRoot: await a.employee(disabledRoot.id),
      underDisabledRoot: await a.employee(underDisabledRoot.id),
      tenantB: { id: '', recordId: '' },
    };
    await a.disable(disabledChild);
    await a.disable(disabledRoot);
    // 租户 B 结构相同、同样有停用组织，用于验证跨租户隔离不因新口径放宽。
    const rootB = await b.org('B 范围根');
    const disabledB = await b.org('B 停用下级', rootB.id);
    people.tenantB = await b.employee(disabledB.id);
    await b.disable(disabledB);
    tenantBOrgs = { root: rootB.id, disabled: disabledB.id };
    readers = {
      withDescendants: await a.reader('with-descendants', [{ orgId: root.id, includeDescendants: true }]),
      rootOnly: await a.reader('root-only', [{ orgId: root.id, includeDescendants: false }]),
      disabledRoot: await a.reader('disabled-root', [{ orgId: disabledRoot.id, includeDescendants: true }]),
    };
  });

  it('“含下级”范围内，已停用下级组织及其子树下员工的人员信息与任职仍可见', async () => {
    const as = readers.withDescendants;
    expect(await visibility(a.world, as, people.disabledChild)).toEqual(visible(people.disabledChild));
    expect(await visibility(a.world, as, people.underDisabled)).toEqual(visible(people.underDisabled));
    expect(await visibility(a.world, as, people.disabledRoot)).toEqual(hidden);
  });

  it('范围根本身停用时同样不收缩：根与其下级的员工仍可见', async () => {
    const as = readers.disabledRoot;
    expect(await visibility(a.world, as, people.disabledRoot)).toEqual(visible(people.disabledRoot));
    expect(await visibility(a.world, as, people.underDisabledRoot)).toEqual(visible(people.underDisabledRoot));
    expect(await visibility(a.world, as, people.disabledChild)).toEqual(hidden);
  });

  it('不含下级的范围不受影响：停用下级组织的员工仍不可见', async () => {
    const as = readers.rootOnly;
    expect(await visibility(a.world, as, people.disabledChild)).toEqual(hidden);
    expect(await visibility(a.world, as, people.underDisabled)).toEqual(hidden);
  });

  it('跨租户隔离不变：不能用其他租户的停用组织配置范围，也看不到其员工', async () => {
    const as = readers.withDescendants;
    expect(await visibility(a.world, as, people.tenantB)).toEqual(hidden);
    const foreign = await a.world.api.request('GET', `/api/tenant/employment/employees/${people.tenantB.id}`, {
      user: as.user,
      tenant: b.world.tenant.id,
    });
    expect([401, 403]).toContain(foreign.status);
    const user = await addMember(a.world, 'foreign-scope');
    const assign = await a.world.api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
      ...a.world.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId: tenantBOrgs.root, includeDescendants: true }] },
    });
    expect(assign.status).toBeGreaterThanOrEqual(400);
  });

  it('范围展开读取器按 DEC-146 显式包含停用组织；isEnabled 如实反映停用，但不再决定范围根是否纳入', async () => {
    const tenantId = a.world.tenant.id;
    const asOf = '2026-10-01';
    const roots = [
      { orgId: orgs.root, dimension: 'admin', includeDescendants: true },
      { orgId: orgs.disabledRoot, dimension: 'admin', includeDescendants: true },
    ];
    await withTenant(a.world.db, tenantId, async (tx) => {
      const reader = scopeHierarchyReader(tx, tenantId, asOf, roots);
      const query = (orgId: string) => ({
        tenantId,
        asOf: asOf as `${number}-${number}-${number}`,
        orgId: orgId as OrgId,
      });
      expect(
        [
          ...(await reader.listDescendantIds({ ...query(orgs.root), dimension: 'admin' }, { includeDisabled: true })),
        ].sort(),
      ).toEqual([orgs.disabledChild, orgs.grandchild].sort());
      // 数据范围不允许按停用剪枝：误传 false 直接报错，而不是悄悄收缩。
      await expect(
        reader.listDescendantIds({ ...query(orgs.root), dimension: 'admin' }, { includeDisabled: false }),
      ).rejects.toThrow(TypeError);
      expect(await reader.isEnabled(query(orgs.root))).toBe(true);
      expect(await reader.isEnabled(query(orgs.disabledRoot))).toBe(false);
      expect([...(await expandScopeRoots(tx, tenantId, asOf, roots))].sort()).toEqual(Object.values(orgs).sort());
      // 其他租户的组织即使写进范围根也解析为空（租户隔离）。
      const foreign = [{ orgId: tenantBOrgs.root, dimension: 'admin', includeDescendants: true }];
      expect(await expandScopeRoots(tx, tenantId, asOf, foreign)).toEqual([]);
    });
  });
});
