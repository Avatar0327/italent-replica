/**
 * 离职生效单一编排器（R2-T03 设计 §5.1，批 B3-1）：approved → effective 的唯一路径。
 * 顺序 0a 前序 → 0 最终日期 → 0b 顺延后重验 → 0c 在职段延长校验 →（1 作废在途申请：B3-2）→ 2 版本链落地 →
 * 3 编制 →（4 合同、6 职责转交：B3-2）→ 7 状态 / 审计 → 8 后续任务端口。步骤 0a 以外全部在一个保存点内：
 * 任一步业务规则拒绝即整体回滚，只留一条 failed 尝试（DEC-052）；存储不可用原样抛出、不记失败。
 * B3-3 之前这里是内部入口——§18.1 的五个关口仍关着，审批通过 / 直接保存 / 调度 / 重试都不会调用它。
 */
import { randomUUID } from 'node:crypto';
import { and, eq, exitEffects, sql, type Tx } from '@italent/db';
import { addDays, resolveLateLeave, tenantLocalDate, type TimelineSegment } from '@italent/domain';
import { AppError } from '../../errors.js';
import { activationFailureOf, ruleRejection } from './activation-checks.js';
import {
  activationPredecessors,
  PREDECESSOR_FAILED,
  recordActivationAttempt,
  unresolvedPredecessor,
  type ActivationTrigger,
} from './activation-store.js';
import { auditEmployment } from './context.js';
import { runExitEffectiveHooks, type ExitActivationSource, type ExitEffectiveEvent } from './exit-confirmation.js';
import { loadExitRequest, pendingTransferAckSet, regularizationBlocker, type AckRecord } from './exit-gate.js';
import {
  assertExtendedEmploymentAvailable,
  assertNoNewEstablishmentOccupancy,
  loadTimelineSegments,
} from './exit-projection.js';
import { assertNoRebuildRequired } from './late-transfer.js';
import { blockingPredecessors } from './linkage-dependency.js';
import {
  bumpEmploymentBusiness,
  insertEmploymentRow,
  lockEmploymentBusiness,
  rowsOf,
  type LockedEmploymentBusiness,
} from './record-store.js';
import { detachFutureTransfers, loadPlannedEffectiveDate } from './timeline.js';
import { lockTransferParticipants } from './transfer-locks.js';
import type { EmploymentContext } from './types.js';
import { appendEmploymentState, materializeEmploymentRecord } from './write-service.js';

export interface ExitActivationOptions {
  readonly trigger: ActivationTrigger;
  /** 缺省：直接离职为 direct，申请为 approval。free_direct = 免审批直接生效（DEC-593，BE-6b 结束实习：次日生效，类型 / 原因为空，不发交接）。 */
  readonly source?: ExitActivationSource;
}

export type ExitActivationResult =
  | {
      readonly outcome: 'effective';
      readonly lastWorkDate: string;
      readonly effectiveDate: string;
      readonly postponed: boolean;
    }
  /** 前序尚未执行：审批落地不落地、不记尝试，留给调度按队列推进（§5.1 0a）。 */
  | { readonly outcome: 'pending'; readonly blockedByBusinessId: string }
  | { readonly outcome: 'suspended'; readonly reason: typeof PREDECESSOR_FAILED; readonly blockedByBusinessId: string }
  | { readonly outcome: 'failed'; readonly reason: string; readonly detail: Record<string, unknown> };

type ExitRow = NonNullable<Awaited<ReturnType<typeof loadExitRequest>>>;

/** 步骤 0：迟到判定（调用 resolveLateLeave）与简单顺延。区间非空 fail-closed；顺延只追加系统修订载荷版本，人工日期留在前一版本。 */
export async function postponeLateExit(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  planned: string,
  executionDate: string,
): Promise<{ postponed: boolean; lastWorkDate: string; effectiveDate: string }> {
  const resolved = resolveLateLeave({ lastWorkDate: addDays(planned, -1), executionDate });
  if (!resolved.late)
    return { postponed: false, lastWorkDate: resolved.lastWorkDate, effectiveDate: resolved.effectiveDate };
  // 窗口起点与成员的计划日都只取 §5.0A（planned = 创建时的 L + 1）
  await assertNoRebuildRequired(tx, ctx, business, planned, executionDate);
  const previous = business.payload;
  const next = {
    ...previous,
    id: randomUUID(),
    versionNo: previous.versionNo + 1,
    previousVersionId: previous.id,
    effectiveDate: resolved.effectiveDate,
    lastWorkDate: resolved.lastWorkDate,
    commandId: ctx.commandId,
    triggerBusinessId: business.id,
  };
  const { fields, ...metadata } = next;
  await insertEmploymentRow(tx, 'employment_payload_versions', {
    ...metadata,
    ...fields,
    createdAt: ctx.now.toISOString(),
  });
  business.payload = next;
  await auditEmployment(
    tx,
    ctx,
    'employment.leave.rescheduled',
    'employment-business',
    business.id,
    { effectiveDate: previous.effectiveDate, lastWorkDate: previous.lastWorkDate },
    {
      reason: 'late-execution',
      originalLastWorkDate: previous.lastWorkDate,
      originalEffectiveDate: previous.effectiveDate,
      lastWorkDate: resolved.lastWorkDate,
      effectiveDate: resolved.effectiveDate,
      executedAt: ctx.now.toISOString(),
    },
  );
  return { postponed: true, lastWorkDate: resolved.lastWorkDate, effectiveDate: resolved.effectiveDate };
}

/** 步骤 0b：顺延后按 L′ 重验转正在途（入口已无法拦截，只能失败交 HR）；§8 确认集合按 L′ 重算，差异只写审计。 */
async function revalidateAfterPostponement(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  exit: ExitRow,
  lastWorkDate: string,
) {
  const blocker = await regularizationBlocker(tx, ctx, business.employeeId, lastWorkDate);
  if (blocker)
    throw new AppError('CONFLICT', '存在审批中的转正流程，请先处理', {
      activationFailure: { reason: 'EXIT_REGULARIZATION_IN_FLIGHT', detail: { ...blocker } },
    });
  const stored = (exit.pendingTransferAck ?? null) as AckRecord | null;
  const recomputed = await pendingTransferAckSet(tx, ctx, business.employeeId, lastWorkDate);
  if ((recomputed?.hash ?? null) !== (stored?.hash ?? null))
    await auditEmployment(
      tx,
      ctx,
      'employment.exit.ack_set_changed',
      'exit-request',
      business.id,
      { ids: stored?.ids ?? [] },
      { ids: recomputed?.ids ?? [], lastWorkDate },
      undefined,
      undefined,
      { employeeId: business.employeeId },
    );
}

/** 步骤 3：预减时点 R 与 staff_id 不变，只追加 effective 阶段修正行记 E′（幂等：同业务 + phase + kind + target 已有则跳过）。 */
async function recordEffectiveCorrection(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  detail: Record<string, unknown>,
) {
  const confirmed = await tx
    .select()
    .from(exitEffects)
    .where(
      and(
        eq(exitEffects.tenantId, ctx.tenantId),
        eq(exitEffects.businessId, business.id),
        eq(exitEffects.phase, 'confirmed'),
        eq(exitEffects.kind, 'establishment_pre_released'),
      ),
    );
  const done = await tx
    .select({ id: exitEffects.id })
    .from(exitEffects)
    .where(
      and(
        eq(exitEffects.tenantId, ctx.tenantId),
        eq(exitEffects.businessId, business.id),
        eq(exitEffects.phase, 'effective'),
        eq(exitEffects.kind, 'establishment_pre_released'),
      ),
    )
    .limit(1);
  if (done.length || !confirmed.length) return;
  await tx.insert(exitEffects).values(
    confirmed.map((row) => ({
      tenantId: ctx.tenantId,
      businessId: business.id,
      employeeId: business.employeeId,
      phase: 'effective',
      kind: 'establishment_pre_released',
      targetType: row.targetType,
      targetId: row.targetId,
      detail: { ...(row.detail as object), ...detail, correction: true },
      commandId: ctx.commandId,
      createdAt: ctx.now,
    })),
  );
}

/** §5.8：摘下同周期排在离职之后的已落地调动；台账记原窗口（B4 撤销时按它挂回），审计提示 HR。 */
async function detachAndRecord(tx: Tx, ctx: EmploymentContext, business: LockedEmploymentBusiness) {
  const detached = await detachFutureTransfers(tx, ctx, business.employeeId, business.id);
  for (const item of detached) {
    await tx.insert(exitEffects).values({
      tenantId: ctx.tenantId,
      businessId: business.id,
      employeeId: business.employeeId,
      phase: 'effective',
      kind: 'future_transfer_detached',
      targetType: 'employment-record',
      targetId: item.recordId,
      detail: { window: { from: item.from, to: item.to } },
      commandId: ctx.commandId,
      createdAt: ctx.now,
    });
    await auditEmployment(
      tx,
      ctx,
      'employment.exit.future_transfer_warning',
      'exit-request',
      business.id,
      null,
      { transferId: item.recordId, window: { from: item.from, to: item.to } },
      undefined,
      undefined,
      { employeeId: business.employeeId },
    );
  }
  return detached.length;
}

/** 保存点内的步骤 0 → 8；返回最终日期。 */
async function runSteps(
  tx: Tx,
  ctx: EmploymentContext,
  business: LockedEmploymentBusiness,
  exit: ExitRow,
  source: ExitActivationSource,
  trigger: ActivationTrigger,
) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const planned = await loadPlannedEffectiveDate(tx, ctx.tenantId, business.id, business.payload.effectiveDate);
  const ref = {
    businessId: business.id,
    employeeId: business.employeeId,
    staffId: exit.staffId,
    releaseDate: exit.preReleaseDate,
  };
  const before: TimelineSegment[] = await loadTimelineSegments(tx, ctx, business.employeeId);
  const late = await postponeLateExit(tx, ctx, business, planned, today);
  if (late.postponed) {
    await revalidateAfterPostponement(tx, ctx, business, exit, late.lastWorkDate);
    await assertExtendedEmploymentAvailable(tx, ctx, ref, before, planned, late.effectiveDate);
  }
  // 离职不作为向后更新 / 状态传播的来源（§5.6）；落地时的部门可用性由 materialize 对离职跳过（R-O6）
  await materializeEmploymentRecord(tx, ctx, business, { forwardUpdate: false, skipStatusPropagation: true });
  const detached = await detachAndRecord(tx, ctx, business);
  const detail = { effectiveDate: late.effectiveDate, lastWorkDate: late.lastWorkDate, postponed: late.postponed };
  await assertNoNewEstablishmentOccupancy(
    tx,
    ctx,
    ref,
    before,
    await loadTimelineSegments(tx, ctx, business.employeeId),
    planned,
    late.effectiveDate,
  );
  await recordEffectiveCorrection(tx, ctx, business, detail);
  await appendEmploymentState(tx, ctx, business, 'effective');
  await auditEmployment(
    tx,
    ctx,
    'employment.exit.effective',
    'exit-request',
    business.id,
    { state: 'approved' },
    { state: 'effective', source, plannedEffectiveDate: planned, detachedTransfers: detached, ...detail },
    undefined,
    undefined,
    { employeeId: business.employeeId },
  );
  const event: ExitEffectiveEvent = {
    businessId: business.id,
    employeeId: business.employeeId,
    source,
    lastWorkDate: late.lastWorkDate,
    effectiveDate: late.effectiveDate,
  };
  await runExitEffectiveHooks(tx, ctx, event);
  // 审批落地由调用命令统一递增一次业务 revision；调度 / 重试 / 内部入口在这里递增
  if (trigger !== 'approval') await bumpEmploymentBusiness(tx, ctx, business);
  return late;
}

/**
 * 内部编排器入口：按 §5.2 锁序取锁后执行。0a 在保存点之外判定：前序失败 / 挂起 → 记 suspended 返回；前序只是尚未执行 →
 * 审批落地返回 pending（不记尝试），调度 / 重试 / activate 端口 409 ACTIVATION_PREDECESSOR_PENDING。
 */
export async function activateExit(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
  options: ExitActivationOptions,
): Promise<ExitActivationResult> {
  const [owner] = rowsOf<{ employeeId: string }>(
    await tx.execute(sql`SELECT employee_id AS "employeeId" FROM employment_business_objects
      WHERE tenant_id=${ctx.tenantId} AND id=${businessId}::uuid`),
  );
  if (!owner) throw new AppError('NOT_FOUND', '任职业务不存在');
  await lockTransferParticipants(tx, ctx, owner.employeeId);
  const business = await lockEmploymentBusiness(tx, ctx, businessId);
  const exit = await loadExitRequest(tx, ctx.tenantId, businessId);
  if (business.payload.kind !== 'leave' || !exit || business.state !== 'approved')
    throw new AppError('CONFLICT', '只有审批通过、尚未生效的离职可以生效', { reason: 'NOT_PENDING' });
  const source = options.source ?? (exit.mode === 'direct' ? 'direct' : 'approval');
  if (source === 'free_direct' && exit.mode !== 'direct')
    throw new AppError('VALIDATION_FAILED', '免审批直接生效只适用于直接离职', { reason: 'EXIT_SOURCE_INVALID' });
  const planned = await loadPlannedEffectiveDate(tx, ctx.tenantId, businessId, business.payload.effectiveDate);
  if (tenantLocalDate(ctx.now, ctx.timezone) < planned)
    throw new AppError('CONFLICT', '尚未到离职生效日期', { reason: 'EFFECTIVE_DATE_NOT_REACHED' });

  const { item, before } = await activationPredecessors(tx, ctx, business.employeeId, businessId, true);
  if (!item) throw new AppError('CONFLICT', '只有审批通过、尚未生效的离职可以生效', { reason: 'NOT_PENDING' });
  const bumpRevision = options.trigger !== 'approval';
  const blocking = await blockingPredecessors(tx, ctx, before, businessId);
  const blocker = unresolvedPredecessor(blocking);
  if (blocker) {
    if (item.lastOutcome !== 'suspended' || item.lastBlockedBy !== blocker.failedId)
      await recordActivationAttempt(
        tx,
        ctx,
        item,
        { outcome: 'suspended', trigger: options.trigger, reason: PREDECESSOR_FAILED, blockedBy: blocker.failedId },
        { bumpRevision },
      );
    return { outcome: 'suspended', reason: PREDECESSOR_FAILED, blockedByBusinessId: blocker.failedId };
  }
  if (blocking.length) {
    if (options.trigger !== 'approval')
      throw new AppError('CONFLICT', '前序待生效业务尚未生效', {
        reason: 'ACTIVATION_PREDECESSOR_PENDING',
        blockedByBusinessId: blocking[0]!.id,
      });
    return { outcome: 'pending', blockedByBusinessId: blocking[0]!.id };
  }

  try {
    const late = await tx.transaction((savepoint) => runSteps(savepoint, ctx, business, exit, source, options.trigger));
    if (options.trigger !== 'approval')
      await recordActivationAttempt(tx, ctx, item, { outcome: 'effective', trigger: options.trigger });
    return { outcome: 'effective', ...late };
  } catch (error) {
    const failure = activationFailureOf(error) ?? ruleRejection(error);
    if (!failure) throw error;
    await recordActivationAttempt(
      tx,
      ctx,
      item,
      { outcome: 'failed', trigger: options.trigger, ...failure },
      { bumpRevision },
    );
    return { outcome: 'failed', reason: failure.reason, detail: failure.detail };
  }
}
