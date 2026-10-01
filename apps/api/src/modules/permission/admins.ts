/**
 * L2 企业管理员记录（06 §2、§2.1）：一个用户 × 一个管理员身份，附「可授权管理员身份」与「可授权业务身份」两个集合。
 * 授出上限（REQ-PRM-001 R1、R2）：只能建 / 改自己可授权的管理员身份；交出的可授权集合不得超出自己的集合。
 */
import {
  and,
  eq,
  pgErrorCode,
  type PermissionAdmin,
  permissionAdminGrantableProfiles,
  permissionAdminGrantableRoles,
  permissionAdmins,
  permissionProfiles,
  type Tx,
} from '@italent/db';
import { type AdminRole, isAdminRole } from '@italent/domain';
import { inArray } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { audit, type WriteContext } from './audit.js';
import { revisionConflict } from './http.js';
import { assertActiveMember } from './members.js';

export interface PermissionAdminView {
  readonly id: string;
  readonly userId: string;
  readonly role: AdminRole;
  readonly status: 'active' | 'revoked';
  readonly revision: number;
  readonly grantableAdminRoles: AdminRole[];
  readonly grantableProfileIds: string[];
}

export interface GrantableSets {
  readonly grantableAdminRoles: readonly AdminRole[];
  readonly grantableProfileIds: readonly string[];
}

/** 某用户全部有效管理员记录的可授权集合并集（多管理员身份取并集）。 */
export async function grantableSetsOf(
  tx: Tx,
  userId: string,
): Promise<{ roles: Set<AdminRole>; profiles: Set<string>; heldRoles: Set<AdminRole> }> {
  const records = await tx
    .select({ id: permissionAdmins.id, role: permissionAdmins.role })
    .from(permissionAdmins)
    .where(and(eq(permissionAdmins.userId, userId), eq(permissionAdmins.status, 'active')));
  const ids = records.map((r) => r.id);
  if (ids.length === 0) return { roles: new Set(), profiles: new Set(), heldRoles: new Set() };
  const roles = await tx
    .select()
    .from(permissionAdminGrantableRoles)
    .where(inArray(permissionAdminGrantableRoles.adminId, ids));
  const profiles = await tx
    .select()
    .from(permissionAdminGrantableProfiles)
    .where(inArray(permissionAdminGrantableProfiles.adminId, ids));
  return {
    roles: new Set(roles.map((r) => r.role).filter(isAdminRole)),
    profiles: new Set(profiles.map((p) => p.profileId)),
    heldRoles: new Set(records.map((r) => r.role).filter(isAdminRole)),
  };
}

export async function listAdmins(tx: Tx): Promise<PermissionAdminView[]> {
  const rows = await tx.select().from(permissionAdmins).where(eq(permissionAdmins.status, 'active'));
  // 同一事务连接上逐条查询，不并发
  const views: PermissionAdminView[] = [];
  for (const row of rows) views.push(await viewOf(tx, row));
  return views;
}

export async function getAdmin(tx: Tx, id: string): Promise<PermissionAdminView> {
  return viewOf(tx, await loadAdmin(tx, id));
}

export interface NewAdmin extends GrantableSets {
  readonly userId: string;
  readonly role: AdminRole;
}

export async function createAdmin(tx: Tx, write: WriteContext, input: NewAdmin): Promise<PermissionAdminView> {
  await assertCanDelegate(tx, write.userId, input.role, input);
  await assertActiveMember(tx, input.userId);
  let row: PermissionAdmin | undefined;
  try {
    [row] = await tx
      .insert(permissionAdmins)
      .values({ tenantId: write.tenantId, userId: input.userId, role: input.role, createdBy: write.userId })
      .returning();
  } catch (error) {
    if (pgErrorCode(error) === '23505') throw new AppError('CONFLICT', '该用户已持有此管理员身份');
    throw error;
  }
  await writeGrantableSets(tx, write.tenantId, row!.id, input);
  const created = await viewOf(tx, row!);
  await audit(tx, write, {
    action: 'permission_admin.create',
    objectType: 'permission_admin',
    objectId: created.id,
    before: null,
    after: created,
  });
  return created;
}

export interface AdminUpdate extends GrantableSets {
  readonly adminId: string;
  readonly expectedRevision: number;
}

/** 整体替换可授权集合，revision + 1。 */
export async function updateAdmin(tx: Tx, write: WriteContext, change: AdminUpdate): Promise<PermissionAdminView> {
  const current = await loadAdmin(tx, change.adminId, true);
  if (current.status !== 'active') throw new AppError('NOT_FOUND', '管理员记录不存在');
  if (current.revision !== change.expectedRevision) throw revisionConflict(change.expectedRevision, current.revision);
  await assertCanDelegate(tx, write.userId, current.role as AdminRole, change);

  const before = await viewOf(tx, current);
  await tx.delete(permissionAdminGrantableRoles).where(eq(permissionAdminGrantableRoles.adminId, current.id));
  await tx.delete(permissionAdminGrantableProfiles).where(eq(permissionAdminGrantableProfiles.adminId, current.id));
  await writeGrantableSets(tx, write.tenantId, current.id, change);
  const [saved] = await tx
    .update(permissionAdmins)
    .set({ revision: current.revision + 1, updatedAt: write.now })
    .where(and(eq(permissionAdmins.id, current.id), eq(permissionAdmins.revision, current.revision)))
    .returning();
  if (!saved) throw revisionConflict(change.expectedRevision, undefined);
  const after = await viewOf(tx, saved);
  await audit(tx, write, {
    action: 'permission_admin.update',
    objectType: 'permission_admin',
    objectId: current.id,
    before,
    after,
  });
  return after;
}

/**
 * 授出上限：被管理的管理员身份须在操作者的可授权管理员身份内（R2）；交出的可授权集合不得超出操作者自己的集合（R1）。
 * 租户管理员例外：可把任意本租户身份放进可授权业务身份集合——否则新建身份永远无人可授（原站 FAQ
 * “新建和复制的身份，为什么授权时选择不到”说明新身份须另行加入）。
 * TODO(需取证 #5)：新建身份进入管理员可授权集合的原站路径（谁能加、能否加给自己）。
 */
async function assertCanDelegate(tx: Tx, actorUserId: string, role: AdminRole, sets: GrantableSets): Promise<void> {
  const actor = await grantableSetsOf(tx, actorUserId);
  const outside = <T>(values: readonly T[], allowed: Set<T>) => values.filter((v) => !allowed.has(v));
  if (!actor.roles.has(role) || outside(sets.grantableAdminRoles, actor.roles).length > 0) {
    throw new AppError('FORBIDDEN', '只能授予可授权范围内的管理员身份', { reason: 'ADMIN_ROLE_NOT_GRANTABLE' });
  }
  await assertProfilesExist(tx, sets.grantableProfileIds);
  if (actor.heldRoles.has('tenant_admin')) return;
  const extra = outside(sets.grantableProfileIds, actor.profiles);
  if (extra.length > 0) {
    throw new AppError('FORBIDDEN', '只能交出自己可授权的业务身份', {
      reason: 'PROFILE_NOT_GRANTABLE',
      profileIds: extra,
    });
  }
}

async function assertProfilesExist(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx
    .select({ id: permissionProfiles.id })
    .from(permissionProfiles)
    .where(inArray(permissionProfiles.id, [...ids]));
  if (rows.length !== new Set(ids).size) throw new AppError('VALIDATION_FAILED', '可授权业务身份中有不存在的身份');
}

export async function writeGrantableSets(
  tx: Tx,
  tenantId: string,
  adminId: string,
  sets: GrantableSets,
): Promise<void> {
  const roles = [...new Set(sets.grantableAdminRoles)];
  const profiles = [...new Set(sets.grantableProfileIds)];
  if (roles.length > 0) {
    await tx.insert(permissionAdminGrantableRoles).values(roles.map((role) => ({ tenantId, adminId, role })));
  }
  if (profiles.length > 0) {
    await tx
      .insert(permissionAdminGrantableProfiles)
      .values(profiles.map((profileId) => ({ tenantId, adminId, profileId })));
  }
}

async function loadAdmin(tx: Tx, id: string, forUpdate = false): Promise<PermissionAdmin> {
  const query = tx.select().from(permissionAdmins).where(eq(permissionAdmins.id, id));
  const [row] = forUpdate ? await query.for('update') : await query;
  if (!row) throw new AppError('NOT_FOUND', '管理员记录不存在');
  return row;
}

export async function viewOf(tx: Tx, row: PermissionAdmin): Promise<PermissionAdminView> {
  const roles = await tx
    .select()
    .from(permissionAdminGrantableRoles)
    .where(eq(permissionAdminGrantableRoles.adminId, row.id));
  const profiles = await tx
    .select()
    .from(permissionAdminGrantableProfiles)
    .where(eq(permissionAdminGrantableProfiles.adminId, row.id));
  return {
    id: row.id,
    userId: row.userId,
    role: row.role as AdminRole,
    status: row.status,
    revision: row.revision,
    grantableAdminRoles: roles
      .map((r) => r.role)
      .filter(isAdminRole)
      .sort(),
    grantableProfileIds: profiles.map((p) => p.profileId).sort(),
  };
}
