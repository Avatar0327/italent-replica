import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { emptyPermissions, loadPermissions, type PermissionSnapshot } from '../demo-stubs/navigation.js';
import { canButton, fieldAccess, type FieldAccess } from './permission-model.js';
import { useApiClient, useSession } from './Session.js';

interface PermissionState {
  snapshot: PermissionSnapshot;
  loading: boolean;
  error?: unknown;
  refresh(): void;
}
const PermissionContext = createContext<PermissionState>({
  snapshot: emptyPermissions,
  loading: true,
  refresh() {},
});
const ObjectContext = createContext<string | undefined>(undefined);
export function PermissionObject({ object, children }: { object?: string; children: ReactNode }) {
  return <ObjectContext.Provider value={object}>{children}</ObjectContext.Provider>;
}
export function PermissionsProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const api = useApiClient();
  const [generation, refresh] = useState(0);
  const [state, setState] = useState<Omit<PermissionState, 'refresh'>>({ snapshot: emptyPermissions, loading: true });
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
  return (
    <PermissionContext.Provider value={{ ...state, refresh: () => refresh((value) => value + 1) }}>
      {children}
    </PermissionContext.Provider>
  );
}
export function usePermissions(objectCode?: string) {
  const state = useContext(PermissionContext);
  const activeObject = useContext(ObjectContext);
  const code = objectCode ?? activeObject;
  const permission = code ? state.snapshot.objects[code] : undefined;
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
  return !access.visible ? null : access.editable ? children : <span className="readonly-field">{value ?? '—'}</span>;
}
