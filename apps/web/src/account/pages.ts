import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

// 个人设置挂在 /settings 下但不属于企业设置菜单：只要求会话，不按菜单可见性拦截。
export const pages: ModulePages = {
  routes: [
    {
      path: '/settings/account',
      page: lazyPage('AccountPage', () => import('./AccountPage.js')),
      legacy: true,
      ungated: true,
    },
  ],
};
