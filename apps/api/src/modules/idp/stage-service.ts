/**
 * 阶段（子流程实例）的开启与结束（docs/02_业务建模/28 IDP-R1～R4；Q-M0-115②；PR 描述 K-06 / K-08 / K-33 / K-41）。
 * - 一个阶段 = 一条审批实例，按子流程**指定的**审批流程发起（startSpecified，DEC-017 不跨流程兜底）；
 * - 开启失败（审批流程已废弃、首节点没有处理人、异常管理员不可用等）记 failed、次数与原因（DEC-052），调度不自动重试；
 * - 实例完成 = 阶段结束；下一段“自动、无规则”立即开启（保存点内，失败只记开启失败）；最后一段结束 = 计划已结束。
 * 调用方已锁计划行（取锁顺序：计划 → 审批实例）。
 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { cancel } from '../approval/actions.js';
import type { ApprovalContext } from '../approval/context.js';
import { startSpecified } from '../approval/engine.js';
import { rowsOf } from './access.js';
import { bumpPlan, loadStages, type PlanRow, type StageRow } from './plan-store.js';
import { audit } from './write-support.js';

/** 触发开启 / 结束的操作人：HR、审批人或调度（系统，SYSTEM_USER_ID）。 */
export interface StageActor {
  readonly tenantId: string;
  readonly userId: string;
  readonly timezone: string;
  readonly now: Date;
  readonly commandId: string;
}

export type OpenOutcome =
  | { readonly kind: 'opened'; readonly instanceId: string }
  | { readonly kind: 'failed'; readonly reason: string; readonly message: string };

const businessDate = (actor: StageActor) => tenantLocalDate(actor.now, actor.timezone);

/**
 * 审批实例的发起人 = 流程所有者，即计划所有者（建计划的人，DEC-318 K-38），不是员工本人；不再按员工有无账号兜底。
 * 实际触发人记为审批日志与审计的操作人。
 */
function approvalContext(actor: StageActor, plan: PlanRow): ApprovalContext {
  return {
    tenantId: actor.tenantId,
    userId: plan.createdBy,
    timezone: actor.timezone,
    now: actor.now,
    commandId: actor.commandId,
    expectedRevision: 0,
    actorUserId: actor.userId === SYSTEM_USER_ID ? null : actor.userId,
  };
}

/** 子流程引用的审批流程不可用（废弃 / 无已发布版本，DEC-309④-3）时的原因；可用为 null。 */
async function approvalUnavailable(tx: Tx, tenantId: string, stage: StageRow): Promise<string | null> {
  const [row] = rowsOf<{ status: string; current_version_id: string | null; approval_type: string }>(
    await tx.execute(sql`SELECT status, current_version_id, approval_type FROM approval_processes
      WHERE tenant_id = ${tenantId} AND id = ${stage.approvalProcessId}::uuid FOR SHARE`),
  );
  if (!row || row.status !== 'active' || !row.current_version_id || row.approval_type !== stage.approvalType) {
    return 'IDP_APPROVAL_PROCESS_UNAVAILABLE';
  }
  return null;
}

const stageAudit = (stage: Pick<StageRow, 'id' | 'seq' | 'status'> & Partial<StageRow>) => ({
  stage: {
    id: stage.id,
    seq: stage.seq,
    status: stage.status,
    approvalInstanceId: stage.approvalInstanceId ?? null,
    failureReason: stage.failureReason ?? null,
    attemptCount: stage.attemptCount ?? 0,
  },
});

async function auditStage(tx: Tx, actor: StageActor, plan: PlanRow, before: StageRow, after: Partial<StageRow>) {
  await audit(tx, { ...actor, expectedRevision: 0 }, 'plan', 'update', plan.id, {
    before: stageAudit(before),
    after: stageAudit({ ...before, ...after }),
    employeeId: plan.employeeId,
  });
}

/**
 * 开启一个阶段。先在保存点里把阶段置为进行中再发起（实例若当场走完会回调 onStageApproved 把它结束），发起失败
 * 回滚保存点，再记开启失败。业务错误（AppError）记为失败；其他异常照常抛出，整次回滚。
 */
export async function openStage(tx: Tx, actor: StageActor, plan: PlanRow, stage: StageRow): Promise<OpenOutcome> {
  const on = businessDate(actor);
  const attempts = stage.attemptCount + 1;
  const unavailable = await approvalUnavailable(tx, actor.tenantId, stage);
  let outcome: OpenOutcome;
  if (unavailable) {
    outcome = { kind: 'failed', reason: unavailable, message: '子流程引用的审批流程已废弃或没有已发布版本' };
  } else {
    const ctx = approvalContext(actor, plan);
    try {
      const instance = await tx.transaction(async (sp) => {
        await sp.execute(sql`UPDATE idp_plan_stages SET status = 'running', opened_at = ${actor.now.toISOString()},
          attempt_count = ${attempts}, failure_reason = NULL, last_attempt_on = ${on}::date
          WHERE tenant_id = ${actor.tenantId} AND id = ${stage.id}::uuid`);
        const started = await startSpecified(sp, ctx, {
          businessType: 'idp',
          businessId: stage.id,
          processId: stage.approvalProcessId,
        });
        await sp.execute(sql`UPDATE idp_plan_stages SET approval_instance_id = ${started.id}::uuid
          WHERE tenant_id = ${actor.tenantId} AND id = ${stage.id}::uuid`);
        return started;
      });
      outcome = { kind: 'opened', instanceId: instance.id };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const reason = (error.details as { reason?: string } | undefined)?.reason ?? error.code;
      outcome = { kind: 'failed', reason, message: error.message };
    }
  }
  if (outcome.kind === 'failed') {
    await tx.execute(sql`UPDATE idp_plan_stages SET status = 'failed', attempt_count = ${attempts},
      failure_reason = ${outcome.reason}, last_attempt_on = ${on}::date, approval_instance_id = NULL
      WHERE tenant_id = ${actor.tenantId} AND id = ${stage.id}::uuid`);
  }
  await bumpPlan(tx, actor.tenantId, plan.id, actor.now);
  await auditStage(tx, actor, plan, stage, {
    status: outcome.kind === 'opened' ? 'running' : 'failed',
    approvalInstanceId: outcome.kind === 'opened' ? outcome.instanceId : null,
    failureReason: outcome.kind === 'failed' ? outcome.reason : null,
    attemptCount: attempts,
  });
  return outcome;
}

/** 结束阶段（审批完成，或 HR“结束当前阶段”），记结束日（租户业务日）。 */
async function endStage(tx: Tx, actor: StageActor, plan: PlanRow, stage: StageRow): Promise<void> {
  await tx.execute(sql`UPDATE idp_plan_stages SET status = 'ended', ended_on = ${businessDate(actor)}::date
    WHERE tenant_id = ${actor.tenantId} AND id = ${stage.id}::uuid`);
  await bumpPlan(tx, actor.tenantId, plan.id, actor.now);
  await auditStage(tx, actor, plan, stage, { status: 'ended' });
}

/** 所有阶段都结束 → 计划已结束（Q-M0-115① 已结束 = 100）。 */
async function settlePlan(tx: Tx, actor: StageActor, plan: PlanRow): Promise<void> {
  const stages = await loadStages(tx, actor.tenantId, [plan.id]);
  if (plan.status !== 'running' || stages.some((s) => s.status !== 'ended')) return;
  await tx.execute(sql`UPDATE idp_plans SET status = 'ended', revision = revision + 1,
    updated_at = ${actor.now.toISOString()} WHERE tenant_id = ${actor.tenantId} AND id = ${plan.id}::uuid`);
  await audit(tx, { ...actor, expectedRevision: 0 }, 'plan', 'update', plan.id, {
    before: { status: plan.status },
    after: { status: 'ended' },
    employeeId: plan.employeeId,
  });
}

/** “自动、无规则”的下一段：上一阶段结束即开启（K-06）。 */
const opensOnPreviousEnd = (stage: StageRow) => stage.startMode === 'auto' && stage.startTimeType === null;

/** 审批实例完成：阶段结束，下一段按开启规则处理，最后一段结束则计划结束（K-41）。 */
export async function onStageApproved(tx: Tx, actor: StageActor, plan: PlanRow, stage: StageRow): Promise<void> {
  await endStage(tx, actor, plan, stage);
  const next = (await loadStages(tx, actor.tenantId, [plan.id])).find((s) => s.seq === stage.seq + 1);
  if (next && next.status === 'pending' && opensOnPreviousEnd(next)) await openStage(tx, actor, plan, next);
  await settlePlan(tx, actor, plan);
}

/** HR“结束当前阶段并开启下一阶段”（StartNextSubProcessType = 1）或终止 / 删除计划：作废运行中的审批实例。 */
export async function cancelStageInstance(tx: Tx, actor: StageActor, plan: PlanRow, stage: StageRow) {
  if (!stage.approvalInstanceId) return;
  const [instance] = rowsOf<{ status: string }>(
    await tx.execute(sql`SELECT status FROM approval_instances WHERE tenant_id = ${actor.tenantId}
      AND id = ${stage.approvalInstanceId}::uuid`),
  );
  if (instance?.status !== 'running') return;
  await cancel(tx, approvalContext(actor, plan), stage.approvalInstanceId);
}

/** HR 结束运行中的阶段：作废实例、阶段结束（不触发“无规则”的自动开启，下一段由调用方开启）。 */
export async function endRunningStage(tx: Tx, actor: StageActor, plan: PlanRow, stage: StageRow): Promise<void> {
  await cancelStageInstance(tx, actor, plan, stage);
  await endStage(tx, actor, plan, stage);
}
