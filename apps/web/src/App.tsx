import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/es/locale/zh_CN.js';
import { BrowserRouter } from 'react-router';
import { DecisionNotesProvider } from './foundation/DecisionNote.js';
import { PermissionsProvider } from './foundation/Permissions.js';
import { SessionProvider, type Session } from './foundation/Session.js';
import { Shell } from './foundation/Shell.js';
import { annotations } from './annotations/index.js';
import { useButtonLoadingA11y } from './foundation/button-loading-a11y.js';
import { theme } from './foundation/theme.js';
import { initialTenantId } from './demo/tenant.js';
import { PortalApp } from './survey360/PortalApp.js';

const emptySession: Session = {
  tenantId: '',
  identityKey: '',
  tenantName: '',
  timezone: '',
  displayName: '',
  source: 'server',
};
export function App({ session = { ...emptySession, tenantId: initialTenantId() } }: { session?: Session }) {
  // F-582：按钮 loading 结束后残留的离场图标不进入可访问名；须在门户分流之前调用，两边都覆盖。
  useButtonLoadingA11y();
  if (/^\/survey360\/portal(?:\/|$)/.test(window.location.pathname)) return <PortalApp />;
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
