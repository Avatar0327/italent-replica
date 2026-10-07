import { useCallback, useEffect, useRef, useState } from 'react';
import { loadApprovalDetail, permissionFailure, requestMessage } from './api.js';
import { text } from './messages.js';
import type { ApprovalDetail } from './types.js';

export function useApprovalInstance(tenantId: string, instanceId: string, onDenied: () => void) {
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [epoch, setEpoch] = useState(0);
  const active = useRef(true);
  const generation = useRef(0);
  const denied = useRef(onDenied);
  denied.current = onDenied;
  const clear = useCallback(() => {
    generation.current++;
    setDetail(null);
    setError(text.forbidden);
    denied.current();
  }, []);
  const publish = useCallback((result: ApprovalDetail) => {
    setDetail(result);
    setEpoch((value) => value + 1);
  }, []);
  const accept = useCallback(
    (result: ApprovalDetail) => {
      if (!active.current) return;
      // 写响应按当前权限裁剪；即使 revision 不变，也必须废弃所有更早的读取。
      generation.current++;
      publish(result);
    },
    [publish],
  );
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const result = await loadApprovalDetail(tenantId, instanceId);
      if (active.current && request === generation.current) {
        publish(result);
        setError('');
      }
      return result;
    } catch (failure) {
      if (active.current && request === generation.current) {
        setError(requestMessage(failure));
        if (permissionFailure(failure)) {
          setDetail(null);
          denied.current();
        }
      }
      throw failure;
    }
  }, [tenantId, instanceId, publish]);
  useEffect(() => {
    const controller = new AbortController();
    active.current = true;
    const request = ++generation.current;
    setLoading(true);
    void loadApprovalDetail(tenantId, instanceId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted && request === generation.current) publish(result);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && request === generation.current) {
          setError(requestMessage(failure));
          if (permissionFailure(failure)) denied.current();
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      active.current = false;
      generation.current++;
      controller.abort();
    };
  }, [tenantId, instanceId, publish]);
  return { detail, accept, epoch, loading, error, refresh, clear };
}
