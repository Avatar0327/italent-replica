import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { createApiClient, type RequestContext } from './client.js';
import type { ServerSnapshot } from './permission-snapshot.js';

export interface Session
  extends
    RequestContext,
    Pick<ServerSnapshot['session'], 'tenantName' | 'timezone' | 'displayName'>,
    Partial<Pick<ServerSnapshot['session'], 'userId' | 'employeeId' | 'today'>> {
  readonly source: 'server';
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
