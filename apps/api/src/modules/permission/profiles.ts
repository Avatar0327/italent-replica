/**
 * 身份（L1 身份定义）：新建身份、配置身份 × 对象的三类子权限（REQ-PRM-001；06 §7.2）。
 * 对象权限按“整对象替换”写入：一次 PUT 给出该对象的数据操作、字段、按钮全集，身份 revision + 1。
 */
import {
  and,
  asc,
  eq,
  inArray,
  pgErrorCode,
  type PermissionProfile,
  permissionGrants,
  permissionProfileApps,
  permissionProfileButtons,
  permissionProfileFields,
  permissionProfileObjects,
  permissionProfiles,
  sql,
  type Tx,
} from '@italent/db';
import {
  isWithinProfileApps,
  isPageCarrier,
  type ObjectCatalog,
  objectCatalogDigest,
  type ObjectPermission,
  validateObjectPermission,
} from '@italent/domain';
import { permissionSet } from './sets.js';
import { objectCatalog } from './catalog.js';
import { AppError } from '../../errors.js';
import { recordTenantSave } from '../../seeds/grant-ledger.js';
import './standard-managed-grants.js';
import { tenantObjectCatalog } from './tenant-catalog.js';
import { audit, type WriteContext } from './audit.js';
import { isAutoHeld } from './auto-held.js';
import { likePattern } from './enterprise-lists.js';
import { revisionConflict } from './http.js';
import { loadObjectPermissions } from './subject.js';
import { userLabels } from './tenant-users.js';

export interface ProfileView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly source: 'standard' | 'custom';
  readonly licenseType: string | null;
  readonly apps: string[];
  readonly revision: number;
  /** 自动适用于全体员工（DEC-402③，只读）：管理端授权人员处只显示“自动适用于全体员工”，不逐人列出、不可手工授予。 */
  readonly autoHeld: boolean;
}

/**
 * 身份详情里的对象权限，另带对象目录指纹（F-061 D2 = A）：租户保存时回传，服务端核对后才把面板上可见但未勾的项
 * 记为“已决定不授予”。指纹按解析后的对象定义（含租户扩展字段）计算，与保存校验同源；对象已不在目录里时不带。
 */
export interface ObjectPermissionView extends ObjectPermission {
  readonly catalogDigest?: string;
}

export interface ProfileDetail extends ProfileView {
  readonly objects: ObjectPermissionView[];
}

export interface NewProfile {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly apps: readonly string[];
  readonly licenseType: string | null;
}

/** 身份列表行：身份 + 最近修改人 / 时间 + 授权范围（有效授权数；F-474-5 #25）。 */
export interface ProfileListRow extends ProfileView {
  /** 最近修改人；迁移前的旧行没有（不回填，DEC-402）。 */
  readonly updatedBy: { readonly userId: string; readonly displayName: string } | null;
  readonly updatedAt: string;
  /** 授权范围：有效授权行数；自动持有的身份（员工）不发授权行，由 autoHeld 表示“自动适用于全体员工”。 */
  readonly grantCount: number;
}

/** 原站身份列表有、本系统没有记录的列：状态（身份没有停用概念）、来源视图（DEC-340③ 不展示）。 */
export const PROFILE_LIST_UNRECORDED = ['status', 'sourceView'] as const;

export interface ProfileListQuery {
  readonly name?: string;
  readonly code?: string;
  readonly app?: string;
  readonly limit: number;
  readonly offset: number;
}

/** 总数与当页同一个 where；按编码排序（编码租户内唯一，翻页稳定）。 */
export async function listProfiles(
  tx: Tx,
  query: ProfileListQuery,
): Promise<{ items: ProfileListRow[]; total: number }> {
  const where = and(
    query.name ? sql`lower(${permissionProfiles.name}) LIKE ${likePattern(query.name)}` : undefined,
    query.code ? sql`lower(${permissionProfiles.code}) LIKE ${likePattern(query.code)}` : undefined,
    query.app
      ? sql`${permissionProfiles.id} IN (
          SELECT a.profile_id FROM permission_profile_apps a WHERE a.app_code = ${query.app})`
      : undefined,
  );
  const rows = await tx
    .select()
    .from(permissionProfiles)
    .where(where)
    .orderBy(asc(permissionProfiles.code))
    .limit(query.limit)
    .offset(query.offset);
  const [count] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(permissionProfiles)
    .where(where);
  const ids = rows.map((p) => p.id);
  const apps = ids.length
    ? await tx.select().from(permissionProfileApps).where(inArray(permissionProfileApps.profileId, ids))
    : [];
  const grants = ids.length
    ? await tx
        .select({ profileId: permissionGrants.profileId, total: sql<number>`count(*)::int` })
        .from(permissionGrants)
        .where(and(inArray(permissionGrants.profileId, ids), eq(permissionGrants.status, 'active')))
        .groupBy(permissionGrants.profileId)
    : [];
  const labels = await userLabels(
    tx,
    rows.flatMap((p) => (p.updatedBy ? [p.updatedBy] : [])),
  );
  const items = rows.map((p) => ({
    ...view(
      p,
      apps.filter((a) => a.profileId === p.id).map((a) => a.appCode),
    ),
    updatedBy: p.updatedBy ? { userId: p.updatedBy, displayName: labels.get(p.updatedBy)?.displayName ?? '' } : null,
    updatedAt: p.updatedAt.toISOString(),
    grantCount: grants.find((g) => g.profileId === p.id)?.total ?? 0,
  }));
  return { items, total: count?.total ?? 0 };
}

export async function getProfileDetail(tx: Tx, id: string): Promise<ProfileDetail> {
  const profile = await loadProfile(tx, id);
  const apps = await loadProfileApps(tx, id);
  const permissions = await loadObjectPermissions(tx, [id]);
  permissions.sort((a, b) => a.objectCode.localeCompare(b.objectCode));
  const objects: ObjectPermissionView[] = [];
  for (const permission of permissions) {
    const definition = (await tenantObjectCatalog(tx, objectCatalog, permission.objectCode)).get(permission.objectCode);
    objects.push(definition ? { ...permission, catalogDigest: objectCatalogDigest(definition) } : permission);
  }
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
        updatedBy: write.userId,
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
  /** 客户端读到该对象权限时的对象目录指纹；不带（旧客户端）时不作负向登记，带了但与服务端不一致返回 409。 */
  readonly catalogDigest?: string;
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
  // D2 = A：面板展示的目录（含租户扩展字段）与服务端当前不一致，说明租户没看到全部现有项，不写任何行，刷新后重提。
  // 先于权限语义校验：目录变化时旧页面提交的字段 / 按钮可能已不存在，要得到 409 CATALOG_CHANGED 而不是 400
  if (change.catalogDigest !== undefined && change.catalogDigest !== objectCatalogDigest(definition)) {
    throw new AppError('CATALOG_CHANGED', '对象目录已变化，请刷新后重新提交', { objectCode: definition.code });
  }
  // F-474-9a §4.4 R1：整对象与局部弹窗共用此出口，载体只能授予页面按钮。
  if (isPageCarrier(permission.objectCode) && Object.values(permission.dataOperations).some(Boolean)) {
    throw new AppError('VALIDATION_FAILED', '页面载体不可授予数据操作权限');
  }
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
    .set({ revision: profile.revision + 1, updatedAt: write.now, updatedBy: write.userId })
    .where(and(eq(permissionProfiles.id, profileId), eq(permissionProfiles.revision, profile.revision)))
    .returning();
  if (!bumped) throw revisionConflict(change.expectedRevision, undefined);
  // 补装台账：租户动过这个对象，保存前后授予过的项以后回补都不再补（F-061 §4.4，不依赖是否跑过回补）
  await recordTenantSave(tx, write, profile, permission.objectCode, before, permission, change.catalogDigest);

  await audit(tx, write, {
    action: 'permission_profile.set_object',
    objectType: 'permission_profile',
    objectId: profileId,
    before: before ?? null,
    after: { ...permission, revision: bumped.revision },
  });
  return getProfileDetail(tx, profileId);
}

export async function replaceObjectRows(tx: Tx, tenantId: string, profileId: string, permission: ObjectPermission) {
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
    apps: permissionSet(apps),
    revision: p.revision,
    autoHeld: isAutoHeld(p),
  };
}
