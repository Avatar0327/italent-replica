import { useEffect, useState } from 'react';
import { useApiClient, useSession } from '../foundation/Session.js';
/** 每次查询清空旧展示；路由/身份/筛选变更后，旧请求即使忽略 abort 返回也不能落地。 */
export function useReportRead<T>(path: string | null, generation = 0) {
  const api = useApiClient();
  const session = useSession();
  const key = JSON.stringify([session.tenantId, session.identityKey, path, generation]);
  const [state, setState] = useState<{ key: string; data?: T; error?: unknown }>({ key: '' });
  useEffect(() => {
    setState({ key });
    if (path === null) return;
    const controller = new AbortController();
    // StrictMode 试挂载会先清理，延后一拍可避免同一查询发两次。
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      void api
        .request<T>(path, { signal: controller.signal })
        .then((data) => {
          if (!controller.signal.aborted) setState({ key, data });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setState({ key, error });
        });
    });
    return () => controller.abort();
  }, [api, path, key]);
  const current = state.key === key ? state : { key };
  return { ...current, loading: path !== null && !current.data && !current.error };
}
