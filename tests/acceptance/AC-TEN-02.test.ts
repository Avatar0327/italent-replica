/**
 * AC-TEN-02（REQ-TEN-001 R2，硬规则 7）：租户 A 的会话请求租户 B 的对象 ID → 后端拒绝。
 * 数据库层（RLS）与 API 层（租户中间件）各验证一次；不带租户上下文的查询一律 0 行。
 * API 对他租户对象统一返回 404，与“不存在”不可区分，不泄露存在性。
 */
import { APP_ROLE, eq, sql, withPlatform, withTenant } from '@italent/db';
import { installTenantProbe, pgErrorCode, tenantProbe, useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { PROBE_POLICIES, probeRoutes } from './support/probe-routes.js';
import { errorCode, seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe('AC-TEN-02 跨租户访问一律拒绝', () => {
  let a: Awaited<ReturnType<typeof seedTenantWithMember>>;
  let b: Awaited<ReturnType<typeof seedTenantWithMember>>;
  let objectOfB: string;

  beforeAll(async () => {
    const { db } = testDb();
    await installTenantProbe(db);
    a = await seedTenantWithMember(db, 'a');
    b = await seedTenantWithMember(db, 'b');
    const [row] = await withTenant(db, b.tenant.id, (tx) =>
      tx.insert(tenantProbe).values({ tenantId: b.tenant.id, name: 'B 的对象' }).returning(),
    );
    objectOfB = row!.id;
  });

  describe('数据库层（RLS，应用角色非超级用户）', () => {
    it('租户会话确实切到了受 RLS 约束的应用角色', async () => {
      const { db } = testDb();
      const role = await withTenant(db, a.tenant.id, (tx) =>
        tx.execute(sql`SELECT current_user AS role, rolsuper, rolbypassrls
          FROM pg_roles WHERE rolname = current_user`),
      );
      expect(JSON.stringify(role)).toContain(`"role":"${APP_ROLE.tenant}"`);
      expect(JSON.stringify(role)).toContain('"rolsuper":false');
      expect(JSON.stringify(role)).toContain('"rolbypassrls":false');
    });

    it('A 会话按 B 的对象 ID 读 / 改 / 删都命中 0 行', async () => {
      const { db } = testDb();
      const read = await withTenant(db, a.tenant.id, (tx) =>
        tx.select().from(tenantProbe).where(eq(tenantProbe.id, objectOfB)),
      );
      const updated = await withTenant(db, a.tenant.id, (tx) =>
        tx.update(tenantProbe).set({ name: '被篡改' }).where(eq(tenantProbe.id, objectOfB)).returning(),
      );
      const deleted = await withTenant(db, a.tenant.id, (tx) =>
        tx.delete(tenantProbe).where(eq(tenantProbe.id, objectOfB)).returning(),
      );
      expect([read.length, updated.length, deleted.length]).toEqual([0, 0, 0]);

      const stillThere = await withTenant(db, b.tenant.id, (tx) =>
        tx.select().from(tenantProbe).where(eq(tenantProbe.id, objectOfB)),
      );
      expect(stillThere[0]?.name).toBe('B 的对象');
    });

    it('A 会话写入 tenant_id = B 的行被 WITH CHECK 拒绝（42501）', async () => {
      const { db } = testDb();
      const error = await failure(
        withTenant(db, a.tenant.id, (tx) => tx.insert(tenantProbe).values({ tenantId: b.tenant.id, name: '越权' })),
      );
      expect(pgErrorCode(error)).toBe('42501');
    });

    it('应用角色未设置租户上下文（或设为空）时读到 0 行、写不进', async () => {
      const { db } = testDb();
      const rows = await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE.tenant}`));
        return tx.select().from(tenantProbe);
      });
      expect(rows).toHaveLength(0);

      const emptyContext = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', '', true)`);
        await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE.tenant}`));
        return tx.select().from(tenantProbe);
      });
      expect(emptyContext).toHaveLength(0);

      const insert = db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE.tenant}`));
        await tx.insert(tenantProbe).values({ tenantId: a.tenant.id, name: '无上下文' });
      });
      expect(pgErrorCode(await failure(insert))).toBe('42501');
    });

    it('平台路径无权直接读写租户数据表（42501）', async () => {
      const { db } = testDb();
      const error = await failure(withPlatform(db, (tx) => tx.select().from(tenantProbe)));
      expect(pgErrorCode(error)).toBe('42501');
    });

    it('withTenant 拒绝非法的租户 ID，而不是放宽过滤', async () => {
      const { db } = testDb();
      await expect(withTenant(db, 'not-a-uuid', (tx) => tx.select().from(tenantProbe))).rejects.toThrow();
      await expect(withTenant(db, '', (tx) => tx.select().from(tenantProbe))).rejects.toThrow();
    });
  });

  describe('API 层（租户中间件 + RLS）', () => {
    it('A 会话在自己租户上下文里读 / 改 / 删 B 的对象 ID → 404', async () => {
      const api = tenantApi(testDb().db, { tenantRoutes: [probeRoutes], routePolicies: [PROBE_POLICIES] });
      const as = { user: a.user.id, tenant: a.tenant.id };
      const path = `/api/tenant/probes/${objectOfB}`;

      const read = await api.request('GET', path, as);
      const update = await api.request('PUT', path, { ...as, body: { name: '被篡改' } });
      const remove = await api.request('DELETE', path, as);

      expect([read.status, update.status, remove.status]).toEqual([404, 404, 404]);
      expect(await errorCode(read)).toBe('NOT_FOUND');
      const own = await api.request('GET', path, { user: b.user.id, tenant: b.tenant.id });
      expect(((await own.json()) as { name: string }).name).toBe('B 的对象');
    });

    it('A 用户把 X-Tenant-Id 换成 B → 403 TENANT_NOT_MEMBER', async () => {
      const api = tenantApi(testDb().db, { tenantRoutes: [probeRoutes], routePolicies: [PROBE_POLICIES] });
      const res = await api.request('GET', `/api/tenant/probes/${objectOfB}`, { user: a.user.id, tenant: b.tenant.id });
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('TENANT_NOT_MEMBER');
    });

    it('不存在的租户与非成员租户返回同一错误码，不泄露租户是否存在', async () => {
      const api = tenantApi(testDb().db, { tenantRoutes: [probeRoutes], routePolicies: [PROBE_POLICIES] });
      const res = await api.request('GET', '/api/tenant/probes', {
        user: a.user.id,
        tenant: '00000000-0000-4000-8000-00000000dead',
      });
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('TENANT_NOT_MEMBER');
    });

    it('缺少或非法 X-Tenant-Id → 400 TENANT_CONTEXT_REQUIRED；缺少身份 → 401', async () => {
      const api = tenantApi(testDb().db, { tenantRoutes: [probeRoutes], routePolicies: [PROBE_POLICIES] });
      const missing = await api.request('GET', '/api/tenant/probes', { user: a.user.id });
      const invalid = await api.request('GET', '/api/tenant/probes', { user: a.user.id, tenant: 'abc' });
      const anonymous = await api.request('GET', '/api/tenant/probes', { tenant: a.tenant.id });

      expect([missing.status, invalid.status, anonymous.status]).toEqual([400, 400, 401]);
      expect(await errorCode(missing)).toBe('TENANT_CONTEXT_REQUIRED');
      expect(await errorCode(anonymous)).toBe('UNAUTHENTICATED');
    });
  });
});
