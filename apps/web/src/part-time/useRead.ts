import { useEffect, useRef, useState } from 'react';
import { useApiClient, useSession } from '../foundation/Session.js';
export function useRead<T>(path: string | null) {
  const api = useApiClient();
  const session = useSession();

  const [generation, setGeneration] = useState(0);
  const epoch = useRef(0);
  const key = `${session.tenantId}/${session.identityKey}/${path}/${generation}`;
  const [state, setState] = useState<{ key: string; data?: T; error?: unknown }>();
  useEffect(() => {
    const controller = new AbortController();
    const requestEpoch = ++epoch.current;
    if (path)
      void api.request<T>(path, { signal: controller.signal }).then(
        (data) => {
          if (!controller.signal.aborted && requestEpoch === epoch.current) setState({ key, data });
        },
        (error: unknown) => {
          if (!controller.signal.aborted && requestEpoch === epoch.current) setState({ key, error });
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
    reload: async () => {
      if (!path) return;
      const requestEpoch = ++epoch.current;
      try {
        const data = await api.request<T>(path);
        if (requestEpoch === epoch.current) setState({ key, data });
        return data;
      } catch (error) {
        // 写后重读失败交给命令内核锁定；保留原界面，避免卸载正在显示的 unknown 表单。
        if (requestEpoch === epoch.current && !current?.data) setState({ key, error });
        throw error;
      }
    },
  };
}
