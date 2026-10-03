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
  pgErrorCode,
  type PermissionGrant,
  permissionGrants,
  permissionProfiles,
  type Tx,
} from '@italent/db';
import { AppError } from '../../errors.js';
import { grantableSetsOf } from './admins.js';
import { audit, type WriteContext } from './audit.js';
import { applyGrantScopes } from './data-scope-admin.js';
import type { GrantScopeInput } from './data-scope-schemas.js';
import { revisionConflict } from './http.js';
import { consumeSeat } from './licenses.js';
import { assertActiveMember } from './members.js';
import { loadProfile, type ProfileView } from './profiles.js';

export interface GrantView {
  readonly id: string;
  readonly userId: string;
  readonly profileId: string;
  readonly source: 'manual' | 'auto';
  readonly status: 'active' | 'revoked';
  readonly revision: number;
}

export async function listGrants(tx: Tx, userId?: string): Promise<GrantView[]> {
  const rows = await tx
    .select()
    .from(permissionGrants)
    .where(userId === undefined ? undefined : eq(permissionGrants.userId, userId))
    .orderBy(asc(permissionGrants.createdAt));
  return rows.map(view);
}

/** 操作者可授予的业务身份（授权选择器的数据源，AC-PRM-10）。 */
export async function grantableProfiles(
  tx: Tx,
  actorUserId: string,
): Promise<Pick<ProfileView, 'id' | 'code' | 'name'>[]> {
  const { profiles } = await grantableSetsOf(tx, actorUserId);
  const rows = await tx
    .select({ id: permissionProfiles.id, code: permissionProfiles.code, name: permissionProfiles.name })
    .from(permissionProfiles)
    .orderBy(asc(permissionProfiles.code));
  return rows.filter((p) => profiles.has(p.id));
}

export async function createGrant(
  tx: Tx,
  write: WriteContext,
  input: { readonly userId: string; readonly profileId: string; readonly scopes?: readonly GrantScopeInput[] },
): Promise<GrantView> {
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
        ...input,
        tenantId: write.tenantId,
        licenseType: profile.licenseType,
        grantId: row!.id,
        now: write.now,
      })
    : false;
  const created = view(row!);
  await audit(tx, write, {
    action: 'permission_grant.create',
    objectType: 'permission_grant',
    objectId: created.id,
    before: null,
    after: { ...created, licenseType: profile.licenseType, licenseSeatConsumed: seat },
  });
  return created;
}

/**
 * 撤销授权。自动授权（自助身份 / 动态授权，DEC-020）不允许手工撤销。
 * TODO(需取证 #6)：撤销后是否归还许可名额原站未验证，暂不归还。
 */
export async function revokeGrant(
  tx: Tx,
  write: WriteContext,
  change: { readonly grantId: string; readonly expectedRevision: number },
): Promise<GrantView> {
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
  const after = view(saved);
  await audit(tx, write, {
    action: 'permission_grant.revoke',
    objectType: 'permission_grant',
    objectId: current.id,
    before: view(current),
    after,
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
