/**
 * AC-TEN-01（REQ-TEN-001 R1/R2，DEC-006）：租户 A、B 各建一个同名对象，各自只看到本租户的。
 * 组织对象（R1-T03）尚未落地，用测试夹具 tenant_probe 代替“组织”；R1-T03 完成后补一条组织列表用例。
 */
import { withTenant } from '@italent/db';
import { installTenantProbe, tenantProbe, useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { probeRoutes } from './support/probe-routes.js';
import { seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

describe('AC-TEN-01 两租户同名对象互不可见', () => {
  let a: Awaited<ReturnType<typeof seedTenantWithMember>>;
  let b: Awaited<ReturnType<typeof seedTenantWithMember>>;

  beforeAll(async () => {
    const { db } = testDb();
    await installTenantProbe(db);
    a = await seedTenantWithMember(db, 'a');
    b = await seedTenantWithMember(db, 'b');
  });

  it('数据库层：各自以租户会话写入同名记录，各自只读到自己的一条', async () => {
    const { db } = testDb();
    for (const t of [a, b]) {
      await withTenant(db, t.tenant.id, (tx) => tx.insert(tenantProbe).values({ tenantId: t.tenant.id, name: '总部' }));
    }

    const rowsA = await withTenant(db, a.tenant.id, (tx) => tx.select().from(tenantProbe));
    const rowsB = await withTenant(db, b.tenant.id, (tx) => tx.select().from(tenantProbe));

    expect(rowsA.map((r) => [r.tenantId, r.name])).toEqual([[a.tenant.id, '总部']]);
    expect(rowsB.map((r) => [r.tenantId, r.name])).toEqual([[b.tenant.id, '总部']]);
  });

  it('API 层：两租户的用户各自列表只含本租户记录', async () => {
    const { db } = testDb();
    const api = tenantApi(db, { tenantRoutes: [probeRoutes] });

    const created = await api.request('POST', '/api/tenant/probes', {
      user: a.user.id,
      tenant: a.tenant.id,
      body: { name: '研发中心' },
    });
    expect(created.status).toBe(201);
    await api.request('POST', '/api/tenant/probes', {
      user: b.user.id,
      tenant: b.tenant.id,
      body: { name: '研发中心' },
    });

    for (const t of [a, b]) {
      const res = await api.request('GET', '/api/tenant/probes', { user: t.user.id, tenant: t.tenant.id });
      expect(res.status).toBe(200);
      const { items } = (await res.json()) as { items: { tenantId: string; name: string }[] };
      expect(items.map((r) => r.name).sort()).toEqual(['总部', '研发中心']);
      expect(items.every((r) => r.tenantId === t.tenant.id)).toBe(true);
    }
  });
});
