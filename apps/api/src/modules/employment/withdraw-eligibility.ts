import type { Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { activeInstanceOf } from '../approval/store.js';
import { approvalWithdrawalFailure } from '../approval/withdraw-eligibility.js';
import { requireEmploymentWrite } from './context.js';
import { requireBusinessWriteScope } from './replay-guard.js';
import { transitionPermitted } from './transitions.js';
import type { EmploymentContext } from './types.js';

/**
 * F-308：读口下发 withdraw 与任职撤回写入口共用，依次检查当前写权 / 按钮、业务范围、状态与审批原发起人。
 * 只返回确定的资格拒绝；存储错误等异常继续抛出。写侧在命令执行内调用，成功台账的重放仍由原 guard 复核权限。
 */
export async function employmentWithdrawalFailure(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
): Promise<AppError | undefined> {
  try {
    await requireEmploymentWrite(ctx, 'update', {}, 'Employment.Withdraw');
    const business = await requireBusinessWriteScope(tx, ctx.authorize!, ctx, businessId);
    if (!transitionPermitted({ state: business.status, payload: business }, 'withdraw'))
      return new AppError('CONFLICT', '当前状态不允许此动作', { state: business.status, action: 'withdraw' });
    // 列表读不加写锁；写链随后在既有员工 → 业务 → 实例锁序下再次调用审批同一谓词。
    const instance = await activeInstanceOf(tx, ctx.tenantId, 'employment', businessId, false);
    // 与 employmentApprovalHooks.withdrawn 一致：没有在途实例时不执行审批撤回，不新增业务约束。
    return instance ? approvalWithdrawalFailure(instance, ctx.userId, undefined, true) : undefined;
  } catch (error) {
    if (error instanceof AppError && (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')) return error;
    throw error;
  }
}
