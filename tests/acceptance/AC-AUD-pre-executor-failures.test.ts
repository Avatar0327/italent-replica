/**
 * PR #75 第二轮 P2-7 / DEC-199：
 * - 执行器之前被拒绝的写命令（请求校验、授权失败）同样记失败命令审计，且与执行器内的失败不重复；
 * - 平台运营命令失败写入平台层受限通道：只有平台运营能读，租户的审计查询里看不到；
 * - 失败的导入任务持久保存任务级日志（条数、结果、错误报告，20 §3 / §5 第 3 条）。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession, EMP_TODAY } from './AC-EMP-support.js';
import { auditApi } from './AC-AUD-support.js';
import { addMember, seedPermissionWorld } from './AC-PRM-support.js';
import { contractWorld } from './AC-CT-support.js';
import { newUser, PLATFORM, provisioned, seedOperator } from './support/platform-api.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const NOW = `${EMP_TODAY}T01:00:00.000Z`;

describe('P2-7 执行器之前的拒绝', () => {
  it('请求校验失败（批量编辑重复记录）：400，记一条业务失败', async () => {
    const { db } = testDb();
    const session = await employmentSession(db, 'aud-pre-validation');
    const employee = await session.employee();
    const hire = await session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01' },
      employee.revision,
    );
    const commandId = randomUUID();
    const item = { id: hire.id, revision: hire.revision };
    const response = await session.request('POST', '/records/batch-edit', {
      idempotencyKey: commandId,
      body: { items: [item, item], patch: { fields: { place: '重复' } } },
    });
    expect(response.status).toBe(400);
    const as = { user: session.user.id, tenant: session.tenant.id };
    expect((await auditApi(db, NOW).commandFailures(as, { commandId })).items).toEqual([
      expect.objectContaining({
        outcome: 'business_failed',
        errorCode: 'VALIDATION_FAILED',
        reason: 'DUPLICATE_RECORD',
        method: 'POST',
      }),
    ]);
  });

  it('授权失败（普通成员改租户配置）：403，记一条业务失败；执行器内的失败只记一次', async () => {
    const { db } = testDb();
    const world = await seedPermissionWorld(db);
    const member = await addMember(world, 'aud-pre-forbidden');
    const api = tenantApi(db, { authorize: undefined, clock: () => new Date(NOW) });
    const commandId = randomUUID();
    const denied = await api.request('PUT', '/api/tenant/settings/audit.retention', {
      user: member.id,
      tenant: world.tenant.id,
      ifMatch: 0,
      idempotencyKey: commandId,
      body: { value: { queryMonths: 1, retainMonths: 1 } },
    });
    expect(denied.status).toBe(403);
    const staleId = randomUUID();
    const stale = await api.request('PUT', '/api/tenant/settings/audit.retention', {
      ...world.asAdmin,
      ifMatch: 9,
      idempotencyKey: staleId,
      body: { value: { queryMonths: 1, retainMonths: 1 } },
    });
    expect(stale.status).toBe(409);
    const audit = auditApi(db, NOW, { authorize: undefined });
    expect((await audit.commandFailures(world.asAdmin, { commandId })).items).toEqual([
      expect.objectContaining({ outcome: 'business_failed', errorCode: 'FORBIDDEN', operator: expect.anything() }),
    ]);
    expect((await audit.commandFailures(world.asAdmin, { commandId: staleId })).items).toHaveLength(1);
  });
});

describe('DEC-199 平台命令失败写平台层受限通道', () => {
  it('平台命令失败只有平台运营可读；租户管理员读不到，也不进租户审计', async () => {
    const { db } = testDb();
    const api = tenantApi(db, { authorize: undefined, clock: () => new Date(NOW) });
    const operator = await seedOperator(db, 'aud-ops');
    const admin = await newUser(db, 'aud-ops-admin');
    const provisionedTenant = await provisioned(api, operator, {
      firstAdminUserId: admin.id,
      exceptionAdminUserId: admin.id,
    });
    const tenant = provisionedTenant.tenant;
    const commandId = randomUUID();
    const stale = await api.request('POST', `${PLATFORM}/tenants/${tenant.id}/status`, {
      user: operator.id,
      ifMatch: tenant.revision + 5,
      idempotencyKey: commandId,
      body: { status: 'suspended' },
    });
    expect(stale.status).toBe(409);
    const read = await api.request('GET', `${PLATFORM}/command-failures?commandId=${commandId}`, {
      user: operator.id,
    });
    expect(read.status, await read.clone().text()).toBe(200);
    expect(((await read.json()) as { items: unknown[] }).items).toEqual([
      expect.objectContaining({
        commandId,
        outcome: 'business_failed',
        errorCode: 'REVISION_CONFLICT',
        subjectTenantId: tenant.id,
      }),
    ]);
    const asAdmin = { user: admin.id, tenant: tenant.id };
    expect((await api.request('GET', `${PLATFORM}/command-failures`, asAdmin)).status).toBe(403);
    const tenantView = await auditApi(db, NOW, { authorize: undefined }).commandFailures(asAdmin, { commandId });
    expect(tenantView.items).toEqual([]);
  });
});

describe('DEC-199 失败的导入任务留痕', () => {
  it('合同导入整批校验失败：业务回滚，任务级日志仍记录条数、失败结果与错误报告', async () => {
    const { db } = testDb();
    const w = await contractWorld(db, 'aud-import-fail');
    const commandId = randomUUID();
    const response = await w.request('POST', '/imports', {
      ifMatch: 0,
      idempotencyKey: commandId,
      body: {
        mode: 'edit',
        rows: [
          { employeeId: w.employee.id, revision: 0, fields: { number: 'NOT-EXIST-1' } },
          { employeeId: w.employee.id, revision: 0, fields: { number: 'NOT-EXIST-2' } },
        ],
      },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const as = { user: w.session.user.id, tenant: w.session.tenant.id };
    const logs = await auditApi(db, NOW).operationLogs(as, { behavior: 'import', commandId });
    expect(logs.items).toEqual([
      expect.objectContaining({
        result: 'failed',
        totalCount: 2,
        failureCount: 2,
        successCount: 0,
        summary: '2条全部导入失败',
        errorReport: expect.arrayContaining([expect.objectContaining({ rowIndex: 0 })]),
      }),
    ]);
  });
});
