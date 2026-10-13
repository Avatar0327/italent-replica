import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import {
  emptyPermissions,
  loadPermissions,
  loadObjectPermission,
  type PermissionSnapshot,
} from '../demo-stubs/navigation.js';
import { canButton, fieldAccess, type FieldAccess } from './permission-model.js';
import { useApiClient, useSession } from './Session.js';

interface PermissionState {
  snapshot: PermissionSnapshot;
  loading: boolean;
  error?: unknown;
  refresh(): void;
  ensure(object: string, signal: AbortSignal): Promise<void>;
}
const PermissionContext = createContext<PermissionState>({
  snapshot: emptyPermissions,
  loading: true,
  refresh() {},
  async ensure() {},
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
  const session = useSession();
  const api = useApiClient();
  const [generation, refresh] = useState(0);
  const [state, setState] = useState<Omit<PermissionState, 'refresh' | 'ensure'>>({
    snapshot: emptyPermissions,
    loading: true,
  });
  useEffect(() => {
    const controller = new AbortController();
    setState({ snapshot: emptyPermissions, loading: true });
    if (!session.tenantId) {
      setState({ snapshot: emptyPermissions, loading: false });
      return;
    }
    void loadPermissions(api, controller.signal)
      .then((snapshot) => {
        if (!controller.signal.aborted) setState({ snapshot, loading: false });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ snapshot: emptyPermissions, loading: false, error });
      });
    return () => controller.abort();
  }, [api, session.tenantId, session.identityKey, generation]);
  const ensure = useCallback(
    async (object: string, signal: AbortSignal) => {
      try {
        const permission = await loadObjectPermission(api, object, signal);
        if (!signal.aborted && permission)
          setState((current) => ({
            ...current,
            snapshot: { ...current.snapshot, objects: { ...current.snapshot.objects, [object]: permission } },
          }));
      } catch (error) {
        if (!signal.aborted) setState((current) => ({ ...current, error }));
      }
    },
    [api],
  );
  const reload = useCallback(() => refresh((value) => value + 1), []);
  return (
    <PermissionContext.Provider value={{ ...state, refresh: reload, ensure }}>{children}</PermissionContext.Provider>
  );
}
export function usePermissions(objectCode?: string) {
  const state = useContext(PermissionContext);
  const activeObject = useContext(ObjectContext);
  const code = objectCode ?? activeObject;
  const permission = code ? state.snapshot.objects[code] : undefined;
  useEffect(() => {
    if (!code || state.loading || permission) return;
    const controller = new AbortController();
    void state.ensure(code, controller.signal);
    return () => controller.abort();
  }, [code, permission, state.loading, state.ensure]);
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
  const permissions = usePermissions(object);
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
