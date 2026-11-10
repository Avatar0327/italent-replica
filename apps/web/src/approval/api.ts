import { ApiError, newCommand, type ApiClient, type PageRequest } from '../foundation/client.js';
import { completedExamples } from '../demo-stubs/approval.js';
import { messages as kernel } from '../foundation/forms/messages.js';
import { editFields, actionTask } from './edit-model.js';
import { detailText as d, messages as m } from './messages.js';
import type { ApprovalAction, ApprovalDetail, ApprovalList, ApprovalLog, ApprovalRow, ApprovalView } from './types.js';

export interface DecisionButton {
  readonly action: 'approve' | 'disagree';
  /** 接口 exits 的出口编码；旧形状兜底时没有，请求体也不带 exit。 */
  readonly exit?: string;
  readonly label: string;
}

const base = '/api/tenant/approval';
const actions: ApprovalAction[] = ['approve', 'disagree', 'reject', 'transfer', 'withdraw', 'edit'];
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const visibleActions = (detail: ApprovalDetail) =>
  actions.filter(
    (action) => detail.actions.includes(action) && (action !== 'edit' || editFields(detail, action).length > 0),
  );

/**
 * F-478 S5（设计 §4）：同意 / 不同意按钮按接口 exits 渲染，文案取 exits.label，前端不拼文案、不按审批类型分支；
 * 详情没有 exits（旧形状）时按 actions 兜底为“同意 / 不同意”。出口仍须在 actions 里可见，二者不一致时不显示。
 */
export function decisionButtons(detail: ApprovalDetail): DecisionButton[] {
  const visible = visibleActions(detail);
  if (!Array.isArray(detail.exits))
    return (['approve', 'disagree'] as const)
      .filter((action) => visible.includes(action))
      .map((action) => ({ action, label: m[action] }));
  return detail.exits
    .filter((exit) => (exit.family === 'approve' || exit.family === 'disagree') && visible.includes(exit.family))
    .map((exit) => ({ action: exit.family, exit: exit.code, label: exit.label }));
}

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
  exit?: string,
) {
  taskId = actionTask(detail, taskId);
  const exitGone =
    exit !== undefined && !decisionButtons(detail).some((item) => item.action === action && item.exit === exit);
  if (!visibleActions(detail).includes(action) || (action !== 'withdraw' && !taskId) || exitGone)
    throw new ApiError(403, 'ACTION_UNAVAILABLE', 'forbidden', m.actionDenied);
  const toUserId = typeof input.toUserId === 'string' ? input.toUserId.trim().toLowerCase() : undefined;
  if (action === 'transfer' && (!toUserId || !uuidPattern.test(toUserId)))
    throw new ApiError(422, 'INVALID_TARGET', 'fields', m.targetInvalid);
  const comment = typeof input.comment === 'string' ? input.comment.trim() || null : null;
  const body: { comment?: string | null; toUserId?: string; fields?: Record<string, unknown>; exit?: string } =
    action === 'withdraw' || action === 'edit' ? {} : { comment };
  if (exit !== undefined) body.exit = exit;
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
  // F-478 S5：审批业务冲突（顶层 CONFLICT，如他人已办理、出口已不可用）保留服务端原因并提示重新读取；
  // 通用客户端不保留 details.reason，不按原因码分支，也不把原因码显示给用户（DEC-045）。内核按明确拒绝处理，不自动重提。
  const changed = error.status === 409 && error.kind === 'conflict';
  const message = changed
    ? m.handlingChanged(error.serverMessage || error.message)
    : // F-291 的业务原因在 details.reason；顶层 code 是 FORBIDDEN，不能拿它匹配业务原因。
      error.status === 403
      ? (error.serverMessage ?? m.fieldNotEditable)
      : error.message;
  return new ApiError(
    error.status,
    error.code,
    error.kind,
    message,
    {
      message: changed ? message : error.serverMessage,
      details: error.fieldErrors.flatMap(({ name, errors }) =>
        errors.map((message) => ({ path: name[0] === 'fields' ? name.slice(1) : name, message })),
      ),
    },
    error.retryAfter,
  );
}
