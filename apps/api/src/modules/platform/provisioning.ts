/**
 * 租户开通（REQ-PLT-001 R1/R2/R5；R1-T17）：一个平台命令、一个事务，幂等（平台命令台账），全程写审计。
 * 顺序：建租户（时区缺省 Asia/Shanghai，DEC-056）→ 首位租户管理员与异常管理员的成员关系 → 标准业务身份
 * （DEC-121 预置看全部）→ 首位租户管理员（8 类管理员身份可授，标准身份可授）→ 许可发放 → 标准开关
 * （允许直接调动 = 开 DEC-051；同一部门下职位允许重复 = 关 DEC-062a）→ 预置流程（出厂带发起条件 DEC-018）
 * 配置异常管理员后发布 → 人才标准预置（发展建议类型样本，DEC-281④）。任何一步失败整笔回滚，不留下半个租户。
 */
import {
  type Db,
  eq,
  grantMembershipIn,
  inArray,
  insertTenant,
  type PlatformCommandContext,
  type PlatformCommandMeta,
  runPlatformCommand,
  type Tenant,
  tenants,
  type Tx,
  users,
} from '@italent/db';
import { FIRST_ADMIN_PROFILE, PRESET_PROCESSES } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { ApprovalContext } from '../approval/context.js';
import { installPresets, publishProcess, replaceDraft } from '../approval/definitions.js';
import { updateSettings } from '../employment/configuration.js';
import { writeJobSettings } from '../job/settings.js';
import type { PlatformWriteContext } from '../permission/audit.js';
import { listBalances, type LicenseBalance } from '../permission/licenses.js';
import { bootstrapTenantAdminIn, setLicenseQuotaIn } from '../permission/platform.js';
import {
  grantStandardProfile,
  installStandardProfiles,
  type InstalledProfile,
} from '../permission/standard-profiles.js';
import { installTalentPresets } from '../talent/presets.js';
import { installTalentReviewPresets } from '../talent-review/presets.js';

/** 开通时登记的外部用户业务身份（DEC-158，符合 DEC-128）。 */
export const FIRST_ADMIN_IDENTITY = '租户管理员';
export const EXCEPTION_ADMIN_IDENTITY = '异常管理员';

export interface ProvisionInput {
  readonly code: string;
  readonly name: string;
  readonly timezone?: string | undefined;
  /** 首位租户管理员（已有的全局账号）。 */
  readonly firstAdminUserId: string;
  /** 预置流程的异常管理员（已有的全局账号）；必填，开通时据此发布全部预置流程（DEC-098）。 */
  readonly exceptionAdminUserId: string;
  /** 开通时按产品线发放的许可总量（可选，之后可经平台许可接口调整）。 */
  readonly licenses?: readonly { readonly licenseType: string; readonly quota: number }[] | undefined;
}

export interface TenantView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly timezone: string;
  readonly status: Tenant['status'];
  readonly revision: number;
}

export interface ProvisionResult {
  readonly tenant: TenantView;
  readonly admin: { id: string; userId: string; role: string; grantableAdminRoles: string[] };
  readonly profiles: InstalledProfile[];
  readonly processes: { id: string; code: string; approvalType: string; status: 'published'; versionNo: number }[];
  readonly settings: { allowDirectTransfer: boolean; allowDuplicatePositionNames: boolean };
  readonly licenses: LicenseBalance[];
}

export const tenantView = (t: Tenant): TenantView => ({
  id: t.id,
  code: t.code,
  name: t.name,
  timezone: t.timezone,
  status: t.status,
  revision: t.revision,
});

export async function provisionTenant(
  db: Db,
  input: ProvisionInput,
  meta: PlatformCommandMeta,
  now: Date,
): Promise<ProvisionResult> {
  return runPlatformCommand(db, meta, 'tenant.provision', input, async (ctx) => {
    await assertCodeFree(ctx.tx, input.code);
    await assertActiveUsers(ctx.tx, [input.firstAdminUserId, input.exceptionAdminUserId]);
    const tenant = await insertTenant(ctx, input);
    const tenantId = tenant.id;
    // DEC-158：开通时这两人尚无人员档案，登记为外部用户并带业务身份；日后以同一登录邮箱建档 / 入职时自动转内部员工
    for (const userId of new Set([input.firstAdminUserId, input.exceptionAdminUserId])) {
      const businessIdentity = userId === input.firstAdminUserId ? FIRST_ADMIN_IDENTITY : EXCEPTION_ADMIN_IDENTITY;
      const registration = { userType: 'external', businessIdentity } as const;
      await grantMembershipIn(ctx, { tenantId, userId, expectedRevision: 0 }, meta, registration);
    }
    const write: PlatformWriteContext = { tenantId, actorUserId: meta.actorUserId, now, commandId: meta.commandId };
    const profiles = await ctx.inTenant(tenantId, (tx) => installStandardProfiles(tx, write));
    const admin = await bootstrapTenantAdminIn(
      ctx,
      { tenantId, userId: input.firstAdminUserId },
      meta,
      profiles.map((p) => p.id),
    );
    for (const license of input.licenses ?? []) {
      await setLicenseQuotaIn(ctx, { tenantId, ...license, expectedRevision: 0 });
    }
    const result = await ctx.inTenant(tenantId, async (tx) => {
      const firstProfile = profiles.find((p) => p.code === FIRST_ADMIN_PROFILE)!;
      await grantStandardProfile(tx, write, { userId: input.firstAdminUserId, profile: firstProfile });
      const scoped = { tenant, input, now, meta };
      const settings = await installSwitches(tx, scoped);
      const processes = await publishPresetProcesses(tx, scoped);
      await installTalentPresets(tx, write);
      await installTalentReviewPresets(tx, write);
      return { settings, processes, licenses: await listBalances(tx) };
    });
    const summary: ProvisionResult = {
      tenant: tenantView(tenant),
      admin: {
        id: admin.id,
        userId: admin.userId,
        role: admin.role,
        grantableAdminRoles: admin.grantableAdminRoles,
      },
      profiles,
      ...result,
    };
    await audit(ctx, tenant, summary);
    return summary;
  });
}

async function assertCodeFree(tx: Tx, code: string) {
  const [existing] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, code));
  if (existing) throw new AppError('CONFLICT', '租户编码已存在', { reason: 'TENANT_CODE_DUPLICATE' });
}

async function assertActiveUsers(tx: Tx, ids: readonly string[]) {
  const wanted = [...new Set(ids)];
  const rows = await tx
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(inArray(users.id, wanted))
    .for('share');
  const active = new Set(rows.filter((u) => u.status === 'active').map((u) => u.id));
  const missing = wanted.filter((id) => !active.has(id));
  if (missing.length > 0) {
    throw new AppError('VALIDATION_FAILED', '首位租户管理员与异常管理员必须是有效的全局账号', {
      reason: 'USER_NOT_ACTIVE',
      userIds: missing,
    });
  }
}

interface Scoped {
  readonly tenant: Tenant;
  readonly input: ProvisionInput;
  readonly now: Date;
  readonly meta: PlatformCommandMeta;
}

/**
 * 标准开关显式落成该租户的第一版设置（而不是依赖读取时的缺省值），租户侧看到 revision 1 的出厂值并可修改。
 * 设置模块的审计以“操作人”记账：平台运营身份；系统开通（无操作人）时记首位租户管理员。
 */
async function installSwitches(tx: Tx, { tenant, input, now, meta }: Scoped) {
  const base = {
    tenantId: tenant.id,
    userId: meta.actorUserId ?? input.firstAdminUserId,
    timezone: tenant.timezone,
    now,
    commandId: meta.commandId,
    expectedRevision: 0,
  };
  // DEC-051：允许直接调动，出厂开启
  const employment = await updateSettings(tx, base, { allowDirectTransfer: true });
  // DEC-062a：同一部门下的职位允许重复，出厂关闭（照本租户 SwitchType 83）
  const job = await writeJobSettings(tx, base, { allowDuplicatePositionNames: false });
  return {
    allowDirectTransfer: employment.allowDirectTransfer,
    allowDuplicatePositionNames: job.allowDuplicatePositionNames,
  };
}

/**
 * 预置流程（DEC-018 出厂带发起条件）以草稿安装后，填入开通时指定的异常管理员并发布（R1-T07 预置流程以草稿安装、
 * 未配置前无法提交调动，PR #35 转入本任务）。流程创建人 / 发布人须是租户成员，记首位租户管理员；审计操作人记平台运营。
 */
async function publishPresetProcesses(tx: Tx, { tenant, input, now, meta }: Scoped) {
  const ctx: ApprovalContext = {
    tenantId: tenant.id,
    userId: input.firstAdminUserId,
    timezone: tenant.timezone,
    now,
    commandId: meta.commandId,
    expectedRevision: 0,
    actorUserId: meta.actorUserId,
  };
  const published: ProvisionResult['processes'] = [];
  for (const installed of await installPresets(tx, ctx)) {
    const preset = PRESET_PROCESSES.find((p) => p.presetKey === installed.presetKey)!;
    const definition = { ...preset.definition, exceptionAdminUserId: input.exceptionAdminUserId };
    const draft = await replaceDraft(tx, { ...ctx, expectedRevision: installed.revision }, installed.id, definition);
    const process = await publishProcess(tx, { ...ctx, expectedRevision: draft.revision }, installed.id);
    published.push({
      id: process.id,
      code: process.code,
      approvalType: process.approvalType,
      status: 'published',
      versionNo: process.currentVersion!.versionNo,
    });
  }
  return published;
}

async function audit(ctx: PlatformCommandContext, tenant: Tenant, summary: ProvisionResult) {
  await ctx.auditPlatform(
    {
      action: 'tenant.provision',
      objectType: 'tenant',
      objectId: tenant.id,
      before: null,
      after: {
        tenant: summary.tenant,
        firstAdminUserId: summary.admin.userId,
        profiles: summary.profiles.map((p) => p.code),
        processes: summary.processes.map((p) => p.code),
        settings: summary.settings,
        licenses: summary.licenses,
      },
    },
    tenant.id,
  );
}
