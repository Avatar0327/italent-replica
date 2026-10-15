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
export interface HrWriteOutcome {
  readonly employeeId: string;
  /** 暂存时记入按人索引，带出时还原类型（P2-1）。 */
  readonly transferTypeCode?: string;
}
const notSent = () => new TransferApiError('NOT_SENT', text.recoveryUnavailable, 400);
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
  /**
   * 发出一次写命令并返回回执；失败原样抛出，交 F-142 内核区分冲突、被拒与结果未知（#350 P2-2）。
   * 没有发出（处理中、会话不可写）时抛 NOT_SENT：内核按被拒处理，不会锁成结果未知。
   */
  const run = async (send: (id: string) => Promise<TransferBusiness>, outcome: HrWriteOutcome) => {
    if (!scope || running.current || isProcessing(scope)) throw notSent();
    try {
      beginHrWrite(scope);
    } catch {
      setError(text.recoveryUnavailable);
      throw notSent();
    }
    running.current = true;
    setError('');
    setResult(null);
    try {
      const receipt = await send(crypto.randomUUID());
      if (!mounted.current) throw new Error(text.unknown);
      if (!receipt.id || !Number.isInteger(receipt.revision) || !receipt.status) throw new Error(text.unknown);
      const { employeeId, transferTypeCode } = outcome;
      const draft = { id: receipt.id, ...(transferTypeCode ? { transferTypeCode } : {}) };
      finishHrWrite(scope, { employeeId, ...(receipt.status === 'draft' ? { draft } : {}) });
      setResult(receipt);
      return receipt;
    } catch (cause) {
      // 只有当前打开的界面收到明确拒绝，才允许重新核对；5xx / 网络错误保持只读。
      if (mounted.current && cause instanceof TransferApiError && cause.status < 500) release(scope, cause);
      throw cause;
    } finally {
      running.current = false;
    }
  };
  const release = (current: string, cause: TransferApiError) => {
    finishHrWrite(current);
    // 版本冲突由内核提示并引导重读，不再重复一条“重新读取表单”。
    if (cause.code !== 'REVISION_CONFLICT') setError(requestError(cause));
  };
  return { processing, error, result, run };
}
