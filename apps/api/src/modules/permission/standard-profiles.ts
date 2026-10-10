/**
 * 开通租户时下发标准业务身份（REQ-PLT-001 R2；R1-T17）：身份、身份 × 应用、对象权限（字段 / 按钮 / 数据操作），
 * 以及 DEC-121 的“看全部”预置——只给标准 HR 身份、只针对无组织字段的对象（职务字典、编制方案数据源）。
 * 身份定义在 @italent/domain 的 STANDARD_PROFILES；这里只负责按对象目录校验后落库，并与业务写同事务写审计与 outbox。
 */
import {
  and,
  eq,
  permissionAdminGrantableProfiles,
  permissionAdmins,
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
  type PresetSeeAllTarget,
  profileLedgerMarker,
  STANDARD_GRANT_ENTRY,
  STANDARD_PROFILES,
  type StandardProfile,
  standardGrantItems,
  validateObjectPermission,
} from '@italent/domain';
import { recordLedger } from '../../seeds/grant-ledger.js';
import { viewOf } from './admins.js';
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

export interface StandardBackfill {
  readonly installed: string[];
  readonly skipped: { readonly code: string; readonly reason: 'ALREADY_INSTALLED' | 'CODE_TAKEN' }[];
}

/**
 * 存量租户回补标准身份（DEC-289③）：开通早于新增标准身份（如 360 三类身份）的租户，按 STANDARD_PROFILES 只补租户里
 * 还没有该编码的（与开通同一安装函数，同样按对象目录校验、逐个写身份审计）。同编码已是标准身份跳过
 * （ALREADY_INSTALLED）；租户手工建过同编码身份不覆盖、不合并、不改其对象权限（CODE_TAKEN）。身份编码建后不能改、
 * 身份也不能删，所以这个标准身份不会再由回补装入，租户身份管理员可二选一：在身份管理里按标准身份
 * （STANDARD_PROFILES）的对象权限调整这条自定义身份后继续使用；或另建一个其他编码的自定义身份按同样配置，在用户
 * 授权里改授并撤销旧授权。新装身份加入有效租户管理员的可授权业务身份。重复执行不新建任何行。
 */
export async function installMissingStandardProfiles(tx: Tx, write: PlatformWriteContext): Promise<StandardBackfill> {
  const existing = await tx
    .select({ code: permissionProfiles.code, source: permissionProfiles.source })
    .from(permissionProfiles);
  const sources = new Map(existing.map((p) => [p.code, p.source]));
  const installed: InstalledProfile[] = [];
  const skipped: StandardBackfill['skipped'][number][] = [];
  for (const profile of STANDARD_PROFILES) {
    const source = sources.get(profile.code);
    if (source === undefined) installed.push(await installProfile(tx, write, profile));
    else skipped.push({ code: profile.code, reason: source === 'standard' ? 'ALREADY_INSTALLED' : 'CODE_TAKEN' });
  }
  if (installed.length)
    await grantableToTenantAdmins(
      tx,
      write,
      installed.map((p) => p.id),
    );
  return { installed: installed.map((p) => p.code), skipped };
}

/** 新装身份加入有效租户管理员的可授权业务身份：推进管理员记录 revision（防并发整体覆盖丢失）、写审计。 */
async function grantableToTenantAdmins(tx: Tx, write: PlatformWriteContext, profileIds: readonly string[]) {
  const admins = await tx
    .select()
    .from(permissionAdmins)
    .where(and(eq(permissionAdmins.role, 'tenant_admin'), eq(permissionAdmins.status, 'active')))
    .for('update');
  for (const admin of admins) {
    const before = await viewOf(tx, admin);
    await tx
      .insert(permissionAdminGrantableProfiles)
      .values(profileIds.map((profileId) => ({ tenantId: write.tenantId, adminId: admin.id, profileId })))
      .onConflictDoNothing();
    const [saved] = await tx
      .update(permissionAdmins)
      .set({ revision: admin.revision + 1, updatedAt: write.now })
      .where(eq(permissionAdmins.id, admin.id))
      .returning();
    await auditAs(tx, write, {
      action: 'permission_admin.update',
      objectType: 'permission_admin',
      objectId: admin.id,
      before,
      after: await viewOf(tx, saved!),
    });
  }
}

/**
 * 装一个标准身份并**装入即记账**（F-061 §3.3）：权限行与审计之外，把身份定义授予的全部授权项编码和该身份的
 * @ledger 标记以 install 登记进补装台账，以后“当前没有、台账有”即视为租户撤销，回补不再补回。
 * 开通、旧回补路由、standard-profiles 登记项都走这里。
 */
export async function installProfile(tx: Tx, write: PlatformWriteContext, profile: StandardProfile) {
  const installed = await installProfileRows(tx, write, profile);
  await recordLedger(tx, {
    entry: STANDARD_GRANT_ENTRY,
    codes: [...standardGrantItems([profile]).map((item) => item.code), profileLedgerMarker(profile.code)],
    source: 'install',
    commandId: write.commandId,
    now: write.now,
  });
  return installed;
}

/**
 * 只写身份与权限行、预置看全部和审计，不写台账。给“F-061 上线前开通的租户”测试夹具用（按注入的旧定义装身份、
 * 不留台账）；产品路径一律走 installProfile。
 */
export async function installProfileRows(tx: Tx, write: PlatformWriteContext, profile: StandardProfile) {
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
  const seeAll = await presetSeeAll(tx, write, profileId, seeAllTargets(profile));
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

/** 标准 HR 身份按 DEC-121 的无组织字段对象；其他标准身份按各自登记的目标（人才标准管理员的类型字典，DEC-281⑩）。 */
function seeAllTargets(profile: StandardProfile): PresetSeeAllTarget[] {
  const hr: PresetSeeAllTarget[] = profile.hr
    ? [
        ...NO_ORG_FIELD_SEE_ALL.entities.map((code) => ({
          appCode: ORG_EMPLOYEE_APP,
          targetKind: 'entity' as const,
          targetCode: code,
        })),
        ...NO_ORG_FIELD_SEE_ALL.dataSources.map((code) => ({
          appCode: ORG_EMPLOYEE_APP,
          targetKind: 'datasource' as const,
          targetCode: code,
        })),
      ]
    : [];
  return [...hr, ...(profile.seeAll ?? [])];
}

/**
 * DEC-121：标准身份对无组织字段对象预置“看全部”（与租户管理员在数据权限里手工配置的结果完全相同：同表、
 * revision 1、留范围版本与审计），租户管理员可在数据权限中查看与关闭。新建的自定义身份不受影响（默认空）。
 */
async function presetSeeAll(
  tx: Tx,
  write: PlatformWriteContext,
  profileId: string,
  targets: readonly PresetSeeAllTarget[],
): Promise<string[]> {
  const keys: string[] = [];
  for (const { appCode, ...target } of targets) {
    const scope = { tenantId: write.tenantId, profileId, appCode, ...target };
    const [after] = await tx
      .insert(permissionIdentityScopes)
      .values({ ...scope, seeAll: true, revision: 1 })
      .returning();
    const objectId = `${profileId}:${appCode}:${target.targetKind}:${target.targetCode}`;
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
