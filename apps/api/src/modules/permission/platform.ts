/**
 * L0 平台运营层的权限写操作（REQ-PRM-001「多租户」）。R1-T17 的开通命令经 *In 变体在同一平台命令事务内复用。
 * 一律经 runPlatformCommand：带操作人与命令 ID（幂等）、带 revision、同一事务内把审计写进该租户。
 */
import {
  type Db,
  eq,
  licensePools,
  type PlatformCommandContext,
  type PlatformCommandMeta,
  permissionAdmins,
  RevisionConflictError,
  runPlatformCommand,
  type Tx,
} from '@italent/db';
import { ADMIN_ROLES } from '@italent/domain';
import { type PermissionAdminView, viewOf, writeGrantableSets } from './admins.js';
import { assertActiveMember } from './members.js';

/**
 * 为租户开通第一位（或新增）租户管理员：可授权管理员身份为全部 8 类；可授权业务身份默认为空，
 * 由租户管理员在新建身份后自行加入（新建身份默认不可授权）。数据范围不在此设置（默认为空，R1-T02）。
 */
export async function bootstrapTenantAdmin(
  db: Db,
  input: { readonly tenantId: string; readonly userId: string },
  meta: PlatformCommandMeta,
): Promise<PermissionAdminView> {
  return runPlatformCommand(db, meta, 'permission.bootstrap_tenant_admin', input, (ctx) =>
    bootstrapTenantAdminIn(ctx, input, meta),
  );
}

/**
 * 在已有的平台命令内开通租户管理员（R1-T17 开通命令复用）。grantableProfileIds：开通时下发的标准业务身份，
 * 首位租户管理员可直接授出（原站管理员的可授权业务身份几乎全选，06 §2.1）。
 */
export async function bootstrapTenantAdminIn(
  ctx: PlatformCommandContext,
  input: { readonly tenantId: string; readonly userId: string },
  meta: PlatformCommandMeta,
  grantableProfileIds: readonly string[] = [],
): Promise<PermissionAdminView> {
  const created = await ctx.inTenant(input.tenantId, async (tx) => {
    await assertActiveMember(tx, input.userId);
    const [row] = await tx
      .insert(permissionAdmins)
      .values({ tenantId: input.tenantId, userId: input.userId, role: 'tenant_admin', createdBy: meta.actorUserId })
      .returning();
    const sets = { grantableAdminRoles: [...ADMIN_ROLES], grantableProfileIds };
    await writeGrantableSets(tx, input.tenantId, row!.id, sets);
    return viewOf(tx, row!);
  });
  await ctx.auditTenant(input.tenantId, {
    action: 'permission_admin.bootstrap',
    objectType: 'permission_admin',
    objectId: created.id,
    before: null,
    after: created,
  });
  return created;
}

export interface LicenseQuotaChange {
  readonly tenantId: string;
  readonly licenseType: string;
  readonly quota: number;
  /** 许可池尚不存在时为 0。 */
  readonly expectedRevision: number;
}

const LICENSE_TYPE = /^[a-z][a-z0-9_]{0,63}$/;

/** 平台发放 / 调整某租户某类许可的总量（REQ-PRM-003 R1）。 */
export async function setLicenseQuota(db: Db, change: LicenseQuotaChange, meta: PlatformCommandMeta) {
  assertLicenseQuota(change);
  return runPlatformCommand(db, meta, 'license_pool.set_quota', change, (ctx) => setLicenseQuotaIn(ctx, change));
}

export function assertLicenseQuota(change: Pick<LicenseQuotaChange, 'licenseType' | 'quota'>): void {
  if (!LICENSE_TYPE.test(change.licenseType)) throw new TypeError('许可类型编码不合法');
  if (!Number.isInteger(change.quota) || change.quota < 0) throw new TypeError('许可总量必须是非负整数');
}

/** 在已有的平台命令内发放 / 调整许可总量（R1-T17 开通命令与平台许可接口复用）；审计写入该租户与平台审计。 */
export async function setLicenseQuotaIn(ctx: PlatformCommandContext, change: LicenseQuotaChange) {
  assertLicenseQuota(change);
  const { before, after } = await ctx.inTenant(change.tenantId, (tx) => upsertPool(tx, change));
  await ctx.auditTenant(change.tenantId, {
    action: 'license_pool.set_quota',
    objectType: 'license_pool',
    objectId: change.licenseType,
    before,
    after,
  });
  return after;
}

async function upsertPool(tx: Tx, change: LicenseQuotaChange) {
  const [current] = await tx
    .select()
    .from(licensePools)
    .where(eq(licensePools.licenseType, change.licenseType))
    .for('update');
  if ((current?.revision ?? 0) !== change.expectedRevision) {
    throw new RevisionConflictError(`许可池 ${change.licenseType}`, change.expectedRevision);
  }
  const values = { quota: change.quota, revision: change.expectedRevision + 1, updatedAt: new Date() };
  const [saved] = current
    ? await tx.update(licensePools).set(values).where(eq(licensePools.licenseType, change.licenseType)).returning()
    : await tx
        .insert(licensePools)
        .values({ tenantId: change.tenantId, licenseType: change.licenseType, ...values })
        .returning();
  const snapshot = (p: typeof saved) => (p ? { quota: p.quota, revision: p.revision } : null);
  return { before: snapshot(current), after: { licenseType: change.licenseType, ...snapshot(saved)! } };
}
