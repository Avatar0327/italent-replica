import { useEffect, useState } from 'react';
import { useApiClient, useSession, type PageRequest, type PageResult } from '../foundation/index.js';
import type { ApplicationRow, ApplicationSort, ApprovalRow } from './types.js';

const firstPage: PageRequest = { page: 1, pageSize: 15 };
export interface ApplicationFilters {
  categories: string[];
  statuses: string[];
  sort?: ApplicationSort;
}
const noFilters: ApplicationFilters = { categories: [], statuses: [] };

/**
 * 我的申请（原站 §2.10）：类别 / 审批状态筛选与排序都交给服务端，改条件回到第 1 页，总数取服务端同一条件下的计数。
 * 切换租户 / 身份即重读，旧响应不覆盖新条件。
 */
export function useApplications() {
  const api = useApiClient();
  const { timezone, tenantId, identityKey } = useSession();
  const context = `${tenantId}/${identityKey}`;
  const [state, setState] = useState({ context, page: firstPage, filters: noFilters });
  if (state.context !== context) setState({ context, page: firstPage, filters: noFilters });
  const { page, filters } = state.context === context ? state : { page: firstPage, filters: noFilters };
  const [result, setResult] = useState<{ key: string; data: PageResult<ApplicationRow> }>({
    key: '',
    data: { items: [] },
  });
  const [selected, setSelected] = useState<ApprovalRow>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [generation, setGeneration] = useState(0);
  const query = new URLSearchParams({ view: 'applications', page: String(page.page), pageSize: String(page.pageSize) });
  if (filters.categories.length) query.set('category', filters.categories.join(','));
  if (filters.statuses.length) query.set('status', filters.statuses.join(','));
  if (filters.sort) {
    query.set('sort', filters.sort.field);
    query.set('order', filters.sort.order);
  }
  const key = `${context}?${query}`;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void api
      .request<PageResult<ApplicationRow>>(`/api/tenant/approval/instances?${key.split('?')[1]}`, {
        signal: controller.signal,
      })
      .then((data) => {
        if (!controller.signal.aborted) setResult({ key, data });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, key, generation]);
  return {
    data: result.key === key ? result.data : ({ items: [] } as PageResult<ApplicationRow>),
    selected,
    page,
    filters,
    loading,
    error,
    timezone,
    setSelected,
    refresh: () => setGeneration((n) => n + 1),
    setPage: (next: PageRequest) => setState({ context, page: next, filters }),
    setFilters: (next: ApplicationFilters) => setState({ context, page: firstPage, filters: next }),
  };
}
export type ApplicationsState = ReturnType<typeof useApplications>;
