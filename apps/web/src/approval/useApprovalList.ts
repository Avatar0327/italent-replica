import { useCallback, useEffect, useState } from 'react';
import { loadApprovalList, permissionFailure, requireUuid, requestMessage } from './api.js';
import { text } from './messages.js';
import type { ApprovalListItem, ApprovalTab } from './types.js';

export function useApprovalList(tenantId: string, initialTab: ApprovalTab, initialBusinessId: string) {
  const [tab, setTab] = useState(initialTab);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState(initialBusinessId);
  const [businessId, setBusinessId] = useState(initialBusinessId);
  const [items, setItems] = useState<readonly ApprovalListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const [denied, setDenied] = useState(false);
  const clear = useCallback(() => {
    setItems([]);
    setBlocked(true);
    setDenied(true);
    setError(text.forbidden);
  }, []);
  const refresh = useCallback(() => {
    setBlocked(false);
    setDenied(false);
    setVersion((value) => value + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    if (blocked) {
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    setError('');
    void loadApprovalList(tenantId, tab, page, businessId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setItems(result.items);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(requestMessage(failure));
        if (permissionFailure(failure)) clear();
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [tenantId, tab, page, businessId, version, blocked, clear]);
  function selectTab(next: ApprovalTab) {
    setTab(next);
    setPage(1);
    setBlocked(false);
    setDenied(false);
  }
  function applyFilter() {
    try {
      setBusinessId(filter.trim() ? requireUuid(filter) : '');
      setPage(1);
      refresh();
    } catch (failure) {
      setError(requestMessage(failure));
    }
  }
  return {
    tab,
    page,
    filter,
    items,
    loading,
    error,
    denied,
    setFilter,
    setPage,
    selectTab,
    applyFilter,
    refresh,
    clear,
  };
}
