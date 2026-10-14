import { Button, Space, Tag } from 'antd';
import { Navigate, useNavigate, useParams } from 'react-router';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { PageState } from '../foundation/PageState.js';
import { usePermissions } from '../foundation/Permissions.js';
import { useSession } from '../foundation/Session.js';
import { settingsAccess, settingsPages } from './model.js';
import { UsersPage } from './UsersPage.js';
import { ProfilesPage } from './ProfilesPage.js';
import { GrantsPage } from './GrantsPage.js';
import { MousPage } from './MousPage.js';
import { AuditPage } from './AuditPage.js';
import { m } from './messages.js';
import './settings.css';
export function SettingsPage() {
  const { code } = useParams();
  const permissions = usePermissions();
  const session = useSession();
  const navigate = useNavigate();
  const adminMenus = (permissions.menus.find((menu) => menu.key === 'settings')?.children ?? []).map((menu) => ({
    code: menu.key,
    editable: menu.editable === true,
  }));
  const pages = settingsPages.filter((item) => settingsAccess(adminMenus, item.code).visible);
  if (!code)
    return pages.length ? <Navigate replace to={`/settings/menu/${pages[0]!.code}`} /> : <PageState kind="forbidden" />;
  const access = settingsAccess(adminMenus, code);
  if (!access.visible) return <PageState kind="forbidden" />;
  const page = settingsPages.find((item) => item.code === code);
  if (!page) return <PageState kind="not-found" />;
  const props = { code, title: page.title, editable: access.editable };
  return (
    <div className="settings-page" key={`${session.tenantId}/${session.identityKey}/${code}`}>
      <DecisionNote id="settings" />
      <DecisionNote id="settings.snapshot" />
      <div className="settings-navigation">
        <Space wrap>
          {pages.map((item) => (
            <Button
              key={item.code}
              type={item.code === code ? 'primary' : 'text'}
              onClick={() => navigate(`/settings/menu/${item.code}`)}
            >
              {item.title}
            </Button>
          ))}
        </Space>
        <Tag title={m.sourceNotice}>{m.serverPermissions}</Tag>
      </div>
      {code.startsWith('users.') && <UsersPage {...props} />}
      {code === 'permission.profiles' && <ProfilesPage {...props} />}
      {code === 'permission.user_grant' && (
        <GrantsPage {...props} canScope={settingsAccess(adminMenus, 'other.mou_settings').editable} />
      )}
      {code === 'permission.mous' && <MousPage {...props} />}
      {code === 'audit.business' && <AuditPage />}
    </div>
  );
}
export interface SettingsProps {
  code: string;
  title: string;
  editable: boolean;
}
