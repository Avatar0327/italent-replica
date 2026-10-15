import { ApiError, newCommand, type ApiClient, type PageRequest } from '../foundation/client.js';
import { completedExamples } from '../demo-stubs/approval.js';
import { messages as kernel } from '../foundation/forms/messages.js';
import { messages as m } from './messages.js';
import type { ApprovalAction, ApprovalDetail, ApprovalList, ApprovalRow, ApprovalView } from './types.js';

const base = '/api/tenant/approval';
const actions: ApprovalAction[] = ['approve', 'disagree', 'reject', 'transfer', 'withdraw'];
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const visibleActions = (detail: ApprovalDetail) => actions.filter((action) => detail.actions.includes(action));

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
  input: { comment?: unknown; toUserId?: unknown } = {},
) {
  if (!visibleActions(detail).includes(action) || (action !== 'withdraw' && !taskId))
    throw new ApiError(403, 'ACTION_UNAVAILABLE', 'forbidden', m.actionDenied);
  const toUserId = typeof input.toUserId === 'string' ? input.toUserId.trim().toLowerCase() : undefined;
  if (action === 'transfer' && (!toUserId || !uuidPattern.test(toUserId)))
    throw new ApiError(422, 'INVALID_TARGET', 'fields', m.targetInvalid);
  const comment = typeof input.comment === 'string' ? input.comment.trim() || null : null;
  const body = action === 'withdraw' ? {} : { comment, ...(action === 'transfer' ? { toUserId } : {}) };
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
