import { useEffect, useRef, useState } from 'react';
import { requestError, TransferApiError } from './api.js';
import { needsEstablishmentConfirm } from './establishment-confirm.js';
import { text } from './messages.js';
import type { TransferBusiness } from './types.js';

export interface HrWriteOutcome {
  readonly employeeId: string;
  /** 实际发出的员工版本（If-Match）；回执的 employeeRevision 须已推进过它（#350 第 2 轮 P2-2）。 */
  readonly revision: number;
}
/**
 * 新建业务单会推进员工版本（write-service createEmploymentBusiness → bumpEmploymentEmployee），
 * 回执的员工版本没有推进过发出的 If-Match 即不是本次写入的结果，按结果未知处理。
 * 业务单 revision 是新单自己的版本，不与员工版本比较。
 */
function validReceipt(receipt: TransferBusiness, sent: number) {
  if (!receipt.id || !Number.isInteger(receipt.revision) || !receipt.status) return false;
  return Number.isInteger(receipt.employeeRevision) && receipt.employeeRevision > sent;
}
/**
 * HR 调动的回执核对与提示。处理中 / 结果未知的锁定由 F-123 内核（transfer/commands.ts，共享恢复记录）持有（F-110）；
 * 卸载后才到的回执按结果未知处理（界面已关，不替用户确认），由用户按原命令 ID 查询结果解锁。
 */
export function useHrWrite() {
  const [error, setError] = useState('');
  const [result, setResult] = useState<TransferBusiness | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /** 发出一次写命令并返回回执；失败原样抛出，交内核区分冲突、被拒与结果未知（#350 P2-2）。 */
  const run = async (send: () => Promise<TransferBusiness>, outcome: HrWriteOutcome) => {
    setError('');
    setResult(null);
    try {
      const receipt = await send();
      if (!mounted.current || !validReceipt(receipt, outcome.revision)) throw new Error(text.unknown);
      setResult(receipt);
      return receipt;
    } catch (cause) {
      // 版本冲突由内核提示并引导重读，不再重复一条“重新读取表单”；超编确认由确认框处理（F-026），取消不留错误提示；
      // 5xx / 网络错误由内核锁成结果未知。
      if (
        mounted.current &&
        cause instanceof TransferApiError &&
        cause.status < 500 &&
        cause.code !== 'REVISION_CONFLICT' &&
        !needsEstablishmentConfirm(cause)
      )
        setError(requestError(cause));
      throw cause;
    }
  };
  /** 内核登记恢复记录时就拒绝（未发出，DEC-954 / DEC-955 等）：run 没跑，提示由这里给出；传空串清掉上次的。 */
  const refuse = (message: string) => setError(message);
  return { error, result, run, refuse, setResult };
}
