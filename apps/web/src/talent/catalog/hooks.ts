import type { Resource } from './types.js';
import { candidates } from './api.js';
import { useEffect, useState } from 'react';
import { ApiError, type ApiClient } from '../../foundation/client.js';
import { useApiClient, useSession } from '../../foundation/Session.js';

/** 请求按会话和完整参数隔离，过时回包不覆盖当前页面。 */
export function useRemote<T>(key: string, load: (api: ApiClient, signal: AbortSignal) => Promise<T>) {
  const api = useApiClient();
  const session = useSession();
  const requestKey = `${session.tenantId}:${session.identityKey}:${key}`;
  const [state, setState] = useState<{ key: string; data?: T; error?: unknown }>();
  useEffect(() => {
    const controller = new AbortController();
    if (key) {
      void load(api, controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setState({ key: requestKey, data });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setState({ key: requestKey, error });
        });
    }
    return () => controller.abort();
    // key 是请求契约，调用者须把全部请求参数放进 key；函数闭包不作为刷新来源。
  }, [api, requestKey]);
  const current = state?.key === requestKey ? state : undefined;
  return { data: current?.data, error: current?.error, loading: !!key && !current };
}
export function useReferenceNames(resource: Resource, generation = 0) {
  return useRemote(`names:${resource.object}:${generation}`, async (api, signal) => {
    const sources = [...new Set(resource.fields.map((field) => field.source).filter((path): path is string => !!path))];
    const rows = await Promise.all(
      sources.map(async (path) => {
        try {
          return await candidates(api, path, signal);
        } catch (error) {
          if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return [];
          throw error;
        }
      }),
    );
    return new Map(
      rows
        .flat()
        .filter((row) => row.name !== undefined)
        .map((row) => [row.id, row.name!]),
    );
  });
}
