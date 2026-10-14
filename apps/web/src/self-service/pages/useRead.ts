import { useCallback, useEffect, useState } from 'react';
import { useApiClient, useSession } from '../../foundation/Session.js';

/** 页面片最小读取适配：身份、路径或刷新改变时不保留上一份响应；候选/分页均以服务端为准。 */
export function useRead<T>(path: string | null) {
  const api = useApiClient();
  const session = useSession();
  const [generation, setGeneration] = useState(0);
  const key = JSON.stringify([session.tenantId, session.identityKey, path, generation]);
  const [state, setState] = useState<{ key: string; data?: T; error?: unknown; loading: boolean }>({
    key: '',
    loading: true,
  });
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    void api.request<T>(path, { signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) setState({ key, data, loading: false });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ key, error, loading: false });
      },
    );
    return () => controller.abort();
  }, [api, key, path]);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  return { ...(state.key === key ? state : { loading: !!path }), refresh } as {
    data?: T;
    error?: unknown;
    loading: boolean;
    refresh(): void;
  };
}
