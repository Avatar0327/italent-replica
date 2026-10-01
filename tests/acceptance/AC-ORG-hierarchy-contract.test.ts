/** R1-T03：真实组织存储实现 OrgHierarchyReader，供 R1-T02 按时点展开数据范围。 */
import type { Db } from '@italent/db';
import { ORG_DIMENSIONS, type OrgDimension, type OrgHierarchyReader, type OrgId } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const AS_OF = '2026-10-01';
const CLOCK = () => new Date('2026-10-01T04:00:00Z');

interface Organization {
  id: string;
  revision: number;
}

type Parents = Partial<Record<OrgDimension, { parentId: string; sequence?: number }>>;

async function reader(): Promise<OrgHierarchyReader> {
  // 在测试体内加载，先记录真实红测；模块尚未实现时也能正常收集每条契约用例。
  const modulePath = `${process.cwd()}/apps/api/src/modules/org/hierarchy-reader.ts`;
  const module = (await import(modulePath)) as {
    createOrgHierarchyReader(db: Db): OrgHierarchyReader;
  };
  return module.createOrgHierarchyReader(testDb().db);
}

async function fixture(label: string) {
  const { db } = testDb();
  const { tenant, user } = await seedTenantWithMember(db, label);
  const api = tenantApi(db, { clock: CLOCK });
  const identity = { tenant: tenant.id, user: user.id };
  const settings = await api.request('PUT', '/api/tenant/org/settings', {
    ...identity,
    ifMatch: 0,
    body: { enabledDimensions: ['business', 'product', 'reserve4', 'reserve5'], fullNameStartLevel: 0 },
  });
  expect(settings.status).toBe(200);

  async function create(
    name: string,
    parents: Parents = { admin: { parentId: tenant.id } },
    dates: { startDate?: string; stopDate?: string } = {},
  ): Promise<Organization> {
    const response = await api.request('POST', '/api/tenant/org/organizations', {
      ...identity,
      ifMatch: 0,
      body: { name, startDate: '2026-01-01', parents, ...dates },
    });
    expect(response.status).toBe(201);
    return (await response.json()) as Organization;
  }

  async function update(organization: Organization, body: unknown): Promise<Organization> {
    const response = await api.request('PATCH', `/api/tenant/org/organizations/${organization.id}`, {
      ...identity,
      ifMatch: organization.revision,
      body,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as Organization;
  }

  return { tenant, api, identity, create, update };
}

function query(tenantId: string, orgId: string, dimension: OrgDimension = 'admin', asOf = AS_OF) {
  return { tenantId, orgId: orgId as OrgId, dimension, asOf };
}

describe('OrgHierarchyReader 真实实现契约（AC-ORG-07、组织有效期、租户隔离）', () => {
  it('五个维度分别展开传递闭包，不混用上级，不含自身或重复 ID', async () => {
    const hierarchy = await reader();
    const f = await fixture('contract-dimensions');
    const ancestors = await Promise.all(ORG_DIMENSIONS.map((dimension) => f.create(`上级-${dimension}`)));
    const parents: Parents = {};
    for (const [index, dimension] of ORG_DIMENSIONS.entries()) {
      parents[dimension] = { parentId: ancestors[index]!.id, sequence: index + 1 };
    }
    const child = await f.create('共同下级', parents);
    const childParents: Parents = {};
    for (const dimension of ORG_DIMENSIONS) childParents[dimension] = { parentId: child.id };
    const grandchild = await f.create('共同孙级', childParents);

    for (const [index, dimension] of ORG_DIMENSIONS.entries()) {
      const ancestor = ancestors[index]!;
      const ids = await hierarchy.listDescendantIds(query(f.tenant.id, ancestor.id, dimension), {
        includeDisabled: false,
      });
      expect([...ids].sort()).toEqual([child.id, grandchild.id].sort());
      expect(ids).not.toContain(ancestor.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('必填 includeDisabled=false 剪掉停用节点和其子树，true 保留全部层级', async () => {
    const hierarchy = await reader();
    const f = await fixture('contract-disabled');
    const parent = await f.create('上级');
    const disabled = await f.create('停用分支', { admin: { parentId: parent.id } });
    const child = await f.create('停用分支的启用下级', { admin: { parentId: disabled.id } });
    const sibling = await f.create('启用分支', { admin: { parentId: parent.id } });
    await f.update(disabled, { effectiveDate: '2026-09-01', enabled: false });

    expect(await hierarchy.listDescendantIds(query(f.tenant.id, parent.id), { includeDisabled: false })).toEqual([
      sibling.id,
    ]);
    expect(
      [...(await hierarchy.listDescendantIds(query(f.tenant.id, parent.id), { includeDisabled: true }))].sort(),
    ).toEqual([disabled.id, child.id, sibling.id].sort());
    expect(await hierarchy.listDescendantIds(query(f.tenant.id, disabled.id), { includeDisabled: false })).toEqual([]);
    expect(await hierarchy.listDescendantIds(query(f.tenant.id, disabled.id), { includeDisabled: true })).toEqual([
      child.id,
    ]);
    expect(await hierarchy.isEnabled(query(f.tenant.id, disabled.id))).toBe(false);
    expect(await hierarchy.isEnabled(query(f.tenant.id, child.id))).toBe(true);
    expectTypeOf(hierarchy.listDescendantIds).parameter(1).toEqualTypeOf<{ readonly includeDisabled: boolean }>();
  });

  it('asOf 选择当日有效的组织版本与上下级关系，不使用未来调整', async () => {
    const hierarchy = await reader();
    const f = await fixture('contract-history');
    const former = await f.create('原上级');
    const next = await f.create('新上级');
    const child = await f.create('调动组织', { admin: { parentId: former.id } });
    await f.update(child, { effectiveDate: '2026-11-01', parents: { admin: { parentId: next.id } } });

    expect(await hierarchy.listDescendantIds(query(f.tenant.id, former.id), { includeDisabled: false })).toEqual([
      child.id,
    ]);
    expect(await hierarchy.listDescendantIds(query(f.tenant.id, next.id), { includeDisabled: true })).toEqual([]);
    expect(
      await hierarchy.listDescendantIds(query(f.tenant.id, former.id, 'admin', '2026-11-01'), {
        includeDisabled: true,
      }),
    ).toEqual([]);
    expect(
      await hierarchy.listDescendantIds(query(f.tenant.id, next.id, 'admin', '2026-11-01'), {
        includeDisabled: false,
      }),
    ).toEqual([child.id]);
  });

  it('启用状态也按 asOf 读取，失效日期当天有效，生效前与失效后均 fail-closed', async () => {
    const hierarchy = await reader();
    const f = await fixture('contract-dates');
    const expired = await f.create('有效期组织', undefined, { startDate: '2026-03-01', stopDate: '2026-09-30' });
    const future = await f.create('未来组织', undefined, { startDate: '2026-11-01' });
    const disabled = await f.create('停用历史组织');
    await f.update(disabled, { effectiveDate: '2026-09-01', enabled: false });

    expect(await hierarchy.isEnabled(query(f.tenant.id, expired.id, 'admin', '2026-02-28'))).toBe(false);
    expect(await hierarchy.isEnabled(query(f.tenant.id, expired.id, 'admin', '2026-03-01'))).toBe(true);
    expect(await hierarchy.isEnabled(query(f.tenant.id, expired.id, 'admin', '2026-09-30'))).toBe(true);
    expect(await hierarchy.isEnabled(query(f.tenant.id, expired.id))).toBe(false);
    expect(await hierarchy.listDescendantIds(query(f.tenant.id, expired.id), { includeDisabled: true })).toEqual([]);
    expect(await hierarchy.isEnabled(query(f.tenant.id, future.id))).toBe(false);
    expect(await hierarchy.isEnabled(query(f.tenant.id, future.id, 'admin', '2026-11-01'))).toBe(true);
    expect(await hierarchy.isEnabled(query(f.tenant.id, disabled.id, 'admin', '2026-08-31'))).toBe(true);
    expect(await hierarchy.isEnabled(query(f.tenant.id, disabled.id, 'admin', '2026-09-01'))).toBe(false);
  });

  it('关闭扩展维度后列表为空，isEnabled 仍独立于维度开关', async () => {
    const hierarchy = await reader();
    const f = await fixture('contract-settings');
    const parent = await f.create('业务上级');
    const child = await f.create('业务下级', {
      admin: { parentId: f.tenant.id },
      business: { parentId: parent.id },
    });
    expect(
      await hierarchy.listDescendantIds(query(f.tenant.id, parent.id, 'business'), { includeDisabled: false }),
    ).toEqual([child.id]);

    const response = await f.api.request('PUT', '/api/tenant/org/settings', {
      ...f.identity,
      ifMatch: 1,
      body: { enabledDimensions: [], fullNameStartLevel: 0 },
    });
    expect(response.status).toBe(200);
    expect(
      await hierarchy.listDescendantIds(query(f.tenant.id, parent.id, 'business'), { includeDisabled: true }),
    ).toEqual([]);
    expect(await hierarchy.isEnabled(query(f.tenant.id, parent.id))).toBe(true);
    expect(await hierarchy.isEnabled(query(f.tenant.id, child.id))).toBe(true);
    expect(await hierarchy.listDescendantIds(query(f.tenant.id, f.tenant.id), { includeDisabled: false })).toContain(
      child.id,
    );
  });

  it('不存在与属于其他租户的 orgId 返回空数组与 false，不能跨租户展开', async () => {
    const hierarchy = await reader();
    const a = await fixture('contract-tenant-a');
    const b = await fixture('contract-tenant-b');
    const parent = await b.create('同名组织');
    await b.create('异租户下级', { admin: { parentId: parent.id } });

    for (const id of [parent.id, '00000000-0000-4000-8000-000000000000']) {
      expect(await hierarchy.listDescendantIds(query(a.tenant.id, id), { includeDisabled: false })).toEqual([]);
      expect(await hierarchy.listDescendantIds(query(a.tenant.id, id), { includeDisabled: true })).toEqual([]);
      expect(await hierarchy.isEnabled(query(a.tenant.id, id))).toBe(false);
    }
    expect(await hierarchy.isEnabled(query(b.tenant.id, parent.id))).toBe(true);
  });
});
