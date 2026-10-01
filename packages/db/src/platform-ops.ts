/**
 * 平台路径上的操作（L1 平台方，REQ-PLT-001 R1；R1-T17 将在此基础上补开通预置、许可等）。
 * 读：经 withPlatform。写：一律经 runPlatformCommand——带操作人与命令 ID（幂等）、更新带 expectedRevision
 * （创建除外；成员关系“尚不存在”记为 revision 0）、同一事务内写审计。
 */
import { assertValidTimeZone, DEFAULT_TENANT_TIMEZONE } from '@italent/domain';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { pgErrorCode } from './pg-error.js';
import {
  type PlatformCommandContext,
  type PlatformCommandMeta,
  RevisionConflictError,
  runPlatformCommand,
} from './platform-command.js';
import {
  type MembershipStatus,
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
import { withPlatform } from './tenant-context.js';

export interface NewTenant {
  readonly code: string;
  readonly name: string;
  /** IANA 时区，缺省 Asia/Shanghai（DEC-056，REQ-PLT-001 R5）。 */
  readonly timezone?: string | undefined;
}

const tenantSnapshot = (t: Tenant) => ({
  code: t.code,
  name: t.name,
  timezone: t.timezone,
  status: t.status,
  revision: t.revision,
});
const userSnapshot = (u: User) => ({
  email: u.email,
  displayName: u.displayName,
  status: u.status,
  revision: u.revision,
});

/** 开通租户；审计写入新租户自己的 audit_events。 */
export async function createTenant(db: Db, input: NewTenant, meta: PlatformCommandMeta): Promise<Tenant> {
  const timezone = input.timezone ?? DEFAULT_TENANT_TIMEZONE;
  assertValidTimeZone(timezone);
  const values = { code: input.code, name: input.name, timezone };
  return runPlatformCommand(db, meta, 'tenant.create', values, async (ctx) => {
    const [row] = await ctx.tx.insert(tenants).values(values).returning();
    await ctx.auditTenant(row!.id, audit('tenant.create', 'tenant', row!.id, null, tenantSnapshot(row!)));
    return row!;
  });
}

export async function getTenant(db: Db, tenantId: string): Promise<Tenant | undefined> {
  const [row] = await withPlatform(db, (tx) => tx.select().from(tenants).where(eq(tenants.id, tenantId)));
  return row;
}

export interface TenantStatusChange {
  readonly tenantId: string;
  readonly status: TenantStatus;
  readonly expectedRevision: number;
}

/** 停用 / 恢复隔离 / 重新开放。restoring 期间除平台方外一律拒绝访问（DEC-061）。审计写入该租户。 */
export async function setTenantStatus(db: Db, change: TenantStatusChange, meta: PlatformCommandMeta): Promise<Tenant> {
  return runPlatformCommand(db, meta, 'tenant.set_status', change, async (ctx) => {
    const [before] = await ctx.tx.select().from(tenants).where(eq(tenants.id, change.tenantId)).for('update');
    const [row] = await ctx.tx
      .update(tenants)
      .set({ status: change.status, revision: change.expectedRevision + 1, updatedAt: sql`now()` })
      .where(and(eq(tenants.id, change.tenantId), eq(tenants.revision, change.expectedRevision)))
      .returning();
    if (!before || !row) throw new RevisionConflictError('tenant', change.expectedRevision);
    const entry = audit('tenant.set_status', 'tenant', row.id, tenantSnapshot(before), tenantSnapshot(row));
    await ctx.auditTenant(row.id, entry);
    return row;
  });
}

/** 建全局用户；无租户归属，审计写入 platform_audit_events。 */
export async function createUser(
  db: Db,
  input: { email: string; displayName: string },
  meta: PlatformCommandMeta,
): Promise<User> {
  const values = { email: input.email.toLowerCase(), displayName: input.displayName };
  return runPlatformCommand(db, meta, 'user.create', values, async (ctx) => {
    const [row] = await ctx.tx.insert(users).values(values).returning();
    await ctx.auditPlatform(audit('user.create', 'user', row!.id, null, userSnapshot(row!)));
    return row!;
  });
}

export async function getUser(db: Db, userId: string): Promise<User | undefined> {
  const [row] = await withPlatform(db, (tx) => tx.select().from(users).where(eq(users.id, userId)));
  return row;
}

export interface UserStatusChange {
  readonly userId: string;
  readonly status: UserStatus;
  readonly expectedRevision: number;
}

export async function setUserStatus(db: Db, change: UserStatusChange, meta: PlatformCommandMeta): Promise<User> {
  return runPlatformCommand(db, meta, 'user.set_status', change, async (ctx) => {
    const [before] = await ctx.tx.select().from(users).where(eq(users.id, change.userId)).for('update');
    const [row] = await ctx.tx
      .update(users)
      .set({ status: change.status, revision: change.expectedRevision + 1, updatedAt: sql`now()` })
      .where(and(eq(users.id, change.userId), eq(users.revision, change.expectedRevision)))
      .returning();
    if (!before || !row) throw new RevisionConflictError('user', change.expectedRevision);
    await ctx.auditPlatform(audit('user.set_status', 'user', row.id, userSnapshot(before), userSnapshot(row)));
    return row;
  });
}

export interface MembershipChange {
  readonly tenantId: string;
  readonly userId: string;
  /** 当前成员关系的 revision；尚无成员关系时为 0。 */
  readonly expectedRevision: number;
}

/** 授予（revision 0 时新建）或重新激活成员关系。成员关系行与审计都写在该租户下（RLS）。 */
export function grantMembership(db: Db, change: MembershipChange, meta: PlatformCommandMeta) {
  return changeMembership(db, change, meta, 'active');
}

/** 撤销只改状态、保留行（留痕）；中间件每次请求都会重新读取，撤销立即生效。 */
export function revokeMembership(db: Db, change: MembershipChange, meta: PlatformCommandMeta) {
  return changeMembership(db, change, meta, 'revoked');
}

async function changeMembership(
  db: Db,
  change: MembershipChange,
  meta: PlatformCommandMeta,
  status: MembershipStatus,
): Promise<TenantMembership> {
  const op = status === 'active' ? 'tenant_membership.grant' : 'tenant_membership.revoke';
  return runPlatformCommand(db, meta, op, change, (ctx) =>
    ctx.inTenant(change.tenantId, async () => {
      const before = await findMembershipForUpdate(ctx, change);
      if ((before?.revision ?? 0) !== change.expectedRevision) {
        throw new RevisionConflictError('tenant_membership', change.expectedRevision);
      }
      if (!before && status === 'revoked') throw new RevisionConflictError('tenant_membership', 0);
      const after = before ? await updateMembership(ctx, before, status) : await insertMembership(ctx, change);
      await ctx.auditTenant(change.tenantId, audit(op, 'tenant_membership', after.id, snap(before), snap(after)));
      return after;
    }),
  );
}

const snap = (m: TenantMembership | undefined) =>
  m ? { userId: m.userId, status: m.status, revision: m.revision } : null;

async function findMembershipForUpdate(ctx: PlatformCommandContext, change: MembershipChange) {
  const [row] = await ctx.tx
    .select()
    .from(tenantMemberships)
    .where(and(eq(tenantMemberships.tenantId, change.tenantId), eq(tenantMemberships.userId, change.userId)))
    .for('update');
  return row;
}

async function insertMembership(ctx: PlatformCommandContext, change: MembershipChange) {
  const [row] = await insertOnce(
    () => ctx.tx.insert(tenantMemberships).values({ tenantId: change.tenantId, userId: change.userId }).returning(),
    'tenant_membership',
  );
  return row!;
}

/**
 * “期望不存在（revision 0）”的首次插入：并发的另一方已先插入时唯一键冲突（23505），
 * 语义上就是 revision 冲突（与租户配置首次覆盖一致）；runPlatformCommand 随后先查台账，同命令则重放，否则 409。
 */
async function insertOnce<T>(insert: () => Promise<T>, object: string): Promise<T> {
  try {
    return await insert();
  } catch (error) {
    if (pgErrorCode(error) === '23505') throw new RevisionConflictError(object, 0);
    throw error;
  }
}

async function updateMembership(ctx: PlatformCommandContext, before: TenantMembership, status: MembershipStatus) {
  const [row] = await ctx.tx
    .update(tenantMemberships)
    .set({ status, revision: before.revision + 1, updatedAt: sql`now()` })
    .where(and(eq(tenantMemberships.id, before.id), eq(tenantMemberships.revision, before.revision)))
    .returning();
  if (!row) throw new RevisionConflictError('tenant_membership', before.revision);
  return row;
}

export interface SystemSettingInput {
  readonly key: string;
  readonly value: unknown;
  readonly description: string;
  readonly overridable: boolean;
  /** 当前 version；新建时为 0。 */
  readonly expectedVersion: number;
}

/** 平台下发 / 更新系统级预置；version 即其 revision。无租户归属，审计写入 platform_audit_events。 */
export async function upsertSystemSetting(
  db: Db,
  input: SystemSettingInput,
  meta: PlatformCommandMeta,
): Promise<SystemSetting> {
  return runPlatformCommand(db, meta, 'system_setting.upsert', input, async (ctx) => {
    const { expectedVersion, ...values } = input;
    const [before] = await ctx.tx.select().from(systemSettings).where(eq(systemSettings.key, input.key)).for('update');
    if ((before?.version ?? 0) !== expectedVersion) throw new RevisionConflictError('system_setting', expectedVersion);
    const [row] = before
      ? await ctx.tx
          .update(systemSettings)
          .set({ ...values, version: expectedVersion + 1, updatedAt: sql`now()` })
          .where(and(eq(systemSettings.key, input.key), eq(systemSettings.version, expectedVersion)))
          .returning()
      : await insertOnce(() => ctx.tx.insert(systemSettings).values(values).returning(), 'system_setting');
    if (!row) throw new RevisionConflictError('system_setting', expectedVersion);
    // 快照覆盖全部可变字段；创建时 before 为 null，after 含初始 description
    const snapshot = (s: SystemSetting | undefined) =>
      s ? { value: s.value, description: s.description, overridable: s.overridable, version: s.version } : null;
    await ctx.auditPlatform(audit('system_setting.upsert', 'system_setting', row.key, snapshot(before), snapshot(row)));
    return row;
  });
}

function audit(action: string, objectType: string, objectId: string, before: unknown, after: unknown) {
  return { action, objectType, objectId, before, after };
}
