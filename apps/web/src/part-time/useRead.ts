import { useEffect, useRef, useState } from 'react';
import { useApiClient, useSession } from '../foundation/Session.js';
export function useRead<T>(path: string | null) {
  const api = useApiClient();
  const session = useSession();
  const [generation, setGeneration] = useState(0);
  const key = `${session.tenantId}/${session.identityKey}/${path}/${generation}`;
  const latestKey = useRef(key);
  const sequence = useRef(0);
  latestKey.current = key;
  const [state, setState] = useState<{ key: string; data?: T; error?: unknown }>();
  useEffect(() => {
    const controller = new AbortController();
    const request = ++sequence.current;
    const current = () => !controller.signal.aborted && latestKey.current === key && sequence.current === request;
    if (path)
      void api.request<T>(path, { signal: controller.signal }).then(
        (data) => {
          if (current()) setState({ key, data });
        },
        (error: unknown) => {
          if (current()) setState({ key, error });
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
      // 初次读取和写后重读共用序号；过期重读不能让提交方解除锁定。
      const request = ++sequence.current;
      try {
        const data = await api.request<T>(path);
        if (latestKey.current !== key) throw new DOMException('Context changed', 'AbortError');
        if (sequence.current !== request) throw new DOMException('Read superseded', 'AbortError');
        setState({ key, data });
        return data;
      } catch (error) {
        // 写后重读失败交给命令内核锁定；保留原界面，避免卸载正在显示的 unknown 表单。
        if (latestKey.current === key && sequence.current === request && !current?.data) setState({ key, error });
        throw error;
      }
    },
  };
}
