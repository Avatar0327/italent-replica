import { useEffect, useState } from 'react';
import { useApiClient, useSession } from '../foundation/Session.js';

/** 路径或身份改变时立即隐藏旧响应；中止请求不能落入新详情或新筛选。待上移 FE-0。 */
export function useRead<T>(path: string | null) {
  const api = useApiClient();
  const session = useSession();
  const [revision, refresh] = useState(0);
  const key = `${session.tenantId}/${session.identityKey}/${path}/${revision}`;
  const [state, setState] = useState<{ key: string; data?: T; error?: unknown }>({ key: '' });
  useEffect(() => {
    const controller = new AbortController();
    if (path)
      void api.request<T>(path, { signal: controller.signal }).then(
        (data) => {
          if (!controller.signal.aborted) setState({ key, data });
        },
        (error: unknown) => {
          if (!controller.signal.aborted) setState({ key, error });
        },
      );
    return () => controller.abort();
  }, [api, path, key]);
  const current = state.key === key ? state : undefined;
  return {
    data: current?.data,
    error: current?.error,
    loading: !!path && !current,
    refresh: () => refresh((n) => n + 1),
  };
}
