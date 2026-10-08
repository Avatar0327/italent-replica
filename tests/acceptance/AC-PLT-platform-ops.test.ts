/**
 * REQ-PLT-001（R1-T17）平台运营层的接口边界与租户生命周期：
 * - 平台接口只对平台运营身份开放，与租户内权限（含租户管理员）隔离；每次请求重验；
 * - 租户停用后租户内所有请求拒绝、数据保留，重新启用恢复；不影响其他租户；平台审计；
 * - 许可证按产品线发放 / 调整，与租户侧余额、消耗、超额提示口径一致（AC-PRM-08/09，DEC-141 / DEC-143）。
 */
import { eq, platformAuditEvents, revokePlatformOperator, withPlatform } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { newUser, PLATFORM, provisioned, type ProvisionResult, seedOperator } from './support/platform-api.js';
import { cmd, errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

interface Balance {
  licenseType: string;
  quota: number;
  used: number;
  balance: number;
  overage: boolean;
  revision: number;
}

describe('平台运营层：接口边界、停用 / 启用、许可发放', () => {
  let api: ReturnType<typeof tenantApi>;
  let operator: Awaited<ReturnType<typeof seedOperator>>;
  let a: ProvisionResult;
  let b: ProvisionResult;
  let adminA: Awaited<ReturnType<typeof newUser>>;
  let adminB: Awaited<ReturnType<typeof newUser>>;

  beforeAll(async () => {
    const { db } = testDb();
    api = tenantApi(db, { authorize: undefined });
    operator = await seedOperator(db);
    adminA = await newUser(db, 'admin-a');
    adminB = await newUser(db, 'admin-b');
    a = await provisioned(api, operator, { firstAdminUserId: adminA.id, exceptionAdminUserId: adminA.id });
    b = await provisioned(api, operator, { firstAdminUserId: adminB.id, exceptionAdminUserId: adminB.id });
  });

  describe('平台接口只对平台运营身份开放', () => {
    it('未登录 401；租户管理员（即使带租户头）403；平台运营 200', async () => {
      const path = `${PLATFORM}/tenants/${a.tenant.id}`;
      expect((await api.request('GET', path)).status).toBe(401);
      const asTenantAdmin = await api.request('GET', path, { user: adminA.id, tenant: a.tenant.id });
      expect(asTenantAdmin.status).toBe(403);
      expect(await errorCode(asTenantAdmin)).toBe('FORBIDDEN');
      const asOperator = await api.request('GET', path, { user: operator.id });
      expect(asOperator.status).toBe(200);
      expect(await asOperator.json()).toMatchObject({ id: a.tenant.id, timezone: 'Asia/Shanghai', status: 'active' });
    });

    it('租户管理员不能开通租户、改状态或发放许可', async () => {
      const as = { user: adminA.id, tenant: a.tenant.id };
      const attempts = [
        api.request('POST', `${PLATFORM}/tenants`, { ...as, body: { code: 'x', name: 'x' } }),
        api.request('POST', `${PLATFORM}/tenants/${a.tenant.id}/status`, {
          ...as,
          ifMatch: a.tenant.revision,
          body: { status: 'suspended' },
        }),
        api.request('PUT', `${PLATFORM}/tenants/${a.tenant.id}/licenses/core_hr`, {
          ...as,
          ifMatch: 0,
          body: { quota: 999 },
        }),
      ];
      for (const res of await Promise.all(attempts)) expect(res.status).toBe(403);
    });

    it('平台运营身份撤销后，下一次请求立即 403（每次请求重验）', async () => {
      const { db } = testDb();
      const temp = await seedOperator(db, 'temp-ops');
      expect((await api.request('GET', `${PLATFORM}/tenants/${a.tenant.id}`, { user: temp.id })).status).toBe(200);
      await revokePlatformOperator(db, { userId: temp.id, expectedRevision: 1 }, cmd());
      expect((await api.request('GET', `${PLATFORM}/tenants/${a.tenant.id}`, { user: temp.id })).status).toBe(403);
    });

    it('平台运营身份不是租户成员，不能借平台身份访问租户接口', async () => {
      const res = await api.request('GET', '/api/tenant/permission/admins', { user: operator.id, tenant: a.tenant.id });
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe('TENANT_NOT_MEMBER');
    });
  });

  describe('租户停用 / 重新启用', () => {
    it('停用后 A 内所有请求 403 TENANT_UNAVAILABLE，B 不受影响；数据保留；重新启用后恢复', async () => {
      const { db } = testDb();
      const asA = { user: adminA.id, tenant: a.tenant.id };
      const asB = { user: adminB.id, tenant: b.tenant.id };
      const status = (body: unknown, ifMatch: number) =>
        api.request('POST', `${PLATFORM}/tenants/${a.tenant.id}/status`, { user: operator.id, ifMatch, body });

      const stale = await status({ status: 'suspended' }, a.tenant.revision + 5);
      expect(stale.status).toBe(409);

      const suspended = await status({ status: 'suspended' }, a.tenant.revision);
      expect(suspended.status).toBe(200);
      const tenant = (await suspended.json()) as { status: string; revision: number };
      expect(tenant.status).toBe('suspended');
      for (const path of ['/api/tenant/permission/admins', '/api/tenant/approval/processes']) {
        const res = await api.request('GET', path, asA);
        expect(res.status).toBe(403);
        expect(await errorCode(res)).toBe('TENANT_UNAVAILABLE');
      }
      expect((await api.request('GET', '/api/tenant/permission/admins', asB)).status).toBe(200);

      const restoring = await status({ status: 'restoring' }, tenant.revision);
      expect(restoring.status).toBe(400);

      const reopened = await status({ status: 'active' }, tenant.revision);
      expect(reopened.status).toBe(200);
      const processes = await api.request('GET', '/api/tenant/approval/processes', asA);
      expect(processes.status).toBe(200);
      expect(((await processes.json()) as { items: unknown[] }).items).toHaveLength(a.processes.length);

      const events = await withPlatform(db, (tx) =>
        tx
          .select()
          .from(platformAuditEvents)
          .where(eq(platformAuditEvents.objectId, a.tenant.id))
          .orderBy(platformAuditEvents.occurredAt),
      );
      const actions = events.filter((e) => e.action === 'tenant.set_status');
      expect(actions.map((e) => (e.after as { status: string }).status)).toEqual(['suspended', 'active']);
      expect(actions.every((e) => e.actorUserId === operator.id && e.subjectTenantId === a.tenant.id)).toBe(true);
    });
  });

  describe('许可证发放（复用 setLicenseQuota，口径同 R1-T15）', () => {
    const quotaPath = (tenantId: string, type: string) => `${PLATFORM}/tenants/${tenantId}/licenses/${type}`;

    it('按产品线发放与调整总数；返回的余额与租户侧余额一致；revision 不符 409', async () => {
      const first = await api.request('PUT', quotaPath(b.tenant.id, 'digital_talent'), {
        user: operator.id,
        ifMatch: 0,
        body: { quota: 5 },
      });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ licenseType: 'digital_talent', quota: 5, used: 0, balance: 5 });

      const stale = await api.request('PUT', quotaPath(b.tenant.id, 'digital_talent'), {
        user: operator.id,
        ifMatch: 0,
        body: { quota: 6 },
      });
      expect(stale.status).toBe(409);

      const raised = await api.request('PUT', quotaPath(b.tenant.id, 'digital_talent'), {
        user: operator.id,
        ifMatch: 1,
        body: { quota: 8 },
      });
      expect(await raised.json()).toMatchObject({ quota: 8, balance: 8, revision: 2 });

      const platformView = await api.request('GET', `${PLATFORM}/tenants/${b.tenant.id}/licenses`, {
        user: operator.id,
      });
      const tenantView = await api.request('GET', '/api/tenant/permission/licenses', {
        user: adminB.id,
        tenant: b.tenant.id,
      });
      expect(((await platformView.json()) as { items: Balance[] }).items).toEqual(
        ((await tenantView.json()) as { items: Balance[] }).items,
      );
    });

    it('余额为 0（未发放）时首位管理员已占名额 → 平台视图标出超额（DEC-143）；补发后超额消除', async () => {
      const before = await api.request('GET', `${PLATFORM}/tenants/${a.tenant.id}/licenses`, { user: operator.id });
      const items = ((await before.json()) as { items: Balance[] }).items;
      expect(items).toEqual([
        expect.objectContaining({ licenseType: 'core_hr', quota: 0, used: 1, balance: -1, overage: true }),
      ]);
      const issued = await api.request('PUT', quotaPath(a.tenant.id, 'core_hr'), {
        user: operator.id,
        ifMatch: 0,
        body: { quota: 3 },
      });
      expect(await issued.json()).toMatchObject({ quota: 3, used: 1, balance: 2, overage: false });
    });

    it('许可类型或总量不合法 → 400', async () => {
      for (const [type, quota] of [
        ['Bad-Type', 1],
        ['core_hr', -1],
        ['core_hr', 1.5],
      ] as const) {
        const res = await api.request('PUT', quotaPath(b.tenant.id, type), {
          user: operator.id,
          ifMatch: 0,
          body: { quota },
        });
        expect(res.status).toBe(400);
      }
    });
  });
});
