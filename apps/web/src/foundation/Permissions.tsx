import { createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import {
  emptyPermissions,
  loadSnapshot,
  fetchObjectPermission,
  type PermissionSnapshot,
} from './permission-snapshot.js';
import { canButton, fieldAccess, type FieldAccess, type ObjectPermission } from './permission-model.js';
import { SessionProvider, useApiClient, useSession, type Session } from './Session.js';

interface PermissionState {
  snapshot: PermissionSnapshot;
  loading: boolean;
  error?: unknown;
  refresh(): void;
  ensure(object: string, signal: AbortSignal): Promise<ObjectPermission | undefined>;
}
const PermissionContext = createContext<PermissionState>({
  snapshot: emptyPermissions,
  loading: true,
  refresh() {},
  async ensure() {
    return undefined;
  },
});
const ObjectContext = createContext<string | undefined>(undefined);
export function PermissionObject({ object, children }: { object?: string; children: ReactNode }) {
  return <ObjectContext.Provider value={object}>{children}</ObjectContext.Provider>;
}
export function PermissionsProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  return <PermissionsLoader key={`${session.tenantId}/${session.identityKey}`}>{children}</PermissionsLoader>;
}
function PermissionsLoader({ children }: { children: ReactNode }) {
  const context = useSession();
  const api = useApiClient();
  const [generation, refresh] = useState(0);
  const [session, setSession] = useState<Session>(context);
  const [state, setState] = useState<Omit<PermissionState, 'refresh' | 'ensure'>>({
    snapshot: emptyPermissions,
    loading: true,
  });
  const epoch = useRef({
    controller: new AbortController(),
    objects: new Map<string, Promise<ObjectPermission | undefined>>(),
  });
  useEffect(() => {
    const current = {
      controller: new AbortController(),
      objects: new Map<string, Promise<ObjectPermission | undefined>>(),
    };
    epoch.current = current;
    const { signal } = current.controller;
    setState({ snapshot: emptyPermissions, loading: true });
    // StrictMode 的试挂载会先清理；延后到微任务避免首屏重复发请求。
    queueMicrotask(() => {
      if (signal.aborted) return;
      if (!context.tenantId) {
        setState({ snapshot: emptyPermissions, loading: false });
        return;
      }
      void loadSnapshot(api, signal)
        .then((result) => {
          if (signal.aborted) return;
          setSession(result.session);
          setState({ snapshot: result.snapshot, loading: false });
        })
        .catch((error: unknown) => {
          if (!signal.aborted) setState({ snapshot: emptyPermissions, loading: false, error });
        });
    });
    return () => current.controller.abort();
  }, [api, context.tenantId, context.identityKey, generation]);
  const ensure = useCallback(
    async (object: string, signal: AbortSignal) => {
      if (state.loading || state.error || signal.aborted) return undefined;
      const cached = state.snapshot.objects[object];
      if (cached && !cached.summary) return cached;
      const current = epoch.current;
      let pending = current.objects.get(object);
      if (!pending) {
        // 同一快照周期共用请求；单个消费者卸载不会中断其他消费者，刷新或换身份统一取消。
        pending = fetchObjectPermission(api, object, current.controller.signal).then((permission) => {
          if (!current.controller.signal.aborted && permission)
            setState((value) => ({
              ...value,
              snapshot: { ...value.snapshot, objects: { ...value.snapshot.objects, [object]: permission } },
            }));
          return permission;
        });
        current.objects.set(object, pending);
      }
      try {
        const permission = await pending;
        return signal.aborted || current.controller.signal.aborted ? undefined : permission;
      } catch (error) {
        if (!signal.aborted && !current.controller.signal.aborted) setState((value) => ({ ...value, error }));
        return undefined;
      }
    },
    [api, state.loading, state.error, state.snapshot.objects],
  );
  const reload = useCallback(() => refresh((value) => value + 1), []);
  return (
    <SessionProvider session={session}>
      <PermissionContext.Provider value={{ ...state, refresh: reload, ensure }}>{children}</PermissionContext.Provider>
    </SessionProvider>
  );
}
export function usePermissions(objectCode?: string) {
  const state = useContext(PermissionContext);
  // 菜单消费者不加载页面对象；字段、按钮消费者显式指定对象，Can 可沿用页面上下文。
  const code = objectCode;
  const permission = code ? state.snapshot.objects[code] : undefined;
  useEffect(() => {
    if (!code || state.loading || state.error || (permission && !permission.summary)) return;
    const controller = new AbortController();
    void state.ensure(code, controller.signal);
    return () => controller.abort();
  }, [code, permission, state.loading, state.error, state.ensure]);
  return {
    ...state,
    menus: state.snapshot.menus,
    scope: state.snapshot.scope,
    can: (button: string, level = 'detail') => canButton(permission, button, level),
    field: (field: string) => fieldAccess(permission, field),
  };
}
export function Can({
  object,
  button,
  level = 'detail',
  children,
}: {
  object?: string;
  button: string;
  level?: string;
  children: ReactNode;
}) {
  const activeObject = useContext(ObjectContext);
  const permissions = usePermissions(object ?? activeObject);
  return permissions.can(button, level) ? children : null;
}
export function PermissionField({
  access,
  value,
  children,
}: {
  access: FieldAccess;
  value: ReactNode;
  children: ReactNode;
}) {
  if (!access.visible) return null;
  return access.editable ? children : <span className="readonly-field">{value ?? '—'}</span>;
}
