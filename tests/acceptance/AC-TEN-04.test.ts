/**
 * AC-TEN-04（REQ-PLT-001 R1/R2，DEC-006 / DEC-018 / DEC-051 / DEC-062a / DEC-098）：平台新开租户后，
 * 租户管理员可见 8 类管理员身份、标准业务身份与标准流程；标准流程出厂带发起条件，开通时已配置异常管理员并发布；
 * 标准开关按出厂值下发。开通是一个平台命令：同事务、幂等、写平台审计；未指定异常管理员则拒绝开通。
 */
import { ADMIN_ROLES, APPROVAL_TYPES } from '@italent/domain';
import { platformAuditEvents, revokeMembership, eq, tenants, withPlatform } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { newUser, provision, provisioned, type ProvisionResult, seedOperator } from './support/platform-api.js';
import { cmd, errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

describe('AC-TEN-04 平台开通租户：标准预置下发', () => {
  let api: ReturnType<typeof tenantApi>;
  let operator: Awaited<ReturnType<typeof seedOperator>>;
  let admin: Awaited<ReturnType<typeof newUser>>;
  let exceptionAdmin: Awaited<ReturnType<typeof newUser>>;
  let result: ProvisionResult;
  let asAdmin: { user: string; tenant: string };

  beforeAll(async () => {
    const { db } = testDb();
    api = tenantApi(db, { authorize: undefined });
    operator = await seedOperator(db);
    admin = await newUser(db, 'first-admin');
    exceptionAdmin = await newUser(db, 'exception-admin');
    result = await provisioned(api, operator, {
      firstAdminUserId: admin.id,
      exceptionAdminUserId: exceptionAdmin.id,
      licenses: [{ licenseType: 'core_hr', quota: 10 }],
    });
    asAdmin = { user: admin.id, tenant: result.tenant.id };
  });

  it('未指定异常管理员：开通命令拒绝（400），不留下半个租户', async () => {
    const { db } = testDb();
    const before = await withPlatform(db, (tx) => tx.select({ id: tenants.id }).from(tenants));
    const res = await provision(api, operator, { firstAdminUserId: admin.id });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('VALIDATION_FAILED');
    const after = await withPlatform(db, (tx) => tx.select({ id: tenants.id }).from(tenants));
    expect(after).toHaveLength(before.length);
  });

  it('租户管理员可见 8 类企业管理员身份，首位租户管理员可授出全部 8 类', async () => {
    const roles = await api.request('GET', '/api/tenant/permission/admin-roles', asAdmin);
    expect(roles.status).toBe(200);
    const { items } = (await roles.json()) as { items: { role: string; name: string }[] };
    expect(items.map((r) => r.role)).toEqual([...ADMIN_ROLES]);
    expect(items.every((r) => r.name.length > 0)).toBe(true);

    const admins = await api.request('GET', '/api/tenant/permission/admins', asAdmin);
    const records = ((await admins.json()) as { items: ProvisionResult['admin'][] }).items;
    expect(records).toEqual([
      expect.objectContaining({ userId: admin.id, role: 'tenant_admin', grantableAdminRoles: [...ADMIN_ROLES].sort() }),
    ]);
  });

  it('标准业务身份已下发（source=standard），且在首位租户管理员的可授权范围内', async () => {
    const res = await api.request('GET', '/api/tenant/permission/profiles', asAdmin);
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: { code: string; source: string; licenseType: string | null }[] };
    expect(items.map((p) => p.code).sort()).toEqual(
      ['standard_hr_admin', 'standard_hr_specialist', 'standard_manager', 'standard_org_system_admin'].sort(),
    );
    expect(items.every((p) => p.source === 'standard')).toBe(true);
    const grantable = await api.request('GET', '/api/tenant/permission/grantable-profiles', asAdmin);
    expect(((await grantable.json()) as { items: unknown[] }).items).toHaveLength(items.length);
  });

  it('标准流程覆盖全部审批类型、已发布、带发起条件（或显式兜底），异常管理员为开通时指定的人', async () => {
    expect(result.processes.map((p) => p.approvalType).sort()).toEqual(Object.keys(APPROVAL_TYPES).sort());
    const list = await api.request('GET', '/api/tenant/approval/processes', asAdmin);
    expect(list.status).toBe(200);
    const summaries = ((await list.json()) as { items: { id: string; presetKey: string | null }[] }).items;
    expect(summaries).toHaveLength(result.processes.length);
    for (const summary of summaries) {
      expect(summary.presetKey).toMatch(/^standard_/);
      const detail = await api.request('GET', `/api/tenant/approval/processes/${summary.id}`, asAdmin);
      const process = (await detail.json()) as {
        currentVersion: {
          status: string;
          isFallback: boolean;
          exceptionAdminUserId: string;
          conditions: { items: unknown[] };
        } | null;
      };
      expect(process.currentVersion?.status).toBe('published');
      expect(process.currentVersion?.exceptionAdminUserId).toBe(exceptionAdmin.id);
      expect(process.currentVersion!.isFallback || process.currentVersion!.conditions.items.length > 0).toBe(true);
    }
    const transfer = result.processes.find((p) => p.approvalType === 'transfer');
    expect(transfer).toMatchObject({ code: 'StandardTransfer', status: 'published', versionNo: 1 });
  });

  it('标准开关按出厂值下发：允许直接调动=开（DEC-051），同一部门下职位允许重复=关（DEC-062a）', async () => {
    expect(result.settings).toEqual({ allowDirectTransfer: true, allowDuplicatePositionNames: false });
    const employment = await api.request('GET', '/api/tenant/employment/settings', asAdmin);
    expect(employment.status).toBe(200);
    expect(await employment.json()).toMatchObject({ allowDirectTransfer: true, revision: 1 });
    const job = await api.request('GET', '/api/tenant/job/settings', asAdmin);
    expect(job.status).toBe(200);
    expect(await job.json()).toMatchObject({ allowDuplicatePositionNames: false, revision: 1 });
  });

  it('开通时发放的许可与租户侧余额口径一致；首位管理员持标准系统管理员身份占用一个核心人力名额', async () => {
    expect(result.licenses).toEqual([
      expect.objectContaining({ licenseType: 'core_hr', quota: 10, used: 1, balance: 9, overage: false }),
    ]);
    const res = await api.request('GET', '/api/tenant/permission/licenses', asAdmin);
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ licenseType: 'core_hr', quota: 10, used: 1, balance: 9, overage: false }),
    ]);
  });

  it('异常管理员停用规则沿用 DEC-098：仍是可用流程的异常管理员时不能直接撤销其成员关系', async () => {
    const { db } = testDb();
    const revoke = revokeMembership(
      db,
      { tenantId: result.tenant.id, userId: exceptionAdmin.id, expectedRevision: 1 },
      cmd(operator.id),
    );
    await expect(revoke).rejects.toThrow(/异常管理员/);
  });

  it('开通写平台审计；同一命令 ID 重放首次结果，不重复开通', async () => {
    const { db } = testDb();
    const events = await withPlatform(db, (tx) =>
      tx.select().from(platformAuditEvents).where(eq(platformAuditEvents.action, 'tenant.provision')),
    );
    expect(events.find((e) => e.objectId === result.tenant.id)).toMatchObject({ actorUserId: operator.id });

    const key = `provision-${result.tenant.id.slice(0, 8)}`;
    const body = { firstAdminUserId: admin.id, exceptionAdminUserId: admin.id, code: `idem-${key}`, name: '幂等' };
    const first = await api.request('POST', '/api/platform/tenants', { user: operator.id, body, idempotencyKey: key });
    const replay = await api.request('POST', '/api/platform/tenants', { user: operator.id, body, idempotencyKey: key });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as ProvisionResult).tenant.id).toBe(
      ((await first.json()) as ProvisionResult).tenant.id,
    );
    const clash = await api.request('POST', '/api/platform/tenants', {
      user: operator.id,
      body: { ...body, name: '异内容' },
      idempotencyKey: key,
    });
    expect(clash.status).toBe(409);
    expect(await errorCode(clash)).toBe('IDEMPOTENCY_CONFLICT');
  });
});
