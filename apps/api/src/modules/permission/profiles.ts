/**
 * 身份（L1 身份定义）：新建身份、配置身份 × 对象的三类子权限（REQ-PRM-001；06 §7.2）。
 * 对象权限按“整对象替换”写入：一次 PUT 给出该对象的数据操作、字段、按钮全集，身份 revision + 1。
 */
import {
  and,
  asc,
  eq,
  pgErrorCode,
  type PermissionProfile,
  permissionProfileApps,
  permissionProfileButtons,
  permissionProfileFields,
  permissionProfileObjects,
  permissionProfiles,
  type Tx,
} from '@italent/db';
import {
  isWithinProfileApps,
  type ObjectCatalog,
  type ObjectPermission,
  validateObjectPermission,
} from '@italent/domain';
import { tenantObjectCatalog } from './tenant-catalog.js';
import { AppError } from '../../errors.js';
import { audit, type WriteContext } from './audit.js';
import { revisionConflict } from './http.js';
import { loadObjectPermissions } from './subject.js';

export interface ProfileView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly source: 'standard' | 'custom';
  readonly licenseType: string | null;
  readonly apps: string[];
  readonly revision: number;
}

export interface ProfileDetail extends ProfileView {
  readonly objects: ObjectPermission[];
}

export interface NewProfile {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly apps: readonly string[];
  readonly licenseType: string | null;
}

export async function listProfiles(tx: Tx): Promise<ProfileView[]> {
  const rows = await tx.select().from(permissionProfiles).orderBy(asc(permissionProfiles.code));
  const apps = await tx.select().from(permissionProfileApps);
  return rows.map((p) =>
    view(
      p,
      apps.filter((a) => a.profileId === p.id).map((a) => a.appCode),
    ),
  );
}

export async function getProfileDetail(tx: Tx, id: string): Promise<ProfileDetail> {
  const profile = await loadProfile(tx, id);
  const apps = await loadProfileApps(tx, id);
  const objects = await loadObjectPermissions(tx, [id]);
  objects.sort((a, b) => a.objectCode.localeCompare(b.objectCode));
  return { ...view(profile, apps), objects };
}

export async function createProfile(tx: Tx, write: WriteContext, input: NewProfile): Promise<ProfileView> {
  let row: PermissionProfile | undefined;
  try {
    [row] = await tx
      .insert(permissionProfiles)
      .values({
        tenantId: write.tenantId,
        ...input,
        createdBy: write.userId,
        createdAt: write.now,
        updatedAt: write.now,
      })
      .returning();
  } catch (error) {
    if (pgErrorCode(error) === '23505') throw new AppError('CONFLICT', '身份编码已存在', { code: input.code });
    throw error;
  }
  const apps = [...new Set(input.apps)].sort();
  if (apps.length > 0) {
    await tx
      .insert(permissionProfileApps)
      .values(apps.map((appCode) => ({ tenantId: write.tenantId, profileId: row!.id, appCode })));
  }
  const created = view(row!, apps);
  await audit(tx, write, {
    action: 'permission_profile.create',
    objectType: 'permission_profile',
    objectId: created.id,
    before: null,
    after: created,
  });
  return created;
}

export interface ObjectPermissionWrite {
  readonly profileId: string;
  readonly expectedRevision: number;
  readonly permission: ObjectPermission;
}

export async function setObjectPermission(
  tx: Tx,
  write: WriteContext,
  catalog: ObjectCatalog,
  change: ObjectPermissionWrite,
): Promise<ProfileDetail> {
  const { profileId, permission } = change;
  const definition = (await tenantObjectCatalog(tx, catalog, permission.objectCode)).get(permission.objectCode);
  if (!definition) throw new AppError('NOT_FOUND', '对象不存在');
  const violations = validateObjectPermission(definition, permission);
  if (violations.length > 0) throw new AppError('VALIDATION_FAILED', '对象权限配置不合法', violations);

  const profile = await loadProfile(tx, profileId, true);
  if (profile.revision !== change.expectedRevision) throw revisionConflict(change.expectedRevision, profile.revision);
  // 应用边界：身份按“身份 × 应用”授权，对象所属应用不在该身份登记的应用内时不能配置进来
  const apps = await loadProfileApps(tx, profileId);
  if (!isWithinProfileApps(definition, apps)) {
    throw new AppError('VALIDATION_FAILED', '对象不属于该身份登记的应用', [
      { reason: 'OBJECT_OUTSIDE_PROFILE_APPS', objectCode: definition.code, application: definition.application },
    ]);
  }
  const [before] = await loadObjectPermissions(tx, [profileId], permission.objectCode);

  await replaceObjectRows(tx, write.tenantId, profileId, permission);
  const [bumped] = await tx
    .update(permissionProfiles)
    .set({ revision: profile.revision + 1, updatedAt: write.now })
    .where(and(eq(permissionProfiles.id, profileId), eq(permissionProfiles.revision, profile.revision)))
    .returning();
  if (!bumped) throw revisionConflict(change.expectedRevision, undefined);

  await audit(tx, write, {
    action: 'permission_profile.set_object',
    objectType: 'permission_profile',
    objectId: profileId,
    before: before ?? null,
    after: { ...permission, revision: bumped.revision },
  });
  return getProfileDetail(tx, profileId);
}

async function replaceObjectRows(tx: Tx, tenantId: string, profileId: string, permission: ObjectPermission) {
  const key = { tenantId, profileId, objectCode: permission.objectCode };
  // 字段、按钮行随对象行级联删除（迁移 0016 的复合外键 ON DELETE CASCADE）
  await tx
    .delete(permissionProfileObjects)
    .where(
      and(eq(permissionProfileObjects.profileId, profileId), eq(permissionProfileObjects.objectCode, key.objectCode)),
    );
  const ops = permission.dataOperations;
  await tx
    .insert(permissionProfileObjects)
    .values({ ...key, canCreate: ops.create, canUpdate: ops.update, canDelete: ops.delete });
  if (permission.fields.length > 0) {
    await tx
      .insert(permissionProfileFields)
      .values(permission.fields.map((f) => ({ ...key, fieldCode: f.fieldCode, canView: f.view, canEdit: f.edit })));
  }
  if (permission.buttons.length > 0) {
    await tx
      .insert(permissionProfileButtons)
      .values(permission.buttons.map((b) => ({ ...key, buttonCode: b.buttonCode, level: b.level })));
  }
}

async function loadProfileApps(tx: Tx, profileId: string): Promise<string[]> {
  const rows = await tx.select().from(permissionProfileApps).where(eq(permissionProfileApps.profileId, profileId));
  return rows.map((a) => a.appCode).sort();
}

export async function loadProfile(tx: Tx, id: string, forUpdate = false): Promise<PermissionProfile> {
  const query = tx.select().from(permissionProfiles).where(eq(permissionProfiles.id, id));
  const [row] = forUpdate ? await query.for('update') : await query;
  if (!row) throw new AppError('NOT_FOUND', '身份不存在');
  return row;
}

function view(p: PermissionProfile, apps: string[]): ProfileView {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    source: p.source,
    licenseType: p.licenseType,
    apps,
    revision: p.revision,
  };
}
