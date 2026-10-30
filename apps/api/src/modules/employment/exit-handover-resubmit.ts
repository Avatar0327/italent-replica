/** F-305 / DEC-674：HR 在原交接单重提；权限与范围逐次复核，旧审批实例只读保留。 */
import { sql, type Tx } from '@italent/db';
import { HANDOVER_NOT_LAUNCHED_HINTS, HANDOVER_RESUBMIT_BUTTON, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { userOfPerson } from '../approval/resolver.js';
import {
  assertRevision,
  commandContext,
  requireEmployeeInScope,
  requireEmploymentWrite,
  scopedGuard,
} from './context.js';
import { businessState } from './exit-gate.js';
import {
  auditHandover,
  handoverLaunchContext,
  handoverNotLaunchedReason,
  lockHandoverRequest,
} from './exit-handover.js';
import { listHandoverItems } from './exit-handover-items.js';
import {
  insertRequestItems,
  linkHandoverInstance,
  loadHandoverRequest,
  moveHandoverRequest,
} from './exit-handover-store.js';
import { findCurrentRecord } from './read-model.js';
import { requireBusinessWriteScope } from './replay-guard.js';
import type { EmploymentContext } from './types.js';

/** 入口与命令事务共用；与不存在统一 404，范围取原离职单与当前员工，不以员工账号代替 HR 创建人。 */
export async function requireHandoverResubmit(tx: Tx, ctx: EmploymentContext, id: string) {
  await requireEmploymentWrite(ctx, 'update', {}, HANDOVER_RESUBMIT_BUTTON.code, undefined, { commandOnly: true });
  const row = await loadHandoverRequest(tx, ctx.tenantId, id);
  try {
    const business = await requireBusinessWriteScope(tx, ctx.authorize!, ctx, row.exitRequestId, row.employeeId);
    if (business.kind !== 'leave') throw new AppError('NOT_FOUND', '离职交接申请不存在');
    await requireEmployeeInScope(tx, ctx, row.employeeId);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') throw new AppError('NOT_FOUND', '离职交接申请不存在');
    throw error;
  }
}

/** 先等员工 / 交接锁，再解析当前授权；ledgerExit 的首次、直接重放和失败回查均经过 before。 */
export function handoverResubmitGuard(deps: TenantRouteDeps, ctx: EmploymentContext, id: string) {
  return scopedGuard({
    before: async (tx) => {
      await lockHandoverRequest(tx, ctx, id);
      await requireHandoverResubmit(tx, await commandContext(tx, deps, ctx), id);
    },
  });
}

export async function resubmitExitHandover(tx: Tx, ctx: EmploymentContext, id: string) {
  const row = await lockHandoverRequest(tx, ctx, id);
  // 状态校验在 execute 内：同键重放仍可取回首次成功回执，新命令则明确拒绝。
  if (row.state !== 'not_launched' && row.state !== 'terminated')
    throw new AppError('CONFLICT', '交接仅在未发起或已终止时可以重新提交', {
      reason: 'EXIT_HANDOVER_NOT_RESUBMITTABLE',
      state: row.state,
    });
  assertRevision(ctx.expectedRevision, row.revision);
  const exitState = await businessState(tx, ctx.tenantId, row.exitRequestId);
  if (exitState === 'voided' || exitState === 'deleted')
    throw new AppError('CONFLICT', '离职已撤销，不能重新提交交接', { reason: 'EXIT_HANDOVER_EXIT_CANCELLED' });
  const initiatorUserId = await userOfPerson(tx, ctx.tenantId, row.employeeId);
  if (!initiatorUserId)
    throw new AppError('CONFLICT', HANDOVER_NOT_LAUNCHED_HINTS.NO_INITIATOR_ACCOUNT, {
      reason: 'NO_INITIATOR_ACCOUNT',
    });
  if (row.state === 'not_launched') {
    const current = await findCurrentRecord(tx, ctx.tenantId, row.employeeId, tenantLocalDate(ctx.now, ctx.timezone));
    await tx.execute(sql`UPDATE exit_handover_requests SET department_id=${current?.fields.departmentId ?? null}::uuid
      WHERE tenant_id=${ctx.tenantId} AND id=${id}::uuid`);
    await insertRequestItems(tx, { ...ctx, id, items: await listHandoverItems(tx, ctx.tenantId) });
  }
  await tx.execute(sql`UPDATE exit_handover_requests SET initiator_user_id=${initiatorUserId}::uuid
    WHERE tenant_id=${ctx.tenantId} AND id=${id}::uuid`);
  await moveHandoverRequest(tx, ctx, row, { state: 'in_progress' });
  try {
    // 引擎反向加载业务适配器，动态加载避免环；全部写入属于同一命令事务，拒绝时整体回滚。
    const { startNewHandover } = await import('../approval/engine.js');
    const instance = await startNewHandover(tx, handoverLaunchContext(ctx, initiatorUserId, ctx.userId), id);
    await linkHandoverInstance(tx, ctx.tenantId, id, instance.id);
    const current = await loadHandoverRequest(tx, ctx.tenantId, id);
    const receipt = {
      requestId: id,
      status: current.state,
      revision: current.revision,
      approvalInstanceId: instance.id,
    };
    await auditHandover(tx, { ...ctx, actorUserId: ctx.userId }, 'resubmit', 'exit-handover-request', id, row, current);
    return receipt;
  } catch (error) {
    const reason = handoverNotLaunchedReason(error);
    if (reason) throw new AppError('CONFLICT', HANDOVER_NOT_LAUNCHED_HINTS[reason], { reason });
    throw error;
  }
}
