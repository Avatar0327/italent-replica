import { useState } from 'react';
import { useApiClient } from '../foundation/index.js';
import { messages as kernel } from '../foundation/forms/messages.js';
import type { Submission, Values } from '../foundation/forms/store.js';
import { acceptReceipt, approvalRequest, readApproval } from './api.js';
import { useApprovalCommand } from './commands.js';
import type { ApprovalAction, ApprovalDetail, ApprovalRow } from './types.js';

/** 动作与待办任务随草稿存在槽里；不在编辑字段集合内，内核不会把它放进请求体。 */
const contextField = '__context';
interface ActionContext {
  action: ApprovalAction;
  taskId?: string;
}
/** 各动作可编辑的字段：意见、转交对象；撤销不带字段（后端 strictObject 只收这些键）。 */
export const actionFields: Record<ApprovalAction, readonly string[]> = {
  approve: ['comment'],
  disagree: ['comment'],
  reject: ['comment'],
  transfer: ['toUserId', 'comment'],
  withdraw: [],
};
/** 槽里还有未确认的命令（处理中、结果未知、冲突）时，以槽里保存的动作为准，换按钮重开不另起命令。 */
function lockedContext(state: Submission | undefined, locked: boolean) {
  return locked ? (state?.values[contextField] as ActionContext | undefined) : undefined;
}

/**
 * 审批动作接 F-123 内核（F-123 页面片接入 2）：键只含流程实例 ID；回执是动作后的详情，
 * id 须等于实例 ID、revision 须大于实际提交的 revision（acceptReceipt）。
 * 结果未知保持锁定，回查原单只核对，不解锁（DEC-464/475）；冲突重读后按最新 revision 重提。
 */
export function useApprovalAction(row: ApprovalRow, onRead: (detail: ApprovalDetail) => void) {
  const api = useApiClient();
  const command = useApprovalCommand(`/api/tenant/approval/instances/${row.id}`);
  const [chosen, setChosen] = useState<ActionContext>();
  const pending = lockedContext(command.state, command.locked);
  const context = pending ?? chosen;
  const reload = () =>
    command.reread(async (id) => {
      const detail = await readApproval(api, id ?? row.id);
      onRead(detail);
      return { id: detail.id, revision: detail.revision, values: {} };
    });
  const open = (action: ApprovalAction) => {
    // 被拒或已完成的槽可以清掉重来；锁定的槽 clear 无效，仍按槽里的动作打开。
    command.clear();
    setChosen({ action, taskId: row.taskId });
  };
  async function submit(detail: ApprovalDetail, values: Values) {
    if (!context) return;
    const result = await command.submit({
      values: { ...values, [contextField]: context },
      baseline: {},
      editableFields: actionFields[context.action],
      revision: detail.revision,
      businessId: detail.id,
      send: async (sent) => {
        const request = approvalRequest(detail, context.action, context.taskId, sent.body);
        const receipt = await api.request<unknown>(request.path, {
          method: 'POST',
          command: { ...sent, body: request.body },
        });
        return acceptReceipt(receipt, detail.id, sent.revision ?? detail.revision);
      },
    });
    if (result.status !== 'done') throw result.error ?? new Error(kernel.unknown);
    command.clear();
  }
  return {
    command: { ...command, reload },
    /** 弹窗只在用户点了按钮后打开；锁定时标题与提交仍按槽里的动作。 */
    action: chosen ? context?.action : undefined,
    pending: pending?.action,
    open,
    close: () => setChosen(undefined),
    submit,
  };
}
