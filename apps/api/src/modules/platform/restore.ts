/**
 * 按租户恢复的业务编排（DEC-061；AGENTS.md §10「恢复」；R1-T17）：
 *   导入隔离环境（租户 restoring）→ 隔离校验（无跨租户数据、行数与清单一致）→ 附件清单与哈希核对
 *   → 授权对账（以现网的撤销事实为准：备份之后撤销过的授权、管理员身份、成员关系、停用的账号不得因恢复复活）
 *   → 校验全部通过才可开放访问（openRestoredTenant 以隔离环境里记录的校验结论为准，不信任调用方传入的报告）。
 * 恢复不重放审批节点（审批数据按快照原样恢复，不推进流转）、不补发消息（在途事件改记“结果未知”，见 tenant-backup.ts）。
 */
import {
  and,
  type AttachmentReport,
  type AttachmentStore,
  BackupIntegrityError,
  type Db,
  desc,
  eq,
  getTenant,
  importTenantBackup,
  inArray,
  type IsolationReport,
  permissionAdmins,
  permissionGrants,
  permissionProfiles,
  platformAudit,
  platformAuditEvents,
  type PlatformCommandMeta,
  setTenantStatus,
  sql,
  type TenantBackup,
  tenantMemberships,
  type Tx,
  users,
  verifyAttachments,
  verifyTenantIsolation,
  withPlatform,
  withTenant,
} from '@italent/db';
import { auditAs, type PlatformWriteContext } from '../permission/audit.js';
import { releaseSeat } from '../permission/licenses.js';

/** 现网（源库）在恢复开始时的授权撤销事实；只取“已撤销 / 已停用”的一面，恢复只会收紧、不会放宽授权。 */
export interface AuthorizationState {
  readonly tenantId: string;
  readonly capturedAt: string;
  readonly revokedGrantIds: string[];
  readonly revokedAdminIds: string[];
  readonly revokedMemberUserIds: string[];
  readonly disabledUserIds: string[];
}

export async function captureAuthorizationState(db: Db, tenantId: string): Promise<AuthorizationState> {
  const tenant = await withTenant(db, tenantId, async (tx) => ({
    revokedGrantIds: (
      await tx.select({ id: permissionGrants.id }).from(permissionGrants).where(eq(permissionGrants.status, 'revoked'))
    ).map((r) => r.id),
    revokedAdminIds: (
      await tx.select({ id: permissionAdmins.id }).from(permissionAdmins).where(eq(permissionAdmins.status, 'revoked'))
    ).map((r) => r.id),
    memberIds: (await tx
      .select({ userId: tenantMemberships.userId, status: tenantMemberships.status })
      .from(tenantMemberships)) as { userId: string; status: string }[],
  }));
  const memberIds = tenant.memberIds.map((m) => m.userId);
  const disabled =
    memberIds.length === 0
      ? []
      : await withPlatform(db, (tx) =>
          tx
            .select({ id: users.id })
            .from(users)
            .where(and(inArray(users.id, memberIds), eq(users.status, 'disabled'))),
        );
  return {
    tenantId,
    capturedAt: new Date().toISOString(),
    revokedGrantIds: tenant.revokedGrantIds.sort(),
    revokedAdminIds: tenant.revokedAdminIds.sort(),
    revokedMemberUserIds: tenant.memberIds
      .filter((m) => m.status === 'revoked')
      .map((m) => m.userId)
      .sort(),
    disabledUserIds: disabled.map((u) => u.id).sort(),
  };
}

export interface ReconciliationReport {
  readonly revokedGrants: string[];
  readonly revokedAdmins: string[];
  readonly revokedMembers: string[];
  readonly disabledUsers: string[];
  /** 恢复时改记为“结果未知”的在途事件 / 通知（不补发）。 */
  readonly unknownEvents: number;
  /** 无法自动对账、须人工处理后才能开放的事项。 */
  readonly problems: { reason: string; userId: string }[];
}

export interface RestoreReport {
  readonly tenantId: string;
  readonly ok: boolean;
  readonly startedAt: string;
  readonly verifiedAt: string;
  /** 恢复出的数据所处时点（备份时点）；与故障时点之差即本次 RPO。 */
  readonly dataAsOf: string;
  readonly codeVersion: string;
  readonly isolation: IsolationReport;
  readonly attachments: AttachmentReport;
  readonly reconciliation: ReconciliationReport;
}

export interface RestoreInput {
  readonly backup: TenantBackup;
  readonly live: AuthorizationState;
  readonly attachments: AttachmentStore;
}

/** 导入、校验、对账；租户保持 restoring。校验结论记入隔离环境的平台审计，开放时以它为准。 */
export async function restoreTenant(
  target: Db,
  input: RestoreInput,
  meta: PlatformCommandMeta,
  clock: () => Date = () => new Date(),
): Promise<RestoreReport> {
  const { backup, live } = input;
  const tenantId = backup.manifest.tenantId;
  if (live.tenantId !== tenantId) throw new TypeError('授权状态与备份不是同一租户');
  const startedAt = clock().toISOString();
  const imported = await importTenantBackup(target, backup);
  const audit = (action: string, after: Record<string, unknown>) =>
    platformAudit(target, meta, action, tenantId, after, { actorInTarget: false });
  await audit('tenant.restore.import', { dataAsOf: backup.manifest.takenAt, rowCounts: imported.rowCounts });

  const isolation = await verifyTenantIsolation(target, backup);
  const attachments = await verifyAttachments(backup.manifest.attachments, input.attachments);
  const reconciled = await reconcileAuthorization(target, live, { commandId: meta.commandId, now: clock() });
  const reconciliation = { ...reconciled, unknownEvents: imported.unknownEvents };
  await audit('tenant.restore.reconcile', { ...reconciliation });

  const report: RestoreReport = {
    tenantId,
    ok: isolation.ok && attachments.ok && reconciliation.problems.length === 0,
    startedAt,
    verifiedAt: clock().toISOString(),
    dataAsOf: backup.manifest.takenAt,
    codeVersion: backup.manifest.codeVersion,
    isolation,
    attachments,
    reconciliation,
  };
  await audit('tenant.restore.verify', { ok: report.ok, isolation, attachments });
  return report;
}

/**
 * 授权对账：现网已撤销的授权 / 管理员身份 / 成员关系、已停用的账号，在恢复出的数据里同样撤销（备份之后发生的撤销
 * 不得因恢复而复活）。撤销授权按 DEC-141 归还许可名额。仍是可用流程异常管理员的成员不能直接撤销（DEC-098），
 * 记为待人工处理的问题，租户不开放。
 */
async function reconcileAuthorization(
  target: Db,
  live: AuthorizationState,
  options: { readonly commandId: string; readonly now: Date },
): Promise<Omit<ReconciliationReport, 'unknownEvents'>> {
  const tenantId = live.tenantId;
  const write: PlatformWriteContext = { tenantId, actorUserId: null, ...options };
  const result = await withTenant(target, tenantId, async (tx) => ({
    revokedGrants: await revokeGrants(tx, write, live.revokedGrantIds),
    revokedAdmins: await revokeRows(tx, write, 'permission_admins', 'permission_admin', live.revokedAdminIds),
    ...(await revokeMembers(tx, write, live.revokedMemberUserIds)),
  }));
  const disabledUsers = await disableUsers(target, live.disabledUserIds);
  return { ...result, disabledUsers };
}

async function revokeGrants(tx: Tx, write: PlatformWriteContext, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const active = await tx
    .select({ grant: permissionGrants, licenseType: permissionProfiles.licenseType })
    .from(permissionGrants)
    .innerJoin(permissionProfiles, eq(permissionProfiles.id, permissionGrants.profileId))
    .where(and(inArray(permissionGrants.id, [...ids]), eq(permissionGrants.status, 'active')));
  const revoked: string[] = [];
  for (const { grant, licenseType } of active) {
    await tx
      .update(permissionGrants)
      .set({ status: 'revoked', revision: grant.revision + 1, updatedAt: write.now })
      .where(eq(permissionGrants.id, grant.id));
    const released = licenseType
      ? await releaseSeat(tx, { tenantId: write.tenantId, licenseType, userId: grant.userId })
      : false;
    await auditAs(tx, write, {
      action: 'permission_grant.revoke',
      objectType: 'permission_grant',
      objectId: grant.id,
      before: { status: grant.status, revision: grant.revision },
      after: {
        status: 'revoked',
        revision: grant.revision + 1,
        reason: 'restore_reconcile',
        licenseSeatReleased: released,
      },
    });
    revoked.push(grant.id);
  }
  return revoked.sort();
}

async function revokeRows(
  tx: Tx,
  write: PlatformWriteContext,
  table: 'permission_admins',
  objectType: string,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ id: permissionAdmins.id, revision: permissionAdmins.revision })
    .from(permissionAdmins)
    .where(and(inArray(permissionAdmins.id, [...ids]), eq(permissionAdmins.status, 'active')));
  for (const row of rows) {
    await tx
      .update(permissionAdmins)
      .set({ status: 'revoked', revision: row.revision + 1, updatedAt: write.now })
      .where(eq(permissionAdmins.id, row.id));
    await auditAs(tx, write, {
      action: `${objectType}.revoke`,
      objectType,
      objectId: row.id,
      before: { status: 'active', revision: row.revision },
      after: { status: 'revoked', revision: row.revision + 1, reason: 'restore_reconcile', table },
    });
  }
  return rows.map((r) => r.id).sort();
}

async function revokeMembers(tx: Tx, write: PlatformWriteContext, userIds: readonly string[]) {
  const revokedMembers: string[] = [];
  const problems: { reason: string; userId: string }[] = [];
  if (userIds.length === 0) return { revokedMembers, problems };
  const rows = await tx
    .select()
    .from(tenantMemberships)
    .where(and(inArray(tenantMemberships.userId, [...userIds]), eq(tenantMemberships.status, 'active')));
  for (const row of rows) {
    if (await isExceptionAdmin(tx, row.userId)) {
      problems.push({ reason: 'EXCEPTION_ADMIN_HANDOVER_REQUIRED', userId: row.userId });
      continue;
    }
    await tx
      .update(tenantMemberships)
      .set({ status: 'revoked', revision: row.revision + 1, updatedAt: write.now })
      .where(eq(tenantMemberships.id, row.id));
    await auditAs(tx, write, {
      action: 'tenant_membership.revoke',
      objectType: 'tenant_membership',
      objectId: row.id,
      before: { userId: row.userId, status: row.status, revision: row.revision },
      after: { userId: row.userId, status: 'revoked', revision: row.revision + 1, reason: 'restore_reconcile' },
    });
    revokedMembers.push(row.userId);
  }
  return { revokedMembers: revokedMembers.sort(), problems };
}

async function isExceptionAdmin(tx: Tx, userId: string): Promise<boolean> {
  const result = await tx.execute(sql`SELECT 1 FROM approval_processes p
    JOIN approval_process_versions v ON v.tenant_id = p.tenant_id AND v.id = p.current_version_id
    WHERE p.status = 'active' AND v.exception_admin_user_id = ${userId}::uuid LIMIT 1`);
  const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
  return rows.length > 0;
}

async function disableUsers(target: Db, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await withPlatform(target, (tx) =>
    tx
      .update(users)
      .set({ status: 'disabled', revision: sql`${users.revision} + 1`, updatedAt: sql`now()` })
      .where(and(inArray(users.id, [...ids]), eq(users.status, 'active')))
      .returning({ id: users.id }),
  );
  return rows.map((r) => r.id).sort();
}

/**
 * 开放访问：只有隔离环境里最近一次恢复校验通过、租户仍处于 restoring 时才开放；开放前再做一次隔离校验。
 * 开放经平台命令（revision、幂等、审计）把租户状态改回 active。
 */
export async function openRestoredTenant(
  target: Db,
  report: Pick<RestoreReport, 'tenantId'>,
  meta: PlatformCommandMeta,
  backup?: TenantBackup,
  clock: () => Date = () => new Date(),
): Promise<{ status: 'active'; openedAt: string; revision: number }> {
  const tenantId = report.tenantId;
  const [verified] = await withPlatform(target, (tx) =>
    tx
      .select({ after: platformAuditEvents.after })
      .from(platformAuditEvents)
      .where(
        and(eq(platformAuditEvents.subjectTenantId, tenantId), eq(platformAuditEvents.action, 'tenant.restore.verify')),
      )
      .orderBy(desc(platformAuditEvents.occurredAt))
      .limit(1),
  );
  if ((verified?.after as { ok?: boolean } | undefined)?.ok !== true) {
    throw new BackupIntegrityError('RESTORE_NOT_VERIFIED', '恢复校验未通过，租户保持隔离');
  }
  if (backup) {
    // 对账本身会追加审计与 outbox 行，行数不再与清单相同；开放前只复核跨租户数据
    const again = await verifyTenantIsolation(target, backup);
    if (again.foreignRows !== 0 || again.tenants !== 1 || again.foreignUsers !== 0) {
      throw new BackupIntegrityError('RESTORE_NOT_VERIFIED', '开放前隔离校验未通过');
    }
  }
  const tenant = await getTenant(target, tenantId);
  if (tenant?.status !== 'restoring') {
    throw new BackupIntegrityError('RESTORE_NOT_VERIFIED', '租户不在恢复隔离状态');
  }
  // 平台运营账号不在隔离环境的账号表里：状态变更以“系统”记账，操作人记在平台审计 after 中
  const opened = await setTenantStatus(
    target,
    { tenantId, status: 'active', expectedRevision: tenant.revision },
    { actorUserId: null, commandId: meta.commandId },
  );
  const openedAt = clock().toISOString();
  await platformAudit(target, meta, 'tenant.restore.open', tenantId, { openedAt }, { actorInTarget: false });
  return { status: 'active', openedAt, revision: opened.revision };
}
