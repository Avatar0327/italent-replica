import { EMPLOYMENT_API, TRANSFER_API, transferBody, transferRequest } from './api.js';
import type { TransferAction, TransferBusiness, TransferFormModel } from './types.js';

export interface TransferReceipt {
  key: string;
  selection: Pick<TransferFormModel, 'employeeId' | 'effectiveDate' | 'transferTypeCode' | 'reasonCode'>;
  saved?: TransferBusiness;
  pending?: { id: string; path: string; revision: number; body: string; action: TransferAction };
}
interface RecoverySession {
  active?: string;
  entries: Record<string, TransferReceipt>;
}
const storageKey = (scope: string) => `italent.transfer.recovery.v1:${scope}`;
export function readRecovery(scope: string): RecoverySession {
  const raw = sessionStorage.getItem(storageKey(scope));
  if (!raw) return { entries: {} };
  const data = JSON.parse(raw) as RecoverySession;
  if (!data.entries || typeof data.entries !== 'object') throw new Error('INVALID_RECOVERY');
  return data;
}
export function rememberRecovery(scope: string, receipt: TransferReceipt) {
  const session = readRecovery(scope);
  session.entries[receipt.key] = receipt;
  session.active = receipt.key;
  // 必须先落会话存储再发请求；存储失败不能留下不可恢复的写命令。
  sessionStorage.setItem(storageKey(scope), JSON.stringify(session));
}
export function leaveRecovery(scope: string, receipt?: TransferReceipt) {
  const session = readRecovery(scope);
  if (receipt && receipt.saved?.status !== 'draft') delete session.entries[receipt.key];
  delete session.active;
  sessionStorage.setItem(storageKey(scope), JSON.stringify(session));
}
export function forgetPending(scope: string, receipt: TransferReceipt) {
  if (receipt.saved) rememberRecovery(scope, { ...receipt, pending: undefined });
  else {
    const session = readRecovery(scope);
    delete session.entries[receipt.key];
    delete session.active;
    sessionStorage.setItem(storageKey(scope), JSON.stringify(session));
  }
}
export function prepareReceipt(model: TransferFormModel, action: TransferAction, saved: TransferBusiness | null) {
  const { employeeId, effectiveDate, transferTypeCode, reasonCode } = model;
  return {
    key: JSON.stringify([employeeId, model.preview!.form.id]),
    selection: { employeeId, effectiveDate, transferTypeCode, reasonCode },
    saved: saved ?? undefined,
    pending: {
      id: crypto.randomUUID(),
      path: saved ? `${EMPLOYMENT_API}/businesses/${saved.id}/submit` : `${TRANSFER_API}/employees/${employeeId}`,
      revision: saved ? saved.revision : model.preview!.employeeRevision,
      body: saved ? '{}' : JSON.stringify(transferBody(model, action)),
      action,
    },
  } satisfies TransferReceipt;
}
export function sendOriginal(tenantId: string, receipt: TransferReceipt) {
  const request = receipt.pending!;
  return transferRequest<TransferBusiness>(tenantId, request.path, {
    method: 'POST',
    headers: { 'if-match': String(request.revision), 'idempotency-key': request.id },
    body: request.body,
  });
}
export function confirmedReceipt(receipt: TransferReceipt, result: TransferBusiness): TransferReceipt {
  if (!result.id || !Number.isInteger(result.revision) || !result.status) throw new Error('INVALID_RECEIPT');
  // 已确认结果仅保留定位信息；重开时按当前字段权限回读，不渲染缓存的员工字段。
  const { id, revision, employeeRevision, status } = result;
  return { ...receipt, pending: undefined, saved: { id, revision, employeeRevision, status } };
}
