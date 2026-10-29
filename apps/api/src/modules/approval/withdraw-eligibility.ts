import { revokeAllowed, type ApprovalNode } from '@italent/domain';
import type { AppError } from '../../errors.js';
import { approvalError } from './context.js';
import type { InstanceRow } from './store.js';

/** AC-TRF-28 / F-308：业务入口、审批入口与动作披露共用；业务入口仍不受节点撤回开关限制。 */
export function approvalWithdrawalFailure(
  instance: Pick<InstanceRow, 'initiatorUserId' | 'status'>,
  userId: string,
  current?: ApprovalNode,
  fromBusiness = false,
): AppError | undefined {
  if (instance.initiatorUserId !== userId)
    return approvalError('FORBIDDEN', 'APPROVAL_NOT_INITIATOR', '只有发起人可以撤回');
  if (!['running', 'returned'].includes(instance.status))
    return approvalError('CONFLICT', 'APPROVAL_CLOSED', '流程已结束');
  if (!fromBusiness && current && !revokeAllowed(current))
    return approvalError('CONFLICT', 'APPROVAL_ACTION_DISABLED', '当前节点未开启撤回');
  return undefined;
}
