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
import { type Tx, withPlatform } from './tenant-context.js';

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

/**
 * 全局停用账号同样要走成员停用的挂接点（R4-3）：在该用户仍是有效成员的每个租户里调用挂接点，挂接抛错即整笔回滚。
 * users 行以 NO KEY UPDATE 锁住（R1-T07 R5-1 / R5-2）：与其他写入引用该用户的外键检查（KEY SHARE，如审计的操作人）
 * 相容，不会与本人正在进行的操作成环；与授予 / 重新激活成员关系先取的 FOR SHARE 互斥，停用期间该用户不会在任何
 * 租户新变成有效成员，逐租户处理的“有效成员”集合因此稳定。只改状态等非键列，UPDATE 本身同样只需 NO KEY UPDATE。
 */
export async function setUserStatus(db: Db, change: UserStatusChange, meta: PlatformCommandMeta): Promise<User> {
  return runPlatformCommand(db, meta, 'user.set_status', change, async (ctx) => {
    const [before] = await ctx.tx.select().from(users).where(eq(users.id, change.userId)).for('no key update');
    if (before && before.revision !== change.expectedRevision) {
      throw new RevisionConflictError('user', change.expectedRevision);
    }
    if (before?.status === 'active' && change.status === 'disabled' && membershipRevokeHook) {
      await deactivateInTenants(ctx, change.userId, meta, membershipRevokeHook);
    }
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

export interface MembershipRevocation {
  readonly tenantId: string;
  readonly userId: string;
  /** 撤销本租户成员关系，或全局停用账号（R4-3）。 */
  readonly reason: 'membership_revoked' | 'user_disabled';
  /** 租户时区（业务日期按租户时区，DEC-056）。 */
  readonly timezone: string;
  readonly actorUserId: string | null;
  readonly commandId: string;
}

/**
 * 成员停用前、同一事务内的挂接点：业务模块据此处理该成员名下的在途事务（R1-T07 审批中心：异常管理员停用时
 * 自动转派剩余异常待办，DEC-123）。撤销成员关系与全局停用账号都会调用（R4-3）。调用时尚未锁成员行：业务模块
 * 在挂接点里自行与其派单串行（审批中心的派单闸），撤销在挂接点之后才锁成员行并改状态（R5-1）。在租户上下文内调用；
 * 挂接抛错即整笔回滚。本包不依赖业务模块，由应用装配时注册。
 */
export type MembershipRevokeHook = (tx: Tx, revocation: MembershipRevocation) => Promise<void>;
let membershipRevokeHook: MembershipRevokeHook | null = null;

export function registerMembershipRevokeHook(hook: MembershipRevokeHook): void {
  membershipRevokeHook = hook;
}

async function changeMembership(
  db: Db,
  change: MembershipChange,
  meta: PlatformCommandMeta,
  status: MembershipStatus,
): Promise<TenantMembership> {
  const op = status === 'active' ? 'tenant_membership.grant' : 'tenant_membership.revoke';
  return runPlatformCommand(db, meta, op, change, async (ctx) => {
    const timezone = status === 'revoked' ? await tenantTimezone(ctx.tx, change.tenantId) : null;
    // 授予 / 重新激活与全局停用串行：先以 FOR SHARE 锁住 users 行（与停用的 NO KEY UPDATE 互斥，R1-T07 R5-2）。
    if (status === 'active')
      await ctx.tx.select({ id: users.id }).from(users).where(eq(users.id, change.userId)).for('share');
    return ctx.inTenant(change.tenantId, async () => {
      // 撤销先经挂接点接管（不持成员行锁），最后才锁成员行改状态：持成员行锁期间不再等任何业务锁（R1-T07 R5-1）。
      const current = await findMembership(ctx, change);
      assertMembershipRevision(current, change, status);
      if (current?.status === 'active' && timezone !== null && membershipRevokeHook) {
        const { tenantId, userId } = change;
        await membershipRevokeHook(ctx.tx, { tenantId, userId, reason: 'membership_revoked', timezone, ...meta });
      }
      const before = await findMembership(ctx, change, true);
      assertMembershipRevision(before, change, status);
      const after = before ? await updateMembership(ctx, before, status) : await insertMembership(ctx, change);
      await ctx.auditTenant(change.tenantId, audit(op, 'tenant_membership', after.id, snap(before), snap(after)));
      return after;
    });
  });
}

const TENANT_BATCH = 500;

/**
 * 平台角色不能跨租户读成员关系（RLS），按租户逐个切入，该用户在其中是有效成员的就调用挂接点。
 * 停用是低频的平台操作；租户按编号分批读取，不一次读入全部租户。
 */
async function deactivateInTenants(
  ctx: PlatformCommandContext,
  userId: string,
  meta: PlatformCommandMeta,
  hook: MembershipRevokeHook,
) {
  let after: string | null = null;
  for (;;) {
    const page: { id: string; timezone: string }[] = await ctx.tx
      .select({ id: tenants.id, timezone: tenants.timezone })
      .from(tenants)
      .where(after ? sql`${tenants.id} > ${after}` : sql`true`)
      .orderBy(tenants.id)
      .limit(TENANT_BATCH);
    for (const tenant of page) {
      await ctx.inTenant(tenant.id, async (tx) => {
        const [member] = await tx
          .select({ id: tenantMemberships.id })
          .from(tenantMemberships)
          .where(and(eq(tenantMemberships.userId, userId), eq(tenantMemberships.status, 'active')));
        if (member)
          await hook(tx, { tenantId: tenant.id, userId, reason: 'user_disabled', timezone: tenant.timezone, ...meta });
      });
    }
    if (page.length < TENANT_BATCH) return;
    after = page.at(-1)!.id;
  }
}

/** 租户表只对平台角色开放：在切入租户上下文之前读取。 */
async function tenantTimezone(tx: Tx, tenantId: string): Promise<string> {
  const [row] = await tx.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId));
  if (!row) throw new RevisionConflictError('tenant', 0);
  return row.timezone;
}

const snap = (m: TenantMembership | undefined) =>
  m ? { userId: m.userId, status: m.status, revision: m.revision } : null;

async function findMembership(ctx: PlatformCommandContext, change: MembershipChange, forUpdate = false) {
  const query = ctx.tx
    .select()
    .from(tenantMemberships)
    .where(and(eq(tenantMemberships.tenantId, change.tenantId), eq(tenantMemberships.userId, change.userId)));
  const [row] = forUpdate ? await query.for('update') : await query;
  return row;
}

function assertMembershipRevision(
  row: TenantMembership | undefined,
  change: MembershipChange,
  status: MembershipStatus,
) {
  if ((row?.revision ?? 0) !== change.expectedRevision) {
    throw new RevisionConflictError('tenant_membership', change.expectedRevision);
  }
  if (!row && status === 'revoked') throw new RevisionConflictError('tenant_membership', 0);
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
