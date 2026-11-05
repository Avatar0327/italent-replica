import { useEffect, useState } from 'react';
import { useApiClient, useSession } from '../foundation/Session.js';
/** 每次查询清空旧展示；路由/身份/筛选变更后，旧请求即使忽略 abort 返回也不能落地。 */
export function useReportRead<T>(path: string, generation = 0) {
  const api = useApiClient();
  const session = useSession();
  const key = JSON.stringify([session.tenantId, session.identityKey, path, generation]);
  const [state, setState] = useState<{ key: string; data?: T; error?: unknown }>({ key: '' });
  useEffect(() => {
    const controller = new AbortController();
    setState({ key });
    void api
      .request<T>(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setState({ key, data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ key, error });
      });
    return () => controller.abort();
  }, [api, path, key]);
  const current = state.key === key ? state : { key };
  return { ...current, loading: !current.data && !current.error };
}
