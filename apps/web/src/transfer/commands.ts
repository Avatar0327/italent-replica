// F-110：HR 调动的命令存储挂在模块级并接会话恢复记录：关闭表单、切换路由、整页刷新后结果未知的命令仍锁定，
// 只能按原命令 ID 查询结果解锁（不另起命令）。各员工的命令另钉到调动集合槽：一条未确认时，本会话的调动写入都锁定
// （保留 DEC-464 处理标记“一条未确认、整页只读”的口径），重选别人也看得到这条命令。
import { createApiClient } from '../foundation/client.js';
import { queryCommandResult } from '../foundation/forms/command-result.js';
import { messages as kernel } from '../foundation/forms/messages.js';
import { sessionRecovery } from '../foundation/forms/recovery.js';
import { createFormStore } from '../foundation/forms/store.js';
import { EMPLOYMENT_API, TRANSFER_API, transferRequest } from './api.js';
import type { TransferBusiness } from './types.js';

export const transferCommands = createFormStore({ recovery: sessionRecovery('transfer') });
export const transferSlot = TRANSFER_API;
export const transferEntry = (employeeId: string) => `${TRANSFER_API}/employees/${employeeId}`;

/** F-120 成功分支：按 businessId 读回调动单（当前权限），核对单号与业务类型后交给页面显示。 */
export async function transferResult(
  tenantId: string,
  commandId: string,
  onBusiness: (value: TransferBusiness) => void,
) {
  const api = createApiClient(() => ({ tenantId, identityKey: '' }));
  return queryCommandResult(api, commandId, async (result) => {
    if (result.businessType !== 'transfer' || !result.businessId) throw new Error(kernel.invalidReceipt);
    const business = await transferRequest<TransferBusiness>(
      tenantId,
      `${EMPLOYMENT_API}/businesses/${result.businessId}`,
    );
    if (business?.id !== result.businessId) throw new Error(kernel.invalidReceipt);
    onBusiness(business);
    return undefined;
  });
}
