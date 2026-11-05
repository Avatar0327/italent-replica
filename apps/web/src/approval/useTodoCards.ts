import { useEffect, useState } from 'react';
import { useApiClient, useSession, type PageRequest } from '../foundation/index.js';
import type { ApprovalRow, ApprovalView, ApprovalList } from './types.js';

export interface TodoRow extends ApprovalRow {
  isExceptionAdmin?: boolean;
  initiatorName?: string | null;
  summary?: { key: string; label: string; value: string }[];
}
interface TodoList extends ApprovalList {
  items: TodoRow[];
  categories?: { key: string; label: string; count: number }[];
}
const firstPage: PageRequest = { page: 1, pageSize: 15 };

/** DEC-799：待办三个视图读取独立投影；我的申请仍使用原 useApprovalList。 */
export function useTodoCards(view: ApprovalView) {
  const api = useApiClient();
  const { timezone, tenantId, identityKey } = useSession();
  const context = `${tenantId}/${identityKey}/${view}`;
  const [selection, setSelection] = useState({ context, category: '', page: firstPage });
  if (selection.context !== context) setSelection({ context, category: '', page: firstPage });
  const { category, page } = selection.context === context ? selection : { category: '', page: firstPage };
  const key = `${context}/${category}/${page.page}/${page.pageSize}`;
  const [result, setResult] = useState<{ key: string; data: TodoList }>({ key: '', data: { items: [] } });
  const [selected, setSelected] = useState<ApprovalRow>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setResult({ key, data: { items: [] } });
    const query = new URLSearchParams({ view, page: String(page.page), pageSize: String(page.pageSize) });
    if (category) query.set('category', category);
    void api
      .request<TodoList>(`/api/tenant/approval/todos?${query}`, { signal: controller.signal })
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
  }, [api, key, view, category, page, generation]);
  return {
    data: result.key === key ? result.data : ({ items: [] } as TodoList),
    selected,
    setSelected,
    page,
    loading,
    error,
    timezone,
    category,
    setPage: (next: PageRequest) => setSelection({ context, category, page: next }),
    setCategory: (next: string) => setSelection({ context, category: next, page: firstPage }),
    refresh: () => setGeneration((n) => n + 1),
  };
}
export type TodoState = ReturnType<typeof useTodoCards>;
