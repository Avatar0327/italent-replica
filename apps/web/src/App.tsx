import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/es/locale/zh_CN.js';
import { BrowserRouter } from 'react-router';
import { DecisionNotesProvider } from './foundation/DecisionNote.js';
import { PermissionsProvider } from './foundation/Permissions.js';
import { SessionProvider, type Session } from './foundation/Session.js';
import { Shell } from './foundation/Shell.js';
import { annotations } from './annotations/index.js';
import { theme } from './foundation/theme.js';
import { initialTenantId } from './demo/tenant.js';

const emptySession: Session = {
  tenantId: '',
  identityKey: '',
  tenantName: '',
  timezone: '',
  displayName: '',
  source: 'server',
};
export function App({ session = { ...emptySession, tenantId: initialTenantId() } }: { session?: Session }) {
  return (
    <ConfigProvider locale={zhCN} theme={theme}>
      <AntApp>
        <SessionProvider session={session}>
          <PermissionsProvider key={`${session.tenantId}/${session.identityKey}`}>
            <DecisionNotesProvider notes={annotations}>
              <BrowserRouter>
                <Shell />
              </BrowserRouter>
            </DecisionNotesProvider>
          </PermissionsProvider>
        </SessionProvider>
      </AntApp>
    </ConfigProvider>
  );
}
