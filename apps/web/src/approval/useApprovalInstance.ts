import { visibleWhenHidden } from '@italent/domain';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { loadApprovalDetail, permissionFailure, requestMessage } from './api.js';
import { text } from './messages.js';
import { createRequestOrder, type RequestOrder } from './requestOrder.js';
import type { ApprovalDetail } from './types.js';

/** 下发给命令层与历史层的台账视图：发出请求领代次、响应到达时裁决、历史接口报告隐藏时收紧。 */
export interface InstanceRequests {
  readonly issue: () => number;
  readonly settle: (ticket: number) => boolean;
  readonly hideRecords: () => void;
}
/** DEC-115：历史接口报告隐藏后，本地立即按服务端隐藏口径投影（只留当前待办、不留日志），直到更晚的响应被采用。 */
function hiddenView(detail: ApprovalDetail): ApprovalDetail {
  return { ...detail, recordsHidden: true, logs: [], tasks: detail.tasks.filter(visibleWhenHidden) };
}
function instanceRequests(
  order: RequestOrder,
  active: RefObject<boolean>,
  setDetail: Dispatch<SetStateAction<ApprovalDetail | null>>,
): InstanceRequests {
  return {
    issue: order.issue,
    settle: order.settle,
    hideRecords: () => {
      if (active.current) setDetail((current) => (current && !current.recordsHidden ? hiddenView(current) : current));
    },
  };
}
export function useApprovalInstance(tenantId: string, instanceId: string, onDenied: () => void) {
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [epoch, setEpoch] = useState(0);
  const active = useRef(true);
  const [order] = useState(createRequestOrder);
  const denied = useRef(onDenied);
  denied.current = onDenied;
  const clear = useCallback(() => {
    order.invalidate();
    setDetail(null);
    setError(text.forbidden);
    denied.current();
  }, [order]);
  const publish = useCallback((result: ApprovalDetail) => {
    setDetail(result);
    setEpoch((value) => value + 1);
  }, []);
  const refresh = useCallback(async () => {
    const ticket = order.issueLatest();
    try {
      const result = await loadApprovalDetail(tenantId, instanceId);
      if (!active.current || !order.settle(ticket)) return null;
      publish(result);
      setError('');
      return result;
    } catch (failure) {
      // 过期的错误（已有更晚的响应被采用）整条作废，不显示、不清单，也不交给调用方处理。
      if (!active.current || !order.settle(ticket)) return null;
      setError(requestMessage(failure));
      if (permissionFailure(failure)) {
        setDetail(null);
        denied.current();
      }
      throw failure;
    }
  }, [tenantId, instanceId, order, publish]);
  const accept = useCallback(
    (result: ApprovalDetail, ticket: number) => {
      if (!active.current) return;
      // 写响应按当前权限裁剪；即使 revision 不变，采用它也作废所有更早的读取。
      if (order.settle(ticket)) return publish(result);
      // 写响应早于已采用的披露收紧结果（如历史接口报告隐藏）：不发布它，改由服务端重新裁决当前状态。
      void refresh().catch(() => undefined);
    },
    [order, publish, refresh],
  );
  const requests = useMemo(() => instanceRequests(order, active, setDetail), [order]);
  useEffect(() => {
    const controller = new AbortController();
    active.current = true;
    const ticket = order.issueLatest();
    setLoading(true);
    void loadApprovalDetail(tenantId, instanceId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted && order.settle(ticket)) publish(result);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && order.settle(ticket)) {
          setError(requestMessage(failure));
          if (permissionFailure(failure)) denied.current();
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      active.current = false;
      order.invalidate();
      controller.abort();
    };
  }, [tenantId, instanceId, order, publish]);
  return { detail, accept, requests, epoch, loading, error, refresh, clear };
}
