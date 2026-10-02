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
import { resolveDataScope } from '../../apps/api/src/modules/permission/scope-resolver.js';
import { seedTenantWithMember } from './support/tenant-api.js';

vi.mock('../../apps/api/src/modules/permission/scope-hierarchy.js', async (original) => ({
  ...(await original<typeof ScopeHierarchy>()),
  expandScopeRoots: vi.fn(),
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

describe('AC-PRM 管理人员无上限、组织与汇报范围仍有界且重复规则复用', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('管理与汇报人员保留为SQL关系条件，不在解析器中生成有上限的ID数组', async () => {
    const world = await fixture([{ dimension: 'management' }, { dimension: 'reporting', relationMode: 'direct' }]);
    vi.mocked(expandScopeRoots).mockResolvedValue([world.mouRoot]);
    const result = await world.resolve();
    expect(result.personIds).toEqual([]);
    expect(result.terms?.map((term) => term.personQuery?.kind).sort()).toEqual(['organization', 'reporting']);
  });

  it('管理单元与组织关系的组织并集超过20,000时拒绝，不能把每term上限当总上限', async () => {
    const world = await fixture([{ dimension: 'management' }, { dimension: 'organization', roleCode: 'head' }]);
    vi.mocked(expandScopeRoots).mockImplementation(async (_tx, _tenant, _date, roots) =>
      roots[0]?.orgId === world.mouRoot ? ids(1, 10_001) : ids(10_002, 10_000),
    );
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
    const result = await world.resolve();
    expect(result.personIds).toEqual([]);
    expect(result.terms).toHaveLength(2);
    expect(expandScopeRoots).toHaveBeenCalledTimes(1);
    expect(result.terms?.every((term) => !!term.personQuery)).toBe(true);
  });

  it('人员关系不受20,000并集上限影响', async () => {
    const world = await fixture([{ dimension: 'management' }, { dimension: 'reporting', relationMode: 'direct' }]);
    vi.mocked(expandScopeRoots).mockResolvedValue([world.mouRoot]);
    const result = await world.resolve();
    expect(result.personIds).toEqual([]);
    expect(result.hasDataPermission).toBe(true);
  });

  it('超出管理API的20条规则上限的存量策略也拒绝，不能静默截断或放大查询预算', async () => {
    const world = await fixture(Array.from({ length: 21 }, () => ({ dimension: 'management' as const })));
    vi.mocked(expandScopeRoots).mockResolvedValue([world.mouRoot]);
    await expect(world.resolve()).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
});
