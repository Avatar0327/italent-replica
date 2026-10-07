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
  const sequence = useRef(0);
  const denied = useRef(onDenied);
  denied.current = onDenied;
  const clear = useCallback(() => {
    setDetail(null);
    setError(text.forbidden);
    denied.current();
  }, []);
  const accept = useCallback((result: ApprovalDetail) => {
    setDetail(result);
    setEpoch((value) => value + 1);
  }, []);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const result = await loadApprovalDetail(tenantId, instanceId);
      if (active.current && request === sequence.current) {
        accept(result);
        setError('');
      }
      return result;
    } catch (failure) {
      if (active.current && request === sequence.current) {
        setError(requestMessage(failure));
        if (permissionFailure(failure)) {
          setDetail(null);
          denied.current();
        }
      }
      throw failure;
    }
  }, [tenantId, instanceId, accept]);
  useEffect(() => {
    const controller = new AbortController();
    active.current = true;
    setLoading(true);
    void loadApprovalDetail(tenantId, instanceId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) accept(result);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          setError(requestMessage(failure));
          if (permissionFailure(failure)) denied.current();
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      active.current = false;
      sequence.current++;
      controller.abort();
    };
  }, [tenantId, instanceId, accept]);
  return { detail, accept, epoch, loading, error, refresh, clear };
}
