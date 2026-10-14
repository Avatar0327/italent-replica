/**
 * AC-TEN-06（DEC-061，REQ-TEN-001 R6 / REQ-PLT-001 R6；AGENTS.md §10「恢复」）：按租户恢复演练。
 * 恢复单元 = 租户数据的一致快照 + 附件清单与哈希 + 代码 / 迁移版本。恢复到隔离环境（新库）后租户保持 restoring，
 * 先做隔离校验（无跨租户数据）与授权对账（备份后撤销过的授权不得复活），通过后才开放访问；B 全程不受影响；
 * 不重放已处理节点、不补发消息（在途事件恢复为“结果未知”）；备份传输与存储加密。
 * RPO ≤ 1h / RTO ≤ 4h、保留 30 天属部署运维指标（见 docs/06_部署/01_部署运行手册.md），在部署阶段验收；
 * 这里只断言报告给出了度量它们所需的时间点。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { openRestoredTenant, restoreTenant } from '@italent/api';
import {
  BackupIntegrityError,
  type Db,
  exportTenantBackup,
  getTenant,
  grantMembership,
  openBackup,
  permissionGrants,
  permissionOutbox,
  platformAuditEvents,
  sealBackup,
  sql,
  type TenantBackup,
  tenants,
  withPlatform,
  withTenant,
} from '@italent/db';
import { createTestDb, useTestDb } from '@italent/testkit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { newUser, provisioned, type ProvisionResult, seedOperator } from './support/platform-api.js';
import { cmd, errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const HOUR = 3600_000;

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

// 整库备份 / 恢复按全部租户表逐表进行，耗时随表数增长（R3-T03 新增 23 张表后逼近默认 30s），单独放宽且仍有上限
const RESTORE_TIMEOUT = { timeout: 90_000 };

describe('AC-TEN-06 按租户备份恢复演练', RESTORE_TIMEOUT, () => {
  let api: ReturnType<typeof tenantApi>;
  let fixture: ReturnType<typeof tenantApi>;
  let operator: Awaited<ReturnType<typeof seedOperator>>;
  let a: ProvisionResult;
  let b: ProvisionResult;
  let asA: { user: string; tenant: string };
  let asB: { user: string; tenant: string };
  let asH: { user: string; tenant: string };
  let hGrant: string;
  let attachment: { id: string; sha256: string };
  let backup: TenantBackup;
  const targets: { close(): Promise<void> }[] = [];

  afterEach(async () => {
    while (targets.length) await targets.pop()!.close();
  });

  async function target(): Promise<Db> {
    const handle = await createTestDb();
    targets.push(handle);
    return handle.db;
  }

  const store = () => new Map([[attachment.id, attachment.sha256]]);
  const attachments = (hashes: Map<string, string>) => ({ sha256: async (id: string) => hashes.get(id) ?? null });

  beforeAll(async () => {
    const { db } = testDb();
    api = tenantApi(db, { authorize: undefined });
    fixture = tenantApi(db);
    operator = await seedOperator(db);
    const adminA = await newUser(db, 'drill-a');
    const adminB = await newUser(db, 'drill-b');
    a = await provisioned(api, operator, {
      firstAdminUserId: adminA.id,
      exceptionAdminUserId: adminA.id,
      licenses: [{ licenseType: 'core_hr', quota: 5 }],
    });
    b = await provisioned(api, operator, { firstAdminUserId: adminB.id, exceptionAdminUserId: adminB.id });
    asA = { user: adminA.id, tenant: a.tenant.id };
    asB = { user: adminB.id, tenant: b.tenant.id };

    const org = await fixture.request('POST', '/api/tenant/org/organizations', {
      ...asA,
      ifMatch: 0,
      body: { name: '备份前组织', establishedOn: '2026-01-01', parents: { admin: { parentId: a.tenant.id } } },
    });
    expect(org.status, await org.clone().text()).toBe(201);
    await fixture.request('POST', '/api/tenant/org/organizations', {
      ...asB,
      ifMatch: 0,
      body: { name: 'B 的组织', establishedOn: '2026-01-01', parents: { admin: { parentId: b.tenant.id } } },
    });
    const employee = await fixture.request('POST', '/api/tenant/employment/employees', {
      ...asA,
      ifMatch: 0,
      body: { code: 'E001', name: '张三' },
    });
    expect(employee.status, await employee.clone().text()).toBe(201);
    const employeeId = ((await employee.json()) as { id: string }).id;
    const sha256 = randomBytes(32).toString('hex');
    // 附件元数据直接登记（附件登记接口的应用角色授权缺失另行修复，不在本任务范围）
    const attachmentId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${a.tenant.id}, true)`);
      await tx.execute(sql`INSERT INTO personnel_attachments
        (id, tenant_id, employee_id, purpose, filename, content_type, byte_size, sha256, created_by)
        VALUES (${attachmentId}, ${a.tenant.id}, ${employeeId}, 'photo', 'a.png', 'image/png', 3, ${sha256},
          ${adminA.id})`);
    });
    attachment = { id: attachmentId, sha256 };

    const h = await newUser(db, 'drill-h');
    await grantMembership(db, { tenantId: a.tenant.id, userId: h.id, expectedRevision: 0 }, cmd());
    asH = { user: h.id, tenant: a.tenant.id };
    const hr = a.profiles.find((p) => p.code === 'standard_hr_admin')!;
    const granted = await api.request('POST', '/api/tenant/permission/grants', {
      ...asA,
      body: { userId: h.id, profileId: hr.id },
    });
    expect(granted.status, await granted.clone().text()).toBe(201);
    hGrant = ((await granted.json()) as { id: string }).id;

    backup = await exportTenantBackup(db, { tenantId: a.tenant.id, codeVersion: 'drill' }, cmd(operator.id));

    // 备份之后：撤销 H 的授权、再建一个组织（恢复到备份时点时它不应出现）
    const revoked = await api.request('POST', `/api/tenant/permission/grants/${hGrant}/revoke`, {
      ...asA,
      ifMatch: 1,
      body: {},
    });
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    await fixture.request('POST', '/api/tenant/org/organizations', {
      ...asA,
      ifMatch: 0,
      body: { name: '备份后组织', establishedOn: '2026-01-01', parents: { admin: { parentId: a.tenant.id } } },
    });
  });

  it('备份是 A 的一致快照：只含 A 的数据，带附件清单与哈希、代码与迁移版本、校验和', () => {
    expect(backup.manifest).toMatchObject({
      format: 'italent-tenant-backup',
      tenantId: a.tenant.id,
      codeVersion: 'drill',
      attachments: [{ id: attachment.id, sha256: attachment.sha256, byteSize: 3 }],
    });
    expect(backup.manifest.migration.count).toBeGreaterThan(30);
    expect(Date.now() - new Date(backup.manifest.takenAt).getTime()).toBeLessThan(HOUR);
    for (const [table, rows] of Object.entries(backup.tables)) {
      for (const row of rows) expect(row.tenant_id, table).toBe(a.tenant.id);
      expect(backup.manifest.rowCounts[table]).toBe(rows.length);
    }
    expect(backup.tables.tenant_memberships!.length).toBeGreaterThan(0);
    const text = JSON.stringify(backup);
    expect(text).not.toContain(b.tenant.id);
    expect(text).not.toContain('B 的组织');
    expect(backup.platform.tenants).toEqual([expect.objectContaining({ id: a.tenant.id })]);
  });

  it('导出写平台审计', async () => {
    const events = await withPlatform(testDb().db, (tx) =>
      tx
        .select()
        .from(platformAuditEvents)
        .where(sql`${platformAuditEvents.action} = 'tenant.backup.export'`),
    );
    expect(events).toEqual([
      expect.objectContaining({ actorUserId: operator.id, objectId: a.tenant.id, subjectTenantId: a.tenant.id }),
    ]);
  });

  it('加密封装：密文不含明文，换密钥打不开，原密钥还原一致', () => {
    const key = randomBytes(32);
    const sealed = sealBackup(backup, key);
    expect(sealed.toString('utf8')).not.toContain(a.tenant.code);
    expect(() => openBackup(sealed, randomBytes(32))).toThrow(BackupIntegrityError);
    expect(openBackup(sealed, key)).toEqual(backup);
  });

  it('恢复到隔离环境：校验与对账通过前保持 restoring、拒绝访问；撤销过的授权不复活；在途事件不补发；通过后开放', async () => {
    const { db } = testDb();
    const bBefore = await api.request('GET', '/api/tenant/permission/admins', asB);
    const live = db;
    const isolated = await target();
    const restoreCommand = cmd(operator.id);
    const report = await restoreTenant(isolated, { backup, live, attachments: attachments(store()) }, restoreCommand);
    expect(report).toMatchObject({
      tenantId: a.tenant.id,
      ok: true,
      isolation: { ok: true, foreignRows: 0, tenants: 1 },
      attachments: { ok: true, missing: [], mismatched: [] },
      reconciliation: { problems: [] },
      dataAsOf: backup.manifest.takenAt,
    });
    expect(report.reconciliation.unknownEvents).toBeGreaterThan(0);
    expect(report.reconciliation.changed.permission_grants).toBeGreaterThan(0);
    expect(new Date(report.verifiedAt).getTime()).toBeGreaterThanOrEqual(new Date(report.startedAt).getTime());
    expect((await getTenant(isolated, a.tenant.id))?.status).toBe('restoring');

    const restoredApi = tenantApi(isolated, { authorize: undefined });
    const blocked = await restoredApi.request('GET', '/api/tenant/permission/admins', asA);
    expect(blocked.status).toBe(403);
    expect(await errorCode(blocked)).toBe('TENANT_UNAVAILABLE');

    const openCommand = cmd(operator.id);
    const opened = await openRestoredTenant(isolated, { tenantId: a.tenant.id, live: db, backup }, openCommand);
    expect(opened.status).toBe('active');
    expect(new Date(opened.openedAt).getTime() - new Date(report.startedAt).getTime()).toBeLessThan(4 * HOUR);

    const orgs = await restoredApi.request('GET', '/api/tenant/org/organizations?asOf=2026-10-01', asA);
    expect(orgs.status).toBe(200);
    const restoredNames = await withTenant(isolated, a.tenant.id, async (tx) =>
      rowsOf<{ name: string }>(await tx.execute(sql`SELECT name FROM org_versions`)).map((r) => r.name),
    );
    expect(restoredNames).toContain('备份前组织');
    expect(restoredNames).not.toContain('备份后组织');

    const grants = await withTenant(isolated, a.tenant.id, (tx) =>
      tx
        .select()
        .from(permissionGrants)
        .where(sql`${permissionGrants.id} = ${hGrant}`),
    );
    expect(grants[0]?.status).toBe('revoked');
    const licenses = await restoredApi.request('GET', '/api/tenant/permission/licenses', asA);
    expect(((await licenses.json()) as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ licenseType: 'core_hr', used: 1 }),
    ]);
    const asHPosts = await restoredApi.request('GET', '/api/tenant/job/posts', asH);
    expect(asHPosts.status).toBe(403);

    // 备份里的在途事件一律改记“结果未知”、不补发；只有恢复对账自己产生的撤销事件是待投递的新事件
    const pending = await withTenant(isolated, a.tenant.id, (tx) =>
      tx
        .select({ commandId: permissionOutbox.commandId, eventType: permissionOutbox.eventType })
        .from(permissionOutbox)
        .where(sql`${permissionOutbox.state} = 'pending'`),
    );
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((p) => [restoreCommand.commandId, openCommand.commandId].includes(p.commandId))).toBe(true);

    const restoredTenants = await withPlatform(isolated, (tx) => tx.select({ id: tenants.id }).from(tenants));
    expect(restoredTenants).toEqual([{ id: a.tenant.id }]);
    const audits = await withPlatform(isolated, (tx) => tx.select().from(platformAuditEvents));
    expect(audits.map((e) => e.action)).toEqual(
      expect.arrayContaining(['tenant.restore.import', 'tenant.restore.reconcile', 'tenant.restore.open']),
    );

    const bAfter = await api.request('GET', '/api/tenant/permission/admins', asB);
    expect(bAfter.status).toBe(200);
    expect(await bAfter.json()).toEqual(await bBefore.json());
  });

  it('附件哈希不符或缺失：报告不通过，租户保持 restoring，不能开放', async () => {
    const live = testDb().db;
    const isolated = await target();
    const report = await restoreTenant(
      isolated,
      { backup, live, attachments: attachments(new Map([[attachment.id, 'f'.repeat(64)]])) },
      cmd(operator.id),
    );
    expect(report.ok).toBe(false);
    expect(report.attachments.mismatched).toEqual([attachment.id]);
    expect(report.attachments.missing).toEqual([]);

    // 对象存储里根本没有这个附件：同样不通过
    const empty = await target();
    const missing = await restoreTenant(empty, { backup, live, attachments: attachments(new Map()) }, cmd(operator.id));
    expect(missing.ok).toBe(false);
    expect(missing.attachments).toMatchObject({ missing: [attachment.id], mismatched: [] });

    // P2-N4：补齐附件后，以新的命令 ID 对已导入的快照重新校验；通过后可开放。同键重试仍返回首次（失败）结果。
    const failedCommand = cmd(operator.id);
    const fixedTarget = await target();
    const first = await restoreTenant(
      fixedTarget,
      { backup, live, attachments: attachments(new Map()) },
      failedCommand,
    );
    expect(first.ok).toBe(false);
    const fixedStore = attachments(store());
    expect(await restoreTenant(fixedTarget, { backup, live, attachments: fixedStore }, failedCommand)).toEqual(first);
    const reverified = await restoreTenant(fixedTarget, { backup, live, attachments: fixedStore }, cmd(operator.id));
    expect(reverified).toMatchObject({ ok: true, attachments: { ok: true } });
    const opened = await openRestoredTenant(fixedTarget, { tenantId: a.tenant.id, live, backup }, cmd(operator.id));
    expect(opened.status).toBe('active');
    // 已开放的租户不能再“重新校验”
    await expect(
      restoreTenant(fixedTarget, { backup, live, attachments: fixedStore }, cmd(operator.id)),
    ).rejects.toEqual(expect.objectContaining({ reason: 'TARGET_NOT_EMPTY' }));
    await expect(
      openRestoredTenant(isolated, { tenantId: a.tenant.id, live, backup }, cmd(operator.id)),
    ).rejects.toThrow(BackupIntegrityError);
    expect((await getTenant(isolated, a.tenant.id))?.status).toBe('restoring');
  });

  it('校验和被篡改、迁移版本不一致、目标库非空：一律拒绝恢复', async () => {
    const live = testDb().db;
    const run = (input: TenantBackup, db: Db) =>
      restoreTenant(db, { backup: input, live, attachments: attachments(store()) }, cmd(operator.id));
    const tampered = structuredClone(backup);
    tampered.tables.org_versions![0]!.name = '篡改';
    const reason = (r: string) => expect.objectContaining({ name: 'BackupIntegrityError', reason: r });
    await expect(run(tampered, await target())).rejects.toEqual(reason('CHECKSUM_MISMATCH'));

    const versioned = structuredClone(backup);
    versioned.manifest.migration.count += 1;
    await expect(run(versioned, await target())).rejects.toEqual(reason('MIGRATION_VERSION_MISMATCH'));

    await expect(run(backup, testDb().db)).rejects.toEqual(reason('TARGET_NOT_EMPTY'));
  });
});
