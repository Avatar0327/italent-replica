import { useEffect, useState } from 'react';
import { useApiClient } from '../foundation/Session.js';
export function useResource<T>(path: string | null): { data?: T; error?: unknown; loading: boolean; refresh(): void } {
  const api = useApiClient();
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean; path: string | null }>({
    loading: !!path,
    path,
  });
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: !!path, path });
    if (path)
      void api
        .request<T>(path, { signal: controller.signal })
        .then((data) => {
          if (!controller.signal.aborted) setState({ data, loading: false, path });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setState({ error, loading: false, path });
        });
    return () => controller.abort();
  }, [api, path, version]);
  return { ...(state.path === path ? state : { loading: !!path }), refresh: () => setVersion((v) => v + 1) };
}
