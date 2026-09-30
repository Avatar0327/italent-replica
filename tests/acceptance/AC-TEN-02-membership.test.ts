/**
 * AC-TEN-02 补充（硬规则 7“一个用户可以属于多个租户”；AGENTS.md §10「权限」每次请求重验）：
 * - 同一用户属于两个租户，切换 X-Tenant-Id 分别只看到对应租户的数据；
 * - 撤销成员关系后，下一次请求立即 403；
 * - 租户 suspended / restoring（恢复隔离中，DEC-061）时业务请求一律拒绝；
 * - 用户被停用后身份失效 → 401。
 */
import {
  and,
  auditEvents,
  createUser,
  eq,
  getTenant,
  grantMembership,
  RevisionConflictError,
  revokeMembership,
  setTenantStatus,
  setUserStatus,
  sql,
  withTenant,
} from '@italent/db';
import { installTenantProbe, pgErrorCode, useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { probeRoutes } from './support/probe-routes.js';
import { errorCode, seedTenantWithMember, tenantApi } from './support/tenant-api.js';

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
    shared = await createUser(db, { email: 'shared-hr@example.com', displayName: '双租户 HR' });
    await grantMembership(db, { tenantId: a.tenant.id, userId: shared.id, actorUserId: a.user.id });
    await grantMembership(db, { tenantId: b.tenant.id, userId: shared.id, actorUserId: b.user.id });

    api = tenantApi(db, { tenantRoutes: [probeRoutes] });
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

    await revokeMembership(db, { tenantId: b.tenant.id, userId: shared.id, actorUserId: b.user.id });

    const after = await api.request('GET', '/api/tenant/probes', { user: shared.id, tenant: b.tenant.id });
    expect(after.status).toBe(403);
    expect(await errorCode(after)).toBe('TENANT_NOT_MEMBER');
    const stillA = await api.request('GET', '/api/tenant/probes', { user: shared.id, tenant: a.tenant.id });
    expect(stillA.status).toBe(200);
  });

  it.each(['suspended', 'restoring'] as const)('租户状态为 %s 时业务请求 403 TENANT_UNAVAILABLE', async (status) => {
    const { db } = testDb();
    const suspended = await setTenantStatus(db, a.tenant.id, status, (await getTenant(db, a.tenant.id))!.revision);
    try {
      const res = await api.request('GET', '/api/tenant/probes', { user: a.user.id, tenant: a.tenant.id });
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('TENANT_UNAVAILABLE');
    } finally {
      await setTenantStatus(db, a.tenant.id, 'active', suspended.revision);
    }
    const restored = await api.request('GET', '/api/tenant/probes', { user: a.user.id, tenant: a.tenant.id });
    expect(restored.status).toBe(200);
  });

  it('非成员访问停用租户时仍返回 TENANT_NOT_MEMBER，不暴露租户状态', async () => {
    const { db } = testDb();
    const suspended = await setTenantStatus(db, b.tenant.id, 'suspended', (await getTenant(db, b.tenant.id))!.revision);
    try {
      const res = await api.request('GET', '/api/tenant/probes', { user: a.user.id, tenant: b.tenant.id });
      expect(await errorCode(res)).toBe('TENANT_NOT_MEMBER');
    } finally {
      await setTenantStatus(db, b.tenant.id, 'active', suspended.revision);
    }
  });

  it('用户被停用后下一次请求 401 UNAUTHENTICATED', async () => {
    const { db } = testDb();
    const res0 = await api.request('GET', '/api/tenant/probes', { user: b.user.id, tenant: b.tenant.id });
    expect(res0.status).toBe(200);
    await setUserStatus(db, b.user.id, 'disabled');
    const res = await api.request('GET', '/api/tenant/probes', { user: b.user.id, tenant: b.tenant.id });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('UNAUTHENTICATED');
  });
});

describe('成员关系变更与租户状态变更的留痕和并发控制', () => {
  it('授予与撤销成员关系在同一事务内写入该租户的审计（操作人、前后值），且审计不可改删', async () => {
    const { db } = testDb();
    const t = await seedTenantWithMember(db, 'audit');
    const member = await createUser(db, { email: 'audited-member@example.com', displayName: '被审计成员' });
    await grantMembership(db, { tenantId: t.tenant.id, userId: member.id, actorUserId: t.user.id });
    await revokeMembership(db, { tenantId: t.tenant.id, userId: member.id, actorUserId: t.user.id });

    const events = await withTenant(db, t.tenant.id, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.objectType, 'tenant_membership'), eq(auditEvents.actorUserId, t.user.id))),
    );
    expect(events.map((e) => e.action).sort()).toEqual(['tenant_membership.grant', 'tenant_membership.revoke']);
    const revoke = events.find((e) => e.action === 'tenant_membership.revoke')!;
    expect(revoke.tenantId).toBe(t.tenant.id);
    expect(revoke.before).toMatchObject({ userId: member.id, status: 'active', revision: 1 });
    expect(revoke.after).toMatchObject({ userId: member.id, status: 'revoked', revision: 2 });

    // 平台方开通时授予的成员关系，操作人记为“系统”（null）
    const [seeded] = await withTenant(db, t.tenant.id, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, 'tenant_membership.grant'), sql`${auditEvents.actorUserId} IS NULL`)),
    );
    expect(seeded?.after).toMatchObject({ userId: t.user.id, status: 'active' });

    const tamper = withTenant(db, t.tenant.id, (tx) =>
      tx.update(auditEvents).set({ after: null }).where(eq(auditEvents.id, revoke.id)),
    );
    await expect(tamper).rejects.toThrow();
    const erase = await db.execute(sql`DELETE FROM audit_events WHERE id = ${revoke.id}`).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(pgErrorCode(erase)).toBe('55000');
  });

  it('改租户状态须带 expectedRevision，不一致时抛 revision 冲突且不改状态', async () => {
    const { db } = testDb();
    const t = await seedTenantWithMember(db, 'cas');
    const stale = t.tenant.revision;
    const updated = await setTenantStatus(db, t.tenant.id, 'suspended', stale);
    expect(updated.revision).toBe(stale + 1);

    await expect(setTenantStatus(db, t.tenant.id, 'active', stale)).rejects.toBeInstanceOf(RevisionConflictError);
    expect((await getTenant(db, t.tenant.id))?.status).toBe('suspended');
  });
});
