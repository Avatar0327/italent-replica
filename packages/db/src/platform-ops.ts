/**
 * 平台路径上的操作（L1 平台方，REQ-PLT-001 R1；R1-T17 将在此基础上补开通预置、许可等）。
 * 平台级表经 withPlatform 访问；需要写租户数据（如成员关系）时显式切到 withTenant。
 */
import { assertValidTimeZone, DEFAULT_TENANT_TIMEZONE } from '@italent/domain';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  auditEvents,
  type SystemSetting,
  systemSettings,
  type Tenant,
  type TenantMembership,
  tenantMemberships,
  tenants,
  type TenantStatus,
  type User,
  users,
  type UserStatus,
} from './schema/index.js';
import { type Tx, withPlatform, withTenant } from './tenant-context.js';

export interface NewTenant {
  readonly code: string;
  readonly name: string;
  /** IANA 时区，缺省 Asia/Shanghai（DEC-056，REQ-PLT-001 R5）。 */
  readonly timezone?: string | undefined;
}

export async function createTenant(db: Db, input: NewTenant): Promise<Tenant> {
  const timezone = input.timezone ?? DEFAULT_TENANT_TIMEZONE;
  assertValidTimeZone(timezone);
  const [row] = await withPlatform(db, (tx) =>
    tx.insert(tenants).values({ code: input.code, name: input.name, timezone }).returning(),
  );
  return row!;
}

export async function getTenant(db: Db, tenantId: string): Promise<Tenant | undefined> {
  const [row] = await withPlatform(db, (tx) => tx.select().from(tenants).where(eq(tenants.id, tenantId)));
  return row;
}

/** 平台写操作的 revision 不一致（AGENTS.md §10「并发」）；API 层映射为 409 REVISION_CONFLICT。 */
export class RevisionConflictError extends Error {
  readonly code = 'REVISION_CONFLICT';
  constructor(
    readonly object: string,
    readonly expectedRevision: number,
  ) {
    super(`${object} 的 revision 已不是 ${expectedRevision}`);
    this.name = 'RevisionConflictError';
  }
}

/** 停用 / 恢复隔离 / 重新开放，须带 expectedRevision。restoring 期间除平台方外一律拒绝访问（DEC-061）。 */
export async function setTenantStatus(
  db: Db,
  tenantId: string,
  status: TenantStatus,
  expectedRevision: number,
): Promise<Tenant> {
  const [row] = await withPlatform(db, (tx) =>
    tx
      .update(tenants)
      .set({ status, revision: expectedRevision + 1, updatedAt: sql`now()` })
      .where(and(eq(tenants.id, tenantId), eq(tenants.revision, expectedRevision)))
      .returning(),
  );
  if (!row) throw new RevisionConflictError('tenant', expectedRevision);
  return row;
}

export async function createUser(db: Db, input: { email: string; displayName: string }): Promise<User> {
  const [row] = await withPlatform(db, (tx) =>
    tx.insert(users).values({ email: input.email.toLowerCase(), displayName: input.displayName }).returning(),
  );
  return row!;
}

export async function getUser(db: Db, userId: string): Promise<User | undefined> {
  const [row] = await withPlatform(db, (tx) => tx.select().from(users).where(eq(users.id, userId)));
  return row;
}

export async function setUserStatus(db: Db, userId: string, status: UserStatus): Promise<void> {
  await withPlatform(db, (tx) =>
    tx
      .update(users)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(users.id, userId)),
  );
}

export interface MembershipChange {
  readonly tenantId: string;
  readonly userId: string;
  /** 操作人；平台方或系统任务为 null（审计记为“系统”）。 */
  readonly actorUserId: string | null;
}

/** 授予（或重新激活）成员关系；写在租户路径上，受 RLS 约束，并在同一事务内写审计。 */
export async function grantMembership(db: Db, change: MembershipChange): Promise<TenantMembership> {
  return withTenant(db, change.tenantId, async (tx) => {
    const before = await findMembershipForUpdate(tx, change);
    const [row] = await tx
      .insert(tenantMemberships)
      .values({ tenantId: change.tenantId, userId: change.userId })
      .onConflictDoUpdate({
        target: [tenantMemberships.tenantId, tenantMemberships.userId],
        set: { status: 'active', revision: sql`${tenantMemberships.revision} + 1`, updatedAt: sql`now()` },
      })
      .returning();
    await auditMembership(tx, change, 'tenant_membership.grant', before, row!);
    return row!;
  });
}

/** 撤销只改状态、保留行（留痕）并写审计；中间件每次请求都会重新读取，撤销立即生效。 */
export async function revokeMembership(db: Db, change: MembershipChange): Promise<TenantMembership | undefined> {
  return withTenant(db, change.tenantId, async (tx) => {
    const before = await findMembershipForUpdate(tx, change);
    if (before?.status !== 'active') return before;
    const [row] = await tx
      .update(tenantMemberships)
      .set({ status: 'revoked', revision: before.revision + 1, updatedAt: sql`now()` })
      .where(eq(tenantMemberships.id, before.id))
      .returning();
    await auditMembership(tx, change, 'tenant_membership.revoke', before, row!);
    return row;
  });
}

async function findMembershipForUpdate(tx: Tx, change: MembershipChange): Promise<TenantMembership | undefined> {
  const [row] = await tx
    .select()
    .from(tenantMemberships)
    .where(and(eq(tenantMemberships.tenantId, change.tenantId), eq(tenantMemberships.userId, change.userId)))
    .for('update');
  return row;
}

async function auditMembership(
  tx: Tx,
  change: MembershipChange,
  action: string,
  before: TenantMembership | undefined,
  after: TenantMembership,
): Promise<void> {
  const snapshot = (m: TenantMembership | undefined) =>
    m ? { userId: m.userId, status: m.status, revision: m.revision } : null;
  // 审计行落在该租户下（tenant_id = 租户），受同一 RLS 策略约束
  await tx.insert(auditEvents).values({
    tenantId: change.tenantId,
    actorUserId: change.actorUserId,
    action,
    objectType: 'tenant_membership',
    objectId: after.id,
    before: snapshot(before),
    after: snapshot(after),
  });
}

export interface SystemSettingInput {
  readonly key: string;
  readonly value: unknown;
  readonly description: string;
  readonly overridable: boolean;
}

/** 平台下发 / 更新系统级预置；内容变化时 version + 1。 */
export async function upsertSystemSetting(db: Db, input: SystemSettingInput): Promise<SystemSetting> {
  const [row] = await withPlatform(db, (tx) =>
    tx
      .insert(systemSettings)
      .values(input)
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: {
          value: input.value,
          description: input.description,
          overridable: input.overridable,
          version: sql`${systemSettings.version} + 1`,
          updatedAt: sql`now()`,
        },
      })
      .returning(),
  );
  return row!;
}
