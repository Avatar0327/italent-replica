/**
 * AC-TEN-06 恢复安全（PR #60 astra 复审 P2-1～P2-6、P2-9 的回归测试）：
 * - P2-1 构造的备份（他租户行、重算校验和）或非空目标：写入前即拒绝，目标保持为空；
 * - P2-2 授权对账以现网当前有效权限为准：备份后关闭的身份数据权限（看全部）恢复后同样关闭；
 * - P2-3 恢复校验之后、开放之前的现网撤权，开放时再次对账，不复活；
 * - P2-4 导入后推进 identity / 序列，恢复后新事件排在历史事件之后（#53 同日排序依赖它）；
 * - P2-5 系统预置按备份时点恢复（含没有租户覆盖的键），覆盖隔离库的默认值；
 * - P2-6 现网已交接并停用的异常管理员：恢复库的流程改指现网的异常管理员（DEC-098 / 123），不指向停用账号；
 * - P2-9 同一命令 ID 重试恢复与开放：重放首次结果，不报“租户已存在”或“不在恢复隔离状态”。
 */
import { randomUUID } from 'node:crypto';
import { openRestoredTenant, restoreTenant } from '@italent/api';
import {
  backupChecksum,
  BackupIntegrityError,
  createTenant,
  type Db,
  exportTenantBackup,
  grantMembership,
  setUserStatus,
  sql,
  systemSettings,
  type TenantBackup,
  tenants,
  upsertSystemSetting,
  users,
  withPlatform,
  withTenant,
} from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { createTestDb, useTestDb } from '@italent/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUser, provisioned, type ProvisionResult, seedOperator } from './support/platform-api.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const TODAY = '2026-10-01';

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

describe('AC-TEN-06 恢复安全与对账（astra 复审回归）', () => {
  let api: ReturnType<typeof tenantApi>;
  let operator: Awaited<ReturnType<typeof seedOperator>>;
  let a: ProvisionResult;
  let other: ProvisionResult;
  let admin: { id: string };
  let exceptionAdmin: { id: string };
  let asAdmin: { user: string; tenant: string };
  let asH: { user: string; tenant: string };
  let hGrant: { id: string; revision: number };
  let backup: TenantBackup;
  const handles: { close(): Promise<void> }[] = [];
  const noAttachments = { sha256: async () => null };

  async function target(): Promise<Db> {
    const handle = await createTestDb();
    handles.push(handle);
    return handle.db;
  }

  afterAll(async () => {
    for (const handle of handles) await handle.close();
  });

  beforeAll(async () => {
    const { db } = testDb();
    api = tenantApi(db, { authorize: undefined });
    const fixture = tenantApi(db);
    operator = await seedOperator(db);
    admin = await newUser(db, 'safety-admin');
    exceptionAdmin = await newUser(db, 'safety-exception');
    a = await provisioned(api, operator, {
      firstAdminUserId: admin.id,
      exceptionAdminUserId: exceptionAdmin.id,
      licenses: [{ licenseType: 'core_hr', quota: 5 }],
    });
    other = await provisioned(api, operator, { firstAdminUserId: admin.id, exceptionAdminUserId: admin.id });
    asAdmin = { user: admin.id, tenant: a.tenant.id };

    for (const name of ['职务甲', '职务乙']) {
      const res = await fixture.request('POST', '/api/tenant/job/posts', {
        ...asAdmin,
        ifMatch: 0,
        body: { name, code: `P${randomUUID().slice(0, 8)}`, startDate: '2026-01-01' },
      });
      expect(res.status, await res.clone().text()).toBe(201);
    }
    const employee = await fixture.request('POST', '/api/tenant/employment/employees', {
      ...asAdmin,
      ifMatch: 0,
      body: { code: 'S001', name: '李四' },
    });
    expect(employee.status, await employee.clone().text()).toBe(201);

    const h = await newUser(db, 'safety-h');
    await grantMembership(db, { tenantId: a.tenant.id, userId: h.id, expectedRevision: 0 }, cmd());
    asH = { user: h.id, tenant: a.tenant.id };
    const hr = a.profiles.find((p) => p.code === 'standard_hr_admin')!;
    const granted = await api.request('POST', '/api/tenant/permission/grants', {
      ...asAdmin,
      body: { userId: h.id, profileId: hr.id },
    });
    expect(granted.status, await granted.clone().text()).toBe(201);
    hGrant = (await granted.json()) as { id: string; revision: number };

    // P2-5：没有租户覆盖的系统预置也要按备份时点恢复
    await upsertSystemSetting(
      db,
      {
        key: 'approval.show_original_values',
        value: false,
        description: '审批详情页显示原信息（变更前原值）',
        overridable: true,
        expectedVersion: 1,
      },
      cmd(),
    );

    backup = await exportTenantBackup(db, { tenantId: a.tenant.id, codeVersion: 'safety' }, cmd(operator.id));

    // 备份之后的现网变化：关闭 HR 身份对职务的看全部（P2-2）；交接并停用异常管理员（P2-6）
    const base = `/api/tenant/permission/profiles/${hr.id}/data-scopes/TenantBase`;
    const closed = await api.request('PUT', base, {
      ...asAdmin,
      ifMatch: 1,
      body: { targetKind: 'entity', targetCode: MODULE_OBJECTS.jobPost.code, seeAll: false },
    });
    expect(closed.status, await closed.clone().text()).toBe(200);
    const handover = await api.request('POST', '/api/tenant/approval/exception-admins/handover', {
      ...asAdmin,
      ifMatch: 0,
      body: { fromUserId: exceptionAdmin.id, toUserId: admin.id },
    });
    expect(handover.status, await handover.clone().text()).toBe(200);
    await setUserStatus(db, { userId: exceptionAdmin.id, status: 'disabled', expectedRevision: 1 }, cmd());
  });

  const posts = (restored: ReturnType<typeof tenantApi>) =>
    restored.request('GET', `/api/tenant/job/posts?asOf=${TODAY}`, asH);

  it('P2-2：备份后关闭的看全部，恢复开放后同样关闭（以现网当前有效权限对账）', async () => {
    const live = await posts(api);
    expect(await live.json()).toMatchObject({ items: [], hasDataPermission: false });
    const isolated = await target();
    const meta = cmd(operator.id);
    const report = await restoreTenant(isolated, { backup, live: testDb().db, attachments: noAttachments }, meta);
    expect(report.ok, JSON.stringify(report.reconciliation)).toBe(true);
    await openRestoredTenant(isolated, { tenantId: a.tenant.id, live: testDb().db, backup }, cmd(operator.id));
    const restored = await posts(tenantApi(isolated, { authorize: undefined }));
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ items: [], hasDataPermission: false });
  });

  it('P2-6：现网已交接并停用的异常管理员，恢复库流程改指现网异常管理员，账号同样停用', async () => {
    const isolated = await target();
    const report = await restoreTenant(
      isolated,
      { backup, live: testDb().db, attachments: noAttachments },
      cmd(operator.id),
    );
    expect(report.ok, JSON.stringify(report.reconciliation)).toBe(true);
    const admins = await withTenant(isolated, a.tenant.id, async (tx) =>
      rowsOf<{ exception_admin_user_id: string }>(
        await tx.execute(sql`SELECT v.exception_admin_user_id FROM approval_processes p
          JOIN approval_process_versions v ON v.tenant_id = p.tenant_id AND v.id = p.current_version_id
          WHERE p.status = 'active'`),
      ),
    );
    expect(admins.length).toBeGreaterThan(0);
    expect(new Set(admins.map((r) => r.exception_admin_user_id))).toEqual(new Set([admin.id]));
    const [account] = await withPlatform(isolated, (tx) =>
      tx
        .select({ status: users.status })
        .from(users)
        .where(sql`${users.id} = ${exceptionAdmin.id}`),
    );
    expect(account?.status).toBe('disabled');
  });

  it('P2-4：导入后推进序列，恢复后的新事件序号大于历史最大值', async () => {
    const isolated = await target();
    await restoreTenant(isolated, { backup, live: testDb().db, attachments: noAttachments }, cmd(operator.id));
    const [row] = await withTenant(isolated, a.tenant.id, async (tx) =>
      rowsOf<{ max: number | null; next: number }>(
        await tx.execute(sql`SELECT (SELECT max(event_seq) FROM employment_state_events)::bigint AS max,
          nextval(pg_get_serial_sequence('employment_state_events', 'event_seq'))::bigint AS next`),
      ),
    );
    expect(row?.max).not.toBeNull();
    expect(Number(row!.next)).toBeGreaterThan(Number(row!.max));
  });

  it('P2-5：系统预置按备份时点恢复，覆盖隔离库的默认值', async () => {
    const isolated = await target();
    await restoreTenant(isolated, { backup, live: testDb().db, attachments: noAttachments }, cmd(operator.id));
    const rows = await withPlatform(isolated, (tx) => tx.select().from(systemSettings));
    expect(rows.find((r) => r.key === 'approval.show_original_values')?.value).toBe(false);
    expect(rows.map((r) => r.key).sort()).toEqual(backup.platform.systemSettings.map((r) => String(r.key)).sort());
  });

  it('P2-1：他租户行（重算校验和）或非空目标，写入前即拒绝，目标保持为空', async () => {
    const forged = structuredClone(backup);
    forged.tables.tenant_memberships![0]!.tenant_id = other.tenant.id;
    forged.manifest.checksum = backupChecksum(forged);
    const isolated = await target();
    const run = (input: TenantBackup, db: Db) =>
      restoreTenant(db, { backup: input, live: testDb().db, attachments: noAttachments }, cmd(operator.id));
    await expect(run(forged, isolated)).rejects.toEqual(
      expect.objectContaining({ name: 'BackupIntegrityError', reason: 'FOREIGN_ROW' }),
    );
    expect(await withPlatform(isolated, (tx) => tx.select().from(tenants))).toEqual([]);

    const occupied = await target();
    await createTenant(occupied, { code: `occupied-${randomUUID().slice(0, 6)}`, name: '已有租户' }, cmd());
    await expect(run(backup, occupied)).rejects.toEqual(
      expect.objectContaining({ name: 'BackupIntegrityError', reason: 'TARGET_NOT_EMPTY' }),
    );
    expect(BackupIntegrityError).toBeDefined();
  });

  it('P2-9：同一命令 ID 重试恢复与开放，重放首次结果', async () => {
    const isolated = await target();
    const meta = cmd(operator.id);
    const input = { backup, live: testDb().db, attachments: noAttachments };
    const first = await restoreTenant(isolated, input, meta);
    const again = await restoreTenant(isolated, input, meta);
    expect(again).toEqual(first);
    const openMeta = cmd(operator.id);
    const opened = await openRestoredTenant(isolated, { tenantId: a.tenant.id, live: testDb().db, backup }, openMeta);
    const reopened = await openRestoredTenant(isolated, { tenantId: a.tenant.id, live: testDb().db, backup }, openMeta);
    expect(reopened).toEqual(opened);
  });

  it('P2-9：导入阶段的审计写入失败 → 整个导入回滚、目标保持为空；修复后同一命令 ID 重试成功', async () => {
    const isolated = await target();
    // 故障注入：让隔离库拒绝写入导入阶段的平台审计
    await isolated.execute(sql`CREATE FUNCTION fail_restore_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'tenant.restore.import' THEN RAISE EXCEPTION 'audit store unavailable'; END IF;
        RETURN NEW;
      END $$`);
    await isolated.execute(sql`CREATE TRIGGER fail_restore_audit BEFORE INSERT ON platform_audit_events
      FOR EACH ROW EXECUTE FUNCTION fail_restore_audit()`);
    const meta = cmd(operator.id);
    const input = { backup, live: testDb().db, attachments: noAttachments };
    await expect(restoreTenant(isolated, input, meta)).rejects.toThrow();
    expect(await withPlatform(isolated, (tx) => tx.select().from(tenants))).toEqual([]);
    await isolated.execute(sql`DROP TRIGGER fail_restore_audit ON platform_audit_events`);
    const report = await restoreTenant(isolated, input, meta);
    expect(report.ok).toBe(true);
  });

  it('P2-3：恢复校验之后、开放之前的现网撤权，开放时再次对账，不复活', async () => {
    const isolated = await target();
    const report = await restoreTenant(
      isolated,
      { backup, live: testDb().db, attachments: noAttachments },
      cmd(operator.id),
    );
    expect(report.ok).toBe(true);
    const revoked = await api.request('POST', `/api/tenant/permission/grants/${hGrant.id}/revoke`, {
      ...asAdmin,
      ifMatch: hGrant.revision,
      body: {},
    });
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    await openRestoredTenant(isolated, { tenantId: a.tenant.id, live: testDb().db, backup }, cmd(operator.id));
    const restored = await posts(tenantApi(isolated, { authorize: undefined }));
    expect(restored.status).toBe(403);
  });
});
