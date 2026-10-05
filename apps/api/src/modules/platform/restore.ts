/**
 * 按租户恢复的业务编排（DEC-061；AGENTS.md §10「恢复」「幂等」「审计」；R1-T17，PR #60 第二轮）：
 *   导入（restoring，写入前校验、同事务隔离校验，见 tenant-restore.ts）
 *   → 附件清单与哈希核对 → 授权对账（镜像现网当前授权子图，P2-2）→ 审批对账（DEC-098 / 123，P2-6）→ 记录校验结论
 *   → 开放：开放前**重新读取现网并再次对账**（P2-3），全部通过才把租户改回 active。
 * 每个阶段的业务变更、审计与命令台账同一事务提交；同一命令 ID 重试返回首次结果（P2-9）。
 * 恢复不重放审批节点（审批数据按快照原样恢复，不推进流转）、不补发消息（在途事件改记“结果未知”）。
 */
import {
  type AttachmentReport,
  type AttachmentStore,
  BackupIntegrityError,
  captureAuthorization,
  type Db,
  findLedger,
  importTenantBackup,
  isolationIn,
  type IsolationReport,
  ledgerRecord,
  ledgerReplay,
  type MirrorProblem,
  mirrorAuthorization,
  phaseKey,
  platformAuditIn,
  type PlatformCommandMeta,
  priorImport,
  sql,
  type TenantBackup,
  type Tx,
  verifyAttachments,
  withTenant,
} from '@italent/db';
import type { ApprovalContext } from '../approval/context.js';
import { republishWithExceptionAdmin } from '../approval/definitions.js';
import { designateSuccessor, takeOverOnDeactivation } from '../approval/handover.js';
import { auditAs } from '../permission/audit.js';
import { createPermissionAuthorizer } from '../permission/authorizer.js';

export interface ReconciliationReport {
  /** 授权子图各表按现网改动的行数。 */
  readonly changed: Record<string, number>;
  /** 现网有、但引用的业务对象在备份时点不存在而未补入的授权行（只会更窄）。 */
  readonly skipped: number;
  /** 改指现网异常管理员的流程数（DEC-098）。 */
  readonly republishedProcesses: number;
  /** 由不可用账号名下接管走的在途异常待办所在实例数（DEC-123）。 */
  readonly takenOver: number;
  /** 恢复时改记为“结果未知”的在途事件 / 通知（不补发）。 */
  readonly unknownEvents: number;
  /** 无法自动对账、须人工处理后才能开放的事项；非空即不开放。 */
  readonly problems: MirrorProblem[];
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
  /** 现网库（源库）：读取该租户当前的授权子图与流程异常管理员，对账以它为准。 */
  readonly live: Db;
  readonly attachments: AttachmentStore;
}

/** 现网当前状态：授权子图 + 各流程当前生效版本的异常管理员（DEC-098 交接以现网为准）。 */
async function captureLive(live: Db, tenantId: string) {
  const authorization = await captureAuthorization(live, tenantId);
  const rows = await withTenant(live, tenantId, (tx) =>
    tx.execute(sql`SELECT p.id::text AS id, v.exception_admin_user_id::text AS admin FROM approval_processes p
      JOIN approval_process_versions v ON v.tenant_id = p.tenant_id AND v.id = p.current_version_id
      WHERE p.status = 'active'`),
  );
  const list = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as { id: string; admin: string }[];
  const successors = await withTenant(live, tenantId, async (tx) =>
    rowsOf<{ user_id: string; successor: string }>(
      await tx.execute(sql`SELECT user_id::text, successor_user_id::text AS successor
        FROM approval_exception_admin_successors`),
    ),
  );
  return {
    authorization,
    exceptionAdmins: new Map(list.map((r) => [r.id, r.admin])),
    successors: new Map(successors.map((r) => [r.user_id, r.successor])),
  };
}
type LiveState = Awaited<ReturnType<typeof captureLive>>;

/** 导入、核对、对账；租户保持 restoring。校验结论与对账结果同事务记入隔离库，开放时以它为前提。 */
export async function restoreTenant(
  target: Db,
  input: RestoreInput,
  meta: PlatformCommandMeta,
  clock: () => Date = () => new Date(),
): Promise<RestoreReport> {
  const { backup } = input;
  const tenantId = backup.manifest.tenantId;
  const request = { tenantId, checksum: backup.manifest.checksum };
  const done = await findLedger<RestoreReport>(target, phaseKey(meta, 'verify'), request);
  if (done) return done;
  const startedAt = clock().toISOString();
  const imported = await importOrReuse(target, backup, meta);
  const attachments = await verifyAttachments(backup.manifest.attachments, input.attachments);
  const live = await captureLive(input.live, tenantId);
  return target.transaction(async (tx) => {
    const replay = await ledgerReplay<RestoreReport>(tx, phaseKey(meta, 'verify'), request);
    if (replay) return replay;
    const reconciled = await reconcile(tx, target, live, meta, clock);
    const reconciliation = { ...reconciled, unknownEvents: imported.unknownEvents };
    const isolation = await isolationIn(tx, tenantId, backup, false);
    const report: RestoreReport = {
      tenantId,
      ok: imported.isolation.ok && isolation.ok && attachments.ok && reconciliation.problems.length === 0,
      startedAt,
      verifiedAt: clock().toISOString(),
      dataAsOf: backup.manifest.takenAt,
      codeVersion: backup.manifest.codeVersion,
      isolation: imported.isolation,
      attachments,
      reconciliation,
    };
    await platformAuditIn(
      tx,
      meta,
      'tenant.restore.reconcile',
      tenantId,
      { ...reconciliation },
      { actorInTarget: false },
    );
    await platformAuditIn(
      tx,
      meta,
      'tenant.restore.verify',
      tenantId,
      { ok: report.ok, isolation, attachments },
      {
        actorInTarget: false,
      },
    );
    await ledgerRecord(tx, phaseKey(meta, 'verify'), request, report);
    return report;
  });
}

/**
 * 导入；隔离库已有同一份备份的导入且租户仍在恢复隔离中（上次校验未通过）时沿用那次导入，以新命令 ID 重新校验
 * （P2-N4）。成功的命令仍按台账重放；已开放或不是同一份备份的照常拒绝（TARGET_NOT_EMPTY）。
 */
async function importOrReuse(target: Db, backup: TenantBackup, meta: PlatformCommandMeta) {
  try {
    return await importTenantBackup(target, backup, meta);
  } catch (error) {
    if (!(error instanceof BackupIntegrityError) || error.reason !== 'TARGET_NOT_EMPTY') throw error;
    const prior = await priorImport(target, backup);
    if (!prior) throw error;
    return prior;
  }
}

/** 授权对账（镜像现网授权子图）+ 审批对账；调用方事务内执行，返回仍须人工处理的问题。 */
async function reconcile(tx: Tx, target: Db, live: LiveState, meta: PlatformCommandMeta, clock: () => Date) {
  const tenantId = live.authorization.tenantId;
  const mirrored = await mirrorAuthorization(tx, live.authorization);
  const problems = [...mirrored.problems];
  const timezone = await tenantTimezone(tx, tenantId);
  const republished = await reconcileExceptionAdmins(tx, live, meta, clock, problems);
  const takenOver = await takeOverUnavailable(tx, target, { tenantId, timezone, meta, clock, live }, problems);
  await auditAs(
    tx,
    { tenantId, actorUserId: null, now: clock(), commandId: meta.commandId },
    {
      action: 'tenant.restore.reconcile',
      objectType: 'tenant',
      objectId: tenantId,
      before: null,
      after: { changed: mirrored.changed, skipped: mirrored.skipped, republished, takenOver, problems },
    },
  );
  return {
    changed: mirrored.changed,
    skipped: mirrored.skipped,
    republishedProcesses: republished,
    takenOver,
    problems,
  };
}

async function tenantTimezone(tx: Tx, tenantId: string): Promise<string> {
  const rows = await tx.execute(sql`SELECT timezone FROM tenants WHERE id = ${tenantId}::uuid`);
  const list = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as { timezone: string }[];
  return list[0]!.timezone;
}

/** 问题明细：业务错误取机器可读原因，其他取错误信息首行（不含堆栈）。 */
function describe(error: unknown): string {
  const details = (error as { details?: { reason?: string } }).details;
  if (details?.reason) return details.reason;
  return String((error as Error)?.message ?? error)
    .split('\n')[0]!
    .slice(0, 200);
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

/** 账号在隔离库可派：成员关系有效、全局账号未停用（与 approval/resolver.ts 的 isActiveAccount 同一口径）。 */
const assignable = (user: ReturnType<typeof sql>) => sql`EXISTS (SELECT 1 FROM tenant_memberships m
  WHERE m.user_id = ${user} AND m.status = 'active' AND tenant_account_active(m.user_id))`;

/**
 * DEC-098：对账后不可用的账号若仍是可用流程的异常管理员，改指现网该流程当前的异常管理员（以现网交接结果为准）；
 * 现网的也不可用、或流程有未发布草稿无法交接的，列入 problems。
 */
async function reconcileExceptionAdmins(
  tx: Tx,
  live: LiveState,
  meta: PlatformCommandMeta,
  clock: () => Date,
  problems: MirrorProblem[],
): Promise<number> {
  const tenantId = live.authorization.tenantId;
  const stale = rowsOf<{ id: string; admin: string }>(
    await tx.execute(sql`SELECT p.id::text AS id, v.exception_admin_user_id::text AS admin FROM approval_processes p
      JOIN approval_process_versions v ON v.tenant_id = p.tenant_id AND v.id = p.current_version_id
      WHERE p.status = 'active' AND NOT ${assignable(sql`v.exception_admin_user_id`)} ORDER BY p.id`),
  );
  let republished = 0;
  for (const process of stale) {
    const successor = live.exceptionAdmins.get(process.id);
    const usable =
      successor && rowsOf(await tx.execute(sql`SELECT 1 WHERE ${assignable(sql`${successor}::uuid`)}`)).length > 0;
    if (!successor || !usable) {
      problems.push({ reason: 'EXCEPTION_ADMIN_UNAVAILABLE', key: process.id, userId: process.admin });
      continue;
    }
    const ctx: ApprovalContext = {
      tenantId,
      userId: successor,
      actorUserId: null,
      timezone: await tenantTimezone(tx, tenantId),
      now: clock(),
      commandId: meta.commandId,
      expectedRevision: 0,
    };
    const error = await tx
      .transaction((sp) => republishWithExceptionAdmin(sp, ctx, process.id, successor))
      .then(
        () => null,
        (e: unknown) => e,
      );
    if (error) {
      problems.push({
        reason: 'EXCEPTION_ADMIN_HANDOVER_FAILED',
        key: process.id,
        userId: process.admin,
        detail: describe(error),
      });
    } else republished++;
  }
  return republished;
}

/**
 * DEC-123：对账后不可用的账号名下的在途异常待办，按停用时的既有路径接管（替代人 / 租户管理员，DEC-091 回避）；
 * 接管不了的列入 problems。普通审批待办与现网一致：不自动撤销，由管理员转交（`14` §11.7）。
 */
async function takeOverUnavailable(
  tx: Tx,
  target: Db,
  scope: { tenantId: string; timezone: string; meta: PlatformCommandMeta; clock: () => Date; live: LiveState },
  problems: MirrorProblem[],
): Promise<number> {
  const leaving = rowsOf<{ user_id: string }>(
    await tx.execute(sql`SELECT DISTINCT t.assignee_user_id::text AS user_id FROM approval_tasks t
      JOIN approval_instances i ON i.tenant_id = t.tenant_id AND i.id = t.instance_id
      WHERE t.status = 'pending' AND t.is_exception_admin AND i.status = 'running'
        AND NOT ${assignable(sql`t.assignee_user_id`)} ORDER BY 1`),
  );
  const deps = { db: target, authorize: createPermissionAuthorizer(target), clock: scope.clock };
  let instances = 0;
  for (const { user_id: userId } of leaving) {
    const revocation = {
      tenantId: scope.tenantId,
      userId,
      reason: 'user_disabled' as const,
      timezone: scope.timezone,
      actorUserId: null,
      commandId: scope.meta.commandId,
    };
    // 现网为该账号指定过替代人（交接时，DEC-123）的，以现网为准；恢复出的数据可能早于那次交接
    const successor = scope.live.successors.get(userId);
    const error = await tx
      .transaction(async (sp) => {
        if (successor && rowsOf(await sp.execute(sql`SELECT 1 WHERE ${assignable(sql`${successor}::uuid`)}`)).length) {
          const ctx: ApprovalContext = {
            tenantId: scope.tenantId,
            userId: successor,
            actorUserId: null,
            timezone: scope.timezone,
            now: scope.clock(),
            commandId: scope.meta.commandId,
            expectedRevision: 0,
          };
          await designateSuccessor(sp, ctx, { fromUserId: userId, toUserId: successor });
        }
        // 恢复期间只改派待办、不结算（合席会推进流转甚至批准业务），需要结算的列入 problems（P2-N2）
        await takeOverOnDeactivation(sp, deps, revocation, { settle: false });
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    if (error) problems.push({ reason: 'EXCEPTION_TASK_TAKEOVER_FAILED', userId, detail: describe(error) });
    const remaining = rowsOf<{ n: number }>(
      await tx.execute(sql`SELECT count(DISTINCT t.instance_id)::int AS n FROM approval_tasks t
        WHERE t.status = 'pending' AND t.is_exception_admin AND t.assignee_user_id = ${userId}::uuid`),
    )[0]!.n;
    if (!error && remaining > 0) problems.push({ reason: 'EXCEPTION_TASK_TAKEOVER_INCOMPLETE', userId });
    if (!error) instances++;
  }
  return instances;
}

export interface OpenInput {
  readonly tenantId: string;
  readonly live: Db;
  readonly backup: TenantBackup;
}

export interface OpenResult {
  readonly status: 'active';
  readonly openedAt: string;
  readonly revision: number;
}

/**
 * 开放访问：最近一次恢复校验通过、租户仍处于 restoring，且**开放前重新读取现网再次对账**无遗留问题、无跨租户数据，
 * 才把租户改回 active。整个开放一个事务（对账、状态、审计、台账）；同一命令 ID 重试返回首次结果。
 */
export async function openRestoredTenant(
  target: Db,
  input: OpenInput,
  meta: PlatformCommandMeta,
  clock: () => Date = () => new Date(),
): Promise<OpenResult> {
  const { tenantId, backup } = input;
  const key = phaseKey(meta, 'open');
  const request = { tenantId, checksum: backup.manifest.checksum };
  const done = await findLedger<OpenResult>(target, key, request);
  if (done) return done;
  const live = await captureLive(input.live, tenantId);
  return target.transaction(async (tx) => {
    const replay = await ledgerReplay<OpenResult>(tx, key, request);
    if (replay) return replay;
    const [verified] = rowsOf<{ ok: boolean | null }>(
      await tx.execute(sql`SELECT (after->>'ok')::boolean AS ok FROM platform_audit_events
        WHERE subject_tenant_id = ${tenantId}::uuid AND action = 'tenant.restore.verify'
        ORDER BY occurred_at DESC, id DESC LIMIT 1`),
    );
    if (verified?.ok !== true) throw new BackupIntegrityError('RESTORE_NOT_VERIFIED', '恢复校验未通过，租户保持隔离');
    const [tenant] = rowsOf<{ status: string; revision: number }>(
      await tx.execute(sql`SELECT status, revision FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE`),
    );
    if (tenant?.status !== 'restoring') {
      throw new BackupIntegrityError('RESTORE_NOT_VERIFIED', '租户不在恢复隔离状态');
    }
    const reconciled = await reconcile(tx, target, live, meta, clock);
    if (reconciled.problems.length > 0) {
      throw new BackupIntegrityError(
        'RESTORE_NOT_VERIFIED',
        `开放前对账有待处理事项：${JSON.stringify(reconciled.problems)}`,
      );
    }
    const isolation = await isolationIn(tx, tenantId, backup, false);
    if (!isolation.ok) throw new BackupIntegrityError('RESTORE_NOT_VERIFIED', '开放前隔离校验未通过');
    const revision = Number(tenant.revision) + 1;
    await tx.execute(sql`UPDATE tenants SET status = 'active', revision = ${revision}, updated_at = now()
      WHERE id = ${tenantId}::uuid`);
    const openedAt = clock().toISOString();
    const after = { status: 'active', revision, openedAt, changed: reconciled.changed };
    await auditAs(
      tx,
      { tenantId, actorUserId: null, now: clock(), commandId: meta.commandId },
      { action: 'tenant.set_status', objectType: 'tenant', objectId: tenantId, before: tenant, after },
    );
    await platformAuditIn(tx, meta, 'tenant.restore.open', tenantId, after, { actorInTarget: false });
    const result: OpenResult = { status: 'active', openedAt, revision };
    await ledgerRecord(tx, key, request, result);
    return result;
  });
}
