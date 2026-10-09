/**
 * 平台路径上的操作（L1 平台方，REQ-PLT-001 R1）。开通预置、许可发放、备份恢复等组合命令在 API 层
 * modules/platform（R1-T17），经 insertTenant / grantMembershipIn 在同一平台命令事务内复用这里的写法。
 * 读：经 withPlatform。写：一律经 runPlatformCommand——带操作人与命令 ID（幂等）、更新带 expectedRevision
 * （创建除外；成员关系“尚不存在”记为 revision 0）、同一事务内写审计。
 */
import { assertValidTimeZone, DEFAULT_TENANT_TIMEZONE } from '@italent/domain';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { pgErrorCode } from './pg-error.js';
import {
  type AuditEntry,
  type PlatformCommandContext,
  type PlatformCommandMeta,
  RevisionConflictError,
  runPlatformCommand,
} from './platform-command.js';
import {
  type MembershipStatus,
  permissionOutbox,
  type PlatformOperator,
  platformOperators,
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

/** 开通租户；审计写入新租户自己的 audit_events（及平台审计）。完整开通（预置下发）见 API 层 provisionTenant。 */
export async function createTenant(db: Db, input: NewTenant, meta: PlatformCommandMeta): Promise<Tenant> {
  const values = tenantValues(input);
  return runPlatformCommand(db, meta, 'tenant.create', values, (ctx) => insertTenant(ctx, values));
}

/** 时区缺省 Asia/Shanghai，非 IANA 时区抛 RangeError（DEC-056）。 */
export function tenantValues(input: NewTenant): { code: string; name: string; timezone: string } {
  const timezone = input.timezone ?? DEFAULT_TENANT_TIMEZONE;
  assertValidTimeZone(timezone);
  return { code: input.code, name: input.name, timezone };
}

/** 在已有的平台命令内建租户行并写审计（开通命令把它与预置下发放在同一事务）。编码重复 → revision 冲突（409）。 */
export async function insertTenant(ctx: PlatformCommandContext, input: NewTenant): Promise<Tenant> {
  const [row] = await insertOnce(() => ctx.tx.insert(tenants).values(tenantValues(input)).returning(), 'tenant');
  await ctx.auditTenant(row!.id, audit('tenant.create', 'tenant', row!.id, null, tenantSnapshot(row!)));
  return row!;
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
    // F-069：账号行锁排在组织锁之后（入职首次绑定是 员工 → 组织 → 账号行 FOR SHARE）。停用先不加锁地看一眼状态，
    // 若要走成员停用挂接点，先在各租户按全局锁序取齐接管要用的业务锁，再锁账号行，避免持账号行锁时反向等组织锁。
    const [seen] = await ctx.tx.select({ status: users.status }).from(users).where(eq(users.id, change.userId));
    const deactivating = seen?.status === 'active' && change.status === 'disabled';
    const prelocked = new Set<string>();
    if (deactivating && membershipRevokeHook && membershipPrelockHook) {
      for (const tenant of await activeMembershipTenants(ctx, change.userId)) {
        await runInTenant(ctx, tenant, change.userId, meta, 'user_disabled', membershipPrelockHook);
        prelocked.add(tenant.id);
      }
    }
    const [before] = await ctx.tx.select().from(users).where(eq(users.id, change.userId)).for('no key update');
    if (before && before.revision !== change.expectedRevision) {
      throw new RevisionConflictError('user', change.expectedRevision);
    }
    if (before?.status === 'active' && change.status === 'disabled' && membershipRevokeHook) {
      const tenantsNow = await activeMembershipTenants(ctx, change.userId);
      // 预取与锁账号行之间，该账号在预取没覆盖的租户新成为有效成员（重新激活等）：此时已持账号行锁，不能再补取业务锁
      // （入职首次绑定持组织锁等账号行，会成环）。回滚并要求显式重提；重提时那个租户已在预取范围内。
      if (membershipPrelockHook && tenantsNow.some((tenant) => !prelocked.has(tenant.id))) {
        throw new RevisionConflictError('用户的成员关系（停用期间在预取之外的租户发生变化）', change.expectedRevision);
      }
      for (const tenant of tenantsNow) {
        await runInTenant(ctx, tenant, change.userId, meta, 'user_disabled', membershipRevokeHook);
      }
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
 * 在挂接点里自行与其派单串行（审批中心的派单闸），撤销在挂接点之后才锁成员行并改状态（R5-1）；成员行以 NO KEY UPDATE
 * 锁，与其他事务引用该成员的外键锁相容（F-008 / R6-2）。在租户上下文内调用；挂接抛错即整笔回滚。
 * 本包不依赖业务模块，由应用装配时注册。
 */
export type MembershipRevokeHook = (tx: Tx, revocation: MembershipRevocation) => Promise<void>;
let membershipRevokeHook: MembershipRevokeHook | null = null;

export function registerMembershipRevokeHook(hook: MembershipRevokeHook): void {
  membershipRevokeHook = hook;
}

/**
 * 全局停用账号专用的预取挂接点（F-069）：在锁 users 行（NO KEY UPDATE）之前、各租户内、同一事务里调用，
 * 业务模块在此按自己的全局锁序取齐接管会用到的锁（审批中心：派单闸 → 员工 → 业务 → 组织，与手动交接同序）。
 * 入职首次绑定的顺序是“组织锁 → users 行 FOR SHARE”，停用若先持 users 行锁再取组织锁就与之成环（40P01）。
 * 预取之后的 MembershipRevokeHook 在锁住 users 行后重入这些已持有的锁；此时 users 行已锁，不得再新增需等待的业务锁，
 * 所以 setUserStatus 取得账号锁后会核对当前有效成员的租户都已预取，有遗漏（预取后新激活）即回滚并报并发冲突，要求显式重提。
 */
export type MembershipPrelockHook = MembershipRevokeHook;
let membershipPrelockHook: MembershipPrelockHook | null = null;

export function registerMembershipPrelockHook(hook: MembershipPrelockHook): void {
  membershipPrelockHook = hook;
}

async function changeMembership(
  db: Db,
  change: MembershipChange,
  meta: PlatformCommandMeta,
  status: MembershipStatus,
): Promise<TenantMembership> {
  const op = status === 'active' ? 'tenant_membership.grant' : 'tenant_membership.revoke';
  return runPlatformCommand(db, meta, op, change, (ctx) => applyMembershipChange(ctx, change, meta, status));
}

/** 新建成员关系时登记的用户类型（DEC-128：没有人员档案的账号登记为外部用户并带业务身份）。 */
export interface MembershipRegistration {
  readonly userType: 'external';
  readonly businessIdentity: string;
}

/**
 * 在已有的平台命令内授予成员关系（开通命令为首位租户管理员、异常管理员授予成员关系）。
 * registration 只在新建成员关系时写入；已有成员关系（重新激活）保持原登记。
 */
export function grantMembershipIn(
  ctx: PlatformCommandContext,
  change: MembershipChange,
  meta: PlatformCommandMeta,
  registration?: MembershipRegistration,
): Promise<TenantMembership> {
  return applyMembershipChange(ctx, change, meta, 'active', registration);
}

async function applyMembershipChange(
  ctx: PlatformCommandContext,
  change: MembershipChange,
  meta: PlatformCommandMeta,
  status: MembershipStatus,
  registration?: MembershipRegistration,
): Promise<TenantMembership> {
  const op = status === 'active' ? 'tenant_membership.grant' : 'tenant_membership.revoke';
  const timezone = status === 'revoked' ? await tenantTimezone(ctx.tx, change.tenantId) : null;
  // 授予 / 重新激活与全局停用串行：先以 FOR SHARE 锁住 users 行（与停用的 NO KEY UPDATE 互斥，R1-T07 R5-2）。
  if (status === 'active')
    await ctx.tx.select({ id: users.id }).from(users).where(eq(users.id, change.userId)).for('share');
  return ctx.inTenant(change.tenantId, async () => {
    // 撤销先经挂接点接管（不持成员行锁），最后才锁成员行改状态：持成员行锁期间不再等任何业务锁（R1-T07 R5-1）。
    // 最后这一步也不能反过来等“已引用该成员、正在等业务锁”的事务（F-008 / R6-2，如首次交接插入替代人记录时
    // 来源成员外键已取得其成员行的 KEY SHARE）：成员行锁用 NO KEY UPDATE，见 findMembership。
    const current = await findMembership(ctx, change);
    assertMembershipRevision(current, change, status);
    if (current?.status === 'active' && timezone !== null && membershipRevokeHook) {
      const { tenantId, userId } = change;
      await membershipRevokeHook(ctx.tx, { tenantId, userId, reason: 'membership_revoked', timezone, ...meta });
    }
    const before = await findMembership(ctx, change, true);
    assertMembershipRevision(before, change, status);
    const after = before
      ? await updateMembership(ctx, before, status)
      : await insertMembership(ctx, change, registration);
    const entry = audit(op, 'tenant_membership', after.id, snap(before), snap(after));
    await tenantEvent(ctx, meta, change.tenantId, entry, after.revision);
    return after;
  });
}

/**
 * 成员关系变更：同一事务写入该租户的审计与权限 outbox（AGENTS.md §10「审计」「事件」）；
 * 企业设置的停用、启用与移出租户（R1-T15，DEC-142）经此留痕，权限模块据此刷新缓存、通知等。
 */
async function tenantEvent(
  ctx: PlatformCommandContext,
  meta: PlatformCommandMeta,
  tenantId: string,
  entry: AuditEntry,
  revision: number,
) {
  await ctx.auditTenant(tenantId, entry);
  await ctx.inTenant(tenantId, async (tx) => {
    await tx.insert(permissionOutbox).values({
      tenantId,
      objectType: entry.objectType,
      objectId: entry.objectId,
      eventType: entry.action,
      revision,
      commandId: meta.commandId,
    });
  });
}

const TENANT_BATCH = 500;

/**
 * 平台角色不能跨租户读成员关系（RLS），按租户逐个切入，列出该用户当前是有效成员的租户（按租户编号升序，预取与接管两轮同序）。
 * 停用是低频的平台操作；租户按编号分批读取，不一次读入全部租户。
 */
async function activeMembershipTenants(
  ctx: PlatformCommandContext,
  userId: string,
): Promise<{ id: string; timezone: string }[]> {
  const found: { id: string; timezone: string }[] = [];
  let after: string | null = null;
  for (;;) {
    const page: { id: string; timezone: string }[] = await ctx.tx
      .select({ id: tenants.id, timezone: tenants.timezone })
      .from(tenants)
      .where(after ? sql`${tenants.id} > ${after}` : sql`true`)
      .orderBy(tenants.id)
      .limit(TENANT_BATCH);
    for (const tenant of page) {
      const member = await ctx.inTenant(tenant.id, (tx) =>
        tx
          .select({ id: tenantMemberships.id })
          .from(tenantMemberships)
          .where(and(eq(tenantMemberships.userId, userId), eq(tenantMemberships.status, 'active'))),
      );
      if (member.length) found.push(tenant);
    }
    if (page.length < TENANT_BATCH) return found;
    after = page.at(-1)!.id;
  }
}

function runInTenant(
  ctx: PlatformCommandContext,
  tenant: { id: string; timezone: string },
  userId: string,
  meta: PlatformCommandMeta,
  reason: MembershipRevocation['reason'],
  hook: MembershipRevokeHook,
) {
  return ctx.inTenant(tenant.id, (tx) =>
    hook(tx, { tenantId: tenant.id, userId, reason, timezone: tenant.timezone, ...meta }),
  );
}

/** 租户表只对平台角色开放：在切入租户上下文之前读取。 */
async function tenantTimezone(tx: Tx, tenantId: string): Promise<string> {
  const [row] = await tx.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId));
  if (!row) throw new RevisionConflictError('tenant', 0);
  return row.timezone;
}

const snap = (m: TenantMembership | undefined) =>
  m
    ? {
        userId: m.userId,
        status: m.status,
        userType: m.userType,
        businessIdentity: m.businessIdentity,
        revision: m.revision,
      }
    : null;

/**
 * @param lock 锁住成员行以改写。授予 / 撤销只改状态、revision 等非键列（键是编号与“租户 + 用户”），UPDATE 本身只需
 *   NO KEY UPDATE，这里取同一级：同一成员的授予 / 撤销照样互斥；而它与外键检查的 KEY SHARE 相容——别的事务插入引用
 *   该成员的行（审批任务、通知、替代人记录等）不会挡住撤销的最后一步（F-008 / R6-2）。
 */
async function findMembership(ctx: PlatformCommandContext, change: MembershipChange, lock = false) {
  const query = ctx.tx
    .select()
    .from(tenantMemberships)
    .where(and(eq(tenantMemberships.tenantId, change.tenantId), eq(tenantMemberships.userId, change.userId)));
  const [row] = lock ? await query.for('no key update') : await query;
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

async function insertMembership(
  ctx: PlatformCommandContext,
  change: MembershipChange,
  registration?: MembershipRegistration,
) {
  const values = { tenantId: change.tenantId, userId: change.userId, ...registration };
  const [row] = await insertOnce(
    () => ctx.tx.insert(tenantMemberships).values(values).returning(),
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

export interface PlatformOperatorChange {
  readonly userId: string;
  /** 当前 revision；从未登记过时为 0。 */
  readonly expectedRevision: number;
}

const operatorSnapshot = (o: PlatformOperator | undefined) => (o ? { status: o.status, revision: o.revision } : null);

/**
 * 登记（revision 0 时新建）或重新启用平台运营身份（REQ-PLT-001 R1：租户开通、停用、许可发放、备份恢复由平台方操作）。
 * 首位平台运营由部署时的运维脚本以“系统”（actorUserId = null）登记，见 docs/06_部署/01_部署运行手册.md。
 */
export function grantPlatformOperator(db: Db, change: PlatformOperatorChange, meta: PlatformCommandMeta) {
  return changePlatformOperator(db, change, meta, 'active');
}

/** 撤销只改状态、保留行；平台接口每次请求重新读取，撤销立即生效。 */
export function revokePlatformOperator(db: Db, change: PlatformOperatorChange, meta: PlatformCommandMeta) {
  return changePlatformOperator(db, change, meta, 'revoked');
}

async function changePlatformOperator(
  db: Db,
  change: PlatformOperatorChange,
  meta: PlatformCommandMeta,
  status: PlatformOperator['status'],
): Promise<PlatformOperator> {
  const op = status === 'active' ? 'platform_operator.grant' : 'platform_operator.revoke';
  return runPlatformCommand(db, meta, op, change, async (ctx) => {
    const [before] = await ctx.tx
      .select()
      .from(platformOperators)
      .where(eq(platformOperators.userId, change.userId))
      .for('update');
    if ((before?.revision ?? 0) !== change.expectedRevision || (!before && status === 'revoked')) {
      throw new RevisionConflictError('platform_operator', change.expectedRevision);
    }
    const [row] = before
      ? await ctx.tx
          .update(platformOperators)
          .set({ status, revision: before.revision + 1, updatedAt: sql`now()` })
          .where(and(eq(platformOperators.userId, change.userId), eq(platformOperators.revision, before.revision)))
          .returning()
      : await insertOnce(
          () => ctx.tx.insert(platformOperators).values({ userId: change.userId }).returning(),
          'platform_operator',
        );
    if (!row) throw new RevisionConflictError('platform_operator', change.expectedRevision);
    await ctx.auditPlatform(
      audit(op, 'platform_operator', row.userId, operatorSnapshot(before), operatorSnapshot(row)),
    );
    return row;
  });
}

/** 平台接口的准入判断：全局账号有效且平台运营身份有效（每次请求调用，不缓存）。 */
export async function isActivePlatformOperator(db: Db, userId: string): Promise<boolean> {
  const [row] = await withPlatform(db, (tx) =>
    tx
      .select({ userId: platformOperators.userId })
      .from(platformOperators)
      .innerJoin(users, eq(users.id, platformOperators.userId))
      .where(
        and(eq(platformOperators.userId, userId), eq(platformOperators.status, 'active'), eq(users.status, 'active')),
      ),
  );
  return row !== undefined;
}

function audit(action: string, objectType: string, objectId: string, before: unknown, after: unknown) {
  return { action, objectType, objectId, before, after };
}
