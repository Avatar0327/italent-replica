import { Button, Input, Layout, Menu, Tag } from 'antd';
import { lazy, Suspense, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { DecisionNote, DecisionNoteToggle } from './DecisionNote.js';
import { PermissionObject, usePermissions } from './Permissions.js';
import { useSession } from './Session.js';
import { ApiError } from './client.js';
import { PageState } from './PageState.js';
import { AppPages } from './AppPages.js';
import { appRoute } from './routes.js';
import { currentApp } from './menu-nav.js';
import type { MenuNode } from './permission-snapshot.js';
import { isConfigurationPath } from './configuration-registry.js';
import { ui } from './messages.js';
import { MenuIcon } from './ViewHeading.js';
import { AppSwitch, MessageCenter, PersonalMenu } from './HeaderParts.js';
import './shell.css';

const DemoSwitcher = import.meta.env.DEV
  ? lazy(() => import('../demo/DemoIdentitySwitcher.js').then((m) => ({ default: m.DemoIdentitySwitcher })))
  : null;

function Header() {
  const session = useSession();
  return (
    <Layout.Header className="shell-header">
      <Link className="shell-brand" to="/">
        {ui.brand}
      </Link>
      <span className="shell-tenant" title={session.tenantId}>
        {session.tenantName || ui.tenant}
      </span>
      <AppSwitch />
      <Tag color="blue">{ui.demo}</Tag>
      <div className="header-spacer" />
      {/* 原站可搜菜单与同事；复刻暂无全局搜索接口，保持禁用（见后端缺口）。 */}
      <Input className="shell-search" aria-label={ui.search} placeholder={ui.search} disabled prefix="⌕" />
      <MessageCenter />
      {DemoSwitcher && (
        <Suspense fallback={null}>
          <DemoSwitcher />
        </Suspense>
      )}
      <PersonalMenu />
      <DecisionNoteToggle />
    </Layout.Header>
  );
}
function menuItem(menu: MenuNode, navigate: (path: string) => void) {
  return {
    key: menu.directory ? menu.key : menu.path,
    icon: <MenuIcon />,
    label: menu.label,
    onTitleClick: menu.directory ? undefined : () => navigate(menu.path),
    children: menu.children?.length ? menu.children.map(subItem) : undefined,
  };
}
/** 应用下的菜单：叶子按路径导航；目录（如员工自助 > 我的发展计划）只展开，键取菜单键以免与子项路径重复。 */
type SubItem = { key: string; label: string; children?: SubItem[] };
function subItem(menu: MenuNode): SubItem {
  return menu.children?.length
    ? { key: menu.key, label: menu.label, children: menu.children.map(subItem) }
    : { key: menu.path, label: menu.label };
}
/**
 * 原站左侧导航只列当前应用的菜单，切换应用走顶栏全部菜单面板。
 * 当前页不属于任何有权菜单（首页、个人设置、无权限页）时复刻仍按应用分组列出全部有权菜单（假设，原站未取证）。
 */
function sidebarItems(menus: MenuNode[], activePath: string | undefined, navigate: (path: string) => void) {
  const app = currentApp(menus, activePath, ui.groups);
  if (app) return app.menus.map((menu) => menuItem(menu, navigate));
  return Object.entries(ui.groups)
    .map(([key, label]) => ({
      type: 'group' as const,
      key,
      label,
      children: menus.filter((menu) => menu.group === key).map((menu) => menuItem(menu, navigate)),
    }))
    .filter((group) => group.children.length > 0);
}
export function Shell() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { menus, loading, error, refresh } = usePermissions();
  const configuration = isConfigurationPath(location.pathname);
  const active = appRoute(location.pathname);
  const items = sidebarItems(menus, active?.path, navigate);
  const parent = menus.find((menu) => menu.directory && menu.children?.some((child) => child.path === active?.path));
  const openKey = parent?.key ?? active?.path;
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
        {!configuration && (
          <Layout.Sider
            width={200}
            collapsedWidth={72}
            collapsed={collapsed}
            className="shell-sidebar"
            aria-label={ui.apps}
          >
            <Menu
              key={parent?.key ?? 'menus'}
              mode="inline"
              selectedKeys={[location.pathname]}
              defaultOpenKeys={openKey ? [openKey] : []}
              items={items}
              onClick={({ key }) => navigate(key)}
            />
            <Button
              className="menu-collapse"
              type="text"
              onClick={() => setCollapsed(!collapsed)}
              aria-label={collapsed ? ui.expandMenu : ui.collapseMenu}
            >
              <span aria-hidden="true">{collapsed ? '⇥' : '⇤'}</span>
            </Button>
          </Layout.Sider>
        )}
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
