import { useEffect, useState } from 'react';
import { EMPLOYMENT_API, TRANSFER_API, transferRequest, TransferApiError } from './api.js';
import { clearDraft, parseDraft, restoreDraft } from './draft-restore.js';
import { forgetHrDraft, hrDraftOf } from './hr-session.js';
import type { TransferFormModel } from './types.js';

export type DraftRestoreStatus = 'idle' | 'loading' | 'restored' | 'failed';
type SetModel = React.Dispatch<React.SetStateAction<TransferFormModel>>;

function draftIdOf(scope: string, employeeId: string) {
  try {
    return hrDraftOf(scope, employeeId);
  } catch {
    // 会话存储不可读时按没有暂存处理；写入口另有 recoveryUnavailable 提示。
    return undefined;
  }
}
function forget(scope: string, employeeId: string) {
  try {
    forgetHrDraft(scope, employeeId);
  } catch {
    // 存储不可写时下次仍会回查，回查结果同样按当前状态判断，不影响正确性。
  }
}
/**
 * F-153（DEC-511）：选人后按人查本会话已知的暂存单，按当前权限读取并带出。
 * 已不是草稿或已不存在（404）时静默忘掉；其他失败提示未带出，表单保持空白可用。
 */
export function useDraftRestore(tenantId: string, scope: string | undefined, employeeId: string, setModel: SetModel) {
  const [status, setStatus] = useState<DraftRestoreStatus>('idle');
  useEffect(() => {
    const draftId = scope && employeeId ? draftIdOf(scope, employeeId) : undefined;
    setStatus(draftId ? 'loading' : 'idle');
    if (!scope || !draftId) return;
    const controller = new AbortController();
    const { signal } = controller;
    void Promise.all([
      transferRequest<unknown>(tenantId, `${EMPLOYMENT_API}/businesses/${draftId}`, { signal }),
      transferRequest<unknown>(tenantId, `${TRANSFER_API}/${draftId}/linkage`, { signal }),
    ])
      .then(([business, linkage]) => {
        if (signal.aborted) return;
        const draft = parseDraft(draftId, employeeId, business, linkage);
        if (!draft) {
          forget(scope, employeeId);
          setStatus('idle');
          return;
        }
        setModel((current) => restoreDraft(current, draft));
        setStatus('restored');
      })
      .catch((cause: unknown) => {
        if (signal.aborted) return;
        if (cause instanceof TransferApiError && cause.status === 404) {
          forget(scope, employeeId);
          setStatus('idle');
        } else setStatus('failed');
      });
    return () => controller.abort();
  }, [tenantId, scope, employeeId, setModel]);
  return {
    status,
    /** 点击清除：忘掉该人的暂存索引并回到空白表单；服务端草稿不删除。 */
    clear: () => {
      if (scope && employeeId) forget(scope, employeeId);
      setModel(clearDraft);
      setStatus('idle');
    },
  };
}
