import type { Command } from '../foundation/client.js';
import { EMPLOYMENT_API, TRANSFER_API, transferRequest, TransferApiError } from './api.js';
import { parseDraft, type DraftSnapshot } from './draft-restore.js';
import { text } from './messages.js';

export interface ServerDraft extends DraftSnapshot {
  revision: number;
  reasonCode?: string | null;
  withEstablishment?: boolean;
}
const draftPath = (employeeId: string) => `${TRANSFER_API}/employees/${employeeId}/draft`;
/** 元数据与内容分开读；版本发生变化时整条链重读一次，不能拼接两版暂存。 */
export async function readServerDraft(tenantId: string, employeeId: string, signal?: AbortSignal) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await transferRequest<{ draft: null | ServerDraft }>(tenantId, draftPath(employeeId), { signal });
    if (result?.draft === null) return null;
    const meta = result?.draft;
    if (!meta?.id || !Number.isSafeInteger(meta.revision) || meta.revision < 0)
      throw new Error(text.draftRestoreFailed);
    const [business, linkage] = await Promise.all([
      transferRequest<Record<string, unknown>>(tenantId, `${EMPLOYMENT_API}/businesses/${meta.id}`, { signal }),
      transferRequest<Record<string, unknown>>(tenantId, `${TRANSFER_API}/${meta.id}/linkage`, { signal }),
    ]);
    if (business.revision !== meta.revision || linkage.revision !== meta.revision) continue;
    const snapshot = parseDraft(meta.id, employeeId, business, linkage, meta.transferTypeCode);
    if (!snapshot) return null;
    return {
      ...snapshot,
      revision: meta.revision,
      ...(meta.reasonCode !== undefined ? { reasonCode: meta.reasonCode } : {}),
      ...(meta.withEstablishment !== undefined ? { withEstablishment: meta.withEstablishment } : {}),
    };
  }
  throw new Error(text.draftRestoreFailed);
}
/** 删除回执与 DELETE /businesses/:id 同形；只校验稳定标识、版本及未被裁剪的状态。 */
export async function deleteServerDraft(tenantId: string, employeeId: string, id: string, command: Command) {
  // 这个端点的替换原因在 error.details.reason；通用客户端不保留 details，局部读取真实错误信封。
  const response = await fetch(`${draftPath(employeeId)}/${id}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: new Headers({
      'content-type': 'application/json',
      'x-tenant-id': tenantId,
      'If-Match': String(command.revision),
      'Idempotency-Key': command.id,
    }),
  });
  const receipt = await response.json();
  if (!response.ok) {
    const error = receipt?.error;
    const code =
      response.status === 409 && (error?.code === 'DRAFT_REPLACED' || error?.details?.reason === 'DRAFT_REPLACED')
        ? 'REVISION_CONFLICT'
        : (error?.code ?? 'REQUEST_FAILED');
    throw new TransferApiError(
      code,
      response.status === 403 ? text.draftDeleteForbidden : (error?.message ?? text.unknown),
      response.status,
    );
  }
  if (
    receipt?.id !== id ||
    !Number.isSafeInteger(receipt.revision) ||
    receipt.revision <= (command.revision ?? -1) ||
    (receipt.status !== undefined && receipt.status !== 'deleted')
  )
    throw new Error(text.unknown);
  return receipt as { id: string; revision: number; status?: string };
}
