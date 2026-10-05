/**
 * 开通租户时下发标准业务身份（REQ-PLT-001 R2；R1-T17）：身份、身份 × 应用、对象权限（字段 / 按钮 / 数据操作），
 * 以及 DEC-121 的“看全部”预置——只给标准 HR 身份、只针对无组织字段的对象（职务字典、编制方案数据源）。
 * 身份定义在 @italent/domain 的 STANDARD_PROFILES；这里只负责按对象目录校验后落库，并与业务写同事务写审计与 outbox。
 */
import {
  permissionGrants,
  permissionIdentityScopes,
  permissionProfileApps,
  permissionProfileButtons,
  permissionProfileFields,
  permissionProfileObjects,
  permissionProfiles,
  permissionScopeVersions,
  type Tx,
} from '@italent/db';
import {
  NO_ORG_FIELD_SEE_ALL,
  ORG_EMPLOYEE_APP,
  type ObjectPermission,
  STANDARD_PROFILES,
  type StandardProfile,
  validateObjectPermission,
} from '@italent/domain';
import { auditAs, type PlatformWriteContext } from './audit.js';
import { objectCatalog } from './catalog.js';
import { consumeSeat, type LicenseOverage } from './licenses.js';

export interface InstalledProfile {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly licenseType: string | null;
}

/** 新租户内逐个建标准身份；对象定义不合法即抛错（整笔开通回滚），不会下发半套身份。 */
export async function installStandardProfiles(tx: Tx, write: PlatformWriteContext): Promise<InstalledProfile[]> {
  const installed: InstalledProfile[] = [];
  for (const profile of STANDARD_PROFILES) installed.push(await installProfile(tx, write, profile));
  return installed;
}

async function installProfile(tx: Tx, write: PlatformWriteContext, profile: StandardProfile) {
  const { tenantId } = write;
  const [row] = await tx
    .insert(permissionProfiles)
    .values({
      tenantId,
      code: profile.code,
      name: profile.name,
      description: profile.description,
      source: 'standard',
      licenseType: profile.licenseType,
      createdBy: write.actorUserId,
      createdAt: write.now,
      updatedAt: write.now,
    })
    .returning();
  const profileId = row!.id;
  await tx.insert(permissionProfileApps).values(profile.apps.map((appCode) => ({ tenantId, profileId, appCode })));
  for (const permission of profile.objects) await insertObject(tx, tenantId, profileId, permission);
  const seeAll = profile.hr ? await presetSeeAll(tx, write, profileId) : [];
  await auditAs(tx, write, {
    action: 'permission_profile.provision',
    objectType: 'permission_profile',
    objectId: profileId,
    before: null,
    after: {
      code: profile.code,
      name: profile.name,
      source: 'standard',
      licenseType: profile.licenseType,
      apps: profile.apps,
      objects: profile.objects.map((o) => o.objectCode),
      seeAll,
      revision: row!.revision,
    },
  });
  return { id: profileId, code: profile.code, name: profile.name, licenseType: profile.licenseType };
}

async function insertObject(tx: Tx, tenantId: string, profileId: string, permission: ObjectPermission) {
  const definition = objectCatalog.get(permission.objectCode);
  if (!definition) throw new Error(`标准身份引用了未登记的对象 ${permission.objectCode}`);
  const violations = validateObjectPermission(definition, permission);
  if (violations.length > 0) throw new Error(`标准身份对象权限不合法：${JSON.stringify(violations)}`);
  const key = { tenantId, profileId, objectCode: permission.objectCode };
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

/**
 * DEC-121：标准 HR 身份对无组织字段对象预置“看全部”（与租户管理员在数据权限里手工配置的结果完全相同：同表、
 * revision 1、留范围版本与审计），租户管理员可在数据权限中查看与关闭。新建的自定义身份不受影响（默认空）。
 */
async function presetSeeAll(tx: Tx, write: PlatformWriteContext, profileId: string): Promise<string[]> {
  const targets = [
    ...NO_ORG_FIELD_SEE_ALL.entities.map((code) => ({ targetKind: 'entity' as const, targetCode: code })),
    ...NO_ORG_FIELD_SEE_ALL.dataSources.map((code) => ({ targetKind: 'datasource' as const, targetCode: code })),
  ];
  const keys: string[] = [];
  for (const target of targets) {
    const scope = { tenantId: write.tenantId, profileId, appCode: ORG_EMPLOYEE_APP, ...target };
    const [after] = await tx
      .insert(permissionIdentityScopes)
      .values({ ...scope, seeAll: true, revision: 1 })
      .returning();
    const objectId = `${profileId}:${ORG_EMPLOYEE_APP}:${target.targetKind}:${target.targetCode}`;
    const before = { ...scope, seeAll: false, revision: 0 };
    await tx.insert(permissionScopeVersions).values({
      tenantId: write.tenantId,
      objectType: 'permission_identity_scope',
      objectId,
      revision: 1,
      before,
      after,
      commandId: write.commandId,
      createdAt: write.now,
    });
    await auditAs(tx, write, {
      action: 'permission_identity_scope.change',
      objectType: 'permission_identity_scope',
      objectId,
      before,
      after,
    });
    keys.push(`${target.targetKind}:${target.targetCode}`);
  }
  return keys;
}

/**
 * 开通时把标准身份授予首位租户管理员（平台授予，不经租户内“可授权业务身份”校验）。消耗许可的口径与租户内授权
 * 完全相同：同类许可只占一个名额（W-123），余额不足照常授予并返回超额提示（DEC-143）。
 */
export async function grantStandardProfile(
  tx: Tx,
  write: PlatformWriteContext,
  input: { readonly userId: string; readonly profile: InstalledProfile },
): Promise<{ readonly grantId: string; readonly licenseOverage: LicenseOverage | null }> {
  const { userId, profile } = input;
  const [row] = await tx
    .insert(permissionGrants)
    .values({
      tenantId: write.tenantId,
      userId,
      profileId: profile.id,
      grantedBy: write.actorUserId,
      createdAt: write.now,
      updatedAt: write.now,
    })
    .returning();
  const seat = profile.licenseType
    ? await consumeSeat(tx, {
        tenantId: write.tenantId,
        licenseType: profile.licenseType,
        userId,
        grantId: row!.id,
        now: write.now,
      })
    : { consumed: false, overage: null };
  await auditAs(tx, write, {
    action: 'permission_grant.create',
    objectType: 'permission_grant',
    objectId: row!.id,
    before: null,
    after: {
      id: row!.id,
      userId,
      profileId: profile.id,
      source: row!.source,
      status: row!.status,
      revision: row!.revision,
      licenseType: profile.licenseType,
      licenseSeatConsumed: seat.consumed,
      licenseOverage: seat.overage,
    },
  });
  return { grantId: row!.id, licenseOverage: seat.overage };
}
