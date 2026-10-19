import { useEffect, useRef, useState } from 'react';
import { useApiClient, useSession } from '../foundation/Session.js';
export function useRead<T>(path: string | null) {
  const api = useApiClient();
  const session = useSession();
  const [generation, setGeneration] = useState(0);
  const key = `${session.tenantId}/${session.identityKey}/${path}/${generation}`;
  const latestKey = useRef(key);
  latestKey.current = key;
  const [state, setState] = useState<{ key: string; data?: T; error?: unknown }>();
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
  const current = state?.key === key ? state : undefined;
  return {
    data: current?.data,
    error: current?.error,
    loading: !!path && !current,
    refresh: () => setGeneration((n) => n + 1),
    async reload() {
      if (!path) throw new Error('Missing read path');
      const data = await api.request<T>(path);
      if (latestKey.current !== key) throw new DOMException('Context changed', 'AbortError');
      setState({ key, data });
    },
  };
}
