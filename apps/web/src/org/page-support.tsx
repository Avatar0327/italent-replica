import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, newCommand, useApiClient, useSession, usePermissions, PageState } from '../foundation/index.js';
import { pageAccess } from './page-model.js';
import { pageText as m } from './messages.js';

/** 页面页签须等待本组对象完成加载；权限读取和快照仍统一交给 FE-0。 */
export function usePagePermissions(codes: readonly string[]) {
  const base = usePermissions();
  const session = useSession();
  const key = codes.join(',');
  const context = `${session.tenantId}/${session.identityKey}/${key}`;
  const [ready, setReady] = useState('');
  useEffect(() => {
    if (base.loading) return;
    const controller = new AbortController();
    void Promise.all(key.split(',').map((code) => base.ensure(code, controller.signal))).then(() => {
      if (!controller.signal.aborted) setReady(context);
    });
    return () => controller.abort();
  }, [base.ensure, base.loading, context, key]);
  return {
    loading: base.loading || ready !== context,
    error: base.error,
    access: (code: string) => pageAccess(base.snapshot.objects[code]),
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

export function RemoteContent({
  state,
  children,
}: {
  state: { loading: boolean; error?: unknown };
  children: ReactNode;
}) {
  if (state.loading) return <PageState kind="loading" />;
  if (state.error) return <PageState kind="error" error={state.error} />;
  return children;
}
