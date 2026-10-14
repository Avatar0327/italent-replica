import { ApiError, newCommand, type ApiClient, type PageRequest } from '../foundation/client.js';
import { completedExamples } from '../demo-stubs/approval.js';
import { messages as m } from './messages.js';
import type { ApprovalAction, ApprovalDetail, ApprovalList, ApprovalRow, ApprovalView } from './types.js';

const base = '/api/tenant/approval';
const actions: ApprovalAction[] = ['approve', 'reject', 'transfer', 'withdraw'];
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

export function approvalCommand(
  detail: ApprovalDetail,
  action: ApprovalAction,
  taskId?: string,
  input: { comment?: string; toUserId?: string } = {},
) {
  if (!visibleActions(detail).includes(action) || (action !== 'withdraw' && !taskId))
    throw new ApiError(403, 'ACTION_UNAVAILABLE', 'forbidden', m.actionDenied);
  const toUserId = input.toUserId?.trim().toLowerCase();
  if (action === 'transfer' && (!toUserId || !uuidPattern.test(toUserId)))
    throw new ApiError(422, 'INVALID_TARGET', 'fields', m.targetInvalid);
  const body =
    action === 'withdraw'
      ? {}
      : {
          comment: input.comment?.trim() || null,
          ...(action === 'transfer' ? { toUserId } : {}),
        };
  return {
    path:
      action === 'withdraw'
        ? `${base}/instances/${encodeURIComponent(detail.id)}/withdraw`
        : `${base}/tasks/${encodeURIComponent(taskId!)}/${action}`,
    command: newCommand(body, detail.revision),
  };
}
