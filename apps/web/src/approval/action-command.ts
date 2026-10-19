import { useState } from 'react';
import { useApiClient } from '../foundation/index.js';
import { messages as kernel } from '../foundation/forms/messages.js';
import { lockedContext, type Values } from '../foundation/forms/store.js';
import { acceptReceipt, approvalRequest, readApproval } from './api.js';
import { approvalNotice, confirmNotice } from './before-approve.js';
import { useApprovalCommand } from './commands.js';
import type { ApprovalAction, ApprovalDetail, ApprovalRow } from './types.js';

/**
 * 动作与待办任务存进内核的命令上下文（SubmitInput.context，F-147）：不进请求体，冲突重读回填草稿也不动它。
 * 合同行内催办（contracts/RowActions.tsx）与本单共用流程实例的恢复槽，槽里可能是催办。
 */
type ActionContext = {
  action: ApprovalAction | 'urge';
  taskId?: string;
};
/** 各动作可编辑的字段：意见、转交对象；撤销不带字段（后端 strictObject 只收这些键）。 */
export const actionFields: Record<ApprovalAction, readonly string[]> = {
  approve: ['comment'],
  disagree: ['comment'],
  reject: ['comment'],
  transfer: ['toUserId', 'comment'],
  withdraw: [],
};
/**
 * 审批动作接 F-123 内核（F-123 页面片接入 2）：键只含流程实例 ID；回执是动作后的详情，
 * id 须等于实例 ID、revision 须大于实际提交的 revision（acceptReceipt）。
 * 结果未知保持锁定，回查原单只核对，不解锁（DEC-464/475）；冲突重读后按最新 revision 重提。
 */
export function useApprovalAction(row: ApprovalRow, onRead: (detail: ApprovalDetail) => void) {
  const api = useApiClient();
  const command = useApprovalCommand(`/api/tenant/approval/instances/${row.id}`);
  const [chosen, setChosen] = useState<ActionContext>();
  // 槽里还有未确认的命令（处理中、结果未知、冲突）时以槽里的动作为准，换按钮重开不另起命令。
  const pending = lockedContext<ActionContext>(command.state);
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
    // 催办由合同行内发起，本单不重提；槽里是催办时各按钮都已禁用。
    if (!context || context.action === 'urge') return;
    const { action, taskId } = context;
    await confirmNotice(approvalNotice(detail, action));
    const result = await command.submit({
      values,
      baseline: {},
      editableFields: actionFields[action],
      revision: detail.revision,
      businessId: detail.id,
      send: async (sent) => {
        const request = approvalRequest(detail, action, taskId, sent.body);
        const receipt = await api.request<unknown>(request.path, {
          method: 'POST',
          command: { ...sent, body: request.body },
        });
        return acceptReceipt(receipt, detail.id, sent.revision ?? detail.revision);
      },
      context: { action, ...(taskId ? { taskId } : {}) },
    });
    if (result.status !== 'done') throw result.error ?? new Error(kernel.unknown);
    command.clear();
  }
  return {
    command: { ...command, reload },
    /** 弹窗只在用户点了按钮后打开；锁定时标题与提交仍按槽里的动作。 */
    action: chosen && context?.action !== 'urge' ? context?.action : undefined,
    pending: pending?.action,
    open,
    close: () => setChosen(undefined),
    submit,
  };
}
