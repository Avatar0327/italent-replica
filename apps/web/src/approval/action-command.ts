import { useReducer, useRef, useState } from 'react';
import { useApiClient } from '../foundation/index.js';
import { queryCommandResult, type CommandResult } from '../foundation/forms/command-result.js';
import { messages as kernel } from '../foundation/forms/messages.js';
import { lockedContext, type Outcome, type Submission, type Values } from '../foundation/forms/store.js';
import { acceptReceipt, approvalFailure, approvalRequest, readApproval } from './api.js';
import { approvalNotice, confirmNotice } from './before-approve.js';
import { actionTask, editFields, editValues } from './edit-model.js';
import { ApiError, type ApiClient } from '../foundation/client.js';
import { messages as m } from './messages.js';
import { useApprovalCommand } from './commands.js';
import type { ApprovalAction, ApprovalDetail, ApprovalRow } from './types.js';

/**
 * 动作与待办任务存进内核的命令上下文（SubmitInput.context，F-147）：不进请求体，冲突重读回填草稿也不动它。
 * 合同行内催办（contracts/RowActions.tsx）与本单共用流程实例的恢复槽，槽里可能是催办。
 */
type ActionContext = {
  action: ApprovalAction | 'urge';
  taskId?: string;
  /** F-478 S5：所选出口（接口 exits.code）；旧形状兜底时没有，请求体也不带。 */
  exit?: string;
};
/**
 * F-120 成功分支核对：审批台账只存 { instanceId }，摘要的实例 ID / 版本按真实投影为 null（AC-FE-F110-14）。
 * 以命令 ID 匹配的成功结论为准，摘要有值才核对；再读回槽内原实例：实例一致、版本推进过发出的版本
 * （同 acceptReceipt）才算确认。催办不推进版本（同 parseUrgeReceipt），不低于发出的版本即可。
 */
async function confirmResult(
  api: ApiClient,
  instanceId: string,
  sent: { revision?: number; urge: boolean },
  result: CommandResult,
): Promise<ApprovalDetail> {
  const floor = sent.revision ?? -1;
  const advanced = (revision: number) => (sent.urge ? revision >= floor : revision > floor);
  if (result.businessId !== null && result.businessId !== instanceId) throw new Error(kernel.invalidReceipt);
  if (result.revision !== null && !advanced(result.revision)) throw new Error(kernel.invalidReceipt);
  const detail = await readApproval(api, instanceId);
  if (detail.id !== instanceId || !advanced(detail.revision)) throw new Error(kernel.invalidReceipt);
  return detail;
}
/**
 * F-566（同 F-562 第 2 轮 P2-1）：本次提交处理中内核在返回前就发布 rejected 条目；登记冲突后占槽命令已在本页处理
 * 拒绝前落定时，它的 error 是旧的“其他标签页”文案，审批弹窗的 CommandStatus 不能读。处理完之后的 rejected
 * （未发出的 refused、已发出被拒、主动查询结果确认失败）照常显示。
 */
function statusState(state: Submission | undefined, settling: boolean) {
  return settling && state?.status === 'rejected' ? undefined : state;
}
/**
 * 本次未发出的拒绝只取内核 refused 的文案（DEC-954 / DEC-955、存储不可用），条目留给 CommandStatus 显示；
 * 竞争（race）仍按原样显示占槽命令。两者都不带时 error 是旧的“其他标签页”文案：清掉条目，
 * 抛空值让弹窗保持打开、保留输入且不提示（FormOverlay 只对有值的错误显示提示）。
 */
function refuseUnsent(result: Outcome, issued: boolean, clear: () => void) {
  if (result.status !== 'rejected' || issued || result.race) return;
  if (result.refused) throw new Error(result.refused);
  clear();
  throw undefined;
}
/**
 * 提交处理中的标记：调用内核前同步置上，内核返回后放下并按当前条目重新渲染（refused 时内核不再发布新条目，
 * 不重渲染就一直拿着处理中被隐去的状态），再按 refuseUnsent 处理未发出的拒绝。
 */
function useSettling() {
  const settling = useRef(false);
  const [, settled] = useReducer((count: number) => count + 1, 0);
  const settle = async (pending: Promise<Outcome>, issued: () => boolean, clear: () => void) => {
    const result = await pending.finally(() => {
      settling.current = false;
      settled();
    });
    refuseUnsent(result, issued(), clear);
    return result;
  };
  return { settling, settle };
}
/** 各动作可编辑的字段：意见、转交对象；撤销不带字段（后端 strictObject 只收这些键）。 */
export const actionFields: Record<ApprovalAction, readonly string[]> = {
  approve: ['comment'],
  disagree: ['comment'],
  reject: ['comment'],
  transfer: ['toUserId', 'comment'],
  withdraw: [],
  edit: [],
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
  const { settling, settle } = useSettling();
  // 槽里还有未确认的命令（处理中、结果未知、冲突）时以槽里的动作为准，换按钮重开不另起命令。
  const pending = lockedContext<ActionContext>(command.state);
  const context = pending ?? chosen;
  const reload = () =>
    command.reread(async (id) => {
      const detail = await readApproval(api, id ?? row.id);
      onRead(detail);
      return {
        id: detail.id,
        revision: detail.revision,
        values: context && context.action !== 'urge' ? editValues(detail, context.action) : {},
      };
    });
  // 已确认成功即关闭弹窗、清槽：原动作已完成，不能在同一弹窗里再起一条命令。
  const queryResult = async () => {
    const urge = pending?.action === 'urge';
    const result = await command.recoverResult((sent) =>
      queryCommandResult(api, sent.id, async (result) => {
        onRead(await confirmResult(api, row.id, { revision: sent.revision, urge }, result));
        return row.id;
      }),
    );
    if (result?.status !== 'done') return;
    command.clear();
    setChosen(undefined);
  };
  const open = (action: ApprovalAction, detail: ApprovalDetail, exit?: string) => {
    // 被拒或已完成的槽可以清掉重来；锁定的槽 clear 无效，仍按槽里的动作打开。
    command.clear();
    setChosen({ action, taskId: actionTask(detail, row.taskId), ...(exit === undefined ? {} : { exit }) });
  };
  async function submit(detail: ApprovalDetail, values: Values) {
    // 催办由合同行内发起，本单不重提；槽里是催办时各按钮都已禁用。
    if (!context || context.action === 'urge') return;
    const { action, taskId, exit } = context;
    // 冲突重读换了任务时不把原动作转投另一节点；用户需关闭并核对新任务。
    if (taskId !== actionTask(detail, row.taskId))
      throw new ApiError(403, 'ACTION_UNAVAILABLE', 'forbidden', m.actionDenied);
    const fields = editFields(detail, action);
    const businessValues = Object.fromEntries(
      fields.map(({ key, value }) => [key, Object.hasOwn(values, key) ? values[key] : value]),
    );
    await confirmNotice(
      approvalNotice({ ...detail, form: { values: { ...detail.form.values, ...businessValues } } }, action),
    );
    let issued = false;
    settling.current = true;
    const submitted = command.submit({
      values,
      baseline: editValues(detail, action),
      editableFields: [...actionFields[action], ...fields.map(({ key }) => key)],
      revision: detail.revision,
      businessId: detail.id,
      send: async (sent) => {
        issued = true;
        // 重读后出口已不在最新 exits 里时 approvalRequest 直接拒绝，不发请求（不自动改投其他出口）。
        const request = approvalRequest(detail, action, taskId, sent.body, exit);
        const receipt = await api
          .request<unknown>(request.path, { method: 'POST', command: { ...sent, body: request.body } })
          .catch((error: unknown) => {
            throw approvalFailure(error);
          });
        return acceptReceipt(receipt, detail.id, sent.revision ?? detail.revision);
      },
      context: { action, ...(taskId ? { taskId } : {}), ...(exit === undefined ? {} : { exit }) },
    });
    const result = await settle(submitted, () => issued, command.clear);
    if (result.status !== 'done') throw result.error ?? new Error(kernel.unknown);
    command.clear();
  }
  return {
    command: { ...command, state: statusState(command.state, settling.current), reload, queryResult },
    /** 弹窗只在用户点了按钮后打开；锁定时标题与提交仍按槽里的动作。 */
    action: chosen && context?.action !== 'urge' ? context?.action : undefined,
    exit: chosen && context?.action !== 'urge' ? context?.exit : undefined,
    pending: pending?.action,
    pendingExit: pending?.exit,
    open,
    close: () => setChosen(undefined),
    submit,
  };
}
