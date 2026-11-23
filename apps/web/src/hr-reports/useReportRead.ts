import { useEffect, useState } from 'react';
import { useApiClient, useSession } from '../foundation/Session.js';
import type { ApiClient } from '../foundation/client.js';
import { reportFailure, type ReportFailure } from './model.js';
function read<T>(api: ApiClient, path: string, signal: AbortSignal) {
  return api.request<T>(path, { signal });
}

/** 每次查询清空旧展示；路由/身份/筛选变更后，旧请求即使忽略 abort 返回也不能落地。 */
export function useReportRead<T>(
  path: string | null,
  generation = 0,
  load: (api: ApiClient, path: string, signal: AbortSignal) => Promise<T> = read,
) {
  const api = useApiClient();
  const session = useSession();
  const key = JSON.stringify([session.tenantId, session.identityKey, path, generation]);
  const [state, setState] = useState<{ key: string; data?: T; failure?: ReportFailure }>({ key: '' });
  useEffect(() => {
    setState({ key });
    if (path === null) return;
    const controller = new AbortController();
    // 等试挂载清理后再请求，避免开发模式重复读取。
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      void load(api, path, controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setState({ key, data });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setState({ key, failure: reportFailure(error) });
        });
    });
    return () => controller.abort();
  }, [api, path, key, load]);
  const current = state.key === key ? state : { key };
  return { ...current, error: current.failure?.error, loading: path !== null && !current.data && !current.failure };
}
