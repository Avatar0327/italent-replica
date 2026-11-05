/**
 * 离职生效步骤 4：合同（A12）与在途合同申请（R2-T03 设计 §5.4，DEC-222 / 484 / 496①）。
 * 合同的终止 / 删除 / 撤回是离职生效的系统后果，授权已在离职门禁完成（§4A），所以用无范围的系统合同上下文调用合同端口；
 * 端口返回清单，这里写 exit_effects 并给被撤回申请的发起人与申请人发站内消息（合同端口本身不通知）。
 * 收件人口径与任职类终止一致（F-400 exit-void-applications notifyVoided，F-429）：发起人 + 申请人，同一人只发一条；
 * 有审批实例挂实例，没有（审批已办结前直接办理、草稿类）时挂合同申请单，不伪造审批实例。
 */
import { exitEffects, type Tx } from '@italent/db';
import { handleContractsOnExit } from '../contracts/ports.js';
import { schedulerAwareContext } from '../approval/context.js';
import { notifyMessage } from '../approval/notifications.js';
import { userOfPerson } from '../approval/resolver.js';
import { auditEmployment } from './context.js';
import { exitTerminationOf } from './exit-termination-policy.js';
import type { EmploymentContext } from './types.js';

export async function handleContractsOnExitEffective(
  tx: Tx,
  ctx: EmploymentContext,
  exit: { readonly id: string; readonly employeeId: string; readonly payload: { readonly kind: string } },
  lastWorkDate: string,
) {
  const { tenantId, userId, timezone, now, commandId, expectedRevision } = ctx;
  const termination = await exitTerminationOf(tx, tenantId, exit.payload.kind);
  const outcome = await handleContractsOnExit(
    tx,
    { tenantId, userId, timezone, now, commandId, expectedRevision },
    { employeeId: exit.employeeId, lastWorkDate, termination },
  );
  const effect = (kind: string, targetType: string, targetId: string, detail: object) => ({
    tenantId,
    businessId: exit.id,
    employeeId: exit.employeeId,
    phase: 'effective',
    kind,
    targetType,
    targetId,
    detail,
    commandId,
    createdAt: now,
  });
  const rows = [
    ...outcome.terminated.map((item) => effect('contract_terminated', 'contract', item.id, { ...item, lastWorkDate })),
    ...outcome.deleted.map((item) => effect('contract_deleted', 'contract', item.id, { ...item, lastWorkDate })),
    ...outcome.withdrawnRequests.map((item) => effect('contract_request_withdrawn', 'contract-request', item.id, item)),
  ];
  if (rows.length) await tx.insert(exitEffects).values(rows);
  const applicant = outcome.withdrawnRequests.length ? await userOfPerson(tx, tenantId, exit.employeeId) : null;
  for (const request of outcome.withdrawnRequests) {
    const target = request.instanceId
      ? { id: request.instanceId }
      : { businessType: 'contract', businessId: request.id };
    const recipients = new Set([request.initiatorUserId, applicant].filter((id): id is string => !!id));
    for (const recipientUserId of recipients)
      await notifyMessage(tx, schedulerAwareContext(ctx), target, {
        recipientUserId,
        templateCode: 'contract_request_voided_by_exit',
      });
  }
  if (rows.length)
    await auditEmployment(
      tx,
      ctx,
      'employment.exit.contracts_handled',
      'exit-request',
      exit.id,
      null,
      {
        lastWorkDate,
        terminated: outcome.terminated.length,
        deleted: outcome.deleted.length,
        withdrawnRequests: outcome.withdrawnRequests.length,
      },
      undefined,
      undefined,
      { employeeId: exit.employeeId },
    );
}
