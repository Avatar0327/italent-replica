/**
 * 权限模块提供给人员建档 / 入职写入路径的端口（DEC-128，AC-PRM-31/32；06 §9）：
 * 租户内用户与人员一一对应、由建档产生——建立人员档案或办理入职时，在调用方的同一事务里自动创建并绑定租户用户，
 * 按登录邮箱复用已有全局账号。permission_user_person_links 只由这里写入（导入北森数据时的一次性对应另走初始化，
 * DEC-128）；不提供手工绑定或改绑入口，数据库层也收回了应用角色的 UPDATE 权限（迁移 0032）。
 * 账号启用状态（users.status）与在职状态（任职记录）相互独立：这里不看在职状态，也不改账号状态。
 */
import { eq, permissionUserPersonLinks, pgErrorCode, sql, tenantMemberships, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { audit, type WriteContext } from './audit.js';
import { getTenantUser, insertMembership, memberSnapshot, provisionAccount, updateMembership } from './tenant-users.js';

export interface EmployeeUserRequest {
  readonly employeeId: string;
  /** 登录邮箱；建立人员档案时可暂无，办理入职前必须补齐（DEC-140）。 */
  readonly loginEmail?: string | undefined;
  /** 新建全局账号时的显示名（人员姓名）；复用已有账号时不改。 */
  readonly displayName: string;
  /**
   * 办理入职（含重聘、入职申请）时为 true：人员尚未绑定用户又没给登录邮箱即拒绝并提示补填，
   * 保证入职完成的员工一定已有租户用户并绑定档案（DEC-140，落实 DEC-128）。
   */
  readonly accountRequired?: boolean;
}

export interface EmployeeUser {
  readonly userId: string;
  readonly created: boolean;
}

const conflict = (reason: string, message: string) => new AppError('CONFLICT', message, { reason });

/**
 * 确保该人员有绑定的租户用户：已绑定 → 不改绑（给了不同的登录邮箱即 409），成员关系已被移出的在（重新）入职时恢复；
 * 未绑定且给了登录邮箱 → 找到或新建全局账号、建 / 恢复成员关系（用户类型 = 内部员工；原为外部用户的自动转换，
 * DEC-158）并绑定；
 * 未绑定也没给登录邮箱 → 建档时暂不建用户，入职时拒绝（DEC-140）。
 * @returns 绑定的用户；建档时未绑定且没有登录邮箱为 null
 */
export async function provisionEmployeeUser(
  tx: Tx,
  write: WriteContext,
  request: EmployeeUserRequest,
): Promise<EmployeeUser | null> {
  const [bound] = await tx
    .select()
    .from(permissionUserPersonLinks)
    .where(eq(permissionUserPersonLinks.employeeId, request.employeeId));
  if (bound) return keepBinding(tx, write, bound.userId, request);
  if (!request.loginEmail) {
    if (!request.accountRequired) return null;
    throw new AppError('VALIDATION_FAILED', '办理入职必须填写登录邮箱', { reason: 'LOGIN_EMAIL_REQUIRED' });
  }

  const account = await provisionAccount(tx, write, request.loginEmail, request.displayName);
  // 同一账号的并发建档串行化：后到者看到已有绑定，按“账号已绑定另一人员”拒绝，而不是撞唯一键
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${write.tenantId}:person-link:${account.userId}`}, 0))`,
  );
  const [other] = await tx
    .select()
    .from(permissionUserPersonLinks)
    .where(eq(permissionUserPersonLinks.userId, account.userId));
  if (other) throw conflict('ACCOUNT_BOUND_TO_OTHER_PERSON', '该登录邮箱的账号已绑定本租户的另一份人员档案');

  const [membership] = await tx
    .select()
    .from(tenantMemberships)
    .where(eq(tenantMemberships.userId, account.userId))
    .for('update');
  // DEC-158：外部用户以同一登录邮箱建档 / 入职时自动转为内部员工并绑定档案；成员关系、授权、管理员身份原样保留。
  // 这是外部用户转内部员工的唯一途径（不提供手工改类型入口）。
  const internal = { userType: 'internal' as const, businessIdentity: null, updatedAt: write.now };
  const before = membership ? memberSnapshot(membership) : null;
  if (!membership) await insertMembership(tx, write, account.userId, internal);
  else await updateMembership(tx, membership, { ...internal, status: 'active' });
  try {
    await tx.insert(permissionUserPersonLinks).values({
      tenantId: write.tenantId,
      userId: account.userId,
      employeeId: request.employeeId,
    });
  } catch (error) {
    if (pgErrorCode(error) === '23505') throw conflict('ACCOUNT_BOUND_TO_OTHER_PERSON', '该人员或账号已有绑定');
    throw error;
  }
  const after = await getTenantUser(tx, account.userId);
  await audit(tx, write, {
    action: 'tenant_user.provision',
    objectType: 'tenant_user',
    objectId: account.userId,
    before,
    after: { ...after, revision: after.membershipRevision, accountCreated: account.created },
  });
  return { userId: account.userId, created: account.created };
}

async function keepBinding(
  tx: Tx,
  write: WriteContext,
  userId: string,
  request: EmployeeUserRequest,
): Promise<EmployeeUser> {
  const current = await getTenantUser(tx, userId);
  if (request.loginEmail && request.loginEmail.trim().toLowerCase() !== current.email) {
    throw conflict('USER_REBIND_FORBIDDEN', '人员已绑定用户，不能改绑到另一登录账号');
  }
  if (current.membershipStatus === 'active') return { userId, created: false };
  // 被移出租户后（重新）入职：恢复成员关系，绑定不变。先以 FOR SHARE 锁账号再锁成员行，与平台授予成员关系同序。
  await provisionAccount(tx, write, current.email, current.displayName);
  const [membership] = await tx
    .select()
    .from(tenantMemberships)
    .where(eq(tenantMemberships.userId, userId))
    .for('update');
  const restored = { status: 'active' as const, userType: 'internal' as const, updatedAt: write.now };
  const saved = await updateMembership(tx, membership!, restored);
  await audit(tx, write, {
    action: 'tenant_user.provision',
    objectType: 'tenant_user',
    objectId: userId,
    before: memberSnapshot(membership!),
    after: memberSnapshot(saved),
  });
  return { userId, created: false };
}
