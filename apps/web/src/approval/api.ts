import { ApiError, newCommand, type ApiClient, type PageRequest } from '../foundation/client.js';
import { completedExamples } from '../demo-stubs/approval.js';
import { messages as kernel } from '../foundation/forms/messages.js';
import { editFields, actionTask } from './edit-model.js';
import { detailText as d, messages as m } from './messages.js';
import type { ApprovalAction, ApprovalDetail, ApprovalList, ApprovalLog, ApprovalRow, ApprovalView } from './types.js';

const base = '/api/tenant/approval';
const actions: ApprovalAction[] = ['approve', 'disagree', 'reject', 'transfer', 'withdraw', 'edit'];
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const visibleActions = (detail: ApprovalDetail) =>
  actions.filter(
    (action) => detail.actions.includes(action) && (action !== 'edit' || editFields(detail, action).length > 0),
  );

export async function approvalList(
  api: ApiClient,
  view: ApprovalView,
  page: PageRequest,
  signal?: AbortSignal,
): Promise<ApprovalList> {
  if (view === 'completed') {
    const rows = completedExamples();
    return {
      items: rows.slice((page.page - 1) * page.pageSize, page.page * page.pageSize),
      total: rows.length,
      demo: true,
    };
  }
  const query = new URLSearchParams({ page: String(page.page), pageSize: String(page.pageSize) });
  if (view === 'initiated') query.set('role', 'initiated');
  const result = await api.request<{ items: (ApprovalRow & { instanceId?: string })[] }>(
    `${base}/${view === 'pending' ? 'todos' : 'instances'}?${query}`,
    { signal },
  );
  return {
    items: result.items.map((row) => (view === 'pending' ? { ...row, id: row.instanceId!, status: 'pending' } : row)),
    hasMore: result.items.length === page.pageSize,
  };
}
/**
 * 操作记录的意见只取日志自身 detail.comment（#333 第 2 轮 P2）。后端写日志时：同意 / 不同意 / 驳回 / 跳转 / 抄送的
 * taskId 是操作人自己的任务；转交、加签、加签返回、撤回的 taskId 指向新任务，经 taskId 去读任务意见会拿到接收人后来的意见。
 * 发起、催办、撤销、终止等不带意见。
 */
export function logComment(log: ApprovalLog): string | null {
  const comment = log.detail?.comment;
  return typeof comment === 'string' && comment.trim() ? comment : null;
}
/** DEC-656：姓名仅取日志下发值；系统判定沿用 F-248FE，未下发姓名不补 ID。 */
export function logActor(log: ApprovalLog): string | null {
  return log.actorUserId === null ? d.systemActor : (log.actorName ?? null);
}
export const readApproval = (api: ApiClient, id: string, signal?: AbortSignal) =>
  api.request<ApprovalDetail>(`${base}/instances/${encodeURIComponent(id)}`, { signal });

/**
 * 动作回执校验（DEC-502①(a)）：动作接口成功时返回动作后的详情（routes.ts respondOutcome → respondDetail），
 * id 须是本实例，revision 须大于实际提交的命令 revision（冲突重读后即新 revision）；否则按结果未知处理，不当成功。
 */
export function acceptReceipt(receipt: unknown, instanceId: string, sentRevision: number) {
  const value = receipt as Partial<ApprovalDetail> | null;
  const revision = value?.revision;
  if (value?.id !== instanceId || typeof revision !== 'number' || !Number.isSafeInteger(revision))
    throw new Error(kernel.unknown);
  if (revision <= sentRevision) throw new Error(kernel.unknown);
  return value as ApprovalDetail;
}
/** 动作请求的路径与请求体；提交经 F-123 内核时由内核生成命令 ID 与 revision（F-123 页面片接入 2）。 */
export function approvalRequest(
  detail: ApprovalDetail,
  action: ApprovalAction,
  taskId?: string,
  input: Record<string, unknown> = {},
) {
  taskId = actionTask(detail, taskId);
  if (!visibleActions(detail).includes(action) || (action !== 'withdraw' && !taskId))
    throw new ApiError(403, 'ACTION_UNAVAILABLE', 'forbidden', m.actionDenied);
  const toUserId = typeof input.toUserId === 'string' ? input.toUserId.trim().toLowerCase() : undefined;
  if (action === 'transfer' && (!toUserId || !uuidPattern.test(toUserId)))
    throw new ApiError(422, 'INVALID_TARGET', 'fields', m.targetInvalid);
  const comment = typeof input.comment === 'string' ? input.comment.trim() || null : null;
  const body: { comment?: string | null; toUserId?: string; fields?: Record<string, unknown> } =
    action === 'withdraw' || action === 'edit' ? {} : { comment };
  const keys = editFields(detail, action).map(({ key }) => key);
  if (keys.length) body.fields = Object.fromEntries(Object.entries(input).filter(([key]) => keys.includes(key)));
  if (action === 'transfer') body.toUserId = toUserId;
  return {
    path:
      action === 'withdraw'
        ? `${base}/instances/${encodeURIComponent(detail.id)}/withdraw`
        : `${base}/tasks/${encodeURIComponent(taskId!)}/${action}`,
    body,
  };
}
export function approvalCommand(
  detail: ApprovalDetail,
  action: ApprovalAction,
  taskId?: string,
  input: { comment?: string; toUserId?: string } = {},
) {
  const request = approvalRequest(detail, action, taskId, input);
  return { path: request.path, command: newCommand(request.body, detail.revision) };
}

/** 审批 fields 是传输信封；内核表单的字段名不带此前缀。保留状态码供内核区分明确拒绝与未知。 */
export function approvalFailure(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  return new ApiError(
    error.status,
    error.code,
    error.kind,
    error.code === 'APPROVAL_FIELD_NOT_EDITABLE' ? (error.serverMessage ?? m.fieldNotEditable) : error.message,
    {
      message: error.serverMessage,
      details: error.fieldErrors.flatMap(({ name, errors }) =>
        errors.map((message) => ({ path: name[0] === 'fields' ? name.slice(1) : name, message })),
      ),
    },
    error.retryAfter,
  );
}
