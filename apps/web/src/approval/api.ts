import { normalizeUuid } from '@italent/domain';
import { text } from './messages.js';
import type { ApprovalCommand, ApprovalDetail, ApprovalListItem, ApprovalPageResult, ApprovalTab } from './types.js';

export const APPROVAL_API = '/api/tenant/approval';
export const PAGE_SIZE = 20;
export class ApprovalApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}
/** DEC-288 止损：客户端在读写请求里回传最后看到的披露版本，服务端据此判断是否已收紧。 */
export const DISCLOSURE_VERSION_HEADER = 'x-disclosure-version';
export interface ApprovalRequestOptions extends RequestInit {
  /** 最后看到的披露版本；首次读取或刷新后为 null，不回传。 */
  readonly version?: string | null;
}
export async function approvalRequest<T>(
  tenantId: string,
  path: string,
  options: ApprovalRequestOptions = {},
): Promise<T> {
  const { version, ...init } = options;
  const response = await fetch(`${APPROVAL_API}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': tenantId,
      ...(version ? { [DISCLOSURE_VERSION_HEADER]: version } : {}),
      ...init.headers,
    },
  });
  const body = (await response.json()) as T & {
    error?: { code?: string; message?: string; details?: { reason?: string } };
  };
  if (!response.ok)
    throw new ApprovalApiError(
      response.status,
      body.error?.code ?? 'REQUEST_FAILED',
      body.error?.message ?? text.failed,
      body.error?.details?.reason,
    );
  return body;
}
export function loadApprovalList(
  tenantId: string,
  tab: ApprovalTab,
  page: number,
  businessId: string,
  signal: AbortSignal,
) {
  const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (tab !== 'todos') {
    query.set('role', tab);
    if (businessId) query.set('businessId', requireUuid(businessId));
  }
  return approvalRequest<ApprovalPageResult<ApprovalListItem>>(
    tenantId,
    `${tab === 'todos' ? '/todos' : '/instances'}?${query}`,
    { signal },
  );
}
export function loadApprovalDetail(tenantId: string, id: string, signal?: AbortSignal, version?: string | null) {
  return approvalRequest<ApprovalDetail>(tenantId, `/instances/${requireUuid(id)}`, { signal, version });
}
export function executeApprovalCommand(
  tenantId: string,
  command: ApprovalCommand,
  signal?: AbortSignal,
  version?: string | null,
) {
  return approvalRequest<ApprovalDetail>(tenantId, command.path, {
    method: 'POST',
    signal,
    version,
    headers: { 'if-match': String(command.revision), 'idempotency-key': command.id },
    body: JSON.stringify(command.body),
  });
}
export function requireUuid(value: string): string {
  const id = normalizeUuid(value);
  if (!id) throw new Error(text.uuidInvalid);
  return id;
}
export function permissionFailure(error: unknown) {
  return error instanceof ApprovalApiError && [401, 403, 404].includes(error.status);
}
export function revisionConflict(error: unknown): error is ApprovalApiError {
  return (
    error instanceof ApprovalApiError &&
    error.status === 409 &&
    (error.code === 'REVISION_CONFLICT' ||
      error.reason === 'APPROVAL_BUSINESS_CHANGED' ||
      error.reason === 'APPROVAL_CONCURRENT_CONFLICT')
  );
}
/** 服务端判定披露已收紧（DEC-288 止损）：清空并整页刷新，不按普通 409 处理。 */
export function disclosureTightened(error: unknown): error is ApprovalApiError {
  return error instanceof ApprovalApiError && error.status === 409 && error.reason === 'DISCLOSURE_TIGHTENED';
}
export function unknownResult(error: unknown) {
  if (!(error instanceof ApprovalApiError)) return true;
  return error.reason === 'RESULT_UNKNOWN' || (error.status >= 500 && error.reason !== 'STORAGE_UNWRITABLE');
}
export function requestMessage(error: unknown) {
  if (permissionFailure(error)) return text.forbidden;
  return error instanceof Error ? error.message : text.failed;
}
