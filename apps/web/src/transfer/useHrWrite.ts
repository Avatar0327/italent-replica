import { useEffect, useRef, useState } from 'react';
import { requestError, TransferApiError } from './api.js';
import { beginHrWrite, finishHrWrite, hrSessionChanged, readHrSession } from './hr-session.js';
import { text } from './messages.js';
import type { TransferBusiness } from './types.js';

function isProcessing(scope?: string) {
  if (!scope) return false;
  try {
    return readHrSession(scope).processing;
  } catch {
    return true;
  }
}
/** HR 调动的唯一写入口；未知结果只读，卸载后的响应没有会话写权限。有回执时按人更新暂存索引（DEC-511）。 */
export function useHrWrite(scope?: string) {
  const [processing, setProcessing] = useState(() => isProcessing(scope));
  const [error, setError] = useState('');
  const [result, setResult] = useState<TransferBusiness | null>(null);
  const mounted = useRef(false);
  const running = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const refresh = () => setProcessing(isProcessing(scope));
    refresh();
    window.addEventListener(hrSessionChanged, refresh);
    return () => {
      mounted.current = false;
      window.removeEventListener(hrSessionChanged, refresh);
    };
  }, [scope]);
  const run = async (send: (id: string) => Promise<TransferBusiness>, employeeId: string) => {
    if (!scope || running.current || isProcessing(scope)) return;
    try {
      beginHrWrite(scope);
    } catch {
      setError(text.recoveryUnavailable);
      return;
    }
    running.current = true;
    setError('');
    setResult(null);
    try {
      const receipt = await send(crypto.randomUUID());
      if (!mounted.current) return;
      if (!receipt.id || !Number.isInteger(receipt.revision) || !receipt.status) throw new Error(text.unknown);
      finishHrWrite(scope, { employeeId, ...(receipt.status === 'draft' ? { draftId: receipt.id } : {}) });
      setResult(receipt);
    } catch (cause) {
      if (!mounted.current) return;
      // 只有当前打开的界面收到明确拒绝，才允许重新核对；5xx / 网络错误保持只读。
      if (cause instanceof TransferApiError && cause.status < 500) {
        try {
          finishHrWrite(scope);
        } catch {
          return;
        }
        setError(requestError(cause));
      }
    } finally {
      running.current = false;
    }
  };
  return { processing, error, result, run };
}
