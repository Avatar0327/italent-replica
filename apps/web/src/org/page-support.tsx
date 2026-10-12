import { useEffect, useRef, useState } from 'react';
import { ApiError, newCommand, useApiClient, useSession } from '../foundation/index.js';
import { type ObjectPermission } from '../foundation/permission-model.js';
import { pageAccess } from './page-model.js';
import { pageText as m } from './messages.js';

/** FE-0 尚只预加载首页对象。本片复用其权限模型，额外对象仍从服务端读取；待上移。 */
export function usePagePermissions(codes: readonly string[]) {
  const api = useApiClient();
  const session = useSession();
  const key = codes.join(',');
  const [state, setState] = useState<{ key: string; objects: Record<string, ObjectPermission>; error?: unknown }>();
  const context = `${session.tenantId}/${session.identityKey}/${key}`;
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all(
      key.split(',').map(async (code) => {
        try {
          return await api.request<ObjectPermission>(`/api/tenant/permission/me/objects/${code}`, {
            signal: controller.signal,
          });
        } catch (error) {
          if (error instanceof ApiError && [403, 404].includes(error.status)) return undefined;
          throw error;
        }
      }),
    )
      .then((items) => {
        if (!controller.signal.aborted)
          setState({
            key: context,
            objects: Object.fromEntries(items.filter((item) => !!item).map((item) => [item.objectCode, item])),
          });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ key: context, objects: {}, error });
      });
    return () => controller.abort();
  }, [api, context, key]);
  const objects = state?.key === context ? state.objects : {};
  return {
    loading: state?.key !== context,
    error: state?.key === context ? state.error : undefined,
    object: (code: string) => objects[code],
    access: (code: string) => pageAccess(objects[code]),
  };
}
export function useRemote<T>(path: string | null) {
  const api = useApiClient();
  const session = useSession();
  const [generation, setGeneration] = useState(0);
  const key = `${session.tenantId}/${session.identityKey}/${path}/${generation}`;
  const [state, setState] = useState<{ key: string; data?: T; error?: unknown }>();
  useEffect(() => {
    const controller = new AbortController();
    if (path)
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
  return {
    data: state?.key === key ? state.data : undefined,
    error: state?.key === key ? state.error : undefined,
    loading: !!path && state?.key !== key,
    refresh: () => setGeneration((value) => value + 1),
  };
}
export type PageAccess = ReturnType<ReturnType<typeof usePagePermissions>['access']>;

/** 结果未知或冲突后冻结本次编辑；必须关闭、回查并显式重开，禁止盲重试。 */
export function usePageWrite() {
  const api = useApiClient();
  const blocked = useRef(false);
  return async (path: string, body: Record<string, unknown>, revision: number, method: 'POST' | 'PATCH') => {
    if (blocked.current) throw new ApiError(409, 'RELOAD_REQUIRED', 'refresh', m.recovery);
    try {
      return await api.request(path, { method, command: newCommand(body, revision) });
    } catch (error) {
      if (!(error instanceof ApiError) || ['unknown', 'refresh', 'rate-limit'].includes(error.kind))
        blocked.current = true;
      throw error;
    }
  };
}
