import { randomUUID } from 'node:crypto';
import {
  eq,
  orgVersions,
  orgHierarchyLinks,
  permissionDynamicOrgGrants,
  permissionGrants,
  permissionIdentityScopes,
  permissionScopeApps,
  permissionScopePolicies,
  permissionScopePolicyRules,
  permissionUserPersonLinks,
  withTenant,
} from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { resolveDataScope } from '../../apps/api/src/modules/permission/scope-resolver.js';
import { scopeAllows } from '../../apps/api/src/modules/permission/module-access.js';
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
const date = '2026-10-01';
async function fixture() {
  const world = await seedPermissionWorld(database().db);
  const setup = tenantApi(world.db, { clock: () => new Date(`${date}T01:00:00Z`) });
  const user = await addMember(world, 'scope-subject');
  const profile = await createProfile(world, `p${randomUUID()}`, { apps: ['TenantBase', 'Other', 'Attendance'] });
  await makeGrantable(world, [profile.id]);
  expect((await grant(world, user.id, profile.id)).status).toBe(201);
  const employee = async (name: string) => {
    const r = await setup.request('POST', '/api/tenant/employment/employees', {
      ...world.asAdmin,
      ifMatch: 0,
      body: { name, code: randomUUID() },
    });
    expect(r.status, await r.clone().text()).toBe(201);
    return (await r.json()) as { id: string; revision: number };
  };
  const org = async (name: string, parentId = world.tenant.id, extra = {}) => {
    const r = await setup.request('POST', '/api/tenant/org/organizations', {
      ...world.asAdmin,
      ifMatch: 0,
      body: { name, startDate: '2025-01-01', parents: { admin: { parentId } }, ...extra },
    });
    expect(r.status, await r.clone().text()).toBe(201);
    return (await r.json()) as { id: string; revision: number };
  };
  const resolve = (extra = {}) =>
    withTenant(world.db, world.tenant.id, (tx) =>
      resolveDataScope(tx, {
        tenantId: world.tenant.id,
        userId: user.id,
        appCode: 'TenantBase',
        asOf: date,
        objectCode: MODULE_OBJECTS.employmentRecord.code,
        ...extra,
      }),
    );
  const assign = async (orgRanges: { orgId: string; includeDescendants: boolean }[], revision = 0) => {
    const r = await world.api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
      ...world.asAdmin,
      ifMatch: revision,
      body: { kind: 'org_range', orgRanges },
    });
    expect(r.status, await r.clone().text()).toBe(200);
  };
  return { ...world, setup, user, profile, employee, org, resolve, assign };
}

describe('AC-PRM-03~07/17/18/21 scope resolution and policy priority', () => {
  it('per-root expansion, disabled subtree pruning, app separation and default empty', async () => {
    const w = await fixture();
    const root = await w.org('范围根');
    const child = await w.org('下级', root.id);
    const disabled = await w.org('已停用', root.id, { enabled: false });
    await w.org('停用下级', disabled.id);
    const other = await w.org('另一个根');
    await w.org('不展开子级', other.id);
    expect((await w.resolve()).hasDataPermission).toBe(false);
    await w.assign([
      { orgId: root.id, includeDescendants: true },
      { orgId: other.id, includeDescendants: false },
    ]);
    expect([...(await w.resolve()).orgIds].sort()).toEqual([root.id, child.id, other.id].sort());
    expect((await w.resolve({ appCode: 'Other' })).orgIds).toEqual([]);
    await w.assign([{ orgId: root.id, includeDescendants: false }], 1);
    expect((await w.resolve()).orgIds).toEqual([root.id]);
  });

  it('identity > page/datasource > entity; rules union and explicit empty replaces lower-level rules', async () => {
    const w = await fixture();
    const org = await w.org('原范围');
    await w.assign([{ orgId: org.id, includeDescendants: false }]);
    await withTenant(w.db, w.tenant.id, async (tx) => {
      const [entity] = await tx
        .insert(permissionScopePolicies)
        .values({
          tenantId: w.tenant.id,
          appCode: 'TenantBase',
          objectCode: MODULE_OBJECTS.employmentRecord.code,
          targetKind: 'entity',
          targetCode: MODULE_OBJECTS.employmentRecord.code,
          personField: 'employeeId',
          departmentField: 'departmentId',
        })
        .returning();
      // Empty entity policy is an intentional deny, not a fallback to management.
      const [page] = await tx
        .insert(permissionScopePolicies)
        .values({
          tenantId: w.tenant.id,
          appCode: 'TenantBase',
          objectCode: MODULE_OBJECTS.employmentRecord.code,
          targetKind: 'page',
          targetCode: `${MODULE_OBJECTS.employmentRecord.code}.list`,
        })
        .returning();
      await tx.insert(permissionScopePolicyRules).values([
        { tenantId: w.tenant.id, policyId: page!.id, dimension: 'management' },
        { tenantId: w.tenant.id, policyId: page!.id, dimension: 'using_user' },
      ]);
      expect(entity).toBeDefined();
    });
    expect((await w.resolve()).hasDataPermission).toBe(false);
    const pageScope = await w.resolve({ pageCode: `${MODULE_OBJECTS.employmentRecord.code}.list` });
    expect(pageScope.source).toBe('page');
    expect(pageScope.orgIds).toEqual([org.id]);
    expect(scopeAllows(pageScope, { creatorId: w.user.id })).toBe(true);
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.insert(permissionIdentityScopes).values({
        tenantId: w.tenant.id,
        profileId: w.profile.id,
        appCode: 'TenantBase',
        targetKind: 'app',
        targetCode: '',
        seeAll: true,
      }),
    );
    const all = await w.resolve({ pageCode: `${MODULE_OBJECTS.employmentRecord.code}.list` });
    expect(all.all).toBe(true);
    expect(all.source).toBe('identity');
    expect((await w.resolve({ appCode: 'Other' })).all).toBe(false);
  });

  it('explicit dynamic org grants work only in HR/attendance and only with default MOU', async () => {
    const w = await fixture();
    const person = await w.employee('负责人');
    const org = await w.org('负责组织');
    // Trusted fixture for the pre-existing org-role data: T03 personnel-reference writer is still deferred.
    await withTenant(w.db, w.tenant.id, async (tx) => {
      const [old] = await tx.select().from(orgVersions).where(eq(orgVersions.orgId, org.id));
      const versionId = randomUUID();
      await tx
        .insert(orgVersions)
        .values({ ...old!, id: versionId, versionNo: 2, previousVersionId: old!.id, personInChargeId: person.id });
      const links = await tx.select().from(orgHierarchyLinks).where(eq(orgHierarchyLinks.versionId, old!.id));
      await tx.insert(orgHierarchyLinks).values(links.map((link) => ({ ...link, versionId })));
    });
    const child = await w.org('负责组织下级', org.id);
    const manual = await w.org('显式范围优先');
    const autoProfile = await createProfile(w, `auto${randomUUID()}`, { apps: ['TenantBase', 'Other', 'Attendance'] });
    await withTenant(w.db, w.tenant.id, async (tx) => {
      await tx
        .insert(permissionUserPersonLinks)
        .values({ tenantId: w.tenant.id, userId: w.user.id, employeeId: person.id });
      const p = await tx
        .insert(permissionGrants)
        .values({ tenantId: w.tenant.id, userId: w.user.id, profileId: autoProfile.id, source: 'auto' })
        .returning();
      await tx
        .insert(permissionDynamicOrgGrants)
        .values({ tenantId: w.tenant.id, grantId: p[0]!.id, roleCode: 'head' });
      await tx.insert(permissionScopeApps).values({
        tenantId: w.tenant.id,
        appCode: 'Attendance',
        family: 'attendance',
        allowedKinds: ['default', 'mou', 'org_range'],
      });
    });
    expect((await w.resolve()).orgIds).toEqual([org.id]);
    expect((await w.resolve()).orgIds).not.toContain(child.id);
    expect((await w.resolve({ appCode: 'Attendance' })).orgIds).toEqual([org.id]);
    expect((await w.resolve({ appCode: 'Other' })).orgIds).toEqual([]);
    await w.assign([{ orgId: manual.id, includeDescendants: false }]);
    expect((await w.resolve()).orgIds).toEqual([manual.id]);
    const pageCode = `${MODULE_OBJECTS.employmentRecord.code}.list`;
    await withTenant(w.db, w.tenant.id, async (tx) => {
      const [page] = await tx
        .insert(permissionScopePolicies)
        .values({
          tenantId: w.tenant.id,
          appCode: 'TenantBase',
          objectCode: MODULE_OBJECTS.employmentRecord.code,
          targetKind: 'page',
          targetCode: pageCode,
          personField: 'employeeId',
          departmentField: 'departmentId',
        })
        .returning();
      await tx
        .insert(permissionScopePolicyRules)
        .values({ tenantId: w.tenant.id, policyId: page!.id, dimension: 'organization', roleCode: 'head' });
    });
    // A page organization-relation rule explicitly includes all descendants, unlike dynamic default-MOU grants.
    expect([...(await w.resolve({ pageCode })).orgIds].sort()).toEqual([org.id, child.id].sort());
    await withTenant(w.db, w.tenant.id, async (tx) => {
      const [old] = await tx
        .select()
        .from(orgVersions)
        .where(eq(orgVersions.orgId, org.id))
        .orderBy(orgVersions.versionNo);
      const versionId = randomUUID();
      await tx
        .insert(orgVersions)
        .values({ ...old!, id: versionId, versionNo: 3, previousVersionId: old!.id, personInChargeId: null });
      const links = await tx.select().from(orgHierarchyLinks).where(eq(orgHierarchyLinks.versionId, old!.id));
      await tx.insert(orgHierarchyLinks).values(links.map((link) => ({ ...link, versionId })));
    });
    expect((await w.resolve({ pageCode })).orgIds).toEqual([]); // No cache or manual scope reset is needed.
  });
  it('reporting and using-user policies filter actual lists', async () => {
    const w = await fixture();
    const org = await w.org('汇报部门');
    const manager = await w.employee('经理');
    const direct = await w.employee('直线下属');
    const grandchild = await w.employee('隔级下属');
    const dotted = await w.employee('虚线下属');
    for (const [person, directManagerId, dottedManagerId] of [
      [manager, null, null],
      [direct, manager.id, null],
      [grandchild, direct.id, null],
      [dotted, null, manager.id],
    ] as const) {
      const r = await w.setup.request('POST', `/api/tenant/employment/employees/${person.id}/businesses`, {
        ...w.asAdmin,
        ifMatch: person.revision,
        body: {
          kind: 'hire',
          mode: 'direct',
          effectiveDate: '2026-01-01',
          fields: { departmentId: org.id, directManagerId, dottedManagerId },
        },
      });
      expect(r.status, await r.clone().text()).toBe(201);
    }
    await setObjectPermission(
      w,
      w.profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: [{ fieldCode: 'id', view: true, edit: false }],
        buttons: [],
      },
      MODULE_OBJECTS.employee.code,
    );
    const pageCode = `${MODULE_OBJECTS.employee.code}.list`;
    let policyId = '';
    await withTenant(w.db, w.tenant.id, async (tx) => {
      await tx
        .insert(permissionUserPersonLinks)
        .values({ tenantId: w.tenant.id, userId: w.user.id, employeeId: manager.id });
      const [page] = await tx
        .insert(permissionScopePolicies)
        .values({
          tenantId: w.tenant.id,
          appCode: 'TenantBase',
          objectCode: MODULE_OBJECTS.employee.code,
          targetKind: 'page',
          targetCode: pageCode,
          personField: 'id',
        })
        .returning();
      policyId = page!.id;
      await tx
        .insert(permissionScopePolicyRules)
        .values({ tenantId: w.tenant.id, policyId, dimension: 'reporting', relationMode: 'direct' });
    });
    const api = tenantApi(w.db, { authorize: undefined, clock: () => new Date(`${date}T01:00:00Z`) });
    const ids = async () => {
      const response = await api.request('GET', '/api/tenant/employment/employees', {
        user: w.user.id,
        tenant: w.tenant.id,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { items: { id: string }[] }).items.map((p) => p.id).sort();
    };
    expect(await ids()).toEqual([direct.id]);
    let revision = 1;
    const policy = async (rule: Record<string, unknown>) => {
      const r = await w.api.request(
        'PUT',
        `/api/tenant/permission/scope-policies/TenantBase/${MODULE_OBJECTS.employee.code}/page/${pageCode}`,
        {
          ...w.asAdmin,
          ifMatch: revision,
          body: { personField: 'id', rules: [rule] },
        },
      );
      expect(r.status, await r.clone().text()).toBe(200);
      revision++;
    };
    await policy({ dimension: 'reporting', relationMode: 'all_direct' });
    expect(await ids()).toEqual([direct.id, grandchild.id].sort());
    await policy({ dimension: 'reporting', relationMode: 'dotted' });
    expect(await ids()).toEqual([dotted.id]);
    const managerNow = await w.setup.request('GET', `/api/tenant/employment/employees/${manager.id}`, w.asAdmin);
    const managerRevision = ((await managerNow.json()) as { revision: number }).revision;
    const cycle = await w.setup.request('POST', `/api/tenant/employment/employees/${manager.id}/businesses`, {
      ...w.asAdmin,
      ifMatch: managerRevision,
      body: {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { directManagerId: direct.id, dottedManagerId: dotted.id },
      },
    });
    expect(cycle.status, await cycle.clone().text()).toBe(201);
    await policy({ dimension: 'reporting', relationMode: 'direct_mixed' });
    expect(await ids()).toEqual([direct.id, grandchild.id].sort());
    await policy({ dimension: 'reporting', relationMode: 'dotted_mixed' });
    expect(await ids()).toEqual([dotted.id]);
    await policy({ dimension: 'reporting', relationMode: 'part_time' });
    expect(await ids()).toEqual([]);
    await policy({ dimension: 'using_user' });
    expect(await ids()).toEqual([]); // actor who did not create the employees sees none
    await grant(w, w.admin.id, w.profile.id);
    const owner = await api.request('GET', '/api/tenant/employment/employees', w.asAdmin);
    expect(owner.status, await owner.clone().text()).toBe(200);
    expect(((await owner.json()) as { items: unknown[] }).items).toHaveLength(4);
  });
});
