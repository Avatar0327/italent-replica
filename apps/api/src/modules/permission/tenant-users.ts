/**
 * 企业设置 · 用户管理（R1-T15；DEC-128；06 §9、§7.1）。租户内的用户 = 成员关系（tenant_memberships），
 * 全局登录账号（users）只经迁移 0032 的两个受限定义者函数访问：按登录邮箱找到或新建账号、读取本租户成员的账号。
 * - 内部员工：随建档 / 入职由 user-provisioning.ts 产生并绑定档案，没有手工新建、绑定、改绑入口；
 * - 外部用户：没有人员档案，必须带业务身份（猎头、实施顾问等）；
 * - 停用 / 移出租户：调用平台流程（user-routes.ts → platform-ops，PR #35），这里不改账号与成员状态。
 */
import {
  and,
  asc,
  eq,
  pgErrorCode,
  permissionUserPersonLinks,
  sql,
  type TenantMembership,
  tenantMemberships,
  type Tx,
  type UserType,
} from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { audit, type WriteContext } from './audit.js';
import { revisionConflict } from './http.js';
import { scopeRows } from './scope-hierarchy.js';
import { userAvatars, type AvatarReference } from '../avatar/references.js';

export interface TenantUserView {
  readonly avatar?: AvatarReference | null;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly userType: UserType | null;
  readonly businessIdentity: string | null;
  readonly employeeId: string | null;
  readonly membershipStatus: TenantMembership['status'];
  readonly membershipRevision: number;
  readonly accountStatus: 'active' | 'disabled';
  readonly accountRevision: number;
}

export type UserTypeFilter = UserType | 'all';

interface Account {
  readonly email: string;
  readonly displayName: string;
  readonly status: 'active' | 'disabled';
  readonly revision: number;
}

const notFound = () => new AppError('NOT_FOUND', '用户不存在');
export const internalUserByProfile = () =>
  new AppError('FORBIDDEN', '内部员工随人员档案自动产生，请前往新增员工', { reason: 'INTERNAL_USER_BY_PROFILE' });

/** 按登录邮箱找到或新建全局账号（不新建第二个），并以 FOR SHARE 锁住，与全局停用串行（迁移 0032）。 */
export async function provisionAccount(
  tx: Tx,
  write: WriteContext,
  email: string,
  displayName: string,
): Promise<{ userId: string; created: boolean }> {
  const [row] = scopeRows<{ account_id: string; created: boolean }>(
    await tx.execute(sql`SELECT account_id, created
      FROM tenant_provision_account(${email}, ${displayName}, ${write.userId}::uuid, ${write.commandId})`),
  );
  return { userId: row!.account_id, created: row!.created };
}

/** 本租户成员的账号信息（不是本租户成员的账号不返回，迁移 0032）。 */
async function accountsOf(tx: Tx, userIds: readonly string[]): Promise<Map<string, Account>> {
  if (userIds.length === 0) return new Map();
  const ids = sql.join(
    userIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = scopeRows<{ account_id: string; email: string; display_name: string; status: string; revision: number }>(
    await tx.execute(sql`SELECT * FROM tenant_member_accounts(ARRAY[${ids}]::uuid[])`),
  );
  return new Map(
    rows.map((r) => [
      r.account_id,
      {
        email: r.email,
        displayName: r.display_name,
        status: r.status as Account['status'],
        revision: Number(r.revision),
      },
    ]),
  );
}

/** 内部员工 = 已绑定人员档案（或已登记为内部员工）；外部用户 = 登记为外部用户。 */
function typeFilter(type: UserTypeFilter): SQL | undefined {
  if (type === 'external') return eq(tenantMemberships.userType, 'external');
  if (type === 'internal') {
    return sql`(${tenantMemberships.userType} = 'internal' OR ${permissionUserPersonLinks.employeeId} IS NOT NULL)`;
  }
  return undefined;
}

function memberQuery(tx: Tx, where: SQL | undefined) {
  return tx
    .select({ membership: tenantMemberships, employeeId: permissionUserPersonLinks.employeeId })
    .from(tenantMemberships)
    .leftJoin(
      permissionUserPersonLinks,
      and(
        eq(permissionUserPersonLinks.tenantId, tenantMemberships.tenantId),
        eq(permissionUserPersonLinks.userId, tenantMemberships.userId),
      ),
    )
    .where(where);
}

type MemberRow = { membership: TenantMembership; employeeId: string | null };

async function viewsOf(tx: Tx, rows: readonly MemberRow[]): Promise<TenantUserView[]> {
  const accounts = await accountsOf(
    tx,
    rows.map((r) => r.membership.userId),
  );
  const avatars = rows.length
    ? await userAvatars(
        tx,
        rows[0]!.membership.tenantId,
        rows.map((r) => r.membership.userId),
      )
    : new Map();
  return rows.map(({ membership: m, employeeId }) => {
    const account = accounts.get(m.userId);
    return {
      userId: m.userId,
      avatar: avatars.get(m.userId) ?? null,
      email: account?.email ?? '',
      displayName: account?.displayName ?? '',
      // 档案绑定由早期夹具 / 导入直接写入时尚未登记类型，按绑定视为内部员工
      userType: employeeId ? 'internal' : m.userType,
      businessIdentity: m.businessIdentity,
      employeeId,
      membershipStatus: m.status,
      membershipRevision: m.revision,
      accountStatus: account?.status ?? 'disabled',
      accountRevision: account?.revision ?? 0,
    };
  });
}

export async function listTenantUsers(
  tx: Tx,
  query: { readonly type: UserTypeFilter; readonly limit: number; readonly offset: number },
): Promise<TenantUserView[]> {
  const rows = await memberQuery(tx, typeFilter(query.type))
    .orderBy(asc(tenantMemberships.createdAt), asc(tenantMemberships.id))
    .limit(query.limit)
    .offset(query.offset);
  return viewsOf(tx, rows);
}

export async function getTenantUser(tx: Tx, userId: string): Promise<TenantUserView> {
  const [row] = await memberQuery(tx, eq(tenantMemberships.userId, userId));
  if (!row) throw notFound();
  return (await viewsOf(tx, [row]))[0]!;
}

export interface ExternalUserInput {
  readonly email: string;
  readonly displayName: string;
  readonly businessIdentity: string;
}

/**
 * 登记外部用户（AC-PRM-33）：按登录邮箱复用或新建全局账号，在本租户新建（或重新启用已移出且无档案的）成员关系，
 * 用户类型 = 外部用户并带业务身份。已是本租户有效成员的账号 → 409。
 */
export async function registerExternalUser(
  tx: Tx,
  write: WriteContext,
  input: ExternalUserInput,
): Promise<TenantUserView> {
  const account = await provisionAccount(tx, write, input.email, input.displayName);
  const [current] = await memberQuery(tx, eq(tenantMemberships.userId, account.userId)).for('update', {
    of: tenantMemberships,
  });
  if (current?.employeeId) {
    throw new AppError('CONFLICT', '该账号已绑定本租户的人员档案', { reason: 'ACCOUNT_BOUND_TO_OTHER_PERSON' });
  }
  if (current?.membership.status === 'active') {
    throw new AppError('CONFLICT', '该账号已是本租户的用户', { reason: 'USER_ALREADY_MEMBER' });
  }
  const values = { userType: 'external' as const, businessIdentity: input.businessIdentity, updatedAt: write.now };
  const saved = current
    ? await updateMembership(tx, current.membership, { ...values, status: 'active' })
    : await insertMembership(tx, write, account.userId, values);
  const after = await getTenantUser(tx, saved.userId);
  await audit(tx, write, {
    action: 'tenant_user.register_external',
    objectType: 'tenant_user',
    objectId: saved.userId,
    before: current ? memberSnapshot(current.membership) : null,
    after: { ...after, revision: after.membershipRevision, accountCreated: account.created },
  });
  return after;
}

/** 修改外部用户的业务身份，或把平台授予、尚未登记类型的成员登记为外部用户；内部员工的类型不能改。 */
export async function updateExternalUser(
  tx: Tx,
  write: WriteContext,
  change: { readonly userId: string; readonly expectedRevision: number; readonly businessIdentity: string },
): Promise<TenantUserView> {
  const [current] = await memberQuery(tx, eq(tenantMemberships.userId, change.userId)).for('update', {
    of: tenantMemberships,
  });
  if (!current) throw notFound();
  const m = current.membership;
  if (m.revision !== change.expectedRevision) throw revisionConflict(change.expectedRevision, m.revision);
  if (current.employeeId || m.userType === 'internal') {
    throw new AppError('CONFLICT', '内部员工的用户类型由人员档案决定，不能修改', { reason: 'USER_TYPE_LOCKED' });
  }
  const before = await getTenantUser(tx, m.userId);
  const patch = { userType: 'external' as const, businessIdentity: change.businessIdentity, updatedAt: write.now };
  await updateMembership(tx, m, patch);
  const after = await getTenantUser(tx, m.userId);
  await audit(tx, write, {
    action: 'tenant_user.update',
    objectType: 'tenant_user',
    objectId: m.userId,
    before: { ...before, revision: before.membershipRevision },
    after: { ...after, revision: after.membershipRevision },
  });
  return after;
}

type MembershipPatch = Partial<Pick<TenantMembership, 'status' | 'userType' | 'businessIdentity' | 'updatedAt'>>;

/** 成员关系的租户侧改写：带 revision 条件，revision + 1（与平台路径同一并发口径）。 */
export async function updateMembership(
  tx: Tx,
  current: TenantMembership,
  patch: MembershipPatch,
): Promise<TenantMembership> {
  const [saved] = await tx
    .update(tenantMemberships)
    .set({ ...patch, revision: current.revision + 1 })
    .where(and(eq(tenantMemberships.id, current.id), eq(tenantMemberships.revision, current.revision)))
    .returning();
  if (!saved) throw revisionConflict(current.revision, undefined);
  return saved;
}

export async function insertMembership(
  tx: Tx,
  write: WriteContext,
  userId: string,
  values: MembershipPatch,
): Promise<TenantMembership> {
  try {
    const [row] = await tx
      .insert(tenantMemberships)
      .values({ tenantId: write.tenantId, userId, createdAt: write.now, ...values })
      .returning();
    return row!;
  } catch (error) {
    // 并发的另一条命令已为同一账号建了成员关系：按冲突返回，客户端刷新后显式重提
    if (pgErrorCode(error) === '23505') throw new AppError('CONFLICT', '该账号正在被其他操作登记', { reason: 'BUSY' });
    throw error;
  }
}

export function memberSnapshot(m: TenantMembership) {
  return {
    userId: m.userId,
    status: m.status,
    userType: m.userType,
    businessIdentity: m.businessIdentity,
    revision: m.revision,
  };
}
