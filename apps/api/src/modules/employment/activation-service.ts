/**
 * 到期待生效业务的落地（R1-T08）：定时任务与 HR 重试共用同一条按序推进逻辑。
 * - DEC-108：同员工到期业务按队列顺序逐条经 activate 端口生效，每条生效后重读队列（向后更新会改写其后申请的载荷）；
 * - DEC-052：某条失败记 failed、原因并生成待办，自动生效主路径不变；
 * - DEC-112：失败（或失败未修正）的那条之后的到期业务一律挂起，记“因前序业务失败挂起”，同一前序只记一次；
 *   前序重试成功后，其后业务在同一次重试里按顺序紧接着生效。
 * 调用方须持员工行锁；多实例并发由员工行锁（定时任务 SKIP LOCKED）串行，状态在锁内重读，故可重复执行。
 */
import type { Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { activateWithJudgement } from './activation-checks.js';
import {
  activationPredecessors,
  failedPredecessor,
  pendingActivations,
  PREDECESSOR_FAILED,
  recordActivationAttempt,
  type ActivationTrigger,
  type PendingActivation,
} from './activation-store.js';
import { lockEmploymentEmployee } from './record-store.js';
import type { EmploymentContext } from './types.js';

export interface ActivationResult {
  readonly activated: string[];
  readonly failed: string[];
  readonly suspended: string[];
}

async function dueQueue(tx: Tx, ctx: EmploymentContext, employeeId: string): Promise<PendingActivation[]> {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  return (await pendingActivations(tx, ctx, employeeId)).filter((item) => item.effectiveDate <= today);
}

export async function activateDueBusinesses(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  trigger: Exclude<ActivationTrigger, 'approval'>,
  retryBusinessId?: string,
): Promise<ActivationResult> {
  const result: ActivationResult = { activated: [], failed: [], suspended: [] };
  let queue = await dueQueue(tx, ctx, employeeId);
  let blocker: PendingActivation | undefined;
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index]!;
    if (blocker) {
      if (item.lastOutcome !== 'suspended' || item.lastBlockedBy !== blocker.id) {
        await recordActivationAttempt(tx, ctx, item, {
          outcome: 'suspended',
          trigger,
          reason: PREDECESSOR_FAILED,
          blockedBy: blocker.id,
        });
        result.suspended.push(item.id);
      }
      continue;
    }
    // 失败的业务只由 HR 修正后重试（DEC-052），定时任务不自动重试，失败次数不随每次运行增加。
    if (item.lastOutcome === 'failed' && item.id !== retryBusinessId) {
      blocker = item;
      continue;
    }
    const failure = await activateWithJudgement(tx, ctx, item);
    if (failure) {
      await recordActivationAttempt(tx, ctx, item, { outcome: 'failed', trigger, ...failure });
      result.failed.push(item.id);
      blocker = item;
      continue;
    }
    await recordActivationAttempt(tx, ctx, item, { outcome: 'effective', trigger });
    result.activated.push(item.id);
    // 已生效的这条离开队列；其后申请的 revision / 载荷可能被向后更新改写，从头重读。
    queue = await dueQueue(tx, ctx, employeeId);
    index = -1;
  }
  return result;
}

/**
 * HR 重试（DEC-052 / DEC-112）：只适用于已到期、生效失败或被挂起的申请，且前面没有失败未修正的业务；
 * 按原生效日落地，并让其后到期的业务依次生效。expectedRevision 由 lockEmploymentBusiness 在状态迁移时校验。
 */
export async function retryActivation(tx: Tx, ctx: EmploymentContext, businessId: string, employeeId: string) {
  await lockEmploymentEmployee(tx, ctx, employeeId);
  const { item, before } = await activationPredecessors(tx, ctx, employeeId, businessId);
  if (!item) throw new AppError('CONFLICT', '只有审批通过、尚未生效的申请可以重试生效', { reason: 'NOT_PENDING' });
  if (item.revision !== ctx.expectedRevision)
    throw new AppError('REVISION_CONFLICT', '任职数据已变更，请刷新后显式重提', {
      expected: ctx.expectedRevision,
      actual: item.revision,
    });
  if (item.lastOutcome !== 'failed' && item.lastOutcome !== 'suspended')
    throw new AppError('CONFLICT', '该申请没有生效失败或挂起，等待定时生效', { reason: 'NOT_FAILED' });
  if (item.effectiveDate > tenantLocalDate(ctx.now, ctx.timezone))
    throw new AppError('CONFLICT', '尚未到任职生效日期', { reason: 'EFFECTIVE_DATE_NOT_REACHED' });
  const blocker = failedPredecessor(before);
  if (blocker)
    throw new AppError('CONFLICT', '前序业务生效失败，请先处理前序业务', {
      reason: PREDECESSOR_FAILED,
      blockedByBusinessId: blocker.id,
    });
  return activateDueBusinesses(tx, ctx, employeeId, 'retry', businessId);
}
