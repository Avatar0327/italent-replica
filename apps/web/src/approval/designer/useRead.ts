import { useEffect, useState } from 'react';

/** 请求键变化立即隐藏旧内容；卸载或换记录时迟到回执不能覆盖当前页面。 */
export function useRead<T>(key: string, read: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<{ key: string; data?: T; error?: unknown }>();
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ key });
    void read(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ key, data });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ key, error });
      },
    );
    return () => controller.abort();
  }, [key, read, epoch]);
  const result = state?.key === key ? state : undefined;
  return { data: result?.data, error: result?.error, refresh: () => setEpoch((value) => value + 1) };
}
