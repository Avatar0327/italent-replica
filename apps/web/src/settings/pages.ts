import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

const SettingsPage = lazyPage('SettingsPage', () => import('./SettingsPage.js'));
export const pages: ModulePages = {
  apps: [
    {
      app: 'settings',
      label: '企业设置',
      group: 'settings',
      page: SettingsPage,
      legacy: true,
      // 企业设置下一层是后台菜单，由服务端快照的 adminMenus 给出；可编辑标记原样带下去。
      children: (snapshot, route) =>
        snapshot.adminMenus.map((menu) => ({
          key: menu.code,
          label: menu.path,
          path: `/settings/menu/${encodeURIComponent(menu.code)}`,
          group: route.group,
          editable: menu.editable,
        })),
    },
  ],
  routes: [{ path: '/settings/menu/:code', page: SettingsPage }],
};
