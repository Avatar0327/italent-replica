/** Resolver组合边界：真实租户/范围/策略配置，派生reader桩只模拟合法的大结果，SQL规模另由性能测试覆盖。 */
import { randomUUID } from 'node:crypto';
import {
  employmentEmployees,
  orgObjects,
  orgVersions,
  permissionMous,
  permissionMouOrgRefs,
  permissionScopePolicies,
  permissionScopePolicyRules,
  permissionUserAppScopes,
  permissionUserPersonLinks,
  withTenant,
} from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ScopeHierarchy from '../../apps/api/src/modules/permission/scope-hierarchy.js';
import { expandScopeRoots } from '../../apps/api/src/modules/permission/scope-hierarchy.js';
import type * as ScopePersons from '../../apps/api/src/modules/permission/scope-persons.js';
import { managedPersons, reportingPersons } from '../../apps/api/src/modules/permission/scope-persons.js';
import { resolveDataScope } from '../../apps/api/src/modules/permission/scope-resolver.js';
import { seedTenantWithMember } from './support/tenant-api.js';

vi.mock('../../apps/api/src/modules/permission/scope-hierarchy.js', async (original) => ({
  ...(await original<typeof ScopeHierarchy>()),
  expandScopeRoots: vi.fn(),
}));
vi.mock('../../apps/api/src/modules/permission/scope-persons.js', async (original) => ({
  ...(await original<typeof ScopePersons>()),
  managedPersons: vi.fn(),
  reportingPersons: vi.fn(),
}));

const database = useTestDb();
const asOf = '2026-10-01';
const ids = (start: number, size: number) =>
  Array.from({ length: size }, (_, n) => `00000000-0000-4000-8000-${String(start + n).padStart(12, '0')}`);
type Rule = { dimension: 'management' | 'organization' | 'reporting'; roleCode?: string; relationMode?: string };

async function fixture(rules: Rule[]) {
  const { db } = database();
  const { tenant, user } = await seedTenantWithMember(db, 'scope-bound');
  const [mouRoot, roleRoot, employeeId] = [randomUUID(), randomUUID(), randomUUID()];
  await withTenant(db, tenant.id, async (tx) => {
    await tx
      .insert(employmentEmployees)
      .values({ id: employeeId, tenantId: tenant.id, code: 'person', name: '合成人员' });
    await tx.insert(permissionUserPersonLinks).values({ tenantId: tenant.id, userId: user.id, employeeId });
    await tx.insert(orgObjects).values([mouRoot, roleRoot].map((id) => ({ id, tenantId: tenant.id })));
    await tx.insert(orgVersions).values(
      [mouRoot, roleRoot].map((orgId) => ({
        tenantId: tenant.id,
        orgId,
        versionNo: 1,
        startDate: '2025-01-01',
        code: orgId,
        name: orgId,
        fullName: orgId,
        personInChargeId: orgId === roleRoot ? employeeId : null,
      })),
    );
    const [mou] = await tx
      .insert(permissionMous)
      .values({ tenantId: tenant.id, code: 'mou', name: '管理单元' })
      .returning();
    await tx
      .insert(permissionMouOrgRefs)
      .values({ tenantId: tenant.id, mouId: mou!.id, orgId: mouRoot, includeDescendants: true });
    await tx
      .insert(permissionUserAppScopes)
      .values({ tenantId: tenant.id, userId: user.id, appCode: 'TenantBase', kind: 'mou', mouId: mou!.id });
    const [policy] = await tx
      .insert(permissionScopePolicies)
      .values({
        tenantId: tenant.id,
        appCode: 'TenantBase',
        objectCode: 'TenantBase.EmploymentRecord',
        targetKind: 'entity',
        targetCode: 'TenantBase.EmploymentRecord',
      })
      .returning();
    await tx.insert(permissionScopePolicyRules).values(
      rules.map((rule) => ({
        tenantId: tenant.id,
        policyId: policy!.id,
        ...rule,
      })),
    );
  });
  return {
    mouRoot,
    roleRoot,
    resolve: () =>
      withTenant(db, tenant.id, (tx) =>
        resolveDataScope(tx, {
          tenantId: tenant.id,
          userId: user.id,
          appCode: 'TenantBase',
          asOf,
          objectCode: 'TenantBase.EmploymentRecord',
        }),
      ),
  };
}

describe('AC-PRM 范围并集保留20,000上限与重复规则复用', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('两条合法人员范围各≤20,000，但最终并集20,001时拒绝整个解析', async () => {
    const world = await fixture([{ dimension: 'management' }, { dimension: 'reporting', relationMode: 'direct' }]);
    vi.mocked(expandScopeRoots).mockResolvedValue([world.mouRoot]);
    vi.mocked(managedPersons).mockResolvedValue(ids(1, 10_001));
    vi.mocked(reportingPersons).mockResolvedValue(ids(10_002, 10_000));
    await expect(world.resolve()).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('管理单元与组织关系的组织并集超过20,000时拒绝，不能把每term上限当总上限', async () => {
    const world = await fixture([{ dimension: 'management' }, { dimension: 'organization', roleCode: 'head' }]);
    vi.mocked(expandScopeRoots).mockImplementation(async (_tx, _tenant, _date, roots) =>
      roots[0]?.orgId === world.mouRoot ? ids(1, 10_001) : ids(10_002, 10_000),
    );
    vi.mocked(managedPersons).mockResolvedValue([]);
    await expect(world.resolve()).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('20条重复组织/汇报配置只展开两个不同规则，保留OR语义且不复制巨大的SQL谓词', async () => {
    const world = await fixture(
      Array.from({ length: 20 }, (_, n) =>
        n % 2
          ? { dimension: 'reporting' as const, relationMode: 'direct' }
          : { dimension: 'organization' as const, roleCode: 'head' },
      ),
    );
    vi.mocked(expandScopeRoots).mockResolvedValue([world.roleRoot]);
    vi.mocked(managedPersons).mockResolvedValue(ids(1, 2));
    vi.mocked(reportingPersons).mockResolvedValue(ids(3, 2));
    const result = await world.resolve();
    expect(result.personIds).toHaveLength(4);
    expect(result.terms).toHaveLength(2);
    expect(expandScopeRoots).toHaveBeenCalledTimes(1);
    expect(managedPersons).toHaveBeenCalledTimes(1);
    expect(reportingPersons).toHaveBeenCalledTimes(1);
  });

  it('重叠的两个20,000人员集合按去重后的并集计算，不能误拒绝', async () => {
    const world = await fixture([{ dimension: 'management' }, { dimension: 'reporting', relationMode: 'direct' }]);
    vi.mocked(expandScopeRoots).mockResolvedValue([world.mouRoot]);
    vi.mocked(managedPersons).mockResolvedValue(ids(1, 20_000));
    vi.mocked(reportingPersons).mockResolvedValue(ids(1, 20_000));
    const result = await world.resolve();
    expect(result.personIds).toHaveLength(20_000);
    expect(result.hasDataPermission).toBe(true);
  });

  it('超出管理API的20条规则上限的存量策略也拒绝，不能静默截断或放大查询预算', async () => {
    const world = await fixture(Array.from({ length: 21 }, () => ({ dimension: 'management' as const })));
    vi.mocked(expandScopeRoots).mockResolvedValue([world.mouRoot]);
    vi.mocked(managedPersons).mockResolvedValue([]);
    await expect(world.resolve()).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
});
