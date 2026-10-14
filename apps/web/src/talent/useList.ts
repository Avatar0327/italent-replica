import { useCallback, useEffect, useState } from 'react';
import { request, type ListResult } from './api.js';

const PAGE_SIZE = 50;

/** 分页列表：查询条件或页码变化时重新加载；reload 供写入成功后刷新。 */
export function useList<T>(tenantId: string, path: string, onError: (message: string) => void) {
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<ListResult<T>>({ items: [], hasDataPermission: true });
  useEffect(() => setPage(1), [path]);
  useEffect(() => {
    let active = true;
    const join = path.includes('?') ? '&' : '?';
    void request<ListResult<T>>(tenantId, `${path}${join}page=${page}&pageSize=${PAGE_SIZE}`)
      .then((value) => {
        if (active) setResult(value);
      })
      .catch((cause: unknown) => {
        if (active) onError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [tenantId, path, page, version, onError]);
  return {
    ...result,
    page,
    hasNext: result.items.length >= PAGE_SIZE,
    setPage,
    reload: useCallback(() => setVersion((value) => value + 1), []),
  };
}
