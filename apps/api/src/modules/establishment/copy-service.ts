/** AC-EST-06：复制请求先持久化，执行时整批保存或整批回滚，运行结果与通知仍能追溯。 */
import { randomUUID } from 'node:crypto';
import {
  and,
  desc,
  eq,
  establishmentCopyJobItems,
  establishmentCopyJobs,
  establishmentCopyJobVersions,
  establishmentMovementObjects,
  establishmentNotificationDeliveryAttempts,
  establishmentNotifications,
  inArray,
  isUuid,
  type EstablishmentCapacityConflict,
  type EstablishmentCopyStatus,
  sql,
  type Tx,
} from '@italent/db';
import { scopeSql } from '../permission/module-access.js';
import { AppError } from '../../errors.js';
import { readCapacity, type CapacityRecord } from './capacity-read.js';
import { CapacityOverlapError, genericOverlapMessage, overlapMessage } from './capacity-overlap.js';
import { createCapacity } from './capacity-service.js';
import { loadScheme, nextPeriod, type SchemeRecord } from './schemes.js';
import {
  assertRevision,
  audit,
  invalid,
  lockEstablishment,
  notify,
  today,
  type EstablishmentContext,
} from './store.js';

export interface JobRecord extends Omit<typeof establishmentCopyJobVersions.$inferSelect, 'id'> {
  readonly id: string;
  readonly versionId: string;
  readonly revision: number;
  readonly createdBy: string | null;
  readonly capacityIds: readonly string[];
}

export async function readCopyJob(tx: Tx, tenantId: string, id: string): Promise<JobRecord> {
  if (!isUuid(id)) throw invalid('jobId', '复制任务 ID 必须为 UUID');
  const [record] = await tx
    .select({ job: establishmentCopyJobs, version: establishmentCopyJobVersions })
    .from(establishmentCopyJobVersions)
    .innerJoin(
      establishmentCopyJobs,
      and(
        eq(establishmentCopyJobs.tenantId, establishmentCopyJobVersions.tenantId),
        eq(establishmentCopyJobs.id, establishmentCopyJobVersions.jobId),
      ),
    )
    .where(and(eq(establishmentCopyJobs.tenantId, tenantId), eq(establishmentCopyJobs.id, id)))
    .orderBy(desc(establishmentCopyJobVersions.versionNo))
    .limit(1);
  if (!record) throw new AppError('NOT_FOUND', '复制任务不存在');
  const items = await tx
    .select({ capacityId: establishmentCopyJobItems.capacityId })
    .from(establishmentCopyJobItems)
    .where(and(eq(establishmentCopyJobItems.tenantId, tenantId), eq(establishmentCopyJobItems.jobId, id)))
    .orderBy(establishmentCopyJobItems.capacityId)
    .limit(100);
  return {
    ...record.version,
    id: record.job.id,
    versionId: record.version.id,
    revision: record.job.revision,
    createdBy: record.job.createdBy,
    capacityIds: items.map((item) => item.capacityId),
  };
}

export async function readCopyJobReport(
  tx: Tx,
  ctx: EstablishmentContext,
  id: string,
  fields?: ReadonlySet<string>,
): Promise<{ filename: string; content: string }> {
  const job = await readCopyJob(tx, ctx.tenantId, id);
  if (job.status === 'pending') {
    throw new AppError('CONFLICT', '复制尚未完成，明细暂不可下载', { reason: 'COPY_REPORT_PENDING' });
  }
  // docs/02_业务建模/18 §9：明细保留 15 天，以持久化结果时间起算，读取不延长保留期。
  const expiresAt = job.createdAt.getTime() + 15 * 24 * 60 * 60 * 1000;
  if (ctx.now.getTime() >= expiresAt) throw new AppError('NOT_FOUND', '复制明细不存在或已过期');
  const columns = ['capacityIds', 'status', 'failureReason'];
  const allowed = (values: string[]) => values.filter((_value, index) => !fields || fields.has(columns[index]!));
  const failureReason = await renderFailureText(tx, ctx, job.failureReason, job.failureDetail);
  const rows = job.capacityIds.map((capacityId) => allowed([capacityId, job.status, failureReason ?? '']));
  return {
    filename: `establishment-copy-${job.id}.csv`,
    content: [allowed(['capacityId', 'status', 'reason']), ...rows]
      .map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(','))
      .join('\r\n'),
  };
}

export async function enqueueCopyJob(
  tx: Tx,
  ctx: EstablishmentContext,
  input: { readonly capacityIds: readonly string[] },
): Promise<JobRecord> {
  assertRevision(ctx.expectedRevision, 0);
  validateCapacityIds(input?.capacityIds);
  await lockEstablishment(tx, ctx);
  // 先按当前租户读源对象；跨租户 ID 或不存在的源不能成为持久队列里的悬空请求。
  for (const id of input.capacityIds) await readCapacity(tx, ctx.tenantId, id, today(ctx));
  const id = randomUUID();
  await tx.insert(establishmentCopyJobs).values({
    id,
    tenantId: ctx.tenantId,
    createdBy: ctx.userId,
    revision: 1,
    createdAt: ctx.now,
  });
  await tx
    .insert(establishmentCopyJobItems)
    .values(input.capacityIds.map((capacityId) => ({ tenantId: ctx.tenantId, jobId: id, capacityId })));
  await appendJobVersion(tx, ctx, id, 1, 'pending', 0, null, null);
  const saved = await readCopyJob(tx, ctx.tenantId, id);
  await audit(tx, ctx, 'establishment.copy.enqueued', 'establishment-copy-job', id, null, saved);
  return saved;
}

function validateCapacityIds(ids: readonly string[]): void {
  if (!Array.isArray(ids) || ids.length === 0) throw invalid('capacityIds', '复制至少需要一条编制');
  if (ids.length > 100) throw new AppError('PAYLOAD_TOO_LARGE', '一次复制最多选择 100 条编制');
  if (ids.some((id) => typeof id !== 'string' || !isUuid(id))) {
    throw invalid('capacityIds', '编制 ID 必须为 UUID');
  }
  if (new Set(ids).size !== ids.length) throw invalid('capacityIds', '同一编制不能重复选择');
}

export async function executeCopyJob(tx: Tx, ctx: EstablishmentContext, jobId: string): Promise<JobRecord> {
  await lockEstablishment(tx, ctx);
  const before = await readCopyJob(tx, ctx.tenantId, jobId);
  assertRevision(ctx.expectedRevision, before.revision);
  if (before.status === 'succeeded') return before;

  let failure: BusinessFailure | null = null;
  try {
    // 所有目标容量、细分、审计及 outbox 同属一个 savepoint；一行失败不能留下先前成功行。
    await tx.transaction(async (savepoint) => {
      for (const id of before.capacityIds) {
        const source = await readCapacity(savepoint, ctx.tenantId, id, today(ctx));
        const scheme = await loadScheme(savepoint, ctx.tenantId, source.schemeId, today(ctx));
        await copyCapacity(savepoint, ctx, source, scheme);
      }
    });
  } catch (error) {
    failure = classifyBusinessFailure(error);
    // 存储、审计或结果未知错误不能伪装为业务失败；外层命令事务须回滚，原 pending 可重新执行。
    if (failure === null) throw error;
  }

  const revision = before.revision + 1;
  await tx
    .update(establishmentCopyJobs)
    .set({ revision })
    .where(and(eq(establishmentCopyJobs.tenantId, ctx.tenantId), eq(establishmentCopyJobs.id, jobId)));
  const status = failure === null ? 'succeeded' : 'failed';
  await appendJobVersion(tx, ctx, jobId, revision, status, before.attempts + 1, failure, before.versionId);
  const saved = await readCopyJob(tx, ctx.tenantId, jobId);
  await audit(tx, ctx, 'establishment.copy.executed', 'establishment-copy-job', jobId, before, saved);
  await notify(tx, ctx, failure?.text ?? '下期编制复制成功', {
    jobId,
    attempt: saved.attempts,
    recipientUserId: before.createdBy,
    reasonDetail: failure?.detail ?? null,
  });
  return saved;
}

async function copyCapacity(tx: Tx, ctx: EstablishmentContext, source: CapacityRecord, scheme: SchemeRecord) {
  await createCapacity(
    tx,
    { ...ctx, expectedRevision: 0 },
    {
      orgId: source.orgId,
      schemeId: source.schemeId,
      periodStart: nextPeriod(source.periodStart, scheme),
      effectiveDate: today(ctx),
      ...(scheme.maintenanceMode === 'inclusive' ? {} : { localCapacity: source.localCapacity ?? undefined }),
      ...(scheme.maintenanceMode === 'local' ? {} : { inclusiveCapacity: source.inclusiveCapacity ?? undefined }),
      reservedLocal: source.reservedLocal,
      reservedInclusive: source.reservedInclusive,
      strictControl: source.strictControl,
      subdivisions: source.subdivisions,
    },
    { autoFill: false },
  );
}

interface BusinessFailure {
  /** 落库 / 通知用的文本：重叠冲突只存不带名称的通用句，名称由读取人权限在读取时重新生成。 */
  readonly text: string;
  readonly detail: EstablishmentCapacityConflict | null;
}

function classifyBusinessFailure(error: unknown): BusinessFailure | null {
  if (
    !(error instanceof AppError) ||
    !['VALIDATION_FAILED', 'CONFLICT', 'NOT_FOUND', 'REVISION_CONFLICT'].includes(error.code)
  ) {
    return null;
  }
  if (error instanceof CapacityOverlapError) {
    const { conflict } = error;
    return { text: `${conflict.reason}: ${genericOverlapMessage(conflict.reason)}`, detail: conflict };
  }
  const details = error.details as { reason?: unknown } | undefined;
  const reason = typeof details?.reason === 'string' ? details.reason : error.code;
  return { text: `${reason}: ${error.message}`, detail: null };
}

/**
 * 按读取人 / 接收人当前权限生成失败文案（DEC-121）：有结构化冲突信息时，方案详情范围与名称读权齐备才用
 * DEC-295 原文，否则用落库的通用句。没有读取人身份的出口（未注入 canDiscloseSchemeName）一律不披露。
 */
export async function renderFailureText(
  tx: Tx,
  ctx: Pick<EstablishmentContext, 'tenantId' | 'canDiscloseSchemeName'>,
  text: string | null,
  detail: EstablishmentCapacityConflict | null,
): Promise<string | null> {
  if (!detail || text === null) return text;
  const disclose = (await ctx.canDiscloseSchemeName?.(tx, detail.schemeId)) ?? false;
  return disclose ? `${detail.reason}: ${await overlapMessage(tx, ctx.tenantId, detail, true)}` : text;
}

/**
 * 执行响应 / 幂等重放的出口：命令台账与响应体只存通用句（fail-closed），这里按当前操作人权限换成原文。
 * 按回执里的版本（versionId，被字段读权裁掉时用 revision = 版本号）读对应的不可变失败版本，而不是任务最新版本，
 * 旧命令重放时才不会混入后续失败的冲突；回执里没有可定位版本的信息时保持通用句。
 */
export async function renderExecutedFailure(
  tx: Tx,
  ctx: EstablishmentContext,
  jobId: string,
  receipt: { readonly versionId?: unknown; readonly revision?: unknown },
  shown: string,
): Promise<string> {
  const { versionId, revision } = receipt;
  const byId = typeof versionId === 'string' && isUuid(versionId);
  const byNo = typeof revision === 'number' && Number.isSafeInteger(revision);
  if (!byId && !byNo) return shown;
  const [version] = await tx
    .select({
      failureReason: establishmentCopyJobVersions.failureReason,
      failureDetail: establishmentCopyJobVersions.failureDetail,
    })
    .from(establishmentCopyJobVersions)
    .where(
      and(
        eq(establishmentCopyJobVersions.tenantId, ctx.tenantId),
        eq(establishmentCopyJobVersions.jobId, jobId),
        byId
          ? eq(establishmentCopyJobVersions.id, versionId)
          : eq(establishmentCopyJobVersions.versionNo, revision as number),
      ),
    )
    .limit(1);
  if (!version || version.failureReason !== shown) return shown;
  return (await renderFailureText(tx, ctx, version.failureReason, version.failureDetail)) ?? shown;
}

/** 任务读取出口：失败原因按读取人权限渲染，结构化冲突信息（组织 / 方案 ID）不外露。 */
export async function renderCopyJob(tx: Tx, ctx: EstablishmentContext, job: JobRecord) {
  const { failureDetail, ...rest } = job;
  return { ...rest, failureReason: await renderFailureText(tx, ctx, job.failureReason, failureDetail) };
}

async function appendJobVersion(
  tx: Tx,
  ctx: EstablishmentContext,
  jobId: string,
  versionNo: number,
  status: EstablishmentCopyStatus,
  attempts: number,
  failure: BusinessFailure | null,
  previousVersionId: string | null,
): Promise<void> {
  await tx.insert(establishmentCopyJobVersions).values({
    tenantId: ctx.tenantId,
    jobId,
    versionNo,
    previousVersionId,
    status,
    attempts,
    failureReason: failure?.text ?? null,
    failureDetail: failure?.detail ?? null,
    createdAt: ctx.now,
  });
}

export async function listNotifications(
  tx: Tx,
  tenantId: string,
  recipientUserId: string,
  page: { limit: number; offset: number },
  scope?: Parameters<typeof scopeSql>[0],
) {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100) {
    throw invalid('limit', '每页通知数量须为 1 至 100');
  }
  if (!Number.isSafeInteger(page.offset) || page.offset < 0) throw invalid('offset', '通知分页偏移必须为非负整数');
  const records = await tx
    .select({ notice: establishmentNotifications, businessId: establishmentMovementObjects.businessId })
    .from(establishmentNotifications)
    .leftJoin(
      establishmentMovementObjects,
      and(
        eq(establishmentNotifications.tenantId, establishmentMovementObjects.tenantId),
        eq(establishmentNotifications.movementId, establishmentMovementObjects.id),
      ),
    )
    .where(
      and(
        eq(establishmentNotifications.tenantId, tenantId),
        eq(establishmentNotifications.recipientUserId, recipientUserId),
        ...(scope
          ? [
              sql`(
          (${establishmentNotifications.jobId} IS NOT NULL AND EXISTS (
            SELECT 1 FROM establishment_copy_job_items ci
            WHERE ci.tenant_id = ${tenantId} AND ci.job_id = ${establishmentNotifications.jobId}
          ) AND NOT EXISTS (
            SELECT 1 FROM establishment_copy_job_items ci
            JOIN establishment_objects co ON co.tenant_id = ci.tenant_id AND co.id = ci.capacity_id
            WHERE ci.tenant_id = ${tenantId} AND ci.job_id = ${establishmentNotifications.jobId}
            AND NOT (${scopeSql(scope, { org: sql`co.org_id` })})
          )) OR (${establishmentNotifications.movementId} IS NOT NULL AND EXISTS (
            SELECT 1 FROM (
              SELECT * FROM establishment_movement_versions mv
              WHERE mv.tenant_id = ${tenantId} AND mv.movement_id = ${establishmentNotifications.movementId}
              ORDER BY mv.version_no DESC LIMIT 1
            ) movement WHERE ${scopeSql(scope, { org: sql`movement.source_org_id` })}
              AND ${scopeSql(scope, { org: sql`movement.target_org_id` })}
          ))
        )`,
            ]
          : []),
      ),
    )
    .orderBy(desc(establishmentNotifications.createdAt), desc(establishmentNotifications.id))
    .limit(page.limit)
    .offset(page.offset);
  if (records.length === 0) return [];
  const attempts = await tx
    .selectDistinctOn([establishmentNotificationDeliveryAttempts.notificationId])
    .from(establishmentNotificationDeliveryAttempts)
    .where(
      and(
        eq(establishmentNotificationDeliveryAttempts.tenantId, tenantId),
        inArray(
          establishmentNotificationDeliveryAttempts.notificationId,
          records.map((row) => row.notice.id),
        ),
      ),
    )
    .orderBy(
      establishmentNotificationDeliveryAttempts.notificationId,
      desc(establishmentNotificationDeliveryAttempts.attempt),
    );
  const deliveryByNotice = new Map(attempts.map((attempt) => [attempt.notificationId, attempt]));
  return records.map(({ notice, businessId }) => ({
    ...notice,
    businessId,
    status: deliveryByNotice.get(notice.id)?.status ?? notice.status,
  }));
}

/**
 * 通知读取出口：接收人即读取人（listNotifications 只返回本人的通知），名称按其本人当前权限生成，
 * 与发起人 / 执行人的权限无关；结构化冲突信息（组织 / 方案 ID）不外露。
 */
export async function renderNotifications(
  tx: Tx,
  ctx: EstablishmentContext,
  items: Awaited<ReturnType<typeof listNotifications>>,
) {
  return Promise.all(
    items.map(async ({ reasonDetail, ...notice }) => ({
      ...notice,
      reason: await renderFailureText(tx, ctx, notice.reason, reasonDetail),
    })),
  );
}
