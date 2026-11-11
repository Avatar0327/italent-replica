/**
 * 用户授权（L2 授予 L3 身份；06 §1.1）：一条 = 一个用户 × 一个身份。
 * 授予须同时满足：操作者有「用户授权」能力（路由层）、身份在操作者的可授权业务身份内（R1）、
 * 对象是本租户有效成员、许可有余额（REQ-PRM-003）。撤销只改状态，并须带 revision。
 * 数据范围（管理单元）不在这里：按（用户 × 应用）另存（R1-T02，DEC-043），撤销身份不连带删除范围。
 */
import {
  and,
  asc,
  eq,
  inArray,
  pgErrorCode,
  type PermissionGrant,
  permissionGrants,
  permissionProfileApps,
  permissionProfiles,
  sql,
  type Tx,
} from '@italent/db';
import { AppError } from '../../errors.js';
import { grantableSetsOf } from './admins.js';
import { assertNotAutoHeld } from './auto-held.js';
import { audit, type WriteContext } from './audit.js';
import { accountMatch, hasMou, mousOfUsers, type UserMou } from './enterprise-lists.js';
import { applyGrantScopes } from './data-scope-admin.js';
import type { GrantScopeInput } from './data-scope-schemas.js';
import { revisionConflict } from './http.js';
import { consumeSeat, type LicenseOverage, lockLicenseType, releaseSeat } from './licenses.js';
import { assertActiveMember } from './members.js';
import { loadProfile, type ProfileView } from './profiles.js';
import { userLabels } from './tenant-users.js';

export interface GrantView {
  readonly id: string;
  readonly userId: string;
  readonly profileId: string;
  readonly source: 'manual' | 'auto';
  readonly status: 'active' | 'revoked';
  readonly revision: number;
}

/** 授权列表行：授权本身 + 用户 / 身份 / 管理单元投影（F-474-5 #22）。 */
export interface GrantListRow extends GrantView {
  readonly userName: string;
  readonly userEmail: string;
  readonly profileCode: string;
  readonly profileName: string;
  readonly apps: string[];
  readonly mous: UserMou[];
  readonly grantedBy: { readonly userId: string; readonly displayName: string } | null;
  readonly createdAt: string;
}

/** 原站授权列表有、本系统未记录的列：手机号码（账号无手机号）；产品用身份关联应用代替。 */
export const GRANT_LIST_UNRECORDED = ['phone'] as const;

export interface GrantListQuery {
  readonly userId?: string;
  readonly profileId?: string;
  readonly mouId?: string;
  readonly status?: 'active' | 'revoked';
  readonly q?: string;
  readonly limit: number;
  readonly offset: number;
}

/** 总数与当页同一个 where；撤销身份后行仍在（status=revoked），不连带动用户的管理单元（DEC-043）。 */
export async function listGrants(tx: Tx, query: GrantListQuery): Promise<{ items: GrantListRow[]; total: number }> {
  const where = and(
    query.userId ? eq(permissionGrants.userId, query.userId) : undefined,
    query.profileId ? eq(permissionGrants.profileId, query.profileId) : undefined,
    query.status ? eq(permissionGrants.status, query.status) : undefined,
    query.mouId ? hasMou(permissionGrants.userId, query.mouId) : undefined,
    query.q ? accountMatch(permissionGrants.userId, query.q) : undefined,
  );
  const rows = await tx
    .select({ grant: permissionGrants, profile: permissionProfiles })
    .from(permissionGrants)
    .innerJoin(permissionProfiles, eq(permissionProfiles.id, permissionGrants.profileId))
    .where(where)
    .orderBy(asc(permissionGrants.createdAt), asc(permissionGrants.id))
    .limit(query.limit)
    .offset(query.offset);
  const [count] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(permissionGrants)
    .where(where);
  const userIds = rows.flatMap((r) => (r.grant.grantedBy ? [r.grant.userId, r.grant.grantedBy] : [r.grant.userId]));
  const labels = await userLabels(tx, userIds);
  const mous = await mousOfUsers(
    tx,
    rows.map((r) => r.grant.userId),
  );
  const apps = await tx
    .select()
    .from(permissionProfileApps)
    .where(inArray(permissionProfileApps.profileId, [...new Set(rows.map((r) => r.profile.id))]));
  const items = rows.map(({ grant: g, profile }) => ({
    ...view(g),
    userName: labels.get(g.userId)?.displayName ?? '',
    userEmail: labels.get(g.userId)?.email ?? '',
    profileCode: profile.code,
    profileName: profile.name,
    apps: apps
      .filter((a) => a.profileId === profile.id)
      .map((a) => a.appCode)
      .sort(),
    mous: mous.get(g.userId) ?? [],
    grantedBy: g.grantedBy ? { userId: g.grantedBy, displayName: labels.get(g.grantedBy)?.displayName ?? '' } : null,
    createdAt: g.createdAt.toISOString(),
  }));
  return { items, total: count?.total ?? 0 };
}

/**
 * 操作者可授予的业务身份（授权选择器的数据源，AC-PRM-10）：范围外的身份不出现。
 * 带出身份消耗的许可类型，授权界面据此实时显示该类许可余额（REQ-PRM-003 R3）。
 */
export async function grantableProfiles(
  tx: Tx,
  actorUserId: string,
): Promise<Pick<ProfileView, 'id' | 'code' | 'name' | 'licenseType'>[]> {
  const { profiles } = await grantableSetsOf(tx, actorUserId);
  if (profiles.size === 0) return [];
  return tx
    .select({
      id: permissionProfiles.id,
      code: permissionProfiles.code,
      name: permissionProfiles.name,
      licenseType: permissionProfiles.licenseType,
    })
    .from(permissionProfiles)
    .where(inArray(permissionProfiles.id, [...profiles]))
    .orderBy(asc(permissionProfiles.code));
}

export async function createGrant(
  tx: Tx,
  write: WriteContext,
  input: { readonly userId: string; readonly profileId: string; readonly scopes?: readonly GrantScopeInput[] },
): Promise<GrantView & { readonly licenseOverage: LicenseOverage | null }> {
  // DEC-402③：自动持有的身份（员工）不发授权行，先于可授权集合判断
  await assertNotAutoHeld(tx, [input.profileId]);
  await assertGrantable(tx, write.userId, input.profileId);
  await assertActiveMember(tx, input.userId);
  const profile = await loadProfile(tx, input.profileId);
  if (input.scopes?.length) await applyGrantScopes(tx, write, input.userId, input.profileId, input.scopes);

  let row: PermissionGrant | undefined;
  try {
    [row] = await tx
      .insert(permissionGrants)
      .values({
        tenantId: write.tenantId,
        userId: input.userId,
        profileId: input.profileId,
        grantedBy: write.userId,
        createdAt: write.now,
        updatedAt: write.now,
      })
      .returning();
  } catch (error) {
    if (pgErrorCode(error) === '23505')
      throw new AppError('CONFLICT', '该用户已持有此身份', { reason: 'ALREADY_GRANTED' });
    throw error;
  }
  const seat = profile.licenseType
    ? await consumeSeat(tx, {
        userId: input.userId,
        tenantId: write.tenantId,
        licenseType: profile.licenseType,
        grantId: row!.id,
        now: write.now,
      })
    : { consumed: false, overage: null };
  const created = view(row!);
  await audit(tx, write, {
    action: 'permission_grant.create',
    objectType: 'permission_grant',
    objectId: created.id,
    before: null,
    after: {
      ...created,
      licenseType: profile.licenseType,
      licenseSeatConsumed: seat.consumed,
      licenseOverage: seat.overage,
    },
  });
  // DEC-143：超额照常授予，响应带可机读的超额提示，授权页据此标出超额
  return { ...created, licenseOverage: seat.overage };
}

/**
 * 撤销授权。自动授权（自助身份 / 动态授权，DEC-020）不允许手工撤销。
 * 撤销后该用户不再持有同类许可的有效授权即归还名额（DEC-141，releaseSeat）。
 */
export async function revokeGrant(
  tx: Tx,
  write: WriteContext,
  change: { readonly grantId: string; readonly expectedRevision: number },
): Promise<GrantView> {
  const [target] = await tx
    .select({ profileId: permissionGrants.profileId })
    .from(permissionGrants)
    .where(eq(permissionGrants.id, change.grantId));
  if (!target) throw new AppError('NOT_FOUND', '授权记录不存在');
  // 先取该类许可锁、再锁授权行（与归还名额同序，见 lockLicenseType）；身份的许可类型建好后不变，可先无锁读
  const { licenseType } = await loadProfile(tx, target.profileId);
  if (licenseType) await lockLicenseType(tx, write.tenantId, licenseType);
  const [current] = await tx
    .select()
    .from(permissionGrants)
    .where(eq(permissionGrants.id, change.grantId))
    .for('update');
  if (!current) throw new AppError('NOT_FOUND', '授权记录不存在');
  if (current.revision !== change.expectedRevision) throw revisionConflict(change.expectedRevision, current.revision);
  if (current.status !== 'active') throw new AppError('CONFLICT', '授权已撤销', { reason: 'ALREADY_REVOKED' });
  if (current.source === 'auto')
    throw new AppError('FORBIDDEN', '自动授权的身份不能手工撤销', { reason: 'AUTO_GRANT' });
  await assertGrantable(tx, write.userId, current.profileId);

  const [saved] = await tx
    .update(permissionGrants)
    .set({ status: 'revoked', revision: current.revision + 1, revokedBy: write.userId, updatedAt: write.now })
    .where(and(eq(permissionGrants.id, current.id), eq(permissionGrants.revision, current.revision)))
    .returning();
  if (!saved) throw revisionConflict(change.expectedRevision, undefined);
  const released = licenseType
    ? await releaseSeat(tx, { tenantId: write.tenantId, licenseType, userId: current.userId })
    : false;
  const after = view(saved);
  await audit(tx, write, {
    action: 'permission_grant.revoke',
    objectType: 'permission_grant',
    objectId: current.id,
    before: view(current),
    after: { ...after, licenseType, licenseSeatReleased: released },
  });
  return after;
}

async function assertGrantable(tx: Tx, actorUserId: string, profileId: string): Promise<void> {
  const { profiles } = await grantableSetsOf(tx, actorUserId);
  if (!profiles.has(profileId)) {
    throw new AppError('FORBIDDEN', '只能授予有授权权限的身份', { reason: 'PROFILE_NOT_GRANTABLE' });
  }
}

function view(g: PermissionGrant): GrantView {
  return {
    id: g.id,
    userId: g.userId,
    profileId: g.profileId,
    source: g.source,
    status: g.status,
    revision: g.revision,
  };
}
