import { MAX_ADD_SIGNERS } from '@italent/domain';
import { requireUuid } from './api.js';
import { buildFieldEdits } from './fields.js';
import { text } from './messages.js';
import type { ActionDraft, ApprovalAction, ApprovalCommand, ApprovalDetail, FieldDraft } from './types.js';

export function initialActionDraft(detail: ApprovalDetail): ActionDraft {
  return {
    comment: '',
    toUserId: '',
    userIds: '',
    signType: 'before',
    taskId: detail.taskId ?? '',
    adminKind: 'reassign',
    nodeKey: '',
    reason: '',
  };
}
function accounts(value: string, limit: number) {
  const ids = [
    ...new Set(
      value
        .split(/[\s,，]+/)
        .filter(Boolean)
        .map(requireUuid),
    ),
  ];
  if (!ids.length || ids.length > limit) throw new Error(text.uuidInvalid);
  return ids;
}
export function makeApprovalCommand(
  detail: ApprovalDetail,
  action: ApprovalAction,
  draft: ActionDraft,
  fieldDraft: FieldDraft,
): ApprovalCommand {
  if (!detail.actions.includes(action)) throw new Error(text.actionUnavailable);
  const comment = draft.comment.trim() || null;
  const editsAllowed = action === 'edit' || (action === 'approve' && detail.form.editMode === 'with_approve');
  const fields = editsAllowed ? buildFieldEdits(detail.form.values, fieldDraft, detail.form.editableFields) : {};
  const taskId = action === 'retrieve' ? detail.retrieveTaskId : detail.taskId;
  const instanceAction = ['withdraw', 'urge', 'resubmit', 'adminTransfer', 'adminIntervene'].includes(action);
  const target = instanceAction ? `/instances/${detail.id}` : `/tasks/${requireUuid(taskId ?? '')}`;
  const paths: Partial<Record<ApprovalAction, string>> = {
    addSign: 'add-sign',
    adminTransfer: 'admin-transfer',
    adminIntervene: 'admin-intervene',
  };
  return {
    id: crypto.randomUUID(),
    instanceId: detail.id,
    revision: detail.revision,
    path: `${target}/${paths[action] ?? action}`,
    body: commandBody(detail, action, draft, fields, comment),
  };
}
function commandBody(
  detail: ApprovalDetail,
  action: ApprovalAction,
  draft: ActionDraft,
  fields: Readonly<Record<string, unknown>>,
  comment: string | null,
): Readonly<Record<string, unknown>> {
  if (action === 'approve')
    return {
      comment,
      ...(detail.form.editMode === 'with_approve' && Object.keys(fields).length ? { fields } : {}),
    };
  if (action === 'disagree' || action === 'reject') return { comment };
  if (action === 'transfer') return { toUserId: requireUuid(draft.toUserId), comment };
  if (action === 'addSign') return { userIds: accounts(draft.userIds, MAX_ADD_SIGNERS), type: draft.signType, comment };
  if (action === 'cc') return { userIds: accounts(draft.userIds, 20), comment };
  if (action === 'edit') {
    if (detail.form.editMode !== 'separate' || !Object.keys(fields).length) throw new Error(text.invalidValue);
    return { fields };
  }
  if (action === 'adminTransfer' || action === 'adminIntervene') {
    const reason = draft.reason.trim() || null;
    if (action === 'adminIntervene' && draft.adminKind === 'jump') {
      if (!draft.nodeKey.trim()) throw new Error(text.invalidValue);
      return { kind: 'jump', toNodeKey: draft.nodeKey.trim(), reason };
    }
    return {
      ...(action === 'adminIntervene' ? { kind: 'reassign' } : {}),
      taskId: requireUuid(draft.taskId),
      toUserId: requireUuid(draft.toUserId),
      reason,
    };
  }
  return {};
}
