/**
 * 离职生效步骤 4：合同（A12）与在途合同申请（R2-T03 设计 §5.4，DEC-222 / 484 / 496①）。
 * 合同的终止 / 删除 / 撤回是离职生效的系统后果，授权已在离职门禁完成（§4A），所以用无范围的系统合同上下文调用合同端口；
 * 端口返回清单，这里写 exit_effects 并给被撤回申请的发起人发站内消息（合同端口本身不通知）。
 */
import { exitEffects, type Tx } from '@italent/db';
import { handleContractsOnExit } from '../contracts/ports.js';
import { notifyMessage } from '../approval/notifications.js';
import { auditEmployment } from './context.js';
import type { EmploymentContext } from './types.js';

export async function handleContractsOnExitEffective(
  tx: Tx,
  ctx: EmploymentContext,
  exit: { readonly id: string; readonly employeeId: string },
  lastWorkDate: string,
) {
  const { tenantId, userId, timezone, now, commandId, expectedRevision } = ctx;
  const outcome = await handleContractsOnExit(
    tx,
    { tenantId, userId, timezone, now, commandId, expectedRevision },
    { employeeId: exit.employeeId, lastWorkDate },
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
  for (const request of outcome.withdrawnRequests)
    if (request.instanceId && request.initiatorUserId)
      await notifyMessage(
        tx,
        ctx,
        { id: request.instanceId },
        {
          recipientUserId: request.initiatorUserId,
          templateCode: 'contract_request_voided_by_exit',
        },
      );
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
