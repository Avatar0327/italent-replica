/**
 * 平台运营层的租户生命周期与许可发放（REQ-PLT-001 R1、R3；R1-T17）。复用 platform-ops 的 setTenantStatus 与
 * 权限模块的 setLicenseQuotaIn；全部经平台命令（幂等、revision、同事务写租户审计与平台审计）。
 */
import {
  type Db,
  getTenant,
  type PlatformCommandMeta,
  runPlatformCommand,
  setTenantStatus,
  type Tenant,
  withTenant,
} from '@italent/db';
import { AppError } from '../../errors.js';
import type { PlatformWriteContext } from '../permission/audit.js';
import { listBalances, type LicenseBalance } from '../permission/licenses.js';
import { type LicenseQuotaChange, setLicenseQuotaIn } from '../permission/platform.js';
import { installMissingStandardProfiles, type StandardBackfill } from '../permission/standard-profiles.js';
import { installMissingSeeds, seedModules, type SeedReportItem, type SeedWriteContext } from '../../seeds/index.js';

export async function requireTenant(db: Db, tenantId: string): Promise<Tenant> {
  const tenant = await getTenant(db, tenantId);
  if (!tenant) throw new AppError('NOT_FOUND', '租户不存在');
  return tenant;
}

export interface TenantLifecycleChange {
  readonly tenantId: string;
  /** 停用 / 重新启用。restoring 只由按租户恢复进入、经隔离校验与授权对账后开放（restore.ts），不经这里。 */
  readonly status: 'active' | 'suspended';
  readonly expectedRevision: number;
}

/**
 * 停用：租户内所有请求一律 403 TENANT_UNAVAILABLE（中间件每次请求重读租户状态），数据原样保留；重新启用即恢复。
 * 恢复隔离中的租户不能从这里直接开放，否则会绕过隔离校验与授权对账（DEC-061）。
 */
export async function changeTenantLifecycle(
  db: Db,
  change: TenantLifecycleChange,
  meta: PlatformCommandMeta,
): Promise<Tenant> {
  const current = await requireTenant(db, change.tenantId);
  if (current.revision === change.expectedRevision && current.status === 'restoring') {
    throw new AppError('CONFLICT', '租户处于恢复隔离中，须经恢复校验后开放', { reason: 'TENANT_RESTORING' });
  }
  return setTenantStatus(db, change, meta);
}

/**
 * 许可证发放 / 调整（按产品线：许可类型）。返回该类许可发放后的余额，口径与租户侧“许可管理 / 余额”完全一致：
 * 余额 = 发放总数 − 当前仍在用的名额（DEC-141），可为负并标出超额（DEC-143）。
 */
export async function issueLicense(
  db: Db,
  change: LicenseQuotaChange,
  meta: PlatformCommandMeta,
): Promise<LicenseBalance> {
  await requireTenant(db, change.tenantId);
  return runPlatformCommand(db, meta, 'license_pool.issue', change, async (ctx) => {
    await setLicenseQuotaIn(ctx, change);
    const balances = await ctx.inTenant(change.tenantId, listBalances);
    return balances.find((b) => b.licenseType === change.licenseType)!;
  });
}

export async function tenantBalances(db: Db, tenantId: string): Promise<LicenseBalance[]> {
  await requireTenant(db, tenantId);
  return withTenant(db, tenantId, listBalances);
}

/**
 * 存量租户回补标准身份（DEC-289③）：平台命令（只认平台运营身份，命令台账幂等——同一命令 ID 重放返回原结果）；
 * 回补本身也幂等，重复执行不新建任何行（permission/standard-profiles.ts）。租户审计逐个记身份安装，平台审计留一条汇总。
 */
export async function backfillStandardProfiles(
  db: Db,
  tenantId: string,
  meta: PlatformCommandMeta,
  now: Date,
): Promise<StandardBackfill> {
  await requireTenant(db, tenantId);
  return runPlatformCommand(db, meta, 'tenant.standard_profiles.backfill', { tenantId }, async (ctx) => {
    const write: PlatformWriteContext = { tenantId, actorUserId: meta.actorUserId, now, commandId: meta.commandId };
    const result = await ctx.inTenant(tenantId, (tx) => installMissingStandardProfiles(tx, write));
    await ctx.auditPlatform(
      {
        action: 'tenant.standard_profiles.backfill',
        objectType: 'tenant',
        objectId: tenantId,
        before: null,
        after: result,
      },
      tenantId,
    );
    return result;
  });
}

/**
 * 存量租户回补预置数据（DEC-361）：平台命令（只认平台运营身份、显式指定租户、命令台账幂等）；按种子登记表逐项
 * 补装缺失的预置编码，不覆盖租户定制，重复执行无副作用；租户审计由各登记项同事务写，平台审计留一条汇总。
 */
export async function backfillSeeds(
  db: Db,
  tenantId: string,
  input: { readonly modules?: readonly string[] },
  meta: PlatformCommandMeta,
  now: Date,
): Promise<{ items: SeedReportItem[] }> {
  await requireTenant(db, tenantId);
  const unknown = (input.modules ?? []).filter((module) => !seedModules().includes(module));
  if (unknown.length > 0) {
    throw new AppError('VALIDATION_FAILED', '未知的预置数据模块', { reason: 'SEED_MODULE_UNKNOWN', unknown });
  }
  return runPlatformCommand(
    db,
    meta,
    'tenant.seeds.backfill',
    { tenantId, modules: input.modules ?? null },
    async (ctx) => {
      const write: SeedWriteContext = { tenantId, actorUserId: meta.actorUserId, now, commandId: meta.commandId };
      const items = await ctx.inTenant(tenantId, (tx) => installMissingSeeds(tx, write, input));
      await ctx.auditPlatform(
        { action: 'tenant.seeds.backfill', objectType: 'tenant', objectId: tenantId, before: null, after: { items } },
        tenantId,
      );
      return { items };
    },
  );
}
