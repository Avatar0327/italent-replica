/**
 * 平台写命令（REQ-PLT-001 R1；AGENTS.md §10「并发」「幂等」「审计」）：
 * 所有平台写操作经 runPlatformCommand —— expectedRevision（创建除外）、操作人 + 命令 ID 幂等、同事务审计。
 * 与租户相关的变更审计进该租户的 audit_events；无租户归属的进 platform_audit_events。
 */
import {
  and,
  APP_ROLE,
  auditEvents,
  createTenant,
  createUser,
  type Db,
  eq,
  getTenant,
  getUser,
  grantMembership,
  IdempotencyConflictError,
  platformAuditEvents,
  RevisionConflictError,
  revokeMembership,
  setTenantStatus,
  setUserStatus,
  sql,
  upsertSystemSetting,
  withPlatform,
  withTenant,
} from '@italent/db';
import { pgErrorCode, useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { cmd } from './acceptance/support/tenant-api.js';

const testDb = useTestDb();

async function tenantAudit(db: Db, tenantId: string, objectId: string) {
  return withTenant(db, tenantId, (tx) =>
    tx
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.objectId, objectId)))
      .orderBy(auditEvents.occurredAt),
  );
}

async function platformAudit(db: Db, objectId: string) {
  return withPlatform(db, (tx) =>
    tx.select().from(platformAuditEvents).where(eq(platformAuditEvents.objectId, objectId)),
  );
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe('平台写命令：租户', () => {
  let operator: string;

  beforeAll(async () => {
    operator = (await createUser(testDb().db, { email: 'platform-op@example.com', displayName: '平台运维' }, cmd())).id;
  });

  it('开租户与改状态都写入该租户的审计；状态变更须带 revision，旧 revision → 冲突且不改状态', async () => {
    const { db } = testDb();
    const tenant = await createTenant(db, { code: 'plt-t1', name: '平台租户一' }, cmd(operator));
    const changed = await setTenantStatus(
      db,
      { tenantId: tenant.id, status: 'suspended', expectedRevision: tenant.revision },
      cmd(operator),
    );
    expect(changed.revision).toBe(tenant.revision + 1);

    const stale = setTenantStatus(db, { tenantId: tenant.id, status: 'active', expectedRevision: 1 }, cmd(operator));
    await expect(stale).rejects.toBeInstanceOf(RevisionConflictError);
    expect((await getTenant(db, tenant.id))?.status).toBe('suspended');

    const events = await tenantAudit(db, tenant.id, tenant.id);
    expect(events.map((e) => e.action)).toEqual(['tenant.create', 'tenant.set_status']);
    expect(events[1]).toMatchObject({ actorUserId: operator, before: { status: 'active', revision: 1 } });
    expect(events[1]?.after).toMatchObject({ status: 'suspended', revision: 2 });
    expect(events.every((e) => e.commandId)).toBe(true);
  });

  it('同命令 ID 同内容重放首次结果（不重复执行、不重复审计）；同 ID 异内容 → 冲突', async () => {
    const { db } = testDb();
    const tenant = await createTenant(db, { code: 'plt-t2', name: '平台租户二' }, cmd(operator));
    const meta = cmd(operator);
    const change = { tenantId: tenant.id, status: 'restoring' as const, expectedRevision: 1 };
    const first = await setTenantStatus(db, change, meta);
    const replay = await setTenantStatus(db, change, meta);
    expect(replay).toEqual(first);
    expect(replay.updatedAt).toBeInstanceOf(Date);
    expect((await getTenant(db, tenant.id))?.revision).toBe(2);

    const other = setTenantStatus(db, { ...change, status: 'active' }, meta);
    await expect(other).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect((await tenantAudit(db, tenant.id, tenant.id)).filter((e) => e.action === 'tenant.set_status')).toHaveLength(
      1,
    );
  });

  it('同命令 ID 的并发重复请求都得到同一结果，只写一次审计', async () => {
    const { db } = testDb();
    const tenant = await createTenant(db, { code: 'plt-t3', name: '平台租户三' }, cmd(operator));
    const meta = cmd(operator);
    const change = { tenantId: tenant.id, status: 'suspended' as const, expectedRevision: 1 };
    const [x, y] = await Promise.all([setTenantStatus(db, change, meta), setTenantStatus(db, change, meta)]);
    expect(y).toEqual(x);
    const statusEvents = (await tenantAudit(db, tenant.id, tenant.id)).filter((e) => e.action === 'tenant.set_status');
    expect(statusEvents).toHaveLength(1);
  });
});

describe('平台写命令：用户与系统预置（无租户归属 → 平台审计）', () => {
  it('建用户、改用户状态写入 platform_audit_events；改状态须带 revision', async () => {
    const { db } = testDb();
    const user = await createUser(db, { email: 'Mixed.Case@Example.com', displayName: '大小写' }, cmd());
    expect(user).toMatchObject({ email: 'mixed.case@example.com', revision: 1 });

    const stale = setUserStatus(db, { userId: user.id, status: 'disabled', expectedRevision: 0 }, cmd());
    await expect(stale).rejects.toBeInstanceOf(RevisionConflictError);
    const disabled = await setUserStatus(db, { userId: user.id, status: 'disabled', expectedRevision: 1 }, cmd());
    expect(disabled).toMatchObject({ status: 'disabled', revision: 2 });
    expect((await getUser(db, user.id))?.status).toBe('disabled');

    const events = await platformAudit(db, user.id);
    expect(events.map((e) => e.action).sort()).toEqual(['user.create', 'user.set_status']);
    const statusEvent = events.find((e) => e.action === 'user.set_status');
    expect(statusEvent?.before).toMatchObject({ status: 'active', revision: 1 });
    expect(statusEvent?.after).toMatchObject({ status: 'disabled', revision: 2 });
  });

  it('系统预置下发须带 expectedVersion，旧版本 → 冲突；变更写入平台审计', async () => {
    const { db } = testDb();
    const input = { key: 'test.preset', value: 1, description: '测试预置', overridable: true };
    const created = await upsertSystemSetting(db, { ...input, expectedVersion: 0 }, cmd());
    expect(created.version).toBe(1);
    const stale = upsertSystemSetting(db, { ...input, value: 2, expectedVersion: 0 }, cmd());
    await expect(stale).rejects.toBeInstanceOf(RevisionConflictError);
    const updated = await upsertSystemSetting(db, { ...input, value: 2, expectedVersion: 1 }, cmd());
    expect(updated).toMatchObject({ value: 2, version: 2 });
    expect((await platformAudit(db, 'test.preset')).map((e) => e.after)).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: 2, version: 2 })]),
    );
  });

  it('平台审计只追加，且租户角色无权读取', async () => {
    const { db } = testDb();
    for (const statement of [
      sql`UPDATE platform_audit_events SET action = 'forged'`,
      sql`DELETE FROM platform_audit_events`,
      sql`TRUNCATE platform_audit_events`,
    ]) {
      expect(pgErrorCode(await failure(db.execute(statement)))).toBe('55000');
    }
    const tenant = await createTenant(db, { code: 'plt-t4', name: '平台租户四' }, cmd());
    const asTenant = withTenant(db, tenant.id, (tx) => tx.select().from(platformAuditEvents));
    expect(pgErrorCode(await failure(asTenant))).toBe('42501');
    const roles = await db.execute(
      sql`SELECT has_table_privilege(${APP_ROLE.tenant}, 'platform_audit_events', 'SELECT') AS ok`,
    );
    expect(JSON.stringify(roles)).toContain('"ok":false');
  });
});

describe('平台写命令：成员关系', () => {
  it('授予 / 撤销 / 重新激活都带 revision，审计写入该租户并记录操作人，审计不可改删', async () => {
    const { db } = testDb();
    const admin = await createUser(db, { email: 'tenant-admin@example.com', displayName: '租户管理员' }, cmd());
    const member = await createUser(db, { email: 'member@example.com', displayName: '成员' }, cmd());
    const tenant = await createTenant(db, { code: 'plt-m1', name: '成员租户' }, cmd());
    const key = { tenantId: tenant.id, userId: member.id };

    const granted = await grantMembership(db, { ...key, expectedRevision: 0 }, cmd(admin.id));
    await expect(grantMembership(db, { ...key, expectedRevision: 0 }, cmd(admin.id))).rejects.toBeInstanceOf(
      RevisionConflictError,
    );
    const revoked = await revokeMembership(db, { ...key, expectedRevision: granted.revision }, cmd(admin.id));
    expect(revoked).toMatchObject({ status: 'revoked', revision: 2 });
    const reactivated = await grantMembership(db, { ...key, expectedRevision: 2 }, cmd(admin.id));
    expect(reactivated).toMatchObject({ status: 'active', revision: 3 });

    const otherUser = { tenantId: tenant.id, userId: admin.id, expectedRevision: 0 };
    await expect(revokeMembership(db, otherUser, cmd(admin.id))).rejects.toBeInstanceOf(RevisionConflictError);

    const events = await tenantAudit(db, tenant.id, granted.id);
    expect(events.map((e) => e.action)).toEqual([
      'tenant_membership.grant',
      'tenant_membership.revoke',
      'tenant_membership.grant',
    ]);
    expect(events[1]).toMatchObject({ tenantId: tenant.id, actorUserId: admin.id });
    expect(events[1]?.before).toMatchObject({ status: 'active', revision: 1 });
    expect(events[1]?.after).toMatchObject({ status: 'revoked', revision: 2 });

    const tamper = withTenant(db, tenant.id, (tx) =>
      tx.update(auditEvents).set({ after: null }).where(eq(auditEvents.id, events[1]!.id)),
    );
    await expect(tamper).rejects.toThrow();
    const erase = db.execute(sql`DELETE FROM audit_events WHERE id = ${events[1]!.id}`);
    expect(pgErrorCode(await failure(erase))).toBe('55000');
  });
});
