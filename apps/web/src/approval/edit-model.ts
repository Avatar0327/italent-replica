import type { ApprovalAction, ApprovalDetail } from './types.js';

/** 两种提交方式共用服务器字段集合；不按审批类型或节点另建白名单。 */
export function editFields(detail: ApprovalDetail, action: ApprovalAction) {
  const edit = detail.form.edit;
  return edit &&
    ((action === 'approve' && edit.mode === 'with_approve') || (action === 'edit' && edit.mode === 'separate'))
    ? edit.fields
    : [];
}
export const editValues = (detail: ApprovalDetail, action: ApprovalAction) =>
  Object.fromEntries(editFields(detail, action).map(({ key, value }) => [key, value]));
/** 可编辑元数据有任务编号时，以详情当前任务为准，不能沿用待办列表的旧任务。 */
export const actionTask = (detail: ApprovalDetail, fallback?: string) => detail.form.edit?.taskId ?? fallback;
