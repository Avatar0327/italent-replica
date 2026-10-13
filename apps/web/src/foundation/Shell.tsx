import { Button, Input, Layout, Menu, Popover, Select, Tag } from 'antd';
import { lazy, Suspense, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { DecisionNote, DecisionNoteToggle } from './DecisionNote.js';
import { PermissionObject, usePermissions } from './Permissions.js';
import { useSession } from './Session.js';
import { ApiError } from './client.js';
import { PageState } from './PageState.js';
import { AppPages } from './AppPages.js';
import { appRoute } from './routes.js';
import { ui } from './messages.js';
import { MenuIcon } from './ViewHeading.js';
import './shell.css';

const DemoSwitcher = import.meta.env.DEV
  ? lazy(() => import('../demo/DemoIdentitySwitcher.js').then((m) => ({ default: m.DemoIdentitySwitcher })))
  : null;

function Header() {
  const session = useSession();
  const { menus } = usePermissions();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <Layout.Header className="shell-header">
      <Link className="shell-brand" to="/">
        {ui.brand}
      </Link>
      <span className="shell-tenant" title={session.tenantId}>
        {session.tenantName || ui.tenant}
      </span>
      <Select
        className="app-switch"
        variant="borderless"
        aria-label={ui.apps}
        placeholder={ui.apps}
        value={menus.find((menu) => menu.path === appRoute(location.pathname)?.path)?.path}
        onChange={(path: string) => navigate(path)}
        options={menus.map((menu) => ({ value: menu.path, label: menu.label }))}
      />
      <Tag color="blue">{ui.demo}</Tag>
      <div className="header-spacer" />
      <Input className="shell-search" aria-label={ui.search} placeholder={ui.search} disabled prefix="⌕" />
      <Popover content={ui.noMessages} trigger="click">
        <Button type="text" aria-label={ui.messages}>
          {ui.messages}
        </Button>
      </Popover>
      {DemoSwitcher ? (
        <Suspense fallback={null}>
          <DemoSwitcher />
        </Suspense>
      ) : (
        <Link to="/settings/account">{session.displayName || ui.identity}</Link>
      )}
      <DecisionNoteToggle />
    </Layout.Header>
  );
}
export function Shell() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { menus, loading, error, refresh } = usePermissions();
  const active = appRoute(location.pathname);
  const groups = Object.entries(ui.groups)
    .map(([key, label]) => ({
      type: 'group' as const,
      key,
      label,
      children: menus
        .filter((menu) => menu.group === key)
        .map((menu) => ({
          key: menu.path,
          icon: <MenuIcon />,
          label: menu.label,
          onTitleClick: () => navigate(menu.path),
          children: menu.children?.length
            ? menu.children.map((child) => ({ key: child.path, label: child.label }))
            : undefined,
        })),
    }))
    .filter((group) => group.children.length > 0);
  let content = <AppPages />;
  if (loading) content = <PageState kind="loading" />;
  else if (error) {
    const kind = error instanceof ApiError && error.kind === 'login' ? 'login' : 'error';
    content = <PageState kind={kind} error={error} retry={refresh} />;
  }
  return (
    <Layout className="app-shell">
      <Header />
      <Layout>
        <Layout.Sider
          width={200}
          collapsedWidth={72}
          collapsed={collapsed}
          className="shell-sidebar"
          aria-label={ui.apps}
        >
          <Menu
            mode="inline"
            selectedKeys={[location.pathname]}
            defaultOpenKeys={active ? [active.path] : []}
            items={groups}
            onClick={({ key }) => navigate(key)}
          />
          <Link className="account-link" to="/settings/account" aria-label={ui.account}>
            {collapsed ? <MenuIcon /> : ui.account}
          </Link>
          <Button
            className="menu-collapse"
            type="text"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? ui.expandMenu : ui.collapseMenu}
          >
            <span aria-hidden="true">{collapsed ? '⇥' : '⇤'}</span>
          </Button>
        </Layout.Sider>
        <Layout.Content className="shell-content">
          <DecisionNote id="foundation" />
          <div className="shell-workspace">
            <PermissionObject object={active?.objectCode}>{content}</PermissionObject>
          </div>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
