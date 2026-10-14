import { lazyPage, type ModulePages } from '../foundation/page-registry.js';

const OrgChangePage = lazyPage('OrgChangePage', () => import('./OrgChangePage.js'));
export const pages: ModulePages = {
  apps: [
    {
      app: 'org',
      label: '组织管理',
      group: 'people',
      objectCode: 'TenantBase.Organization',
      page: OrgChangePage,
      legacy: true,
    },
  ],
  routes: [{ path: '/org/changes', page: OrgChangePage, legacy: true }],
};
