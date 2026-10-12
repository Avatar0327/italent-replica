import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { createApiClient, type RequestContext } from './client.js';

export interface Session extends RequestContext {
  readonly tenantName: string;
  readonly timezone: string;
  readonly displayName: string;
  readonly source: 'server' | 'demo';
}
const empty: Session = {
  tenantId: '',
  identityKey: '',
  tenantName: '',
  timezone: '',
  displayName: '',
  source: 'server',
};
const SessionContext = createContext(empty);
export function SessionProvider({ session, children }: { session: Session; children: ReactNode }) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
export const useSession = () => useContext(SessionContext);
export function useApiClient() {
  const session = useSession();
  const current = useRef(session);
  current.current = session;
  return useMemo(() => createApiClient(() => current.current), []);
}
