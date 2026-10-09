/**
 * AC-TEN-02 补充（硬规则 7“一个用户可以属于多个租户”；AGENTS.md §10「权限」每次请求重验）：
 * - 同一用户属于两个租户，切换 X-Tenant-Id 分别只看到对应租户的数据；
 * - 撤销成员关系后，下一次请求立即 403；
 * - 租户 suspended / restoring（恢复隔离中，DEC-061）时业务请求一律拒绝；
 * - 用户被停用后身份失效 → 401。
 */
import { createUser, getTenant, grantMembership, revokeMembership, setTenantStatus, setUserStatus } from '@italent/db';
import { installTenantProbe, useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { PROBE_POLICIES, probeRoutes } from './support/probe-routes.js';
import { cmd, errorCode, seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

type Seeded = Awaited<ReturnType<typeof seedTenantWithMember>>;

async function names(res: Response): Promise<string[]> {
  const { items } = (await res.json()) as { items: { name: string }[] };
  return items.map((r) => r.name);
}

describe('成员关系与租户状态：每次请求在服务端重验', () => {
  let a: Seeded;
  let b: Seeded;
  let shared: { id: string };
  let api: ReturnType<typeof tenantApi>;

  beforeAll(async () => {
    const { db } = testDb();
    await installTenantProbe(db);
    a = await seedTenantWithMember(db, 'a');
    b = await seedTenantWithMember(db, 'b');
    shared = await createUser(db, { email: 'shared-hr@example.com', displayName: '双租户 HR' }, cmd());
    await grantMembership(db, { tenantId: a.tenant.id, userId: shared.id, expectedRevision: 0 }, cmd(a.user.id));
    await grantMembership(db, { tenantId: b.tenant.id, userId: shared.id, expectedRevision: 0 }, cmd(b.user.id));

    api = tenantApi(db, { tenantRoutes: [probeRoutes], routePolicies: [PROBE_POLICIES] });
    await api.request('POST', '/api/tenant/probes', { user: a.user.id, tenant: a.tenant.id, body: { name: 'A-1' } });
    await api.request('POST', '/api/tenant/probes', { user: b.user.id, tenant: b.tenant.id, body: { name: 'B-1' } });
  });

  it('同一用户切换 X-Tenant-Id，分别只看到对应租户的数据', async () => {
    const inA = await api.request('GET', '/api/tenant/probes', { user: shared.id, tenant: a.tenant.id });
    const inB = await api.request('GET', '/api/tenant/probes', { user: shared.id, tenant: b.tenant.id });
    expect(await names(inA)).toEqual(['A-1']);
    expect(await names(inB)).toEqual(['B-1']);
  });

  it('撤销在 B 的成员关系后，下一次请求立即 403，A 不受影响', async () => {
    const { db } = testDb();
    const before = await api.request('GET', '/api/tenant/probes', { user: shared.id, tenant: b.tenant.id });
    expect(before.status).toBe(200);

    await revokeMembership(db, { tenantId: b.tenant.id, userId: shared.id, expectedRevision: 1 }, cmd(b.user.id));

    const after = await api.request('GET', '/api/tenant/probes', { user: shared.id, tenant: b.tenant.id });
    expect(after.status).toBe(403);
    expect(await errorCode(after)).toBe('TENANT_NOT_MEMBER');
    const stillA = await api.request('GET', '/api/tenant/probes', { user: shared.id, tenant: a.tenant.id });
    expect(stillA.status).toBe(200);
  });

  it.each(['suspended', 'restoring'] as const)('租户状态为 %s 时业务请求 403 TENANT_UNAVAILABLE', async (status) => {
    const { db } = testDb();
    const expectedRevision = (await getTenant(db, a.tenant.id))!.revision;
    const suspended = await setTenantStatus(db, { tenantId: a.tenant.id, status, expectedRevision }, cmd());
    try {
      const res = await api.request('GET', '/api/tenant/probes', { user: a.user.id, tenant: a.tenant.id });
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('TENANT_UNAVAILABLE');
    } finally {
      await setTenantStatus(
        db,
        { tenantId: a.tenant.id, status: 'active', expectedRevision: suspended.revision },
        cmd(),
      );
    }
    const restored = await api.request('GET', '/api/tenant/probes', { user: a.user.id, tenant: a.tenant.id });
    expect(restored.status).toBe(200);
  });

  it('非成员访问停用租户时仍返回 TENANT_NOT_MEMBER，不暴露租户状态', async () => {
    const { db } = testDb();
    const expectedRevision = (await getTenant(db, b.tenant.id))!.revision;
    const suspended = await setTenantStatus(
      db,
      { tenantId: b.tenant.id, status: 'suspended', expectedRevision },
      cmd(),
    );
    try {
      const res = await api.request('GET', '/api/tenant/probes', { user: a.user.id, tenant: b.tenant.id });
      expect(await errorCode(res)).toBe('TENANT_NOT_MEMBER');
    } finally {
      await setTenantStatus(
        db,
        { tenantId: b.tenant.id, status: 'active', expectedRevision: suspended.revision },
        cmd(),
      );
    }
  });

  it('用户被停用后下一次请求 401 UNAUTHENTICATED', async () => {
    const { db } = testDb();
    const res0 = await api.request('GET', '/api/tenant/probes', { user: b.user.id, tenant: b.tenant.id });
    expect(res0.status).toBe(200);
    await setUserStatus(db, { userId: b.user.id, status: 'disabled', expectedRevision: b.user.revision }, cmd());
    const res = await api.request('GET', '/api/tenant/probes', { user: b.user.id, tenant: b.tenant.id });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('UNAUTHENTICATED');
  });
});
